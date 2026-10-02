import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { signPayload } from '../../src/utils/signature';

const PORT = Number(process.env.FAKE_PAYMENT_PORT ?? 4000);
const WEBHOOK_URL = process.env.BACKEND_WEBHOOK_URL ?? 'http://localhost:3000/payments/webhook';
const SECRET = process.env.WEBHOOK_SECRET ?? '';
const BASE_DELAY_MS = Number(process.env.FAKE_PAYMENT_DELAY_MS ?? 2000);
const CHAOS_DEFAULT = process.env.CHAOS === 'true';

if (!SECRET) {
  console.error('WEBHOOK_SECRET is required (must match the API server)');
  process.exit(1);
}

interface Event {
  eventId: string;
  eventType: string;
  paymentId: string;
  providerPaymentId: string;
  amount: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

async function deliver(event: Event, attempt = 1): Promise<void> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': signPayload(SECRET, timestamp, body),
      },
      body,
    });
    console.log(`[fake-pay] ${event.eventType} (${event.eventId}) -> ${res.status}`);
    if (res.status >= 500 && attempt < 5) setTimeout(() => void deliver(event, attempt + 1), 1000 * attempt);
  } catch (err) {
    console.log(`[fake-pay] delivery error: ${(err as Error).message}`);
    if (attempt < 5) setTimeout(() => void deliver(event, attempt + 1), 1000 * attempt);
  }
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

/**
 * POST /fake-pay
 * { merchantPaymentId, amount, outcome?: "succeeded" | "failed", chaos?: boolean }
 * Responds 202 immediately, then sends signed webhooks asynchronously.
 *
 * Normal mode: payment.pending (fast), then payment.succeeded / payment.failed after ~2s.
 * Chaos mode : final event delayed 0-4s extra, delivered 1-3 times, and payment.pending
 *              sometimes arrives AFTER the final event (out of order).
 */
app.post('/fake-pay', (req, res) => {
  const { merchantPaymentId, amount } = req.body ?? {};
  if (typeof merchantPaymentId !== 'string' || typeof amount !== 'number') {
    res.status(400).json({ error: 'merchantPaymentId (string) and amount (number) are required' });
    return;
  }
  const outcome: 'succeeded' | 'failed' =
    req.body.outcome === 'failed' || req.body.outcome === 'succeeded'
      ? req.body.outcome
      : Math.random() < Number(process.env.FAKE_PAYMENT_FAIL_RATE ?? 0)
        ? 'failed'
        : 'succeeded';
  const chaos: boolean = typeof req.body.chaos === 'boolean' ? req.body.chaos : CHAOS_DEFAULT;

  const providerPaymentId = `prov_${randomUUID()}`;
  const make = (type: string): Event => ({
    eventId: `evt_${providerPaymentId}_${type}`,
    eventType: `payment.${type}`,
    paymentId: merchantPaymentId,
    providerPaymentId,
    amount,
    occurredAt: new Date().toISOString(),
    payload: { chaos },
  });

  const pending = make('pending');
  const final = make(outcome);

  if (!chaos) {
    setTimeout(() => void deliver(pending), 200);
    setTimeout(() => void deliver(final), BASE_DELAY_MS);
  } else {
    const finalDelay = BASE_DELAY_MS + Math.random() * 4000;
    const copies = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < copies; i++) {
      setTimeout(() => void deliver(final), finalDelay + i * Math.random() * 1500);
    }
    const pendingDelay = Math.random() < 0.5 ? 200 : finalDelay + 500; // 50%: pending arrives after the final event
    setTimeout(() => void deliver(pending), pendingDelay);
  }

  res.status(202).json({ providerPaymentId, outcome, chaos });
});

app.listen(PORT, () => {
  console.log(`Fake payment provider on http://localhost:${PORT} -> webhooks to ${WEBHOOK_URL} (chaos default: ${CHAOS_DEFAULT})`);
});
