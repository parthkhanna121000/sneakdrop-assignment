import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { AppError } from '../utils/errors';
import { signPayload, safeEqualHex } from '../utils/signature';

export type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * Runs BEFORE any database access:
 * raw body -> HMAC-SHA256 -> compare signature -> check timestamp freshness.
 */
export function webhookAuth(req: RawBodyRequest, _res: Response, next: NextFunction): void {
  const signature = req.header('x-webhook-signature');
  const timestamp = req.header('x-webhook-timestamp');
  const raw = req.rawBody;

  if (!signature || !timestamp || !raw) {
    return next(new AppError(401, 'INVALID_SIGNATURE', 'Missing signature headers or body'));
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return next(new AppError(401, 'INVALID_SIGNATURE', 'Bad timestamp'));
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - ts);
  if (ageSeconds > env.webhookToleranceSeconds) {
    return next(new AppError(401, 'STALE_TIMESTAMP', 'Webhook timestamp outside tolerance'));
  }
  const expected = signPayload(env.webhookSecret, timestamp, raw);
  if (!safeEqualHex(expected, signature)) {
    return next(new AppError(401, 'INVALID_SIGNATURE', 'Signature mismatch'));
  }
  next();
}
