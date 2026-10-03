import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import SoundEngine from '../renderer/sound-engine.js';

const { SOUND_CATEGORY, shouldPlay, volumeToGain, normalizeVolume, createSoundPlayer } = SoundEngine;
const app = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');

const assetsSource = fs.readFileSync(new URL('../renderer/sound-assets.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(assetsSource, sandbox);
const assets = sandbox.window.NOTCH_SOUND_ASSETS;

test('every sound has an embedded asset and a category', () => {
  assert.deepEqual(Object.keys(assets).sort(), Object.keys(SOUND_CATEGORY).sort());
});

test('assets are short mono WAV files (50-300 ms)', () => {
  for (const [name, b64] of Object.entries(assets)) {
    const buf = Buffer.from(b64, 'base64');
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF', name);
    assert.equal(buf.readUInt16LE(22), 1, `${name} mono`);
    const rate = buf.readUInt32LE(24);
    const dataBytes = buf.readUInt32LE(40);
    const ms = (dataBytes / 2 / rate) * 1000;
    assert.ok(ms >= 45 && ms <= 300, `${name} lasts ${ms.toFixed(0)} ms`);
  }
});

test('volume curve is clamped and quadratic', () => {
  assert.equal(normalizeVolume(250), 100);
  assert.equal(normalizeVolume(-4), 0);
  assert.equal(normalizeVolume('abc'), 60);
  assert.equal(volumeToGain(100), 1);
  assert.equal(volumeToGain(0), 0);
  assert.ok(volumeToGain(50) < 0.5);
});

test('master switch, categories, volume and media do-not-disturb gate playback', () => {
  const on = { soundEnabled: true, soundVolume: 60, soundUi: true, soundNotifications: true, soundTimers: true };
  assert.equal(shouldPlay(on, 'timerDone'), true);
  assert.equal(shouldPlay({ ...on, soundEnabled: false }, 'timerDone'), false);
  assert.equal(shouldPlay({ ...on, soundTimers: false }, 'pomoFocusEnd'), false);
  assert.equal(shouldPlay({ ...on, soundTimers: false }, 'reminder'), true);
  assert.equal(shouldPlay({ ...on, soundNotifications: false }, 'connect'), false);
  assert.equal(shouldPlay({ ...on, soundUi: false }, 'tick'), false);
  assert.equal(shouldPlay({ ...on, soundVolume: 0 }, 'reminder'), false);
  assert.equal(shouldPlay({ ...on, soundMuteWhenMedia: true }, 'reminder', { mediaPlaying: true }), false);
  assert.equal(shouldPlay({ ...on, soundMuteWhenMedia: true }, 'reminder', { mediaPlaying: false }), true);
  assert.equal(shouldPlay({ ...on, soundMuteWhenMedia: false }, 'reminder', { mediaPlaying: true }), true);
  assert.equal(shouldPlay(on, 'unknown-sound'), false);
});

test('defaults keep interface ticks opt-in and alerts on (old configs without the new keys)', () => {
  const legacy = { soundEnabled: true };
  assert.equal(shouldPlay(legacy, 'tick'), false);
  assert.equal(shouldPlay(legacy, 'timerDone'), true);
  assert.equal(shouldPlay(legacy, 'connect'), true);
});

function fakeAudio() {
  const log = { started: 0, decoded: 0, contexts: 0, masterGain: null };
  class FakeContext {
    constructor() { log.contexts += 1; this.state = 'running'; this.destination = {}; }
    createGain() { const g = { gain: { value: 1 }, connect() {} }; if (!log.masterNode) log.masterNode = g; return g; }
    async decodeAudioData() { log.decoded += 1; return { fake: true }; }
    createBufferSource() { return { connect() {}, start() { log.started += 1; } }; }
    resume() { return Promise.resolve(); }
  }
  return { FakeContext, log };
}

test('player shares one AudioContext, decodes each asset once and applies the volume', async () => {
  const { FakeContext, log } = fakeAudio();
  let t = 1000;
  const settings = { soundEnabled: true, soundVolume: 50, soundUi: true, soundNotifications: true, soundTimers: true };
  const player = createSoundPlayer({ AudioContextClass: FakeContext, assets, getSettings: () => settings, now: () => t });
  await player.preload();
  await player.preload();
  assert.equal(log.contexts, 1);
  assert.equal(log.decoded, Object.keys(assets).length);

  assert.equal(player.play('timerDone'), true);
  assert.equal(log.masterNode.gain.value, volumeToGain(50));
  assert.equal(player.play('timerDone'), false, 'rapid replay is dropped');
  t += 200;
  assert.equal(player.play('timerDone'), true);
  assert.equal(log.contexts, 1);
  assert.equal(log.started, 2);
});

test('player is silent when disabled or when audio is unavailable', async () => {
  const { FakeContext, log } = fakeAudio();
  const off = createSoundPlayer({ AudioContextClass: FakeContext, assets, getSettings: () => ({ soundEnabled: false }) });
  await off.preload();
  assert.equal(off.play('timerDone'), false);
  assert.equal(log.started, 0);
  const none = createSoundPlayer({ AudioContextClass: null, assets, getSettings: () => ({ soundEnabled: true }) });
  await none.preload();
  assert.equal(none.play('timerDone'), false);
});

test('wiring: Bluetooth sounds use the notification edges, reminders play when displayed', () => {
  assert.doesNotMatch(app, /playBeep/);
  assert.match(app, /if\(justConnected\)\{[\s\S]*?showAudioAccessoryNotification\(\);[\s\S]*?playSound\('connect'\)/);
  assert.match(app, /const justDisconnected = audioAccessoryInitialized && audioAccessoryWasConnected && !connected;/);
  assert.match(app, /if\(justDisconnected\) playSound\('disconnect'\)/);
  assert.match(app, /setMode\('reminder'\);\s*playSound\('reminder'\)/);
  assert.match(app, /playSound\(pomo\.phase === 'focus' \? 'pomoFocusEnd' : 'pomoBreakEnd'\)/);
  assert.match(app, /playSound\('timerDone'\)/);
});

test('settings UI, defaults and script order are in place', () => {
  for (const id of ['s-soundEnabled', 's-soundVolume', 's-soundNotifications', 's-soundTimers', 's-soundUi', 's-soundMuteWhenMedia']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const key of ['soundVolume', 'soundUi', 'soundNotifications', 'soundTimers', 'soundMuteWhenMedia']) {
    assert.match(main, new RegExp(`${key}:`), `main default ${key}`);
    assert.match(app, new RegExp(`${key}:`), `renderer default ${key}`);
  }
  assert.ok(html.indexOf('sound-assets.js') < html.indexOf('sound-engine.js'));
  assert.ok(html.indexOf('sound-engine.js') < html.indexOf('src="app.js"'));
  assert.match(main, /autoplayPolicy: 'no-user-gesture-required'/);
});
