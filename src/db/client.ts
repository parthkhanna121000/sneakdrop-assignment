import { Pool } from 'pg';
import { env } from '../config/env';

// Two pools so that cheap reads (GET /drop, GET /status) are never stuck
// behind a pile of write transactions waiting for the drop lock.
export const writePool = new Pool({
  connectionString: env.databaseUrl,
  max: env.writePoolMax,
  connectionTimeoutMillis: 30_000,
});

export const readPool = new Pool({
  connectionString: env.databaseUrl,
  max: env.readPoolMax,
  connectionTimeoutMillis: 30_000,
});

writePool.on('error', (err) => console.error('[writePool] idle client error', err.message));
readPool.on('error', (err) => console.error('[readPool] idle client error', err.message));

export async function closePools(): Promise<void> {
  await Promise.all([writePool.end(), readPool.end()]);
}
