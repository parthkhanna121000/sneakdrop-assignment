import fs from 'node:fs';
import path from 'node:path';
import { writePool, closePools } from './client';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export async function runMigrations(): Promise<string[]> {
  const client = await writePool.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent migrators (e.g. several test files starting together).
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    await client.query('SELECT pg_advisory_unlock(424242)');
  } finally {
    client.release();
  }
  return applied;
}

if (require.main === module) {
  runMigrations()
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date');
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exitCode = 1;
    })
    .finally(() => closePools());
}
