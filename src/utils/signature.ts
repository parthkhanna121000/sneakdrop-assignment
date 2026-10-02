import crypto from 'node:crypto';

/** HMAC-SHA256 over `${timestampSeconds}.${rawBody}`, hex encoded. */
export function signPayload(secret: string, timestamp: string, rawBody: string | Buffer): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
