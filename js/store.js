// Task storage backed by a Storage-like object (localStorage in the browser).
// Works as a classic browser script (exposes window.TodoStore) and as a
// CommonJS module (for `node --test`).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TodoStore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_KEY = 'todo-app.tasks';
  var FILTERS = ['all', 'active', 'done'];

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function isValidTask(task) {
    return (
      task !== null &&
      typeof task === 'object' &&
      typeof task.id === 'string' &&
      typeof task.title === 'string' &&
      typeof task.done === 'boolean'
    );
  }

  function createStore(storage, options) {
    var key = (options && options.key) || STORAGE_KEY;
    var makeId = (options && options.generateId) || generateId;
    var tasks = load();

    function load() {
      var raw;
      try {
        raw = storage.getItem(key);
      } catch (e) {
        return [];
      }
      if (!raw) return [];
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isValidTask) : [];
      } catch (e) {
        return [];
      }
    }

    function save() {
      try {
        storage.setItem(key, JSON.stringify(tasks));
      } catch (e) {
        // Storage full or unavailable; keep working in memory.
      }
    }

    function copy(task) {
      return { id: task.id, title: task.title, done: task.done };
    }

    function find(id) {
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].id === id) return tasks[i];
      }
      return null;
    }

    return {
      list: function (filter) {
        filter = filter || 'all';
        if (FILTERS.indexOf(filter) === -1) {
          throw new Error('Unknown filter: ' + filter);
        }
        return tasks
          .filter(function (t) {
            if (filter === 'active') return !t.done;
            if (filter === 'done') return t.done;
            return true;
          })
          .map(copy);
      },

      add: function (title) {
        var trimmed = typeof title === 'string' ? title.trim() : '';
        if (!trimmed) return null;
        var task = { id: makeId(), title: trimmed, done: false };
        tasks.push(task);
        save();
        return copy(task);
      },

      toggle: function (id) {
        var task = find(id);
        if (!task) return null;
        task.done = !task.done;
        save();
        return copy(task);
      },

      remove: function (id) {
        var before = tasks.length;
        tasks = tasks.filter(function (t) {
          return t.id !== id;
        });
        if (tasks.length === before) return false;
        save();
        return true;
      },

      counts: function () {
        var done = tasks.filter(function (t) {
          return t.done;
        }).length;
        return { all: tasks.length, active: tasks.length - done, done: done };
      },
    };
  }

  return { createStore: createStore, STORAGE_KEY: STORAGE_KEY, FILTERS: FILTERS };
});
