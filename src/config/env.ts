import dotenv from 'dotenv';

dotenv.config();

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${key} must be a number`);
  return n;
}

function str(key: string, fallback?: string): string {
  const raw = process.env[key];
  if (raw !== undefined && raw !== '') return raw;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${key}. Did you create .env from .env.example?`);
}

// Plain mutable object on purpose: tests shrink the hold/pending windows at runtime.
export const env = {
  port: num('PORT', 3000),
  databaseUrl: str('DATABASE_URL'),
  holdSeconds: num('HOLD_SECONDS', 300),
  pendingSeconds: num('PENDING_SECONDS', 120),
  paymentAmount: num('PAYMENT_AMOUNT', 49900),
  fakePaymentUrl: str('FAKE_PAYMENT_URL', 'http://localhost:4000'),
  webhookSecret: str('WEBHOOK_SECRET'),
  webhookToleranceSeconds: num('WEBHOOK_TOLERANCE_SECONDS', 300),
  workerIntervalMs: num('WORKER_INTERVAL_MS', 1000),
  writePoolMax: num('WRITE_POOL_MAX', 20),
  readPoolMax: num('READ_POOL_MAX', 10),
};

export const TOTAL_SNEAKERS = 20;
export const MAX_PURCHASES_PER_USER = 2;
