'use strict';

(function (global) {
  const todos = [];
  let nextId = 1;

  function copy(todo) {
    return { id: todo.id, text: todo.text, done: todo.done };
  }

  function add(text) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) {
      throw new Error('todo text is required');
    }
    const todo = { id: nextId++, text: value, done: false };
    todos.push(todo);
    return copy(todo);
  }

  function list() {
    return todos.map(copy);
  }

  function complete(id, done) {
    const todo = todos.find((item) => item.id === id);
    if (!todo) {
      return null;
    }
    todo.done = done === undefined ? true : Boolean(done);
    return copy(todo);
  }

  const api = { add, list, complete };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.Todo = api;
  }
})(typeof globalThis === 'undefined' ? this : globalThis);
