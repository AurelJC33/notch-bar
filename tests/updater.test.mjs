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
const preload = fs.readFileSync(new URL('../preload.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fakeUpdater() {
  const u = new EventEmitter();
  u.checks = 0; u.installed = null;
  u.checkForUpdates = async () => { u.checks += 1; u.emit('checking-for-update'); };
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
  assert.equal(updater.getState().status, 'disabled');
});

test('checks once shortly after start then every 6 hours, downloading in background', () => {
  const { autoUpdater, timers, updater } = setup();
  updater.start();
  updater.start();
  assert.equal(timers.timeouts.length, 1);
  assert.equal(timers.timeouts[0].ms, CHECK_DELAY_MS);
  assert.equal(timers.intervals[0].ms, CHECK_INTERVAL_MS);
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
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

test('full lifecycle: available -> progress -> downloaded -> install', async () => {
  const { autoUpdater, sent, updater } = setup();
  updater.start();
  assert.equal(updater.install(), false, 'nothing to install yet');
  await updater.check({ manual: true });
  autoUpdater.emit('update-available', { version: '1.1.0' });
  autoUpdater.emit('download-progress', { percent: 41.6 });
  assert.equal(updater.getState().percent, 42);
  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  assert.deepEqual(sent, ['checking', 'downloading', 'downloading', 'downloaded']);
  assert.equal(updater.getState().availableVersion, '1.1.0');
  assert.equal(updater.install(), true);
  assert.deepEqual(autoUpdater.installed, [false, true]);
});

test('no duplicate check while one is running or an update is ready; errors are reported', async () => {
  const { autoUpdater, updater } = setup();
  updater.start();
  await updater.check({ manual: true });
  await updater.check({ manual: true });
  assert.equal(autoUpdater.checks, 1);
  autoUpdater.emit('error', new Error('404'));
  assert.equal(updater.getState().status, 'error');
  await updater.check({ manual: true });
  assert.equal(autoUpdater.checks, 2);
});

test('up-to-date result resets the state', async () => {
  const { autoUpdater, updater } = setup();
  updater.start();
  autoUpdater.emit('update-not-available', {});
  assert.equal(updater.getState().status, 'uptodate');
});

test('wiring: IPC, preload, settings UI and electron-builder publish config', () => {
  assert.match(main, /require\('electron-updater'\)/);
  assert.match(main, /autoUpdateEnabled: true/);
  assert.match(main, /ipcMain\.handle\('check-for-updates'/);
  assert.match(main, /ipcMain\.handle\('install-update'/);
  for (const name of ['getUpdateState', 'checkForUpdates', 'installUpdate', 'onUpdateState']) assert.match(preload, new RegExp(name));
  for (const id of ['s-autoUpdateEnabled', 'update-action', 'update-status', 'update-version']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /autoUpdateEnabled: true/);
  assert.ok(pkg.dependencies['electron-updater']);
  assert.ok(pkg.build.files.includes('updater.js'));
  assert.equal(pkg.build.publish[0].provider, 'github');
  assert.equal(pkg.build.win.target[0].target, 'nsis');
});
