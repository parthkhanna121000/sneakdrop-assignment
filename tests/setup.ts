import 'dotenv/config';

// Tests TRUNCATE tables, so they must never run against the dev database.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL (a separate database, e.g. sneaker_drop_test) before running tests');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-secret';
