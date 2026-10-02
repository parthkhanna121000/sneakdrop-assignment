import type { PoolClient } from 'pg';
import { MAX_PURCHASES_PER_USER } from '../../config/env';
import { AppError } from '../../utils/errors';
import { withDropLock } from '../../utils/transaction';
import { requireUser } from '../users/user.service';
import { expireDueReservations, reconcileQueue, getActiveReservation } from '../reservations/reservation.service';

/** Position is computed, never stored: WAITING entries ahead of me + 1. */
export async function queuePosition(c: PoolClient, seq: string | number): Promise<number> {
  const { rows } = await c.query(`SELECT COUNT(*) AS n FROM queue_entries WHERE status = 'WAITING' AND seq <= $1`, [seq]);
  return Number(rows[0].n);
}

/** POST /queue */
export async function joinQueue(userId: string) {
  return withDropLock(async (c) => {
    const user = await requireUser(c, userId);
    await expireDueReservations(c);
    await reconcileQueue(c);

    if (user.purchase_count >= MAX_PURCHASES_PER_USER) {
      throw new AppError(409, 'PURCHASE_LIMIT_REACHED', `You can buy at most ${MAX_PURCHASES_PER_USER} pairs`);
    }
    if (await getActiveReservation(c, userId)) {
      throw new AppError(409, 'ALREADY_HOLDING', 'You already hold a pair');
    }
    const waiting = await c.query(`SELECT seq FROM queue_entries WHERE user_id = $1 AND status = 'WAITING'`, [userId]);
    if (waiting.rows[0]) {
      return { status: 'WAITING' as const, queuePosition: await queuePosition(c, waiting.rows[0].seq) };
    }
    const available = await c.query(`SELECT 1 FROM sneakers WHERE status = 'AVAILABLE' LIMIT 1`);
    if (available.rowCount) {
      throw new AppError(409, 'STOCK_AVAILABLE', 'Pairs are in stock, use POST /buy instead');
    }

    const entry = await c.query(`INSERT INTO queue_entries (user_id) VALUES ($1) RETURNING seq`, [userId]);
    return { status: 'WAITING' as const, queuePosition: await queuePosition(c, entry.rows[0].seq) };
  });
}

/** POST /queue/leave */
export async function leaveQueue(userId: string) {
  return withDropLock(async (c) => {
    await requireUser(c, userId);
    const { rowCount } = await c.query(
      `UPDATE queue_entries SET status = 'CANCELLED' WHERE user_id = $1 AND status = 'WAITING'`,
      [userId],
    );
    if (!rowCount) throw new AppError(409, 'NOT_IN_QUEUE', 'You are not waiting in the queue');
    return { status: 'CANCELLED' as const };
  });
}
