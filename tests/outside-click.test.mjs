import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../preload.js', import.meta.url), 'utf8');

test('main process turns window blur into a renderer event, honouring the setting and drag grace period', () => {
  assert.match(main, /collapseOnOutsideClick: true/);
  assert.match(main, /notchWin\.on\('blur'/);
  assert.match(main, /store\.get\('collapseOnOutsideClick'\) === false\) return;/);
  assert.match(main, /Date\.now\(\) < ignoreBlurUntil/);
  assert.match(main, /webContents\.send\('window-blurred'\)/);
  assert.match(main, /ignoreBlurUntil = Date\.now\(\) \+ 3000;\s*try \{\s*notchWin\.webContents\.startDrag/);
});

test('renderer collapses only open modes and never during a Shelf drag', () => {
  assert.match(preload, /onWindowBlur/);
  assert.match(app, /OUTSIDE_COLLAPSIBLE_MODES = new Set\(\['expanded', 'schedule', 'analytics', 'analytics-expanded', 'settings', 'shelf'\]\)/);
  assert.match(app, /function collapseFromOutsideClick\(\)\{\s*if\(settings\.collapseOnOutsideClick === false\) return;\s*if\(shelfDragActive\) return;/);
  assert.match(app, /setMode\(activeTool \? 'running' : 'pill'\)/);
  assert.match(app, /window\.api\.onWindowBlur\(collapseFromOutsideClick\)/);
  for (const mode of ['pill', 'hover', 'running', 'reminder']) {
    assert.doesNotMatch(app.match(/OUTSIDE_COLLAPSIBLE_MODES = new Set\(\[[^\]]*\]\)/)[0], new RegExp(`'${mode}'`));
  }
});

test('settings toggle exists and is wired', () => {
  assert.match(html, /id="s-collapseOnOutsideClick"/);
  assert.match(app, /collapseOnOutsideClick: true,/);
  assert.match(app, /'autoUpdateEnabled', 'collapseOnOutsideClick'/);
  assert.match(app, /\$\('s-collapseOnOutsideClick'\)\.checked/);
});
