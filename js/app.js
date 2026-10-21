(function () {
  'use strict';

  var store = window.TodoStore.createStore(window.localStorage);
  var currentFilter = 'all';

  var form = document.getElementById('new-task-form');
  var input = document.getElementById('new-task-input');
  var list = document.getElementById('task-list');
  var emptyMessage = document.getElementById('empty-message');
  var filterButtons = document.querySelectorAll('[data-filter]');

  function renderTask(task) {
    var li = document.createElement('li');
    li.className = 'task' + (task.done ? ' task--done' : '');
    li.dataset.id = task.id;

    var label = document.createElement('label');
    label.className = 'task__label';

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task__toggle';
    checkbox.checked = task.done;

    var title = document.createElement('span');
    title.className = 'task__title';
    title.textContent = task.title;

    label.appendChild(checkbox);
    label.appendChild(title);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'task__delete';
    del.setAttribute('aria-label', 'Delete "' + task.title + '"');
    del.textContent = '×';

    li.appendChild(label);
    li.appendChild(del);
    return li;
  }

  function render() {
    var tasks = store.list(currentFilter);
    list.replaceChildren.apply(list, tasks.map(renderTask));

    var emptyText = {
      all: 'No tasks yet. Add one above.',
      active: 'Nothing left to do.',
      done: 'No completed tasks.',
    };
    emptyMessage.textContent = emptyText[currentFilter];
    emptyMessage.hidden = tasks.length > 0;

    var counts = store.counts();
    filterButtons.forEach(function (button) {
      var filter = button.dataset.filter;
      var selected = filter === currentFilter;
      button.setAttribute('aria-pressed', String(selected));
      button.querySelector('.filter__count').textContent = counts[filter];
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (store.add(input.value)) {
      input.value = '';
      render();
    }
    input.focus();
  });

  list.addEventListener('change', function (event) {
    if (!event.target.classList.contains('task__toggle')) return;
    var id = event.target.closest('.task').dataset.id;
    store.toggle(id);
    render();
  });

  list.addEventListener('click', function (event) {
    if (!event.target.classList.contains('task__delete')) return;
    var id = event.target.closest('.task').dataset.id;
    store.remove(id);
    render();
  });

  filterButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      currentFilter = button.dataset.filter;
      render();
    });
  });

  render();
})();
