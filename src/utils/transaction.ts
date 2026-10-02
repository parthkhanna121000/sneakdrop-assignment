import type { PoolClient } from 'pg';
import { writePool } from '../db/client';

export const DROP_LOCK_ID = 1;

/**
 * Every state-changing operation goes through here.
 *
 *   BEGIN -> SET LOCAL lock_timeout -> pg_advisory_xact_lock(1) -> callback -> COMMIT
 *
 * The advisory lock serializes ALL mutations of the drop, so the callback always
 * sees a consistent, up-to-date view. The lock is released automatically at
 * COMMIT/ROLLBACK. If it cannot be obtained within 5s, Postgres raises 55P03,
 * which the error handler maps to HTTP 503.
 *
 * Never call external services inside the callback.
 */
export async function withDropLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await writePool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SELECT pg_advisory_xact_lock(${DROP_LOCK_ID})`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken */
    }
    throw err;
  } finally {
    client.release();
  }
}
