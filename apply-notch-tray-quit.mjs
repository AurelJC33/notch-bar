#!/usr/bin/env node
/*
 * Notch Bar — icône de notification + moyen de quitter l'app
 *
 *   1. Icône dans la zone de notification Windows, avec le menu :
 *        Open  /  Settings  /  Quit
 *      Un clic gauche sur l'icône ouvre le notch. « Open » recentre aussi la
 *      fenêtre et la ré-affiche si elle avait disparu (plus besoin du
 *      Gestionnaire des tâches pour la retrouver).
 *   2. Bouton « Quit Notch » en bas des réglages, avec confirmation par second
 *      clic (même principe que « Reset settings »). Si un minuteur est actif,
 *      le texte de confirmation le signale.
 *   3. Relancer l'app alors qu'elle tourne déjà ouvre maintenant le notch
 *      (avant : il était seulement ré-affiché s'il était masqué).
 *   4. Les réglages ouverts depuis un état compact (icône de notification,
 *      rappel, bannière de mise à jour) se referment sur l'état compact normal.
 *   5. Nouveau test : tests/tray-quit.test.mjs
 *
 * L'icône est embarquée dans main.js (PNG en base64) : aucun fichier à ajouter
 * dans l'installeur, package.json "build.files" ne change pas.
 *
 * Usage (à la racine du dépôt) :   node apply-notch-tray-quit.mjs
 * Idempotent et atomique : si une ancre est introuvable, rien n'est écrit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const file = (rel) => path.join(ROOT, ...rel.split('/'));

function fail(msg) {
  console.error('\n✖ ' + msg + '\nAucun fichier n\'a été modifié.');
  process.exit(1);
}

if (!fs.existsSync(file('package.json')) || !fs.existsSync(file('main.js'))) {
  fail('Lance ce script depuis la racine du dépôt notch-bar (là où se trouve package.json).');
}

/* ---------- lecture / écriture (gère LF et CRLF) ---------- */
const pending = new Map(); // rel -> { text, eol }

