import { env } from '../config/env';
import { withDropLock } from '../utils/transaction';
import { expireDueReservations, reconcileQueue } from '../modules/reservations/reservation.service';

/** One cleanup pass: expire due reservations (promoting the queue) and self-heal. */
export async function runExpiryTick() {
  return withDropLock(async (c) => {
    const expired = await expireDueReservations(c);
    const promoted = await reconcileQueue(c);
    return { expired, promoted };
  });
}

/**
 * The worker is NOT the source of truth: /buy, /pay and the webhook all evaluate expiry themselves
 * against the DB clock. The worker just guarantees queue promotion happens even if nobody calls the API.
 */
export function startExpiryWorker(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const loop = async () => {
    try {
      const { expired, promoted } = await runExpiryTick();
      if (expired || promoted) console.log(`[worker] expired=${expired} promoted=${promoted}`);
    } catch (err) {
      console.error('[worker] tick failed:', (err as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(loop, env.workerIntervalMs);
    }
  };
  void loop();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
