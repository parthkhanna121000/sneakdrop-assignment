import type { PoolClient } from 'pg';
import { readPool, writePool } from '../../db/client';
import { AppError } from '../../utils/errors';

export async function createUser(): Promise<string> {
  const { rows } = await writePool.query(`INSERT INTO users DEFAULT VALUES RETURNING id`);
  return rows[0].id;
}

/** Inside a drop-lock transaction. Row-locks the user as an extra safety net. */
export async function requireUser(c: PoolClient, userId: string): Promise<{ id: string; purchase_count: number }> {
  const { rows } = await c.query(`SELECT id, purchase_count FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (!rows[0]) throw new AppError(404, 'USER_NOT_FOUND', 'User does not exist');
  return rows[0];
}

export type UserStatus = 'HELD' | 'PAYMENT_PENDING' | 'WAITING' | 'REFUND_NEEDED' | 'PURCHASED' | 'IDLE';

/** Read-only; uses the read pool so it never waits on the drop lock. */
export async function getUserStatus(userId: string) {
  const [userQ, resvQ, queueQ, refundQ] = await Promise.all([
    readPool.query(`SELECT purchase_count, clock_timestamp() AS now FROM users WHERE id = $1`, [userId]),
    readPool.query(
      `SELECT id, sneaker_id, status, expires_at, pending_deadline
         FROM reservations WHERE user_id = $1 AND status IN ('HELD','PAYMENT_PENDING')`,
      [userId],
    ),
    readPool.query(
      `SELECT (SELECT COUNT(*) FROM queue_entries w WHERE w.status = 'WAITING' AND w.seq <= q.seq) AS position
         FROM queue_entries q WHERE q.user_id = $1 AND q.status = 'WAITING'`,
      [userId],
    ),
    readPool.query(
      `SELECT COUNT(*) AS n FROM payments p JOIN reservations r ON r.id = p.reservation_id
        WHERE r.user_id = $1 AND p.status = 'REFUND_NEEDED'`,
      [userId],
    ),
  ]);

  const user = userQ.rows[0];
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User does not exist');

  const now: Date = user.now;
  const purchaseCount: number = user.purchase_count;
  const refundsPending = Number(refundQ.rows[0].n);
  const resv = resvQ.rows[0];
  const queuePosition = queueQ.rows[0] ? Number(queueQ.rows[0].position) : null;

  let status: UserStatus = 'IDLE';
  let reservation: Record<string, unknown> | null = null;
  let secondsRemaining: number | null = null;

  if (resv) {
    status = resv.status;
    const deadline: Date = resv.status === 'PAYMENT_PENDING' && resv.pending_deadline ? resv.pending_deadline : resv.expires_at;
    secondsRemaining = Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 1000));
    reservation = {
      id: resv.id,
      sneakerId: resv.sneaker_id,
      expiresAt: resv.expires_at,
      pendingDeadline: resv.pending_deadline,
    };
  } else if (queuePosition !== null) {
    status = 'WAITING';
  } else if (refundsPending > 0) {
    status = 'REFUND_NEEDED';
  } else if (purchaseCount > 0) {
    status = 'PURCHASED';
  }

  return {
    serverNow: now,
    status,
    reservation,
    secondsRemaining,
    queuePosition,
    purchaseCount,
    refundsPending,
  };
}
