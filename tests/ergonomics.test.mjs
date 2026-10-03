import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import DurationInput from '../renderer/duration-input.js';

// Fins de ligne normalisées : le dépôt peut être en CRLF sous Windows (autocrlf).
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('../renderer/index.html');
const app = read('../renderer/app.js');
const css = read('../renderer/style.css');
const { parseDuration, MAX_SECONDS } = DurationInput;

test('parseDuration: minutes, seconds, m:s and h:m:s forms', () => {
  assert.equal(parseDuration('45'), 45 * 60);
  assert.equal(parseDuration(' 45 min '), 45 * 60);
  assert.equal(parseDuration('5m'), 300);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('90 sec'), 90);
  assert.equal(parseDuration('5:30'), 330);
  assert.equal(parseDuration('0:45'), 45);
  assert.equal(parseDuration('1:30:00'), 5400);
  assert.equal(parseDuration('3:00:00'), MAX_SECONDS);
  assert.equal(parseDuration('180'), MAX_SECONDS);
});

test('parseDuration: rejects empty, zero, malformed and out-of-range input', () => {
  for (const bad of ['', '   ', '0', '0:00', '00:00', 'abc', '-5', '5.5', '5:75', '5:60', '1:75:00', '1:30:75', '181', '3:00:01', '99999', '5 minutes!', null, undefined]) {
    assert.equal(parseDuration(bad), null, 'should reject ' + JSON.stringify(bad));
  }
  assert.equal(parseDuration('10', { maxSeconds: 300 }), null);
  assert.equal(parseDuration('5', { maxSeconds: 300 }), 300);
});

test('collapse button uses a chevron, not a close cross', () => {
  assert.match(html, /id="btn-collapse"[^>]*>\s*<span class="icon" data-icon="chevron-up">/);
  assert.doesNotMatch(html, /id="btn-collapse"[^>]*>\s*<span class="icon" data-icon="close">/);
  assert.match(app, /function collapseToCompact\(\)\{/);
  assert.match(app, /\$\('btn-collapse'\)\.addEventListener\('click', collapseToCompact\)/);
});

test('Escape collapses layer by layer and leaves inputs and planner dialogs alone', () => {
  const block = app.match(/document\.addEventListener\('keydown', \(e\) => \{\s*if\(e\.key !== 'Escape' \|\| e\.defaultPrevented\) return;[\s\S]*?\n\}\);/);
  assert.ok(block, 'Escape handler not found');
  const code = block[0];
  assert.match(code, /mode === 'settings'\)\{ closeSettingsPanel\(\)/);
  assert.match(code, /closest\('input, textarea, select, \[contenteditable="true"\]'\)/);
  assert.match(code, /event-backdrop/);
  assert.match(code, /task-editor-shell/);
  assert.match(code, /mode === 'shelf'\)\{ closeShelfPanel\(\)/);
  assert.match(code, /setMediaExpanded\(false\)/);
  assert.match(code, /OUTSIDE_COLLAPSIBLE_MODES\.has\(mode\)\) collapseToCompact\(\)/);
  // l'ordre compte : réglages d'abord, vue principale en dernier
  assert.ok(code.indexOf("'settings'") < code.indexOf("'shelf'"));
  assert.ok(code.indexOf("'shelf'") < code.indexOf('setMediaExpanded'));
  assert.ok(code.indexOf('setMediaExpanded') < code.indexOf('collapseToCompact'));
});

test('timer: presets, typed duration and shared script loading order', () => {
  for (const minutes of [5, 10, 15, 25, 45]) {
    assert.match(html, new RegExp('class="preset-chip" data-minutes="' + minutes + '"'));
  }
  assert.match(html, /id="timer-time-input"[^>]*hidden/);
  assert.ok(html.indexOf('duration-input.js') > -1 && html.indexOf('duration-input.js') < html.indexOf('src="app.js"'));
  assert.match(app, /window\.DurationInput\.parseDuration\(timerInputEl\.value\)/);
  assert.match(app, /e\.key === 'Escape'\)\{ e\.preventDefault\(\); e\.stopPropagation\(\); timerEditEnd\(false\)/);
  assert.match(css, /\.big-time-input\.invalid/);
});

test('pomodoro: Skip button never touches the running state and does not count a skipped focus', () => {
  assert.match(html, /id="pomo-reset"[\s\S]*id="pomo-skip"[\s\S]*id="pomo-toggle"/);
  const skip = app.match(/function pomoSkip\(\)\{[\s\S]*?\n\}\n/);
  assert.ok(skip, 'pomoSkip not found');
  assert.match(skip[0], /recordPomoAnalyticsSession\(false\)/);
  assert.doesNotMatch(skip[0], /pomo\.count/);
  assert.doesNotMatch(skip[0], /pomoStart\(|pomoPause\(/);
  assert.match(app, /\$\('pomo-skip'\)\.addEventListener\('click'/);
});
