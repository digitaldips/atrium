/* Tests for the write-through sync flow: debounced scheduling, the offline
   fallback (failing client must flip S.ui.offline, not crash), and happy path. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDebouncedSync, pushDocUpdate } from '../src/core/workspace-api.js';

function fakeClient({ upsertErr = null } = {}) {
  const upserts = [];
  return {
    upserts,
    from() {
      return {
        upsert(payload, opts) {
          upserts.push({ payload, opts });
          return {
            select() {
              return {
                single: async () => (upsertErr ? { data: null, error: upsertErr } : { data: { ...payload, id: 'w1' }, error: null }),
              };
            },
          };
        },
      };
    },
  };
}

const mkS = () => ({
  data: { tasks: [{ id: 't1', title: 'Write tests' }], me: 'm1' },
  prefs: { theme: 'system' },
  views: {},
  ui: { offline: false },
});

test('makeDebouncedSync coalesces a burst of saves into a single trailing call', () => {
  const mock = test.mock;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let calls = 0;
    const seen = [];
    const sync = makeDebouncedSync((...args) => {
      calls++;
      seen.push(args);
    }, 500);
    sync.schedule('first');
    mock.timers.tick(200);
    sync.schedule('second');
    mock.timers.tick(200);
    assert.equal(calls, 0, 'nothing fires while saves keep arriving inside the window');
    sync.schedule('third');
    mock.timers.tick(500);
    assert.equal(calls, 1);
    assert.deepEqual(seen[0], ['third'], 'only the latest payload is synced');
  } finally {
    mock.timers.reset();
  }
});

test('makeDebouncedSync flush forces a pending call immediately', async () => {
  let calls = 0;
  const sync = makeDebouncedSync(() => calls++, 500);
  sync.schedule();
  await sync.flush();
  assert.equal(calls, 1);
  await sync.flush();
  assert.equal(calls, 1, 'flush with nothing pending is a no-op');
  sync.cancel();
});

test('pushDocUpdate with a working client upserts the whole doc and stays online', async () => {
  const client = fakeClient();
  const S = mkS();
  const ok = await pushDocUpdate(client, 'user-1', S, 'Atrium');
  assert.equal(ok, true);
  assert.equal(S.ui.offline, false);
  assert.equal(client.upserts.length, 1);
  assert.deepEqual(client.upserts[0].opts, { onConflict: 'owner_id' });
  assert.deepEqual(client.upserts[0].payload.data.data, S.data);
});

test('pushDocUpdate offline fallback: a failing client flips S.ui.offline instead of throwing', async () => {
  const client = fakeClient({ upsertErr: { message: 'Failed to fetch' } });
  const S = mkS();
  const ok = await pushDocUpdate(client, 'user-1', S);
  assert.equal(ok, false, 'sync reports failure without throwing');
  assert.equal(S.ui.offline, true, 'the offline flag is set so the UI can say so');
});

test('pushDocUpdate recovery: a later successful sync clears the offline flag', async () => {
  const S = mkS();
  const failing = fakeClient({ upsertErr: { message: 'Failed to fetch' } });
  await pushDocUpdate(failing, 'user-1', S);
  assert.equal(S.ui.offline, true);
  const working = fakeClient();
  await pushDocUpdate(working, 'user-1', S);
  assert.equal(S.ui.offline, false);
});

test('pushDocUpdate no-ops without a client or user id (prototype/local-only mode)', async () => {
  const client = fakeClient();
  const S = mkS();
  assert.equal(await pushDocUpdate(null, 'user-1', S), false);
  assert.equal(await pushDocUpdate(client, null, S), false);
  assert.equal(client.upserts.length, 0, 'nothing hits the network');
  assert.equal(S.ui.offline, false, 'local-only mode is not an offline failure');
});
