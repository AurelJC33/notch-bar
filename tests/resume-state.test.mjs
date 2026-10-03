import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeSnapshot, isSnapshotFresh, SNAPSHOT_MAX_AGE_MS } = require('../resume-state.js');
const app = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');

test('sanitizeSnapshot rejects garbage and keeps valid tool states', () => {
  assert.equal(sanitizeSnapshot(null), null);
  assert.equal(sanitizeSnapshot('x'), null);
  assert.equal(sanitizeSnapshot({}), null);
  const clean = sanitizeSnapshot({
    pomodoro: { phase: 'short', remaining: 123.4, running: true, count: 2, session: null },
    timer: { minutes: 7, seconds: 30, remaining: 200, running: false },
    stopwatch: { elapsedMs: 5000, running: false },
  });
  assert.deepEqual(clean.pomodoro, { phase: 'short', remaining: 123, running: true, count: 2, session: null });
  assert.deepEqual(clean.timer, { minutes: 7, seconds: 30, remaining: 200, running: false });
  assert.deepEqual(clean.stopwatch, { elapsedMs: 5000, running: false });
});

test('sanitizeSnapshot clamps values, defaults unknown phases and keeps a single running tool', () => {
  const clean = sanitizeSnapshot({
    pomodoro: { phase: 'nope', remaining: -5, running: true, count: 'abc' },
    timer: { minutes: 9999, seconds: 99, remaining: 1e12, running: true },
    stopwatch: { elapsedMs: -1, running: true },
  });
  assert.equal(clean.pomodoro.phase, 'focus');
  assert.equal(clean.pomodoro.remaining, 0);
  assert.equal(clean.pomodoro.count, 0);
  assert.equal(clean.timer.minutes, 180);
  assert.equal(clean.timer.seconds, 59);
  assert.equal(clean.timer.remaining, 180 * 60 + 59);
  assert.equal(clean.stopwatch.elapsedMs, 0);
  const running = ['pomodoro', 'timer', 'stopwatch'].filter((name) => clean[name].running);
  assert.deepEqual(running, ['pomodoro']);
});

test('sanitizeSnapshot validates the analytics session of a focus phase', () => {
  const good = sanitizeSnapshot({ pomodoro: { phase: 'focus', remaining: 600, running: true, count: 0, session: {
    startedAt: '2026-10-03T10:00:00.000Z', startedAtMs: 1790000000000, durationSeconds: 1500, elapsedSeconds: 900 } } });
  assert.equal(good.pomodoro.session.elapsedSeconds, 900);
  const bad = sanitizeSnapshot({ pomodoro: { phase: 'focus', remaining: 600, running: true, count: 0, session: { startedAt: 'not a date', durationSeconds: 1500 } } });
  assert.equal(bad.pomodoro.session, null);
  const over = sanitizeSnapshot({ pomodoro: { phase: 'focus', remaining: 1, running: false, count: 0, session: {
    startedAt: '2026-10-03T10:00:00.000Z', durationSeconds: 100, elapsedSeconds: 999 } } });
  assert.equal(over.pomodoro.session.elapsedSeconds, 100);
});

test('snapshots expire: fresh within 10 minutes, never from the future or when malformed', () => {
  const now = 1_000_000_000;
  assert.equal(isSnapshotFresh({ savedAt: now - 1000 }, now), true);
  assert.equal(isSnapshotFresh({ savedAt: now - SNAPSHOT_MAX_AGE_MS }, now), true);
  assert.equal(isSnapshotFresh({ savedAt: now - SNAPSHOT_MAX_AGE_MS - 1 }, now), false);
  assert.equal(isSnapshotFresh({ savedAt: now + 5000 }, now), false);
  assert.equal(isSnapshotFresh({}, now), false);
  assert.equal(isSnapshotFresh(null, now), false);
});

/* Le code de capture / restauration vit dans renderer/app.js entre deux marqueurs : on l'extrait
   et on l'exécute avec de faux minuteurs, pour tester la vraie logique sans lancer Electron. */
