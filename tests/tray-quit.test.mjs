import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const main = read('../main.js');
const preload = read('../preload.js');
const html = read('../renderer/index.html');
const app = read('../renderer/app.js');
const css = read('../renderer/style.css');

test('tray: main builds the icon with Open / Settings / Quit and cleans up on quit', () => {
  assert.match(main, /Tray, Menu(?:, \w+)* \} = require\('electron'\)/);
  assert.match(main, /new Tray\(/);
  assert.match(main, /label: 'Open'/);
  assert.match(main, /label: 'Settings'/);
  assert.match(main, /label: 'Quit'/);
  assert.match(main, /tray\.on\('click'/);
  assert.match(main, /createTray\(\);/);
  assert.match(main, /destroyTray\(\);/);
  assert.match(main, /ipcMain\.on\('quit-app'/);
  assert.match(main, /ignoreBlurUntil = Date\.now\(\) \+ 1500/);
});

test('tray: embedded icons are valid PNG files', () => {
  const PNG_SIGNATURE = '89504e470d0a1a0a';
  for (const name of ['TRAY_ICON_16', 'TRAY_ICON_32']) {
    const match = main.match(new RegExp('const ' + name + " = '([A-Za-z0-9+/=]+)';"));
    assert.ok(match, name + ' must be embedded in main.js');
    const bytes = Buffer.from(match[1], 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), PNG_SIGNATURE, name + ' is not a PNG');
    assert.ok(bytes.length > 100 && bytes.length < 20000);
  }
});

test('quit: preload bridge, settings button and double-click confirmation', () => {
  assert.match(preload, /quitApp: \(\) => ipcRenderer\.send\('quit-app'\)/);
  assert.match(preload, /onTrayCommand/);
  assert.match(html, /id="btn-quit-app"[^>]*>Quit Notch</);
  assert.match(app, /window\.api\.onTrayCommand/);
  assert.match(app, /window\.api\.quitApp\(\)/);
  assert.match(app, /Confirm quit/);
  assert.match(css, /#btn-quit-app/);
});
