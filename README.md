# todo-test-kai

A small todo app in plain HTML, CSS and JavaScript — no build step, no dependencies.

Add tasks, mark them done, delete them, and filter by All / Active / Done. Tasks are saved in your browser's `localStorage`, so they survive page reloads.

## How to open it

Open `index.html` directly in a browser — double-click it, or from a terminal:

```sh
open index.html        # macOS
xdg-open index.html    # Linux
start index.html       # Windows
```

If you'd rather serve it over HTTP (e.g. to keep `localStorage` separate from other local files), any static server works:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Running the tests

The storage logic in `js/store.js` is tested with Node's built-in test runner (Node 18+):

```sh
node --test
```

## Project layout

```
index.html          markup
css/styles.css      styles
js/store.js         task storage (localStorage-backed, also loadable in Node)
js/app.js           DOM rendering and event handling
test/store.test.js  tests for js/store.js
```
