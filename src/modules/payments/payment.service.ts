import type { PoolClient } from 'pg';
import { env, MAX_PURCHASES_PER_USER } from '../../config/env';
import { writePool } from '../../db/client';
import { AppError } from '../../utils/errors';
import { withDropLock } from '../../utils/transaction';
import { requireUser } from '../users/user.service';
import { expireDueReservations, releaseAndPromote } from '../reservations/reservation.service';

/**
 * POST /pay
 * 1. short DB transaction: validate, create PENDING payment, reservation -> PAYMENT_PENDING, COMMIT
 * 2. only AFTER commit: call the payment provider (never hold the drop lock during network I/O)
 */
export async function startPayment(userId: string, reservationId: string) {
  const payment = await withDropLock(async (c) => {
    await requireUser(c, userId);
    await expireDueReservations(c);

    const { rows } = await c.query(
      `SELECT id, status, expires_at FROM reservations WHERE id = $1 AND user_id = $2`,
      [reservationId, userId],
    );
    const resv = rows[0];
    if (!resv) throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found for this user');
    if (resv.status !== 'HELD') {
      throw new AppError(409, 'RESERVATION_NOT_PAYABLE', `Reservation is ${resv.status}`, { reservationStatus: resv.status });
    }

    const created = await c.query(
      `INSERT INTO payments (reservation_id, status, amount) VALUES ($1, 'PENDING', $2) RETURNING id, amount`,
      [reservationId, env.paymentAmount],
    );
    const upd = await c.query(
      `UPDATE reservations
          SET status = 'PAYMENT_PENDING',
              pending_deadline = clock_timestamp() + make_interval(secs => $2::double precision)
        WHERE id = $1
        RETURNING pending_deadline`,
      [reservationId, env.pendingSeconds],
    );
    return { paymentId: created.rows[0].id as string, amount: created.rows[0].amount as number, pendingDeadline: upd.rows[0].pending_deadline as Date };
  });

  try {
    const res = await fetch(`${env.fakePaymentUrl}/fake-pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ merchantPaymentId: payment.paymentId, amount: payment.amount }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`provider responded ${res.status}`);
    const data = (await res.json()) as { providerPaymentId?: string };
    if (data.providerPaymentId) {
      await writePool.query(`UPDATE payments SET provider_payment_id = $2 WHERE id = $1`, [payment.paymentId, data.providerPaymentId]);
    }
  } catch (err) {
    // Provider unreachable: undo so the user can retry within their hold.
    await withDropLock(async (c) => {
      const p = await loadPayment(c, payment.paymentId);
      if (p) await applyFailure(c, p);
    });
    throw new AppError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Could not reach payment provider, please retry');
  }

  return {
    status: 'PAYMENT_PENDING' as const,
    paymentId: payment.paymentId,
    reservationId,
    pendingDeadline: payment.pendingDeadline,
  };
}

interface PaymentRow {
  id: string;
  reservation_id: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUND_NEEDED';
}

async function loadPayment(c: PoolClient, paymentId: string): Promise<PaymentRow | undefined> {
  const { rows } = await c.query(`SELECT id, reservation_id, status FROM payments WHERE id = $1`, [paymentId]);
  return rows[0];
}

/** payment.failed: PENDING -> FAILED; reservation back to HELD if its hold is still valid, else expire + promote. */
async function applyFailure(c: PoolClient, payment: PaymentRow): Promise<string> {
  if (payment.status !== 'PENDING') return 'IGNORED_TERMINAL';
  await c.query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [payment.id]);

  const { rows } = await c.query(
    `SELECT id, sneaker_id, status, (expires_at <= clock_timestamp()) AS expired FROM reservations WHERE id = $1`,
    [payment.reservation_id],
  );
  const resv = rows[0];
  if (!resv || resv.status !== 'PAYMENT_PENDING') return 'FAILED';

  if (!resv.expired) {
    await c.query(`UPDATE reservations SET status = 'HELD', pending_deadline = NULL WHERE id = $1`, [resv.id]);
    return 'FAILED_BACK_TO_HELD';
  }
  await c.query(`UPDATE reservations SET status = 'EXPIRED' WHERE id = $1`, [resv.id]);
  await releaseAndPromote(c, resv.sneaker_id);
  return 'FAILED_EXPIRED';
}

/**
 * payment.succeeded.
 * Normal case (payment PENDING + reservation PAYMENT_PENDING): everything flips to PURCHASED in this one transaction.
 * Anything else (reservation already expired, payment already marked FAILED, ...): the money WAS taken, but we cannot
 * legally fulfil it, so the payment becomes REFUND_NEEDED. The sneaker is never taken back from its new holder.
 */
async function applySuccess(c: PoolClient, payment: PaymentRow): Promise<string> {
  if (payment.status === 'SUCCEEDED' || payment.status === 'REFUND_NEEDED') return 'IGNORED_TERMINAL';

  const { rows } = await c.query(
    `SELECT r.id, r.user_id, r.sneaker_id, r.status, u.purchase_count
       FROM reservations r JOIN users u ON u.id = r.user_id
      WHERE r.id = $1 FOR UPDATE OF u`,
    [payment.reservation_id],
  );
  const resv = rows[0];

  if (payment.status === 'PENDING' && resv?.status === 'PAYMENT_PENDING' && resv.purchase_count < MAX_PURCHASES_PER_USER) {
    await c.query(`UPDATE payments SET status = 'SUCCEEDED', paid_at = clock_timestamp() WHERE id = $1`, [payment.id]);
    await c.query(`UPDATE reservations SET status = 'PURCHASED', pending_deadline = NULL WHERE id = $1`, [resv.id]);
    await c.query(`UPDATE sneakers SET status = 'PURCHASED' WHERE id = $1`, [resv.sneaker_id]);
    await c.query(`INSERT INTO purchases (user_id, reservation_id, payment_id) VALUES ($1, $2, $3)`, [resv.user_id, resv.id, payment.id]);
    await c.query(`UPDATE users SET purchase_count = purchase_count + 1 WHERE id = $1`, [resv.user_id]);
    return 'PURCHASED';
  }

  await c.query(`UPDATE payments SET status = 'REFUND_NEEDED', paid_at = clock_timestamp() WHERE id = $1`, [payment.id]);
  return 'REFUND_NEEDED';
}

export interface WebhookEvent {
  eventId: string;
  eventType: string;
  paymentId: string;
  providerPaymentId?: string;
  amount?: number;
  occurredAt?: string;
  payload?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWebhookEvent(body: any): WebhookEvent {
  if (
    !body ||
    typeof body.eventId !== 'string' || !body.eventId ||
    typeof body.eventType !== 'string' || !body.eventType ||
    typeof body.paymentId !== 'string' || !UUID_RE.test(body.paymentId)
  ) {
    throw new AppError(400, 'INVALID_WEBHOOK', 'eventId, eventType and a UUID paymentId are required');
  }
  return body as WebhookEvent;
}

/** POST /payments/webhook (signature already verified by middleware). */
export async function handleWebhook(event: WebhookEvent): Promise<{ result: string }> {
  return withDropLock(async (c) => {
    // Apply any logical expiry first so we evaluate the event against the true current state.
    await expireDueReservations(c);

    const payment = await loadPayment(c, event.paymentId);
    if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Unknown paymentId');

    // Idempotency: the unique external_event_id decides whether we have seen this event.
    const occurred = event.occurredAt ? new Date(event.occurredAt) : null;
    const inserted = await c.query(
      `INSERT INTO payment_events (external_event_id, payment_id, event_type, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (external_event_id) DO NOTHING
       RETURNING id`,
      [event.eventId, payment.id, event.eventType, occurred && !isNaN(occurred.getTime()) ? occurred : null, JSON.stringify(event.payload ?? {})],
    );
    if (!inserted.rowCount) return { result: 'DUPLICATE' };

    let result: string;
    switch (event.eventType) {
      case 'payment.succeeded':
        result = await applySuccess(c, payment);
        break;
      case 'payment.failed':
        result = await applyFailure(c, payment);
        break;
      case 'payment.pending':
        // Informational. A late "pending" can never revert a terminal state.
        result = 'IGNORED_INFORMATIONAL';
        break;
      default:
        result = 'IGNORED_UNKNOWN_TYPE';
    }
    await c.query(`UPDATE payment_events SET processed_at = clock_timestamp() WHERE id = $1`, [inserted.rows[0].id]);
    return { result };
  });
}
