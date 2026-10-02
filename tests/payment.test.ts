import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools, readPool } from '../src/db/client';
import { runExpiryTick } from '../src/jobs/expiryWorker';
import { env } from '../src/config/env';
import {
  api, createUsers, expectInvariantsHold, resetDb, sendWebhook, setupDb, sleep,
  startServer, startStubProvider, webhookEvent,
} from './helpers';

let base: string;
let close: () => Promise<void>;
let closeProvider: () => Promise<void>;

beforeAll(async () => {
  await setupDb();
  ({ base, close } = await startServer());
  ({ close: closeProvider } = await startStubProvider());
});
afterAll(async () => {
  await close();
  await closeProvider();
  await closePools();
});
beforeEach(resetDb);

async function buyAndPay(userId: string) {
  const held = await api(base, 'POST', '/buy', { userId });
  expect(held.json.status).toBe('HELD');
  const pay = await api(base, 'POST', '/pay', { userId, reservationId: held.json.reservationId });
  expect(pay.status).toBe(202);
  return pay.json.paymentId as string;
}

describe('payments + webhooks', () => {
  it('rejects webhooks with a bad signature', async () => {
    const r = await sendWebhook(base, webhookEvent('e1', 'payment.succeeded', '00000000-0000-0000-0000-000000000000'), { badSignature: true });
    expect(r.status).toBe(401);
  });

  it('happy path: succeeded webhook -> PURCHASED', async () => {
    const [u] = await createUsers(1);
    const paymentId = await buyAndPay(u);
    const w = await sendWebhook(base, webhookEvent('e1', 'payment.succeeded', paymentId));
    expect(w.status).toBe(200);
    const s = (await api(base, 'GET', `/status/${u}`)).json;
    expect(s).toMatchObject({ status: 'PURCHASED', purchaseCount: 1 });
    await expectInvariantsHold();
  });

  it('same event delivered 10 times concurrently -> exactly one purchase', async () => {
    const [u] = await createUsers(1);
    const paymentId = await buyAndPay(u);
    const rs = await Promise.all(Array.from({ length: 10 }, () => sendWebhook(base, webhookEvent('dup', 'payment.succeeded', paymentId))));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.json.result === 'PURCHASED')).toHaveLength(1);
    expect(rs.filter((r) => r.json.result === 'DUPLICATE')).toHaveLength(9);
    const { rows } = await readPool.query('SELECT COUNT(*)::int AS n FROM purchases');
    expect(rows[0].n).toBe(1);
    await expectInvariantsHold();
  });

  it('out of order: late payment.pending never reverts SUCCEEDED', async () => {
    const [u] = await createUsers(1);
    const paymentId = await buyAndPay(u);
    await sendWebhook(base, webhookEvent('e-ok', 'payment.succeeded', paymentId));
    const late = await sendWebhook(base, webhookEvent('e-pending', 'payment.pending', paymentId));
    expect(late.status).toBe(200);
    const { rows } = await readPool.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    expect(rows[0].status).toBe('SUCCEEDED');
    await expectInvariantsHold();
  });

  it('failed payment returns the user to HELD and they can retry', async () => {
    const [u] = await createUsers(1);
    const paymentId = await buyAndPay(u);
    await sendWebhook(base, webhookEvent('e-fail', 'payment.failed', paymentId));
    expect((await api(base, 'GET', `/status/${u}`)).json.status).toBe('HELD');
    const resv = (await api(base, 'GET', `/status/${u}`)).json.reservation.id;
    expect((await api(base, 'POST', '/pay', { userId: u, reservationId: resv })).status).toBe(202);
    await expectInvariantsHold();
  });

  it('late success after the payment window -> REFUND_NEEDED, sneaker goes to the queue, not taken back', async () => {
    env.pendingSeconds = 1;
    const users = await createUsers(21);
    const paymentId = await buyAndPay(users[0]);
    for (const u of users.slice(1)) await api(base, 'POST', '/buy', { userId: u }); // 19 holds + user 21 waits
    expect((await api(base, 'GET', `/status/${users[20]}`)).json.status).toBe('WAITING');

    await sleep(1300);
    await runExpiryTick(); // pending window over -> reservation EXPIRED, sneaker promoted to user 21
    expect((await api(base, 'GET', `/status/${users[20]}`)).json.status).toBe('HELD');

    const w = await sendWebhook(base, webhookEvent('e-late', 'payment.succeeded', paymentId));
    expect(w.json.result).toBe('REFUND_NEEDED');
    expect((await api(base, 'GET', `/status/${users[0]}`)).json.status).toBe('REFUND_NEEDED');
    expect((await api(base, 'GET', `/status/${users[20]}`)).json.status).toBe('HELD'); // still theirs
    const { rows } = await readPool.query('SELECT COUNT(*)::int AS n FROM purchases');
    expect(rows[0].n).toBe(0);
    await expectInvariantsHold();
  });

  it('a user can buy at most 2 pairs', async () => {
    const [u] = await createUsers(1);
    for (let i = 0; i < 2; i++) {
      const paymentId = await buyAndPay(u);
      await sendWebhook(base, webhookEvent(`ok-${i}`, 'payment.succeeded', paymentId));
    }
    const third = await api(base, 'POST', '/buy', { userId: u });
    expect(third.status).toBe(409);
    expect(third.json.error.code).toBe('PURCHASE_LIMIT_REACHED');
    await expectInvariantsHold();
  });

  it('cannot pay for someone else\'s reservation', async () => {
    const [a, b] = await createUsers(2);
    const held = await api(base, 'POST', '/buy', { userId: a });
    const r = await api(base, 'POST', '/pay', { userId: b, reservationId: held.json.reservationId });
    expect(r.status).toBe(404);
  });
});