function loadResumeCode(initial) {
  const match = app.match(/\/\* @resume-begin \*\/([\s\S]*?)\/\* @resume-end \*\//);
  assert.ok(match, 'resume markers present in renderer/app.js');
  const calls = [];
  const context = vm.createContext({ Date, Math, calls, initial });
  vm.runInContext(
    'let pomoSession = initial.pomoSession;\n' +
    'const pomo = initial.pomo; const timer = initial.timer; const sw = initial.sw;\n' +
    'function pomoSyncRemaining(){} function timerSyncRemaining(){}\n' +
    'function renderPomo(){ calls.push("renderPomo"); } function renderTimer(){ calls.push("renderTimer"); } function renderStopwatch(){ calls.push("renderStopwatch"); }\n' +
    'function pomoStart(){ calls.push("pomoStart"); } function timerStart(){ calls.push("timerStart"); } function swStart(){ calls.push("swStart"); }\n' +
    match[1] + '\n' +
    'globalThis.api = { captureToolsSnapshot, restoreToolsSnapshot, getSession: () => pomoSession };',
    context
  );
  return { api: context.api, calls, context };
}

test('capture: a running focus pomodoro is frozen with its analytics session, without side effects', () => {
  const now = Date.now();
  const { api } = loadResumeCode({
    pomoSession: { startedAt: '2026-10-03T10:00:00.000Z', startedAtMs: now - 600000, durationSeconds: 1500, elapsedSeconds: 300, runningSinceMs: now - 60000 },
    pomo: { phase: 'focus', remaining: 1200, running: true, count: 1 },
    timer: { minutes: 5, seconds: 0, remaining: 300, running: false },
    sw: { elapsedMs: 0, startedAt: 0, running: false },
  });
  const snapshot = api.captureToolsSnapshot();
  assert.equal(snapshot.pomodoro.running, true);
  assert.equal(snapshot.pomodoro.remaining, 1200);
  assert.equal(snapshot.pomodoro.count, 1);
  assert.ok(snapshot.pomodoro.session.elapsedSeconds >= 359 && snapshot.pomodoro.session.elapsedSeconds <= 362, 'elapsed includes the live minute');
  assert.ok(api.getSession().runningSinceMs > 0, 'capture must not stop the live session if the install fails');
  const clean = sanitizeSnapshot(snapshot);
  assert.ok(clean && clean.pomodoro.session, 'what the renderer captures survives main-process validation');
});

test('restore: a running pomodoro resumes where it was (phase, time, cycle count, analytics session)', () => {
  const { api, calls, context } = loadResumeCode({
    pomoSession: null,
    pomo: { phase: 'focus', remaining: 1500, running: false, count: 0 },
    timer: { minutes: 5, seconds: 0, remaining: 300, running: false },
    sw: { elapsedMs: 0, startedAt: 0, running: false },
  });
  api.restoreToolsSnapshot({
    pomodoro: { phase: 'short', remaining: 187, running: true, count: 3, session: null },
    timer: { minutes: 5, seconds: 0, remaining: 300, running: false },
    stopwatch: { elapsedMs: 0, running: false },
  });
  assert.equal(context.initial.pomo.phase, 'short');
  assert.equal(context.initial.pomo.remaining, 187);
  assert.equal(context.initial.pomo.count, 3);
  assert.deepEqual(calls.filter((c) => c.endsWith('Start')), ['pomoStart']);

  api.restoreToolsSnapshot({
    pomodoro: { phase: 'focus', remaining: 900, running: true, count: 0, session: { startedAt: '2026-10-03T10:00:00.000Z', startedAtMs: 1, durationSeconds: 1500, elapsedSeconds: 600 } },
  });
  assert.equal(api.getSession().elapsedSeconds, 600);
  assert.equal(api.getSession().runningSinceMs, 0, 'pomoStart() re-arms the live clock');
});

test('restore: timer and stopwatch come back with their values, only the running tool restarts', () => {
  const run = (snapshot) => {
    const loaded = loadResumeCode({
      pomoSession: null,
      pomo: { phase: 'focus', remaining: 1500, running: false, count: 0 },
      timer: { minutes: 5, seconds: 0, remaining: 300, running: false },
      sw: { elapsedMs: 0, startedAt: 0, running: false },
    });
    loaded.api.restoreToolsSnapshot(snapshot);
    return loaded;
  };
  const timerCase = run({ timer: { minutes: 12, seconds: 30, remaining: 421, running: true }, stopwatch: { elapsedMs: 8000, running: false } });
  assert.equal(timerCase.context.initial.timer.minutes, 12);
  assert.equal(timerCase.context.initial.timer.remaining, 421);
  assert.equal(timerCase.context.initial.sw.elapsedMs, 8000);
  assert.deepEqual(timerCase.calls.filter((c) => c.endsWith('Start')), ['timerStart']);

  const swCase = run({ stopwatch: { elapsedMs: 93500, running: true } });
  assert.equal(swCase.context.initial.sw.elapsedMs, 93500);
  assert.deepEqual(swCase.calls.filter((c) => c.endsWith('Start')), ['swStart']);

  const paused = run({ pomodoro: { phase: 'focus', remaining: 700, running: false, count: 1, session: null } });
  assert.equal(paused.context.initial.pomo.remaining, 700);
  assert.deepEqual(paused.calls.filter((c) => c.endsWith('Start')), [], 'a paused tool stays paused');

  assert.doesNotThrow(() => run(null));
});

test('wiring: snapshot is taken at install time, read once at startup after the settings are loaded', () => {
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /require\('\.\/resume-state'\)/);
  assert.match(main, /resumeStore\.set\('snapshot'/);
  assert.match(main, /resumeStore\.delete\('snapshot'\)/);
  assert.match(app, /installUpdate\(captureToolsSnapshot\(\)\)/);
  const settingsThen = app.indexOf('window.api.getSettings().then');
  const resumeCall = app.indexOf('resumeToolsAfterUpdate();', settingsThen);
  const analyticsSection = app.indexOf('/* ==================== ANALYTICS', settingsThen);
  assert.ok(resumeCall > settingsThen && resumeCall < analyticsSection, 'restore runs inside the getSettings().then block');
});
