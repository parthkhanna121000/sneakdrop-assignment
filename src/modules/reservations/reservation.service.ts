import type { PoolClient } from 'pg';
import { env, MAX_PURCHASES_PER_USER } from '../../config/env';
import { AppError } from '../../utils/errors';
import { withDropLock } from '../../utils/transaction';
import { requireUser } from '../users/user.service';
import { queuePosition } from '../queue/queue.service';

export interface ReservationRow {
  id: string;
  user_id: string;
  sneaker_id: string;
  status: 'HELD' | 'PAYMENT_PENDING' | 'PURCHASED' | 'EXPIRED';
  expires_at: Date;
  pending_deadline: Date | null;
}

/**
 * CENTRAL FUNCTION. The caller has already ended the previous reservation for `sneakerId`.
 * Gives the sneaker to the first eligible WAITING user (new 5-minute HELD reservation,
 * sneaker stays HELD) or, if nobody is waiting, returns it to AVAILABLE.
 * Returns true if somebody was promoted.
 */
export async function releaseAndPromote(c: PoolClient, sneakerId: string): Promise<boolean> {
  for (;;) {
    const { rows } = await c.query(
      `SELECT q.id AS queue_id, q.user_id, u.purchase_count
         FROM queue_entries q JOIN users u ON u.id = q.user_id
        WHERE q.status = 'WAITING'
        ORDER BY q.seq
        LIMIT 1`,
    );
    const next = rows[0];
    if (!next) break;

    const active = await c.query(
      `SELECT 1 FROM reservations WHERE user_id = $1 AND status IN ('HELD','PAYMENT_PENDING')`,
      [next.user_id],
    );
    if (next.purchase_count >= MAX_PURCHASES_PER_USER || active.rowCount) {
      await c.query(`UPDATE queue_entries SET status = 'SKIPPED' WHERE id = $1`, [next.queue_id]);
      continue;
    }

    const created = await c.query(
      `INSERT INTO reservations (user_id, sneaker_id, status, expires_at)
       VALUES ($1, $2, 'HELD', clock_timestamp() + make_interval(secs => $3::double precision))
       RETURNING id`,
      [next.user_id, sneakerId, env.holdSeconds],
    );
    await c.query(`UPDATE queue_entries SET status = 'PROMOTED', reservation_id = $2 WHERE id = $1`, [
      next.queue_id,
      created.rows[0].id,
    ]);
    await c.query(`UPDATE sneakers SET status = 'HELD' WHERE id = $1`, [sneakerId]);
    return true;
  }

  await c.query(`UPDATE sneakers SET status = 'AVAILABLE' WHERE id = $1`, [sneakerId]);
  return false;
}

/**
 * Logical expiry, evaluated against the DB clock (never waits for the worker).
 * HELD            -> EXPIRED when expires_at <= now
 * PAYMENT_PENDING -> EXPIRED when pending_deadline <= now (its pending payment is marked FAILED;
 *                    a later "succeeded" webhook for it becomes REFUND_NEEDED)
 */
export async function expireDueReservations(c: PoolClient): Promise<number> {
  const { rows } = await c.query(
    `SELECT id, sneaker_id, status FROM reservations
      WHERE (status = 'HELD' AND expires_at <= clock_timestamp())
         OR (status = 'PAYMENT_PENDING' AND pending_deadline <= clock_timestamp())
      ORDER BY expires_at`,
  );
  for (const r of rows) {
    await c.query(`UPDATE reservations SET status = 'EXPIRED' WHERE id = $1`, [r.id]);
    if (r.status === 'PAYMENT_PENDING') {
      await c.query(`UPDATE payments SET status = 'FAILED' WHERE reservation_id = $1 AND status = 'PENDING'`, [r.id]);
    }
    await releaseAndPromote(c, r.sneaker_id);
  }
  return rows.length;
}

/** Self-healing: if people are waiting while stock is AVAILABLE, promote them. */
export async function reconcileQueue(c: PoolClient): Promise<number> {
  let promoted = 0;
  for (;;) {
    const waiting = await c.query(`SELECT 1 FROM queue_entries WHERE status = 'WAITING' LIMIT 1`);
    if (!waiting.rowCount) break;
    const sneaker = await c.query(`SELECT id FROM sneakers WHERE status = 'AVAILABLE' ORDER BY created_at, id LIMIT 1`);
    if (!sneaker.rows[0]) break;
    const ok = await releaseAndPromote(c, sneaker.rows[0].id);
    if (!ok) break;
    promoted++;
  }
  return promoted;
}

export async function getActiveReservation(c: PoolClient, userId: string): Promise<ReservationRow | undefined> {
  const { rows } = await c.query(
    `SELECT id, user_id, sneaker_id, status, expires_at, pending_deadline
       FROM reservations WHERE user_id = $1 AND status IN ('HELD','PAYMENT_PENDING')`,
    [userId],
  );
  return rows[0];
}

function reservationResponse(r: ReservationRow) {
  return {
    status: r.status,
    reservationId: r.id,
    sneakerId: r.sneaker_id,
    expiresAt: r.expires_at,
    pendingDeadline: r.pending_deadline,
  };
}

/** POST /buy */
export async function buy(userId: string) {
  return withDropLock(async (c) => {
    const user = await requireUser(c, userId);

    // Lazy expiry + self-heal so we never depend on the worker having run.
    await expireDueReservations(c);
    await reconcileQueue(c);

    if (user.purchase_count >= MAX_PURCHASES_PER_USER) {
      throw new AppError(409, 'PURCHASE_LIMIT_REACHED', `You can buy at most ${MAX_PURCHASES_PER_USER} pairs`);
    }

    // Double-click / retry: return the reservation the user already has.
    const active = await getActiveReservation(c, userId);
    if (active) return reservationResponse(active);

    // Already in line: keep FIFO position, never jump the queue.
    const waiting = await c.query(`SELECT seq FROM queue_entries WHERE user_id = $1 AND status = 'WAITING'`, [userId]);
    if (waiting.rows[0]) {
      return { status: 'WAITING' as const, queuePosition: await queuePosition(c, waiting.rows[0].seq) };
    }

    const sneaker = await c.query(`SELECT id FROM sneakers WHERE status = 'AVAILABLE' ORDER BY created_at, id LIMIT 1`);
    if (sneaker.rows[0]) {
      const sneakerId: string = sneaker.rows[0].id;
      await c.query(`UPDATE sneakers SET status = 'HELD' WHERE id = $1`, [sneakerId]);
      const created = await c.query(
        `INSERT INTO reservations (user_id, sneaker_id, status, expires_at)
         VALUES ($1, $2, 'HELD', clock_timestamp() + make_interval(secs => $3::double precision))
         RETURNING id, user_id, sneaker_id, status, expires_at, pending_deadline`,
        [userId, sneakerId, env.holdSeconds],
      );
      return reservationResponse(created.rows[0]);
    }

    const entry = await c.query(`INSERT INTO queue_entries (user_id) VALUES ($1) RETURNING seq`, [userId]);
    return { status: 'WAITING' as const, queuePosition: await queuePosition(c, entry.rows[0].seq) };
  });
}
