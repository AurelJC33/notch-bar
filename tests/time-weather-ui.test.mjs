import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const main = read('../main.js');
const preload = read('../preload.js');
const app = read('../renderer/app.js');
const html = read('../renderer/index.html');
const css = read('../renderer/style.css');
const weather = read('../renderer/weather.js');
const pkg = JSON.parse(read('../package.json'));

test('Timer and Stopwatch are merged into one Time page, existing controls untouched', () => {
  assert.ok(!html.includes('data-tab="timer"') && !html.includes('data-tab="stopwatch"'), 'no separate tabs');
  assert.match(html, /data-tab="time"/);
  assert.equal((html.match(/id="panel-timer"|id="panel-stopwatch"/g) || []).length, 0);
  assert.match(html, /id="panel-time"/);
  for (const id of ['sw-time', 'sw-toggle', 'sw-reset', 'timer-time', 'timer-time-input', 'timer-presets', 'timer-steppers', 'timer-toggle', 'timer-reset']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  // Les deux sous-vues partagent la même cellule : la bulle ne change jamais de taille.
  assert.match(css, /\.time-stage\{[^}]*display:grid/);
  assert.match(css, /\.time-view\{[\s\S]*?grid-area:1\/1/);
  assert.match(app, /function setTimeMode\(next, remember = true\)/);
  assert.match(app, /function timeAutoSync\(\)/);
});

test('switching the Time view never touches the running tools', () => {
  const fn = app.match(/function setTimeMode\(next, remember = true\)\{[\s\S]*?\n\}/)[0];
  for (const forbidden of ['timerPause', 'timerStart', 'swPause', 'swStart', 'stopAllTools', 'activeTool =', 'clearInterval']) {
    assert.ok(!fn.includes(forbidden), forbidden);
  }
});

test('legacy settings keep working: timer / stopwatch resolve to the Time page', () => {
  assert.match(app, /const LEGACY_PAGE_IDS = \{ timer: 'time', stopwatch: 'time' \}/);
  const ids = [...app.match(/const NOTCH_PAGES = \[[\s\S]*?\n\];/)[0].matchAll(/id: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['pomodoro', 'schedule', 'time', 'weather', 'clipboard', 'analytics']);
  // Même ordre que les onglets du HTML (Ctrl+1..6).
  const tabs = [...html.matchAll(/<button class="tab[^"]*"[^>]*data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ids);
});

test('Weather is a regular page of the existing tab system (no parallel navigation)', () => {
  assert.match(html, /id="tab-weather"[^>]*aria-controls="panel-weather"[^>]*data-tab="weather"/);
  assert.match(html, /id="panel-weather"/);
  assert.match(app, /\{ id: 'weather', label: 'Weather', icon: 'weather-partly' \}/);
  assert.match(main, /pinnedPages: \['pomodoro', 'schedule', 'time', 'weather'\]/);
  // Même taille que les autres onglets : aucune règle de taille propre à Weather.
  assert.ok(!/mode-weather/.test(css) && !/--w-weather/.test(css));
  assert.ok(!/setMode\('weather'\)/.test(app));
});

test('Weather: scripts load before app.js, the loop only runs while visible', () => {
  const order = ['weather-engine.js', 'weather.js', 'app.js'].map((f) => html.indexOf(`<script src="${f}">`));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2]);
  assert.match(app, /window\.NotchWeather\?\.sync\(\)/);
  assert.match(weather, /function isVisible\(\)/);
  assert.match(weather, /if \(!isVisible\(\) \|\| reduced\(\)\)/);
  assert.match(weather, /document\.addEventListener\('visibilitychange', sync\)/);
});

test('Weather data path: one IPC, one bridge, cleared when the privacy switch is off', () => {
  assert.match(main, /ipcMain\.handle\('get-weather-forecast', \(\) => forecastCache\)/);
  assert.match(preload, /getWeatherForecast: \(\) => ipcRenderer\.invoke\('get-weather-forecast'\)/);
  assert.match(preload, /onWeatherForecastUpdated/);
  const stop = main.match(/function stopWeatherLoop\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(stop, /forecastCache = null/);
  const fetchWeather = main.match(/async function fetchWeather\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fetchWeather, /WeatherEngine\.openMeteoQuery/);
  assert.match(fetchWeather, /WeatherEngine\.buildForecast/);
  assert.ok(!/fetch\(/.test(weather), 'the renderer never calls the network itself');
});

test('Weather sky sits behind the tab bar and everything is namespaced wx-', () => {
  assert.match(css, /\.weather-sky\{[^}]*z-index:-1/);
  assert.match(css, /#view-expanded:has\(#panel-weather\.active\) \.weather-sky\{ opacity:1; \}/);
  const block = css.slice(css.indexOf('v1.6 — page Time'));
  for (const sel of block.matchAll(/^([.#][\w-]+)/gm)) {
    assert.match(sel[1], /^[.#](time-|segmented|weather-|wx-)|^#view-expanded$/, sel[1]);
  }
  assert.match(css, /body\.reduce-motion \.weather-panel \*/);
});

test('release metadata: version bumped and new files are checked', () => {
  assert.match(pkg.version, /^1\.\d+\.\d+$/);
  assert.ok(pkg.scripts.check.includes('node --check renderer/weather.js'));
  assert.ok(pkg.scripts.check.includes('node --check renderer/weather-engine.js'));
  assert.ok(pkg.build.files.includes('renderer/**/*'), 'weather-engine.js is packaged (main.js requires it)');
});
