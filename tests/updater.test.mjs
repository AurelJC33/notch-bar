import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUpdater, CHECK_DELAY_MS, CHECK_INTERVAL_MS } = require('../updater.js');
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../preload.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fakeUpdater() {
  const u = new EventEmitter();
  u.checks = 0; u.downloads = 0; u.installed = null; u.failDownload = false;
  u.checkForUpdates = async () => { u.checks += 1; u.emit('checking-for-update'); };
  u.downloadUpdate = async () => { u.downloads += 1; if (u.failDownload) throw new Error('boom'); };
  u.quitAndInstall = (...args) => { u.installed = args; };
  return u;
}
function setup(overrides = {}) {
  const autoUpdater = fakeUpdater();
  const sent = [];
  const timers = { timeouts: [], intervals: [] };
  const updater = createUpdater({
    autoUpdater, isPackaged: true, version: '1.0.0', getAutoEnabled: () => true,
    send: (s) => sent.push(s.status),
    setTimeoutFn: (fn, ms) => { timers.timeouts.push({ fn, ms }); return timers.timeouts.length; },
    setIntervalFn: (fn, ms) => { timers.intervals.push({ fn, ms }); return timers.intervals.length; },
    clearTimeoutFn() {}, clearIntervalFn() {},
    ...overrides,
  });
  return { autoUpdater, sent, timers, updater };
}

test('dev builds never check and report a disabled state', async () => {
  const { autoUpdater, updater } = setup({ isPackaged: false });
  updater.start();
  await updater.check({ manual: true });
  assert.equal(autoUpdater.checks, 0);
  assert.equal(updater.download(), false);
  assert.equal(updater.getState().status, 'disabled');
});

test('checks once shortly after start then every 6 hours, and never downloads or installs on its own', () => {
  const { autoUpdater, timers, updater } = setup();
  updater.start();
  updater.start();
  assert.equal(timers.timeouts.length, 1);
  assert.equal(timers.timeouts[0].ms, CHECK_DELAY_MS);
  assert.equal(timers.intervals[0].ms, CHECK_INTERVAL_MS);
  assert.equal(autoUpdater.autoDownload, false, 'the notch banner asks first');
  assert.equal(autoUpdater.autoInstallOnAppQuit, false, 'no install that would skip the timer snapshot');
  assert.equal(autoUpdater.allowPrerelease, false);
});

test('automatic checks respect the setting but manual checks always run', async () => {
  const { autoUpdater, updater } = setup({ getAutoEnabled: () => false });
  updater.start();
  await updater.check();
  assert.equal(autoUpdater.checks, 0);
  await updater.check({ manual: true });
  assert.equal(autoUpdater.checks, 1);
});

test('full lifecycle: available (nothing downloaded) -> click -> progress -> downloaded -> silent install + relaunch', async () => {
  const { autoUpdater, sent, updater } = setup();
  updater.start();
  assert.equal(updater.download(), false, 'nothing announced yet');
  assert.equal(updater.install(), false, 'nothing to install yet');
  await updater.check({ manual: true });
  autoUpdater.emit('update-available', { version: '1.1.0' });
  assert.equal(updater.getState().status, 'available');
  assert.equal(autoUpdater.downloads, 0, 'announcing must not download');
  assert.equal(updater.install(), false, 'cannot install what is not downloaded');
  assert.equal(updater.download(), true);
  assert.equal(updater.download(), false, 'a second click while downloading is ignored');
  autoUpdater.emit('download-progress', { percent: 41.6 });
  assert.equal(updater.getState().percent, 42);
  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  assert.deepEqual(sent, ['checking', 'available', 'downloading', 'downloading', 'downloaded']);
  assert.equal(updater.getState().availableVersion, '1.1.0');
  assert.equal(autoUpdater.downloads, 1);
  assert.equal(updater.install(), true);
  assert.deepEqual(autoUpdater.installed, [true, true]);
});

test('a failed download keeps the announced version and can be retried with one click', async () => {
  const { autoUpdater, updater } = setup();
  updater.start();
  autoUpdater.emit('update-available', { version: '1.1.0' });
  autoUpdater.failDownload = true;
  assert.equal(updater.download(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.getState().status, 'error');
  assert.equal(updater.getState().error, 'Update download failed');
  assert.equal(updater.getState().availableVersion, '1.1.0');
  autoUpdater.failDownload = false;
  assert.equal(updater.download(), true, 'retry allowed');
  assert.equal(autoUpdater.downloads, 2);
  autoUpdater.emit('error', new Error('network'));
  assert.equal(updater.getState().availableVersion, '1.1.0', 'error during a download keeps the version');
});

test('periodic checks leave a waiting update alone, manual checks still run', async () => {
  const { autoUpdater, updater } = setup();
  updater.start();
  await updater.check({ manual: true });
  autoUpdater.emit('update-available', { version: '1.1.0' });
  await updater.check();
  assert.equal(autoUpdater.checks, 1);
  await updater.check({ manual: true });
  assert.equal(autoUpdater.checks, 2);
});

test('no duplicate check while one is running; check errors are reported and clear the version', async () => {
  const { autoUpdater, updater } = setup();
  updater.start();
  await updater.check({ manual: true });
  await updater.check({ manual: true });
  assert.equal(autoUpdater.checks, 1);
  autoUpdater.emit('error', new Error('404'));
  assert.equal(updater.getState().status, 'error');
  assert.equal(updater.getState().error, 'Update check failed');
  assert.equal(updater.download(), false, 'no version known after a failed check');
  await updater.check({ manual: true });
  assert.equal(autoUpdater.checks, 2);
});

test('up-to-date result resets the state', async () => {
  const { autoUpdater, updater } = setup();
  updater.start();
  autoUpdater.emit('update-not-available', {});
  assert.equal(updater.getState().status, 'uptodate');
});

test('wiring: IPC, preload, banner markup, settings UI and electron-builder publish config', () => {
  assert.match(main, /require\('electron-updater'\)/);
  assert.match(main, /autoUpdateEnabled: true/);
  for (const channel of ['check-for-updates', 'download-update', 'install-update', 'take-resume-state']) {
    assert.match(main, new RegExp("ipcMain\\.handle\\('" + channel + "'"));
  }
  assert.match(main, /NOTCH_FAKE_UPDATE/);
  for (const name of ['getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'takeResumeState', 'onUpdateState']) assert.match(preload, new RegExp(name));
  for (const id of ['s-autoUpdateEnabled', 'update-action', 'update-status', 'update-version', 'view-update', 'update-card', 'update-card-title', 'update-card-sub', 'update-dismiss', 'update-progress', 'update-progress-bar']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(app, /autoUpdateEnabled: true/);
  assert.match(app, /playSound\('updateAvailable'\)/);
  assert.match(app, /setMode\('update'\)/);
  assert.match(css, /body\.mode-update #capsule/);
  assert.match(css, /\.edge-accent\{/);
  assert.ok(pkg.dependencies['electron-updater']);
  assert.ok(pkg.build.files.includes('updater.js'));
  assert.ok(pkg.build.files.includes('resume-state.js'), 'resume-state.js must ship inside the installer');
  assert.equal(pkg.build.publish[0].provider, 'github');
  assert.equal(pkg.build.win.target[0].target, 'nsis');
});
