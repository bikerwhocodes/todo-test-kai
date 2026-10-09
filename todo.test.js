'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshTodo() {
  const modulePath = require.resolve('./todo.js');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('add stores a todo and returns it', () => {
  const todo = freshTodo();
  const added = todo.add('buy milk');

  assert.equal(added.text, 'buy milk');
  assert.equal(added.done, false);
  assert.ok(added.id);
  assert.deepEqual(todo.list(), [added]);
});

test('add trims surrounding whitespace', () => {
  const todo = freshTodo();

  assert.equal(todo.add('  walk the dog  ').text, 'walk the dog');
});

test('add rejects empty or non-string text', () => {
  const todo = freshTodo();

  assert.throws(() => todo.add('   '), /text is required/);
  assert.throws(() => todo.add(''), /text is required/);
  assert.throws(() => todo.add(undefined), /text is required/);
  assert.deepEqual(todo.list(), []);
});

test('add gives every todo a distinct id', () => {
  const todo = freshTodo();
  const first = todo.add('one');
  const second = todo.add('two');

  assert.notEqual(first.id, second.id);
  assert.deepEqual(todo.list().map((item) => item.text), ['one', 'two']);
});

test('list starts empty and does not expose internal state', () => {
  const todo = freshTodo();
  assert.deepEqual(todo.list(), []);

  todo.add('keep me');
  const listed = todo.list();
  listed.pop();
  listed.length = 0;

  assert.equal(todo.list().length, 1);

  todo.list()[0].text = 'tampered';
  assert.equal(todo.list()[0].text, 'keep me');
});

test('complete marks a todo as done', () => {
  const todo = freshTodo();
  const added = todo.add('write tests');

  const completed = todo.complete(added.id);

  assert.equal(completed.done, true);
  assert.equal(todo.list()[0].done, true);
});

test('complete(id, false) clears the done flag so the UI can toggle', () => {
  const todo = freshTodo();
  const added = todo.add('toggle me');

  todo.complete(added.id);
  const reopened = todo.complete(added.id, false);

  assert.equal(reopened.done, false);
  assert.equal(todo.list()[0].done, false);
});

test('complete leaves other todos untouched', () => {
  const todo = freshTodo();
  const first = todo.add('first');
  todo.add('second');

  todo.complete(first.id);

  assert.deepEqual(todo.list().map((item) => item.done), [true, false]);
});

test('complete returns null for an unknown id', () => {
  const todo = freshTodo();
  todo.add('only');

  assert.equal(todo.complete(999), null);
  assert.equal(todo.list()[0].done, false);
});
