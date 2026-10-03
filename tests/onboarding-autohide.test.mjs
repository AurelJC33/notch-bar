import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DEFAULT_GLOBAL_SHORTCUT, isValidAccelerator } = require('../shortcut.js');

// Fins de ligne normalisées : le dépôt peut être en CRLF sous Windows (autocrlf).
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const main = read('../main.js');
const preload = read('../preload.js');
const html = read('../renderer/index.html');
const app = read('../renderer/app.js');
const css = read('../renderer/style.css');
const planner = read('../renderer/planner.js');
const pkg = JSON.parse(read('../package.json'));

test('shortcut: default is valid and the format is strict', () => {
  assert.equal(DEFAULT_GLOBAL_SHORTCUT, 'Ctrl+Alt+N');
  for (const ok of ['Ctrl+Alt+N', 'Ctrl+Shift+Space', 'Alt+F9', 'CommandOrControl+Shift+1', 'Ctrl+Alt+Left', 'Super+Q']) {
    assert.equal(isValidAccelerator(ok), true, ok);
  }
  for (const bad of ['', 'N', 'F5', 'Space', 'Ctrl+', 'Ctrl+Alt', 'Ctrl+n', 'Ctrl+Alt+NN', 'Ctrl+Alt+F25', 'Ctrl + N', 'Ctrl+Alt+;', null, undefined, 42, 'Ctrl+' + 'A'.repeat(60)]) {
    assert.equal(isValidAccelerator(bad), false, String(bad));
  }
});

test('shortcut.js is shipped in the installer', () => {
  assert.ok(pkg.build.files.includes('shortcut.js'));
});

test('main: global shortcut lifecycle, onboarding storage and first-run detection', () => {
  assert.match(main, /globalShortcut \} = require\('electron'\)/);
  assert.match(main, /applyGlobalShortcut\(\);\s*setupUpdater\(\);/);
  assert.match(main, /unregisterGlobalShortcut\(\);\s*destroyTray\(\);/);
  assert.match(main, /'globalShortcut' in partial\) applyGlobalShortcut\(\)/);
  assert.match(main, /store\.clear\(\);\s*applyGlobalShortcut\(\);/);
  assert.match(main, /autoHide: false/);
  assert.match(main, /globalShortcutEnabled: true/);
  assert.match(main, /new Store\(\{ name: 'app-state'/);
  assert.match(main, /NOTCH_FORCE_WELCOME/);
  // l'existence du fichier de config doit être lue AVANT que le store ne l'écrive
  assert.ok(main.indexOf('configAlreadyExisted =') < main.indexOf('const store = new Store('));
  for (const channel of ['get-onboarding', 'complete-onboarding', 'set-global-shortcut', 'get-global-shortcut-status']) {
    assert.ok(main.includes("'" + channel + "'"), channel + ' handler');
    assert.ok(preload.includes("'" + channel + "'"), channel + ' preload bridge');
  }
});

test('settings: groups are ordered by how often they are used, Help is last', () => {
  const titles = [...html.matchAll(/settings-group-title">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Pomodoro', 'Appearance', 'Behavior', 'Pinned pages', 'Calendars', 'Reminders', 'Sound', 'Privacy', 'Updates', 'Help']);
  assert.match(html, /<div class="settings-group" id="settings-calendars">/);
  for (const id of ['s-autoHide', 's-globalShortcutEnabled', 'btn-shortcut-capture', 'shortcut-row', 'btn-show-welcome']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.match(app, /'collapseOnOutsideClick', 'autoHide', 'globalShortcutEnabled'/);
});

test('welcome: view, state machine and dismissal', () => {
  assert.match(html, /id="view-welcome"/);
  assert.match(html, /id="welcome-done"/);
  assert.match(css, /body\.mode-welcome #capsule\{/);
  assert.match(css, /body\.mode-welcome \.view#view-welcome\{/);
  assert.match(app, /function showWelcome\(\)/);
  assert.match(app, /function dismissWelcome\(\)/);
  assert.match(app, /if\(mode === 'welcome'\)\{ dismissWelcome\(\); return; \}/);
  assert.doesNotMatch(app.match(/OUTSIDE_COLLAPSIBLE_MODES = new Set\(\[[^\]]*\]\)/)[0], /welcome/);
  assert.match(app, /window\.api\.getOnboarding/);
});

test('calendar: empty-state banner opens Settings on the Calendars group', () => {
  assert.match(html, /id="calendar-empty"[\s\S]*id="calendar-empty-action"[\s\S]*id="calendar-stage"/);
  assert.match(planner, /function renderCalendarEmptyState\(\)/);
  assert.match(planner, /banner\.hidden = state\.calendarSources\.length > 0/);
  assert.match(app, /window\.openSettingsAt\('settings-calendars', 'calendar-settings-url'\)/);
  assert.match(app, /window\.openSettingsAt = function/);
  assert.doesNotMatch(app.match(/window\.openSettingsAt = function[\s\S]*?\n\};/)[0], /scrollIntoView/);
});

test('auto-hide: hot zone is the only interactive region while hidden, 50 ms reveal', () => {
  assert.match(html, /id="autohide-hotzone"[^>]*hidden/);
  assert.match(css, /body\[data-autohide="away"\] #capsule/);
  assert.match(css, /#autohide-hotzone\{[^}]*height:4px/);
  assert.match(app, /AUTOHIDE_REVEAL_DELAY_MS = 50;/);
  assert.match(app, /const rects = away \? \[rectForInput\(\$\('autohide-hotzone'\)\)\]/);
  assert.match(app, /body\.dataset\.autohide = 'away'/);
  assert.match(app, /autoHideEvaluate\(\);\n\}\n/);
  // masqué uniquement au repos : jamais pendant un minuteur, une vue ouverte ou une notification
  const idle = app.match(/function autoHideIdle\(\)\{[\s\S]*?\n\}/)[0];
  for (const needle of ["mode === 'pill'", 'autoHidePointerIn', "accessoryState !== 'visible'", "mediaState !== 'expanded'"]) {
    assert.ok(idle.includes(needle), needle);
  }
});

test('global shortcut: toggle command opens or collapses, capture ignores its own combination', () => {
  assert.match(app, /if\(command === 'toggle' && shortcutCapturing\) return;/);
  assert.match(app, /else if\(OUTSIDE_COLLAPSIBLE_MODES\.has\(mode\)\) collapseToCompact\(\);\n    else openCurrentView\(\);/);
  assert.match(app, /function acceleratorFromEvent\(e\)/);
  assert.match(app, /window\.api\.setGlobalShortcut\(result\)/);
});
