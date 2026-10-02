import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePools } from '../src/db/client';
import { runExpiryTick } from '../src/jobs/expiryWorker';
import { env } from '../src/config/env';
import { api, createUsers, expectInvariantsHold, resetDb, setupDb, sleep, startServer } from './helpers';

let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  await setupDb();
  ({ base, close } = await startServer());
});
afterAll(async () => {
  await close();
  await closePools();
});
beforeEach(resetDb);

describe('buy + queue', () => {
  it('20 users get holds, the 21st and 22nd wait in FIFO order', async () => {
    const users = await createUsers(22);
    const results = [];
    for (const u of users) results.push(await api(base, 'POST', '/buy', { userId: u }));
    expect(results.slice(0, 20).every((r) => r.json.status === 'HELD')).toBe(true);
    expect(results[20].json).toEqual({ status: 'WAITING', queuePosition: 1 });
    expect(results[21].json).toEqual({ status: 'WAITING', queuePosition: 2 });
    expect((await api(base, 'GET', '/drop')).json.pairsLeft).toBe(0);
    await expectInvariantsHold();
  });

  it('1000 concurrent buyers: exactly 20 holds, 980 waiting, never oversold', async () => {
    const users = await createUsers(1000);
    const results = await Promise.all(users.map((u) => api(base, 'POST', '/buy', { userId: u })));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.json.status === 'HELD')).toHaveLength(20);
    const waiting = results.filter((r) => r.json.status === 'WAITING');
    expect(waiting).toHaveLength(980);
    // every queue position 1..980 handed out exactly once
    expect(new Set(waiting.map((r) => r.json.queuePosition)).size).toBe(980);

    const drop = (await api(base, 'GET', '/drop')).json;
    expect(drop).toMatchObject({ pairsLeft: 0, held: 20, purchased: 0, waitingCount: 980 });
    await expectInvariantsHold();
  });

  it('same user double-clicking 100 times still has exactly one hold', async () => {
    const [u] = await createUsers(1);
    const results = await Promise.all(Array.from({ length: 100 }, () => api(base, 'POST', '/buy', { userId: u })));
    expect(new Set(results.map((r) => r.json.reservationId)).size).toBe(1);
    expect((await api(base, 'GET', '/drop')).json).toMatchObject({ pairsLeft: 19, held: 1 });
    await expectInvariantsHold();
  });

  it('expired hold is promoted to the first person in line', async () => {
    env.holdSeconds = 1;
    const users = await createUsers(22);
    for (const u of users) await api(base, 'POST', '/buy', { userId: u });
    // user 21 (index 20) is #1, user 22 is #2. Everyone's hold expires after 1s.
    await sleep(1300);
    await runExpiryTick();

    // 20 holds expired -> the 2 waiting users got 2 of them; the other 18 sneakers are AVAILABLE
    const s21 = (await api(base, 'GET', `/status/${users[20]}`)).json;
    const s22 = (await api(base, 'GET', `/status/${users[21]}`)).json;
    expect(s21.status).toBe('HELD');
    expect(s22.status).toBe('HELD');
    expect((await api(base, 'GET', '/drop')).json).toMatchObject({ pairsLeft: 18, held: 2, waitingCount: 0 });
    await expectInvariantsHold();
  });

  it('a waiting user cannot jump the line with /buy', async () => {
    const users = await createUsers(22);
    for (const u of users) await api(base, 'POST', '/buy', { userId: u });
    const again = await api(base, 'POST', '/buy', { userId: users[21] });
    expect(again.json).toEqual({ status: 'WAITING', queuePosition: 2 });
  });

  it('queue/leave removes the user and positions shift', async () => {
    const users = await createUsers(23);
    for (const u of users) await api(base, 'POST', '/buy', { userId: u });
    expect((await api(base, 'POST', '/queue/leave', { userId: users[20] })).json.status).toBe('CANCELLED');
    expect((await api(base, 'GET', `/status/${users[21]}`)).json.queuePosition).toBe(1);
    expect((await api(base, 'GET', `/status/${users[22]}`)).json.queuePosition).toBe(2);
  });
});
