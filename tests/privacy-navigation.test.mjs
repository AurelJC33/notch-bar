import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Fins de ligne normalisées : le dépôt peut être en CRLF sous Windows (autocrlf).
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const main = read('../main.js');
const preload = read('../preload.js');
const html = read('../renderer/index.html');
const app = read('../renderer/app.js');
const css = read('../renderer/style.css');

test('weather: no plain-HTTP provider remains and the CSP no longer allows one', () => {
  assert.ok(!/http:\/\/ip-api/.test(main));
  assert.ok(!/ip-api\.com/.test(html));
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(!/connect-src[^;]*\bhttp:/.test(csp), 'connect-src must be HTTPS only');
  assert.match(csp, /connect-src https:\/\/ipapi\.co https:\/\/ipwho\.is https:\/\/api\.open-meteo\.com/);
});

test('weather: the switch defaults to on, stops every request and clears the cached location', () => {
  assert.match(main, /weatherEnabled: true,/);
  const fetchWeather = main.match(/async function fetchWeather\(\) \{[\s\S]*?\n\}/)[0];
  assert.ok((fetchWeather.match(/weatherDisabled\(\)/g) || []).length >= 3, 'checked before and after each await');
  const start = main.match(/function startWeatherLoop\(\) \{[\s\S]*?\n\}/)[0];
  assert.ok(start.indexOf('weatherDisabled()') < start.indexOf('fetchWeather()'), 'no request when disabled');
  const stop = main.match(/function stopWeatherLoop\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(stop, /clearInterval\(weatherTimer\)/);
  assert.match(stop, /geoCache = null/);
  assert.match(main, /if \('weatherEnabled' in partial\) applyWeatherSetting\(\);/);
  assert.match(main, /store\.clear\(\);\n  applyGlobalShortcut\(\);\n  applyWeatherSetting\(\);/);
});

test('weather: Settings > Privacy toggle is wired and hides the pill block', () => {
  assert.match(html, /id="s-weatherEnabled"/);
  assert.match(app, /'clipboardHistoryEnabled', 'weatherEnabled'/);
  assert.match(app, /\$\('s-weatherEnabled'\)\.checked = settings\.weatherEnabled !== false/);
  assert.match(app, /body\.dataset\.weather = settings\.weatherEnabled === false \? 'off' : 'on'/);
  assert.match(css, /body\[data-weather="off"\] \.pill-weather/);
});

test('clipboard: clearing deletes entries and files, and keeps the live clipboard from being re-added', () => {
  const source = main.match(/function clearClipboardHistory\(\) \{[\s\S]*?\n\}/)[0];
  assert.ok(!/clipboardLastFingerprint\s*=/.test(source), 'fingerprint must be kept');
  const removed = [];
  let stored = null;
  let sent = null;
  let rmArgs = null;
  const items = [{ id: 'a', imagePath: '/x/a.png' }, { id: 'b', rawFormats: [{ filePath: '/x/b.bin' }] }];
  const run = new Function(
    'getClipboardHistoryRawItems', 'removeClipboardHistoryItemFiles', 'clipboardHistoryStore',
    'fs', 'clipboardHistoryMediaDir', 'notchWin',
    source + '\nreturn clearClipboardHistory();'
  );
  const result = run(
    () => items,
    (item) => removed.push(item.id),
    { set: (key, value) => { stored = [key, value]; } },
    { rmSync: (...args) => { rmArgs = args; } },
    () => '/x',
    { isDestroyed: () => false, webContents: { send: (...args) => { sent = args; } } }
  );
  assert.deepEqual(result, []);
  assert.deepEqual(removed, ['a', 'b']);
  assert.deepEqual(stored, ['items', []]);
  assert.deepEqual(rmArgs, ['/x', { recursive: true, force: true }]);
  assert.deepEqual(sent, ['clipboard-history-updated', []]);
});

test('clipboard: IPC, preload bridge and both buttons are in place', () => {
  assert.match(main, /ipcMain\.handle\('clear-clipboard-history', \(\) => clearClipboardHistory\(\)\)/);
  assert.match(preload, /clearClipboardHistory: \(\) => ipcRenderer\.invoke\('clear-clipboard-history'\)/);
  assert.match(html, /id="clipboard-clear"/);
  assert.match(html, /id="btn-clear-clipboard"/);
  assert.match(app, /setupConfirmButton\(\$\('clipboard-clear'\)/);
  assert.match(app, /setupConfirmButton\(\$\('btn-clear-clipboard'\)/);
  assert.match(app, /clearButton\.disabled = clipboardHistory\.length === 0/);
});

test('tabs: ARIA roles, labels only on the active tab, roving tabindex', () => {
  assert.match(html, /<div class="tabs" role="tablist"/);
  const tabs = [...html.matchAll(/<button class="tab[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tabs.length, 6);
  for (const tab of tabs) {
    const page = tab.match(/data-tab="(\w+)"/)[1];
    assert.match(tab, /role="tab"/);
    assert.ok(tab.includes('id="tab-' + page + '"'), page);
    assert.ok(tab.includes('aria-controls="panel-' + page + '"'), page);
    assert.match(tab, /aria-label="[^"]+"/);
    assert.ok(html.includes('id="panel-' + page + '"'), 'panel for ' + page);
  }
  assert.equal(tabs.filter((tab) => /aria-selected="true"/.test(tab)).length, 1);
  assert.equal((html.match(/class="tab-label"/g) || []).length, 6);
  assert.match(css, /\.tab:not\(\.active\) \.tab-label\{ display:none; \}/);
  assert.match(app, /panel\.setAttribute\('role', 'tabpanel'\)/);
  assert.match(app, /t\.setAttribute\('aria-selected'/);
  assert.match(app, /t\.tabIndex = active \? 0 : -1/);
});

test('tabs: arrows, Home/End and Ctrl+1..6 are handled, but never inside a text field', () => {
  const keys = app.match(/tabListEl\.addEventListener\('keydown'[\s\S]*?\n\}\);/)[0];
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(keys.includes(key), key);
  const ctrl = app.match(/const TAB_SHORTCUT_MODES[\s\S]*?\n\}\);/)[0];
  assert.match(ctrl, /\/\^\[1-6\]\$\/\.test\(e\.key\)/);
  assert.match(ctrl, /closest\('input, textarea, select, \[contenteditable="true"\]'\)/);
  assert.ok(!ctrl.includes("'settings'"), 'inactive while Settings is open');
});

test('tabs: the current page is remembered and restored at startup', () => {
  assert.match(main, /lastTab: 'pomodoro',/);
  assert.match(app, /function rememberTab\(name\)\{[\s\S]*?pendingPatch\.lastTab = name;[\s\S]*?queueSave\(\);/);
  const select = app.match(/function selectTab\(name, updateMode = true\)\{[\s\S]*?\n\}/)[0];
  assert.ok(select.indexOf('if(!updateMode) return;') < select.indexOf('rememberTab(name)'), 'restoring does not rewrite the setting');
  assert.match(app, /const savedTab = pageDefinition\(settings\.lastTab\) \? settings\.lastTab : 'pomodoro';\n  if\(savedTab !== currentTab\) selectTab\(savedTab, false\);/);
});

test('calendar: compact by default (month/day only), Expand shows the tasks, Collapse goes back', () => {
  assert.match(app, /let calendarExpanded = false;/);
  assert.match(html, /id="calendar-expand"/);
  assert.match(html, /id="calendar-collapse"/);
  const open = app.match(/function openCurrentView\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(open, /setMode\(calendarExpanded \? 'schedule' : 'expanded'\)/);
  const select = app.match(/function selectTab\(name, updateMode = true\)\{[\s\S]*?\n\}/)[0];
  assert.match(select, /if\(name === 'schedule' && calendarExpanded\)/);
  assert.match(app, /\$\('calendar-expand'\)\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); setCalendarExpanded\(true\); \}\)/);
  assert.match(app, /\$\('calendar-collapse'\)\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); setCalendarExpanded\(false\); \}\)/);
  assert.match(css, /body\.mode-expanded \.schedule-panel\.active \.tasks-pane,/);
  assert.match(css, /body\.mode-schedule #calendar-expand\{ display:none; \}/);
  assert.match(css, /#calendar-collapse\{ display:none; \}/);
});
