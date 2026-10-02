import { env } from './config/env';
import { createApp } from './app';
import { runMigrations } from './db/migrate';
import { closePools } from './db/client';
import { startExpiryWorker } from './jobs/expiryWorker';

async function main() {
  const applied = await runMigrations();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`Sneaker Drop API listening on http://localhost:${env.port}`);
  });
  const stopWorker = startExpiryWorker();

  const shutdown = () => {
    console.log('Shutting down...');
    stopWorker();
    server.close(async () => {
      await closePools();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
