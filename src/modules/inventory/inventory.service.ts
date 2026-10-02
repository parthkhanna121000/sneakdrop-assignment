import { readPool } from '../../db/client';

export async function getDropSummary() {
  const { rows } = await readPool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'AVAILABLE') AS available,
       COUNT(*) FILTER (WHERE status = 'HELD') AS held,
       COUNT(*) FILTER (WHERE status = 'PURCHASED') AS purchased,
       (SELECT COUNT(*) FROM queue_entries WHERE status = 'WAITING') AS waiting
     FROM sneakers`,
  );
  const r = rows[0];
  return {
    pairsLeft: Number(r.available),
    held: Number(r.held),
    purchased: Number(r.purchased),
    waitingCount: Number(r.waiting),
  };
}