function load(rel) {
  if (pending.has(rel)) return pending.get(rel);
  const raw = fs.readFileSync(file(rel), 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const entry = { text: raw.replace(/\r\n/g, '\n'), eol };
  pending.set(rel, entry);
  return entry;
}

function replaceOnce(rel, search, replacement, label) {
  const entry = load(rel);
  const first = entry.text.indexOf(search);
  if (first === -1) fail(rel + ' : ancre introuvable (' + label + ').');
  if (entry.text.indexOf(search, first + 1) !== -1) fail(rel + ' : ancre ambiguë (' + label + ').');
  entry.text = entry.text.slice(0, first) + replacement + entry.text.slice(first + search.length);
}

/* ---------- déjà appliqué ? ---------- */
if (load('main.js').text.includes('function createTray')) {
  console.log('✔ Cette mise à jour est déjà appliquée, rien à faire.');
  process.exit(0);
}

/* =====================================================================
 *  1. main.js
 * ===================================================================== */
replaceOnce('main.js',
  "const { app, BrowserWindow, ipcMain, screen, shell, nativeImage, clipboard } = require('electron');",
  "const { app, BrowserWindow, ipcMain, screen, shell, nativeImage, clipboard, Tray, Menu } = require('electron');",
  'require electron');

replaceOnce('main.js',
  '/* ---------------- IPC ----------------',
`/* ---------------- Icône de la zone de notification ----------------
 * Le notch n'a ni fenêtre classique ni bouton dans la barre des tâches
 * (skipTaskbar) : sans cette icône, impossible de quitter l'app, ni de la
 * retrouver si la fenêtre a disparu. Clic gauche = ouvrir ; clic droit = menu.
 * Les deux PNG (16 px et 32 px pour les écrans à 200 %) sont embarqués ici en
 * base64 : rien de plus à livrer dans l'installeur. */
const TRAY_ICON_16 = '__TRAY16__';
const TRAY_ICON_32 = '__TRAY32__';
let tray = null;

function buildTrayIcon() {
  const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_16, 'base64'), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(TRAY_ICON_32, 'base64') });
  return image;
}

function showNotchFromTray(command) {
  if (!notchWin || notchWin.isDestroyed()) return;
  // Retrouve le notch même s'il était masqué ou décalé (changement d'écran).
  notchWin.setBounds(notchWindowBounds());
  if (!notchWin.isVisible()) notchWin.show();
  // Le menu de la zone de notification reprend le focus en se fermant : sans ce
  // délai de grâce, le repli au clic extérieur refermerait aussitôt la vue
  // qu'on vient d'ouvrir.
  ignoreBlurUntil = Date.now() + 1500;
  notchWin.focus();
  notchWin.webContents.send('tray-command', command);
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(buildTrayIcon());
  } catch (error) {
    console.warn('[tray] icône indisponible :', error.message);
    tray = null;
    return;
  }
  tray.setToolTip('Notch Bar');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Notch Bar v' + app.getVersion(), enabled: false },
    { type: 'separator' },
    { label: 'Open', click: () => showNotchFromTray('open') },
    { label: 'Settings', click: () => showNotchFromTray('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => showNotchFromTray('open'));
}

function destroyTray() {
  // Sans destroy(), Windows garde une icône fantôme jusqu'au prochain survol.
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

// Bouton « Quit Notch » des réglages (la confirmation se fait côté renderer).
ipcMain.on('quit-app', () => app.quit());

/* ---------------- IPC ----------------`,
  'bloc IPC');

replaceOnce('main.js',
`app.on('second-instance', () => {
  if (notchWin && !notchWin.isDestroyed()) {
    if (!notchWin.isVisible()) notchWin.show();
  }
});`,
`app.on('second-instance', () => {
  // Relancer l'app alors qu'elle tourne déjà = « où est mon notch ? » : on l'ouvre.
  showNotchFromTray('open');
});`,
  'second-instance');

replaceOnce('main.js',
`  createNotchWindow();
  setupUpdater();`,
`  createNotchWindow();
  createTray();
  setupUpdater();`,
  'whenReady');

replaceOnce('main.js',
`app.on('before-quit', () => {
  appIsQuitting = true;`,
`app.on('before-quit', () => {
  appIsQuitting = true;
  destroyTray();`,
  'before-quit');

/* =====================================================================
 *  2. preload.js
 * ===================================================================== */
replaceOnce('preload.js',
`  getWeather: () => ipcRenderer.invoke('get-weather'),`,
`  quitApp: () => ipcRenderer.send('quit-app'),
  onTrayCommand: (callback) => {
    ipcRenderer.on('tray-command', (event, command) => callback(command));
  },
  getWeather: () => ipcRenderer.invoke('get-weather'),`,
  'preload');

/* =====================================================================
 *  3. index.html — bouton Quit
 * ===================================================================== */
replaceOnce('renderer/index.html',
`      <div class="settings-footer">
        <button class="btn ghost" id="btn-reset-settings">Reset settings</button>
      </div>`,
`      <div class="settings-footer">
        <button class="btn ghost" id="btn-reset-settings">Reset settings</button>
        <button class="btn ghost" id="btn-quit-app">Quit Notch</button>
      </div>`,
  'footer réglages');

/* =====================================================================
 *  4. style.css — pied de réglages à deux boutons
 * ===================================================================== */
replaceOnce('renderer/style.css',
`.settings-footer{ flex:none; padding:10px 16px 14px; }
.settings-footer .btn{ width:100%; }
.settings-footer .btn.danger-pending{ background:var(--red); color:#fff; border-color:transparent; }`,
`.settings-footer{ flex:none; display:flex; flex-direction:column; gap:8px; padding:10px 16px 14px; }
.settings-footer .btn{ width:100%; }
.settings-footer .btn.danger-pending{ background:var(--red); color:#fff; border-color:transparent; }
/* « Quit Notch » : discret au repos, rouge quand il attend la confirmation. */
.settings-footer #btn-quit-app:not(.danger-pending){ color:var(--red); }`,
  'css footer');

/* =====================================================================
 *  5. app.js
 * ===================================================================== */
replaceOnce('renderer/app.js',
`function openSettingsPanel(){
  if(mode === 'settings') return;
  previousMode = mode;`,
`function openSettingsPanel(){
  if(mode === 'settings') return;
  // Depuis un état compact (pill, hover, rappel, bannière de mise à jour — cas de
  // l'icône de notification), on revient à la capsule normale à la fermeture.
  previousMode = OUTSIDE_COLLAPSIBLE_MODES.has(mode) ? mode : (activeTool ? 'running' : 'pill');`,
  'openSettingsPanel');

replaceOnce('renderer/app.js',
`$('btn-close-settings').addEventListener('click', closeSettingsPanel);`,
`$('btn-close-settings').addEventListener('click', closeSettingsPanel);

/* ---- icône de la zone de notification : Open / Settings ---- */
if(window.api.onTrayCommand) window.api.onTrayCommand((command) => {
  setWindowMouseIgnored(false);
  if(command === 'settings') openSettingsPanel();
  else if(!OUTSIDE_COLLAPSIBLE_MODES.has(mode)) openCurrentView();
});

/* ---- quitter l'app (second clic de confirmation, comme « Reset settings ») ---- */
const quitBtn = $('btn-quit-app');
let quitPending = false;
let quitTimer = null;
quitBtn.addEventListener('click', () => {
  if(!quitPending){
    quitPending = true;
    quitBtn.textContent = activeTool ? 'Timer active: confirm quit' : 'Confirm quit';
    quitBtn.classList.add('danger-pending');
    clearTimeout(quitTimer);
    quitTimer = setTimeout(() => {
      quitPending = false;
      quitBtn.textContent = 'Quit Notch';
      quitBtn.classList.remove('danger-pending');
    }, 3000);
    return;
  }
  clearTimeout(quitTimer);
  if(window.api.quitApp) window.api.quitApp();
});`,
  'handlers renderer');

/* =====================================================================
 *  6. nouveau test
 * ===================================================================== */
if (fs.existsSync(file('tests/tray-quit.test.mjs'))) fail('tests/tray-quit.test.mjs existe déjà.');
pending.set('tests/tray-quit.test.mjs', {
  eol: '\n',
  text: `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const main = read('../main.js');
const preload = read('../preload.js');
const html = read('../renderer/index.html');
const app = read('../renderer/app.js');
const css = read('../renderer/style.css');

test('tray: main builds the icon with Open / Settings / Quit and cleans up on quit', () => {
  assert.match(main, /Tray, Menu \\} = require\\('electron'\\)/);
  assert.match(main, /new Tray\\(/);
  assert.match(main, /label: 'Open'/);
  assert.match(main, /label: 'Settings'/);
  assert.match(main, /label: 'Quit'/);
  assert.match(main, /tray\\.on\\('click'/);
  assert.match(main, /createTray\\(\\);/);
  assert.match(main, /destroyTray\\(\\);/);
  assert.match(main, /ipcMain\\.on\\('quit-app'/);
  assert.match(main, /ignoreBlurUntil = Date\\.now\\(\\) \\+ 1500/);
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
  assert.match(preload, /quitApp: \\(\\) => ipcRenderer\\.send\\('quit-app'\\)/);
  assert.match(preload, /onTrayCommand/);
  assert.match(html, /id="btn-quit-app"[^>]*>Quit Notch</);
  assert.match(app, /window\\.api\\.onTrayCommand/);
  assert.match(app, /window\\.api\\.quitApp\\(\\)/);
  assert.match(app, /Confirm quit/);
  assert.match(css, /#btn-quit-app/);
});
`,
});

/* =====================================================================
 *  7. MODIFICATIONS.md
 * ===================================================================== */
{
  const entry = load('MODIFICATIONS.md');
  entry.text = entry.text.replace(/\s*$/, '\n') + `
## v15 — System tray icon and a way to quit

- Added a notification-area (tray) icon with an Open / Settings / Quit menu. Left click opens the notch. Open also re-centers the window and shows it again if it was hidden, so the app can always be found. The icon is embedded in main.js as base64 PNGs (16 px + 32 px for 200 % displays); nothing new to package.
- Added a "Quit Notch" button at the bottom of Settings. It asks for a second click to confirm, like "Reset settings", and warns when a timer is active.
- The tray icon is destroyed on quit so Windows does not keep a ghost icon.
- Launching the app a second time now opens the notch instead of only re-showing a hidden window.
- Settings opened from a compact state (tray, reminder, update banner) close back to the normal compact capsule.
- Added tests/tray-quit.test.mjs.
`;
}

/* =====================================================================
 *  8. version (fonctionnalité => version mineure)
 * ===================================================================== */
let version = JSON.parse(load('package.json').text).version;
let tagExists = false;
try {
  tagExists = execSync('git tag --list v' + version, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim() === 'v' + version;
} catch { /* pas de dépôt git : on garde la version telle quelle */ }

if (tagExists) {
  const [major, minor] = version.split('.').map(Number);
  const next = major + '.' + (minor + 1) + '.0';
  const pkg = load('package.json');
  pkg.text = pkg.text.replace('"version": "' + version + '"', '"version": "' + next + '"');
  if (fs.existsSync(file('package-lock.json'))) {
    const lock = load('package-lock.json');
    lock.text = lock.text.replace(
      new RegExp('("name": "notch-bar",\\s*"version": ")' + version.replace(/\./g, '\\.') + '(")', 'g'),
      '$1' + next + '$2');
  }
  version = next;
}

/* =====================================================================
 *  Écriture (tout ou rien)
 * ===================================================================== */
for (const [rel, entry] of pending) {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), entry.eol === '\r\n' ? entry.text.replace(/\n/g, '\r\n') : entry.text);
}

console.log('\n✔ Mise à jour appliquée : ' + [...pending.keys()].join(', '));
console.log('\nVersion : ' + version + (tagExists ? ' (incrémentée, le tag précédent existait déjà)' : ' (le tag v' + version + ' n\'existe pas encore)'));
console.log('\nTest local :   npm run check   puis   npm start');
console.log('(l\'icône apparaît dans la zone de notification ; si elle est cachée derrière la flèche ^, fais-la glisser dans la barre pour l\'épingler)');
console.log('\nPuis publie :\n');
console.log('  git add -A');
console.log('  git commit -m "v' + version + ' : icône de notification (Open / Settings / Quit) et bouton Quit dans les réglages"');
console.log('  git tag v' + version);
console.log('  git push origin main v' + version + '\n');
