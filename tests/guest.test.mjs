import test from 'node:test';
import assert from 'node:assert/strict';
import { GuestStore, GUEST_KEY } from '../src/planner/guest.ts';

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function fixture() {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    locks: { request: async (_name, work) => work() },
  } });
  return { store: new GuestStore(storage), storage };
}

test('guest tasks persist without any account or network', async () => {
  const { store, storage } = fixture();
  const day = store.dashboard().today;
  await store.mutate('create_task', { outcome: 'First task', day, estimatedMinutes: 30 }, timezone);
  assert.equal(new GuestStore(storage).dashboard().todayTasks[0].outcome, 'First task');
  assert.ok(storage.getItem(GUEST_KEY));
});

test('guest mutations read one journal and never persist an already-replayed base', async () => {
  const { store, storage } = fixture();
  const day = store.dashboard().today;
  const read = storage.getItem;
  let reads = 0;
  storage.getItem = (key) => { reads++; return read(key); };
  const task = await store.mutate('create_task', { outcome: 'Original', day, estimatedMinutes: 30 }, timezone);
  assert.equal(reads, 1);
  await store.mutate('rename_task', { id: task.id, outcome: 'Renamed' }, timezone);
  assert.equal(reads, 2);
  const saved = JSON.parse(storage.getItem(GUEST_KEY));
  assert.equal(saved.base.todayTasks.length, 0);
  assert.equal(saved.commands.length, 2);
  const restored = new GuestStore(storage).dashboard();
  assert.equal(restored.todayTasks.length, 1);
  assert.equal(restored.todayTasks[0].outcome, 'Renamed');
  assert.equal(restored.revision, 2);
});

test('local save failure is not reported as success', async () => {
  const { store, storage } = fixture();
  storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(store.mutate('create_task', {
    outcome: 'Task', day: store.dashboard().today, estimatedMinutes: 30,
  }, timezone), /quota/);
  assert.equal(store.dashboard().todayTasks.length, 0);
});

test('guest transfer retains data on failure, binds account, and retries the same payload', async () => {
  const { store, storage } = fixture();
  const task = await store.mutate('create_task', {
    outcome: 'Keep me', day: store.dashboard().today, estimatedMinutes: 30,
  }, timezone);
  await store.mutate('start_task', { id: task.id }, timezone);
  await store.mutate('stop_timer', { id: task.id }, timezone);
  await store.mutate('save_pause_reason', { id: task.id, reason: 'A call' }, timezone);
  await store.mutate('complete_task', { id: task.id }, timezone);
  let original;
  await assert.rejects(store.transfer('account-a', async (payload) => {
    original = payload;
    throw new Error('offline');
  }), /offline/);
  assert.ok(storage.getItem(GUEST_KEY));
  assert.equal(original.tasks[0].status, 'completed');
  assert.equal(original.stops[0].reason, 'A call');
  await assert.rejects(store.transfer('account-b', async () => ({ imported: true })), /different account/);
  await assert.rejects(store.mutate('rename_task', { id: task.id, outcome: 'Changed' }, timezone), /Finish Save & sync/);
  await store.transfer('account-a', async (payload) => {
    assert.deepEqual(payload, original);
    return { imported: true };
  });
  assert.equal(storage.getItem(GUEST_KEY), null);
});

test('survey answers ride along with a guest import and stay frozen for retries', async () => {
  const { store, storage } = fixture();
  await store.mutate('create_task', { outcome: 'Plan task', day: store.dashboard().today, estimatedMinutes: 60 }, timezone);
  const survey = { goal: 'ship', focusMinutes: 60, weekGoal: 'Launch', weekStart: '2026-11-02' };
  let first;
  await assert.rejects(store.transfer('account-a', async (payload) => {
    first = payload;
    throw new Error('offline');
  }, survey), /offline/);
  assert.deepEqual(first.survey, survey);
  // Answers changed after the first attempt cannot alter the import identity's payload.
  assert.equal(await store.transfer('account-a', async (payload) => {
    assert.deepEqual(payload, first);
    return { imported: true };
  }, { goal: 'study' }), true);
  assert.equal(storage.getItem(GUEST_KEY), null);
});

test('an import without answers reports none, and an empty journal sends nothing', async () => {
  const { store } = fixture();
  let sent = 0;
  assert.equal(await store.transfer('account-a', async () => { sent++; return { imported: true }; }, { goal: 'ship' }), false);
  assert.equal(sent, 0);
  await store.mutate('create_task', { outcome: 'Task', day: store.dashboard().today, estimatedMinutes: 30 }, timezone);
  assert.equal(await store.transfer('account-a', async (payload) => {
    assert.equal('survey' in payload, false);
    return { imported: true };
  }), false);
});

test('guest limits are enforced before saving', async () => {
  const { store } = fixture();
  const args = { outcome: 'Task', day: store.dashboard().today, estimatedMinutes: 30 };
  for (let i = 0; i < 3; i++) await store.mutate('create_task', args, timezone);
  await assert.rejects(store.mutate('create_task', args, timezone), /3 tasks/);
});
