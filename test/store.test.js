const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, STORAGE_KEY } = require('../js/store.js');

function memoryStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

function sequentialIds() {
  let n = 0;
  return () => 'id' + ++n;
}

test('starts empty when storage has nothing', () => {
  const store = createStore(memoryStorage());
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.counts(), { all: 0, active: 0, done: 0 });
});

test('add trims the title and returns the new task', () => {
  const store = createStore(memoryStorage(), { generateId: sequentialIds() });
  const task = store.add('  Buy milk  ');
  assert.deepEqual(task, { id: 'id1', title: 'Buy milk', done: false });
  assert.deepEqual(store.list(), [task]);
});

test('add ignores empty or whitespace-only titles', () => {
  const store = createStore(memoryStorage());
  assert.equal(store.add(''), null);
  assert.equal(store.add('   '), null);
  assert.equal(store.add(undefined), null);
  assert.equal(store.list().length, 0);
});

test('toggle flips done and back', () => {
  const store = createStore(memoryStorage(), { generateId: sequentialIds() });
  const { id } = store.add('Task');
  assert.equal(store.toggle(id).done, true);
  assert.equal(store.toggle(id).done, false);
});

test('toggle returns null for unknown id', () => {
  const store = createStore(memoryStorage());
  assert.equal(store.toggle('missing'), null);
});

test('remove deletes the task', () => {
  const store = createStore(memoryStorage(), { generateId: sequentialIds() });
  const a = store.add('A');
  const b = store.add('B');
  assert.equal(store.remove(a.id), true);
  assert.deepEqual(store.list(), [b]);
  assert.equal(store.remove(a.id), false);
});

test('list filters by all / active / done', () => {
  const store = createStore(memoryStorage(), { generateId: sequentialIds() });
  const a = store.add('A');
  const b = store.add('B');
  const c = store.add('C');
  store.toggle(b.id);

  assert.deepEqual(store.list('all').map((t) => t.id), [a.id, b.id, c.id]);
  assert.deepEqual(store.list('active').map((t) => t.id), [a.id, c.id]);
  assert.deepEqual(store.list('done').map((t) => t.id), [b.id]);
  assert.deepEqual(store.counts(), { all: 3, active: 2, done: 1 });
});

test('list rejects unknown filters', () => {
  const store = createStore(memoryStorage());
  assert.throws(() => store.list('bogus'), /Unknown filter/);
});

test('returned tasks are copies and cannot mutate the store', () => {
  const store = createStore(memoryStorage(), { generateId: sequentialIds() });
  store.add('A');
  store.list()[0].title = 'changed';
  assert.equal(store.list()[0].title, 'A');
});

test('changes persist to storage and reload in a new store', () => {
  const storage = memoryStorage();
  const first = createStore(storage, { generateId: sequentialIds() });
  const a = first.add('A');
  first.add('B');
  first.toggle(a.id);

  const second = createStore(storage);
  assert.deepEqual(second.list(), [
    { id: 'id1', title: 'A', done: true },
    { id: 'id2', title: 'B', done: false },
  ]);
  assert.ok(storage.getItem(STORAGE_KEY));
});

test('corrupt or malformed storage falls back safely', () => {
  assert.deepEqual(createStore(memoryStorage({ [STORAGE_KEY]: '{not json' })).list(), []);
  assert.deepEqual(createStore(memoryStorage({ [STORAGE_KEY]: '{"a":1}' })).list(), []);

  const mixed = JSON.stringify([
    { id: 'ok', title: 'Valid', done: false },
    { id: 1, title: 'bad id', done: false },
    null,
    'string',
  ]);
  assert.deepEqual(createStore(memoryStorage({ [STORAGE_KEY]: mixed })).list(), [
    { id: 'ok', title: 'Valid', done: false },
  ]);
});

test('keeps working in memory when storage throws', () => {
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('quota');
    },
  };
  const store = createStore(broken);
  const task = store.add('Still works');
  assert.equal(store.list().length, 1);
  assert.equal(store.toggle(task.id).done, true);
});

test('generated ids are unique', () => {
  const store = createStore(memoryStorage());
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(store.add('t' + i).id);
  assert.equal(ids.size, 100);
});
