import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { AppError } from './utils/errors';
import { readPool } from './db/client';
import { checkInvariants } from './invariants';
import { webhookAuth } from './middleware/webhookAuth';
import type { RawBodyRequest } from './middleware/webhookAuth';
import { createUser, getUserStatus } from './modules/users/user.service';
import { getDropSummary } from './modules/inventory/inventory.service';
import { buy } from './modules/reservations/reservation.service';
import { joinQueue, leaveQueue } from './modules/queue/queue.service';
import { startPayment, handleWebhook, parseWebhookEvent } from './modules/payments/payment.service';

const ah =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

function bodyString(req: Request, key: string): string {
  const v = req.body?.[key];
  if (typeof v !== 'string' || !v) throw new AppError(400, 'INVALID_REQUEST', `${key} is required`);
  return v;
}

export const router = Router();

router.get('/health', ah(async (_req, res) => {
  await readPool.query('SELECT 1');
  res.json({ ok: true });
}));

router.post('/users', ah(async (_req, res) => {
  res.status(201).json({ userId: await createUser() });
}));

router.get('/drop', ah(async (_req, res) => {
  res.json(await getDropSummary());
}));

router.post('/buy', ah(async (req, res) => {
  res.json(await buy(bodyString(req, 'userId')));
}));

router.post('/pay', ah(async (req, res) => {
  res.status(202).json(await startPayment(bodyString(req, 'userId'), bodyString(req, 'reservationId')));
}));

router.post('/queue', ah(async (req, res) => {
  res.json(await joinQueue(bodyString(req, 'userId')));
}));

router.post('/queue/leave', ah(async (req, res) => {
  res.json(await leaveQueue(bodyString(req, 'userId')));
}));

router.get('/status/:userId', ah(async (req, res) => {
  res.json(await getUserStatus(req.params.userId));
}));

router.post('/payments/webhook', webhookAuth, ah(async (req, res) => {
  const event = parseWebhookEvent((req as RawBodyRequest).body);
  const { result } = await handleWebhook(event);
  res.status(200).json({ received: true, result });
}));

// Debug helper: lists violated invariants (empty array = healthy).
router.get('/debug/invariants', ah(async (_req, res) => {
  const violations = await checkInvariants(readPool);
  res.status(violations.length ? 500 : 200).json({ ok: violations.length === 0, violations });
}));
