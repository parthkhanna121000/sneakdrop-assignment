import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { expect } from 'vitest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { readPool, writePool } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { checkInvariants } from '../src/invariants';
import { signPayload } from '../src/utils/signature';

export async function setupDb() {
  await runMigrations();
}

export async function resetDb() {
  await writePool.query(
    `TRUNCATE payment_events, purchases, payments, queue_entries, reservations, sneakers, users RESTART IDENTITY CASCADE`,
  );
  await writePool.query(`INSERT INTO sneakers (status) SELECT 'AVAILABLE' FROM generate_series(1, 20)`);
  env.holdSeconds = 300;
  env.pendingSeconds = 120;
}

export async function createUsers(n: number): Promise<string[]> {
  const { rows } = await writePool.query(`INSERT INTO users SELECT FROM generate_series(1, $1) RETURNING id`, [n]);
  return rows.map((r) => r.id as string);
}

export async function startServer() {
  const server = http.createServer(createApp());
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Stand-in for the fake payment provider: accepts /fake-pay and does nothing (tests send webhooks themselves). */
export async function startStubProvider() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ providerPaymentId: 'prov_stub' }));
    });
  });
  server.listen(0);
  await once(server, 'listening');
  env.fakePaymentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function api(base: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

export async function sendWebhook(base: string, event: Record<string, unknown>, opts: { badSignature?: boolean } = {}) {
  const body = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${base}/payments/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': ts,
      'x-webhook-signature': opts.badSignature ? 'deadbeef' : signPayload(env.webhookSecret, ts, body),
    },
    body,
  });
  return { status: res.status, json: (await res.json()) as any };
}

export const webhookEvent = (eventId: string, type: string, paymentId: string) => ({
  eventId,
  eventType: type,
  paymentId,
  providerPaymentId: 'prov_x',
  amount: env.paymentAmount,
  occurredAt: new Date().toISOString(),
  payload: {},
});

export async function expectInvariantsHold() {
  expect(await checkInvariants(readPool)).toEqual([]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
