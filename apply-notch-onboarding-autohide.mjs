#!/usr/bin/env node
/*
 * Notch Bar — accueil, calendrier vide, réglages, raccourci global, auto-hide
 *
 *   1. Accueil au premier lancement : la capsule s'agrandit et explique en 4
 *      points (survol, clic, raccourci, icône de notification). Réaffichable
 *      depuis Réglages > Help > Welcome tour. Les installations EXISTANTES ne le
 *      voient pas automatiquement (NOTCH_FORCE_WELCOME=1 pour le forcer en test).
 *   2. Onglet Calendar sans calendrier : bandeau « Add calendar » qui ouvre les
 *      réglages directement sur le groupe Calendars, champ URL sélectionné.
 *   3. Réglages réordonnés : Pomodoro, Appearance, Behavior, Pinned pages,
 *      Calendars, Reminders, Sound, Privacy, Updates, Help.
 *   4. Raccourci clavier global (défaut Ctrl+Alt+N) : ouvre / replie le notch
 *      depuis n'importe où. Activable et modifiable dans Behavior.
 *   5. Auto-hide : le notch au repos disparaît entièrement ; on le fait
 *      réapparaître en collant la souris en haut de l'écran (50 ms), ou avec le
 *      raccourci global / l'icône de notification. Il reste visible tant qu'un
 *      minuteur tourne ou qu'une notification s'affiche.
 *   6. Nouveau module shortcut.js (validation du raccourci, ajouté à
 *      build.files) et tests/onboarding-autohide.test.mjs.
 *
 * Prérequis : apply-notch-ergonomics.mjs (v1.4.0) déjà appliqué.
 * Usage (à la racine du dépôt) :   node apply-notch-onboarding-autohide.mjs
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

if (!fs.existsSync(file('package.json')) || !fs.existsSync(file('renderer/app.js'))) {
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

function addNewFile(rel, text) {
  if (fs.existsSync(file(rel))) fail(rel + ' existe déjà.');
  pending.set(rel, { text, eol: '\n' });
}

/* ---------- prérequis / déjà appliqué ? ---------- */
if (!load('renderer/index.html').text.includes('id="pomo-skip"')) {
  fail('Applique d\'abord apply-notch-ergonomics.mjs (v1.4.0) : ce script s\'appuie dessus.');
}
if (!load('main.js').text.includes('function createTray')) {
  fail('Le patch de l\'icône de notification (v1.2.x) est absent de main.js.');
}
if (load('renderer/index.html').text.includes('id="view-welcome"')) {
  console.log('✔ Cette mise à jour est déjà appliquée, rien à faire.');
  process.exit(0);
}

/* =====================================================================
 *  0. shortcut.js — validation de l'accélérateur (testable en Node)
 * ===================================================================== */
addNewFile('shortcut.js', String.raw`// Raccourci clavier global : valeur par défaut et validation du format
// "Ctrl+Alt+N" (syntaxe des accélérateurs Electron). Au moins un modificateur
// est exigé : une touche seule détournerait la frappe dans toutes les apps.
const MODIFIER = '(?:Ctrl|Control|CommandOrControl|CmdOrCtrl|Alt|Shift|Super|Meta)';
const KEY = '(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace)';
const ACCELERATOR_PATTERN = new RegExp('^(?:' + MODIFIER + '\\+)+' + KEY + '$');

const DEFAULT_GLOBAL_SHORTCUT = 'Ctrl+Alt+N';

function isValidAccelerator(value) {
  return typeof value === 'string' && value.length <= 40 && ACCELERATOR_PATTERN.test(value);
}

module.exports = { DEFAULT_GLOBAL_SHORTCUT, isValidAccelerator };
`);

/* =====================================================================
 *  1. main.js
 * ===================================================================== */
replaceOnce('main.js',
  "const { app, BrowserWindow, ipcMain, screen, shell, nativeImage, clipboard, Tray, Menu } = require('electron');",
  "const { app, BrowserWindow, ipcMain, screen, shell, nativeImage, clipboard, Tray, Menu, globalShortcut } = require('electron');",
  'require electron');

replaceOnce('main.js',
  "const { sanitizeSnapshot, isSnapshotFresh } = require('./resume-state');",
  "const { sanitizeSnapshot, isSnapshotFresh } = require('./resume-state');\nconst { DEFAULT_GLOBAL_SHORTCUT, isValidAccelerator } = require('./shortcut');",
  'require resume-state');

// Détection d'une installation existante AVANT la création du store (qui écrit son fichier).
replaceOnce('main.js',
  `const store = new Store({
  defaults: {`,
  `// Lu AVANT la création du store (qui écrit son fichier) : sert à n'afficher
// l'accueil qu'aux nouvelles installations, pas à une mise à jour.
const configAlreadyExisted = fs.existsSync(path.join(app.getPath('userData'), 'config.json'));

const store = new Store({
  defaults: {`,
  'store defaults start');

replaceOnce('main.js',
  `    pinnedPages: ['pomodoro', 'schedule', 'timer', 'stopwatch'],
  },
});`,
  `    pinnedPages: ['pomodoro', 'schedule', 'timer', 'stopwatch'],
    autoHide: false,
    globalShortcutEnabled: true,
    globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
  },
});`,
  'store defaults end');

replaceOnce('main.js',
  '/* ---------------- IPC ----------------',
  String.raw`/* ---------------- Raccourci clavier global ----------------
 * Ouvre / replie le notch depuis n'importe quelle application. Enregistré au
 * démarrage et à chaque changement des réglages ; si la combinaison est déjà
 * prise par une autre app, l'enregistrement échoue sans planter et le
 * renderer l'affiche dans Réglages > Behavior. */
let registeredShortcut = null;

function unregisterGlobalShortcut() {
  if (registeredShortcut) {
    try { globalShortcut.unregister(registeredShortcut); } catch { /* déjà libéré */ }
    registeredShortcut = null;
  }
}

function tryRegisterShortcut(accelerator) {
  try { return globalShortcut.register(accelerator, () => showNotchFromTray('toggle')); }
  catch { return false; }
}

function applyGlobalShortcut() {
  unregisterGlobalShortcut();
  if (store.get('globalShortcutEnabled') === false) return false;
  const accelerator = store.get('globalShortcut');
  if (!isValidAccelerator(accelerator)) return false;
  if (!tryRegisterShortcut(accelerator)) return false;
  registeredShortcut = accelerator;
  return true;
}

ipcMain.handle('get-global-shortcut-status', () => ({
  enabled: store.get('globalShortcutEnabled') !== false,
  accelerator: store.get('globalShortcut'),
  registered: !!registeredShortcut,
}));

// Changement de combinaison depuis les réglages : on essaie la nouvelle, et on
// remet l'ancienne si elle est refusée (déjà utilisée, ou réservée par Windows).
ipcMain.handle('set-global-shortcut', (event, accelerator) => {
  const previous = store.get('globalShortcut');
  if (!isValidAccelerator(accelerator)) return { ok: false, error: 'invalid', accelerator: previous };
  if (store.get('globalShortcutEnabled') !== false) {
    unregisterGlobalShortcut();
    if (!tryRegisterShortcut(accelerator)) {
      if (isValidAccelerator(previous) && tryRegisterShortcut(previous)) registeredShortcut = previous;
      return { ok: false, error: 'in-use', accelerator: previous };
    }
    registeredShortcut = accelerator;
  }
  store.set('globalShortcut', accelerator);
  if (notchWin && !notchWin.isDestroyed()) notchWin.webContents.send('settings-updated', store.store);
  return { ok: true, accelerator };
});

/* ---------------- Accueil (premier lancement) ----------------
 * Stocké à part des réglages : « Reset settings » ne doit pas relancer l'accueil.
 * Une installation déjà utilisée avant cette version est marquée « vue » : seul
 * un tout premier lancement affiche l'accueil. NOTCH_FORCE_WELCOME=1 le force. */
const appStateStore = new Store({ name: 'app-state', defaults: {} });
if (appStateStore.get('onboardingDone') === undefined) {
  appStateStore.set('onboardingDone', configAlreadyExisted);
}
ipcMain.handle('get-onboarding', () => ({
  show: !!process.env.NOTCH_FORCE_WELCOME || appStateStore.get('onboardingDone') === false,
}));
ipcMain.handle('complete-onboarding', () => { appStateStore.set('onboardingDone', true); return true; });

/* ---------------- IPC ----------------`,
  'bloc IPC');

replaceOnce('main.js',
`  if ('launchAtStartup' in partial) {
    app.setLoginItemSettings({ openAtLogin: !!partial.launchAtStartup });
  }
  if (notchWin) notchWin.webContents.send('settings-updated', store.store);
  return store.store;
});`,
`  if ('launchAtStartup' in partial) {
    app.setLoginItemSettings({ openAtLogin: !!partial.launchAtStartup });
  }
  if ('globalShortcutEnabled' in partial || 'globalShortcut' in partial) applyGlobalShortcut();
  if (notchWin) notchWin.webContents.send('settings-updated', store.store);
  return store.store;
});`,
  'save-settings');

replaceOnce('main.js',
`ipcMain.handle('reset-settings', () => {
  store.clear();
  clipboardHistoryEnabled = store.get('clipboardHistoryEnabled') !== false;`,
`ipcMain.handle('reset-settings', () => {
  store.clear();
  applyGlobalShortcut();
  clipboardHistoryEnabled = store.get('clipboardHistoryEnabled') !== false;`,
  'reset-settings');

replaceOnce('main.js',
`  createNotchWindow();
  createTray();`,
`  createNotchWindow();
  createTray();
  applyGlobalShortcut();`,
  'whenReady');

replaceOnce('main.js',
`app.on('before-quit', () => {
  appIsQuitting = true;
  destroyTray();`,
`app.on('before-quit', () => {
  appIsQuitting = true;
  unregisterGlobalShortcut();
  destroyTray();`,
  'before-quit');

/* =====================================================================
 *  2. preload.js
 * ===================================================================== */
replaceOnce('preload.js',
  `  quitApp: () => ipcRenderer.send('quit-app'),`,
  `  quitApp: () => ipcRenderer.send('quit-app'),
  getOnboarding: () => ipcRenderer.invoke('get-onboarding'),
  completeOnboarding: () => ipcRenderer.invoke('complete-onboarding'),
  setGlobalShortcut: (accelerator) => ipcRenderer.invoke('set-global-shortcut', accelerator),
  getGlobalShortcutStatus: () => ipcRenderer.invoke('get-global-shortcut-status'),`,
  'preload');

/* =====================================================================
 *  3. package.json — le module shortcut.js doit être embarqué
 * ===================================================================== */
replaceOnce('package.json',
  `      "resume-state.js",`,
  `      "resume-state.js",
      "shortcut.js",`,
  'build.files');

/* =====================================================================
 *  4. index.html
 * ===================================================================== */

/* 4a. réglages : nouvel ordre + nouvelles lignes + groupe Help --------- */
{
  const entry = load('renderer/index.html');
  const re = /^ {8}<div class="settings-group[^"]*">\n[\s\S]*?^ {8}<\/div>\n/gm;
  const matches = [...entry.text.matchAll(re)];
  if (matches.length !== 9) fail('renderer/index.html : 9 groupes de réglages attendus, ' + matches.length + ' trouvés.');
  for (let i = 1; i < matches.length; i++) {
    const gap = entry.text.slice(matches[i - 1].index + matches[i - 1][0].length, matches[i].index);
    if (gap.trim() !== '') fail('renderer/index.html : contenu inattendu entre deux groupes de réglages.');
  }
  const blocks = {};
  for (const m of matches) {
    const title = m[0].match(/settings-group-title">([^<]+)</);
    if (!title) fail('renderer/index.html : groupe de réglages sans titre.');
    blocks[title[1]] = m[0];
  }
  const expected = ['Pomodoro', 'Appearance', 'Pinned pages', 'Calendars', 'Reminders', 'Behavior', 'Sound', 'Updates', 'Privacy'];
  for (const title of expected) if (!blocks[title]) fail('renderer/index.html : groupe « ' + title + ' » introuvable.');

  // Calendars : ancre pour « Add calendar » (bandeau de l'onglet Calendar)
  blocks['Calendars'] = blocks['Calendars'].replace('<div class="settings-group">', '<div class="settings-group" id="settings-calendars">');

  // Behavior : auto-hide + raccourci global juste après « Collapse on outside click »
  const collapseRow = `<input type="checkbox" id="s-collapseOnOutsideClick"><span class="switch-track"></span></label>
          </div>
`;
  if (!blocks['Behavior'].includes(collapseRow)) fail('renderer/index.html : ligne « Collapse on outside click » introuvable.');
  blocks['Behavior'] = blocks['Behavior'].replace(collapseRow, collapseRow + `          <div class="settings-row">
            <span class="row-label">Auto-hide notch<small class="row-sub">Hidden until you push the mouse against the top of the screen</small></span>
            <label class="switch"><input type="checkbox" id="s-autoHide"><span class="switch-track"></span></label>
          </div>
          <div class="settings-row">
            <span class="row-label">Global shortcut<small class="row-sub" id="shortcut-status">Open or collapse the notch from any app</small></span>
            <label class="switch"><input type="checkbox" id="s-globalShortcutEnabled"><span class="switch-track"></span></label>
          </div>
          <div class="settings-row" id="shortcut-row">
            <span class="row-label">Shortcut keys</span>
            <button class="btn ghost shortcut-capture" id="btn-shortcut-capture" type="button" title="Click, then press the new key combination">Ctrl+Alt+N</button>
          </div>
`);

  blocks['Help'] = `        <div class="settings-group">
          <div class="settings-group-title">Help</div>
          <div class="settings-row">
            <span class="row-label">Welcome tour</span>
            <button class="btn ghost" id="btn-show-welcome" type="button">Show</button>
          </div>
        </div>
`;

  const order = ['Pomodoro', 'Appearance', 'Behavior', 'Pinned pages', 'Calendars', 'Reminders', 'Sound', 'Privacy', 'Updates', 'Help'];
  const start = matches[0].index;
  const last = matches[matches.length - 1];
  const end = last.index + last[0].length;
  entry.text = entry.text.slice(0, start) + order.map((t) => blocks[t]).join('\n') + entry.text.slice(end);
}

/* 4b. accueil ---------------------------------------------------------- */
replaceOnce('renderer/index.html',
  `    <!-- État compact pendant qu'un minuteur tourne -->`,
  `    <!-- Accueil du premier lancement (aussi : Réglages > Help > Welcome tour) -->
    <div class="view" id="view-welcome" role="dialog" aria-label="Welcome to Notch Bar">
      <div class="welcome-card">
        <div class="welcome-title">Welcome to Notch Bar</div>
        <ul class="welcome-tips">
          <li>Hover the notch to see your pinned pages.</li>
          <li>Click it to open the full app. Press Esc to collapse.</li>
          <li id="welcome-shortcut-tip">Press <kbd id="welcome-shortcut">Ctrl+Alt+N</kbd> from any app to open or collapse it.</li>
          <li>Right-click the tray icon (next to the clock) for Settings or Quit.</li>
        </ul>
        <button class="btn primary" id="welcome-done" type="button">Got it</button>
      </div>
    </div>

    <!-- État compact pendant qu'un minuteur tourne -->`,
  'vue accueil');

/* 4c. calendrier sans source ----------------------------------------- */
replaceOnce('renderer/index.html',
  `            <div class="calendar-stage" id="calendar-stage"></div>`,
  `            <div class="calendar-empty" id="calendar-empty">
              <span>No calendar yet. Add an iCal link or file in Settings.</span>
              <button class="btn ghost" id="calendar-empty-action" type="button">Add calendar</button>
            </div>
            <div class="calendar-stage" id="calendar-stage"></div>`,
  'bandeau calendrier');

/* 4d. zone de réveil de l'auto-hide ----------------------------------- */
replaceOnce('renderer/index.html',
  `<script src="icons.js"></script>`,
  `<!-- Auto-hide : bande de 4 px en haut de l'écran, seule zone interactive quand le notch est masqué. -->
<div id="autohide-hotzone" hidden aria-hidden="true"></div>
<script src="icons.js"></script>`,
  'hotzone');

/* =====================================================================
 *  5. style.css
 * ===================================================================== */
replaceOnce('renderer/style.css',
  `  --w-update:340px;   --h-update:68px;`,
  `  --w-update:340px;   --h-update:68px;
  --w-welcome:380px;  --h-welcome:262px;`,
  ':root welcome');

replaceOnce('renderer/style.css',
  `body.mode-update #capsule{
  width:var(--w-update); height:var(--h-update);`,
  `body.mode-welcome #capsule{
  width:var(--w-welcome); height:var(--h-welcome);
}
body.mode-update #capsule{
  width:var(--w-update); height:var(--h-update);`,
  'capsule welcome');

replaceOnce('renderer/style.css',
  `body.mode-update .view#view-update{ opacity:1; pointer-events:auto; transform:translateY(0) scale(1); --view-delay:.09s; }`,
  `body.mode-update .view#view-update{ opacity:1; pointer-events:auto; transform:translateY(0) scale(1); --view-delay:.09s; }
body.mode-welcome .view#view-welcome{ opacity:1; pointer-events:auto; transform:translateY(0) scale(1); --view-delay:.09s; }`,
  'view welcome');

// Auto-hide : la capsule et le notch média glissent hors de l'écran (propriété
// "translate", indépendante du "transform" déjà utilisé pour le décalage média).
replaceOnce('renderer/style.css',
  `             height var(--capsule-dur) var(--capsule-ease),
             transform .42s var(--capsule-ease);
}`,
  `             height var(--capsule-dur) var(--capsule-ease),
             transform .42s var(--capsule-ease),
             translate .32s var(--capsule-ease);
}`,
  'transition capsule');

replaceOnce('renderer/style.css',
  `             opacity .2s ease;
}
#media-notch[hidden]{ display:none; }`,
  `             opacity .2s ease,
             translate .32s var(--capsule-ease);
}
#media-notch[hidden]{ display:none; }`,
  'transition media');

{
  const entry = load('renderer/style.css');
  entry.text = entry.text.replace(/\s*$/, '\n') + String.raw`
/* ==================== AUTO-HIDE ==================== */
/* data-autohide="away" est posé sur <body> par app.js (un attribut survit aux
   changements de classe mode-xxx). 8 px de plus que la hauteur : rien ne dépasse. */
body[data-autohide="away"] #capsule,
body[data-autohide="away"] #media-notch{ translate:0 calc(-100% - 8px); }
body[data-autohide="away"] #capsule{ pointer-events:none; }
body.reduce-motion #capsule, body.reduce-motion #media-notch{ transition:none; }
#autohide-hotzone{ position:fixed; top:0; z-index:60; height:4px; background:transparent; }
#autohide-hotzone[hidden]{ display:none; }

/* ==================== RÉGLAGES : sous-textes et raccourci ==================== */
.row-sub{ display:block; margin-top:2px; font-size:10px; font-weight:400; line-height:1.3; color:var(--sub); }
.row-sub.warn{ color:var(--orange); }
.shortcut-capture{ min-width:96px; flex:none; font-variant-numeric:tabular-nums; }
.shortcut-capture.capturing{ border-color:var(--accent); color:var(--accent); }
.settings-row.is-disabled .shortcut-capture{ opacity:.4; pointer-events:none; }

/* ==================== ACCUEIL ==================== */
#view-welcome{ height:var(--h-welcome); }
.welcome-card{ width:100%; height:100%; box-sizing:border-box; padding:18px 22px 16px; display:flex; flex-direction:column; gap:10px; }
.welcome-title{ font-size:15px; font-weight:700; letter-spacing:.01em; }
.welcome-tips{ list-style:none; margin:0; padding:0; display:grid; gap:9px; counter-reset:tip; flex:1; align-content:center; }
.welcome-tips li{ display:flex; gap:10px; align-items:flex-start; font-size:12.5px; line-height:1.35; color:var(--text); counter-increment:tip; }
.welcome-tips li::before{ content:counter(tip); flex:none; width:18px; height:18px; margin-top:0; border-radius:50%; background:var(--accent); color:#fff; font-size:10.5px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.welcome-tips kbd{ font-family:inherit; font-size:11px; font-weight:650; background:var(--panel2); border:1px solid var(--border); border-radius:6px; padding:1px 6px; white-space:nowrap; }
.welcome-card .btn{ align-self:flex-end; }

/* ==================== CALENDRIER : état vide ==================== */
.calendar-empty{ flex:none; display:flex; align-items:center; justify-content:space-between; gap:10px; margin:0 0 8px; padding:6px 6px 6px 11px; background:var(--panel2); border:1px solid var(--border); border-radius:10px; font-size:11.5px; color:var(--sub); }
.calendar-empty[hidden]{ display:none; }
.calendar-empty .btn{ flex:none; padding:5px 10px; font-size:11px; }
`;
}

/* =====================================================================
 *  6. planner.js — bandeau « Add calendar » tant qu'aucune source n'existe
 * ===================================================================== */
replaceOnce('renderer/planner.js',
`  state.events = mergeEnabledCalendarEvents(state.calendarSources);
}

async function persistCalendarSources() {`,
`  state.events = mergeEnabledCalendarEvents(state.calendarSources);
  renderCalendarEmptyState();
}

// Bandeau visible par défaut (aucune source) ; masqué dès qu'un calendrier existe.
function renderCalendarEmptyState() {
  const banner = document.getElementById('calendar-empty');
  if (banner) banner.hidden = state.calendarSources.length > 0;
}

async function persistCalendarSources() {`,
  'planner setCalendarSources');

/* =====================================================================
 *  7. app.js
 * ===================================================================== */

/* 7a. zone interactive : seulement la bande de réveil quand le notch est masqué */
replaceOnce('renderer/app.js',
`  const rects = [rectForInput(capsuleEl, edgePad)];
  const media = $('media-notch');
  if(media && !media.hidden) rects.push(rectForInput(media));`,
`  const away = body.dataset.autohide === 'away';
  const rects = away ? [rectForInput($('autohide-hotzone'))] : [rectForInput(capsuleEl, edgePad)];
  const media = $('media-notch');
  if(!away && media && !media.hidden) rects.push(rectForInput(media));`,
  'syncInteractiveRegion');

/* 7b. auto-hide : état + setMode */
replaceOnce('renderer/app.js',
`function setMode(next){
  if(next === mode) return;
  const leaving = mode;
  mode = next;
  body.className = 'mode-' + next + (settings.reduceMotion ? ' reduce-motion' : '');
  if(leaving === 'update') onLeaveUpdateMode();
  else if(updateBannerPending && (next === 'pill' || next === 'running')) setTimeout(showPendingUpdateBanner, 1200);
}`,
String.raw`/* ==================== AUTO-HIDE ====================
   Réglage « Auto-hide notch » : au repos (mode pill, rien à signaler) le notch
   glisse hors de l'écran après AUTOHIDE_HIDE_DELAY_MS. Une bande de 4 px en haut
   de l'écran (#autohide-hotzone) devient alors la SEULE zone interactive de la
   fenêtre : la souris collée en haut pendant AUTOHIDE_REVEAL_DELAY_MS le fait
   réapparaître. Il reste affiché tant qu'une autre vue est active (minuteur,
   rappel, mise à jour, vue ouverte, notification Bluetooth, notch média déplié).
   L'état « masqué » est un attribut de <body> (data-autohide) : contrairement à
   une classe, il survit à setMode qui réécrit body.className. */
const AUTOHIDE_REVEAL_DELAY_MS = 50;
const AUTOHIDE_HIDE_DELAY_MS = 700;
let autoHidePointerIn = false;     // souris sur la capsule ou le notch média
let autoHideHideTimer = null;
let autoHideRevealTimer = null;

function autoHideIdle(){
  return !!settings.autoHide && mode === 'pill' && !autoHidePointerIn
    && body.dataset.accessoryState !== 'visible'
    && body.dataset.mediaState !== 'expanded';
}

function autoHideShow(){
  clearTimeout(autoHideRevealTimer);
  autoHideRevealTimer = null;
  if(body.dataset.autohide !== 'away') return;
  delete body.dataset.autohide;
  $('autohide-hotzone').hidden = true;
  syncInteractiveRegion();
}

function autoHideAwayNow(){
  autoHideHideTimer = null;
  if(!autoHideIdle() || body.dataset.autohide === 'away') return;
  // La bande de réveil épouse la largeur de la capsule, mesurée AVANT de la masquer.
  const rect = capsuleEl.getBoundingClientRect();
  const zone = $('autohide-hotzone');
  zone.style.left = Math.round(rect.left) + 'px';
  zone.style.width = Math.max(60, Math.round(rect.width)) + 'px';
  zone.hidden = false;
  body.dataset.autohide = 'away';
  syncInteractiveRegion();
  setWindowMouseIgnored(true, { forward: true });
}

function autoHideEvaluate(){
  clearTimeout(autoHideHideTimer);
  autoHideHideTimer = null;
  if(autoHideIdle()){
    if(body.dataset.autohide !== 'away') autoHideHideTimer = setTimeout(autoHideAwayNow, AUTOHIDE_HIDE_DELAY_MS);
  } else {
    autoHideShow();
  }
}

function autoHideReveal(){
  autoHideShow();
  setWindowMouseIgnored(false);
  if(mode === 'pill') setMode('hover');
  // Si la souris n'est finalement pas sur la capsule (aucun mouseenter reçu), on
  // revient à l'état de repos au lieu de laisser la vue survolée ouverte.
  setTimeout(() => {
    if(mode === 'hover' && !capsuleEl.matches(':hover')){
      autoHidePointerIn = false;
      setMode('pill');
    }
  }, 900);
}

{
  const zone = $('autohide-hotzone');
  zone.addEventListener('mouseenter', () => {
    clearTimeout(autoHideRevealTimer);
    autoHideRevealTimer = setTimeout(autoHideReveal, AUTOHIDE_REVEAL_DELAY_MS);
  });
  zone.addEventListener('mouseleave', () => { clearTimeout(autoHideRevealTimer); autoHideRevealTimer = null; });
  // Un fichier glissé vers le haut de l'écran (pour la Shelf) réveille le notch tout de suite.
  zone.addEventListener('dragenter', autoHideReveal);
  new MutationObserver(() => autoHideEvaluate()).observe(body, {
    attributes: true,
    attributeFilter: ['data-accessory-state', 'data-media-state'],
  });
}

function setMode(next){
  if(next === mode) return;
  const leaving = mode;
  mode = next;
  body.className = 'mode-' + next + (settings.reduceMotion ? ' reduce-motion' : '');
  if(leaving === 'update') onLeaveUpdateMode();
  else if(updateBannerPending && (next === 'pill' || next === 'running')) setTimeout(showPendingUpdateBanner, 1200);
  autoHideEvaluate();
}`,
  'setMode');

/* 7c. auto-hide : la souris sur la capsule / le notch média empêche de masquer */
replaceOnce('renderer/app.js',
`  if(mode==='hover') setMode('pill');
});

function requestWindowMode(kind){`,
`  if(mode==='hover') setMode('pill');
});
for(const surface of [capsuleEl, $('media-notch')]){
  if(!surface) continue;
  surface.addEventListener('mouseenter', () => { autoHidePointerIn = true; autoHideEvaluate(); });
  surface.addEventListener('mouseleave', () => { autoHidePointerIn = false; autoHideEvaluate(); });
}

function requestWindowMode(kind){`,
  'listeners capsule');

/* 7d. réglages appliqués -> auto-hide réévalué */
replaceOnce('renderer/app.js',
`  renderPomo(); renderTimer(); renderStopwatch();
  renderAnalytics();
}`,
`  renderPomo(); renderTimer(); renderStopwatch();
  renderAnalytics();
  autoHideEvaluate();
}`,
  'applySettings');

/* 7e. Échap ferme l'accueil */
replaceOnce('renderer/app.js',
`  if(mode === 'settings'){ closeSettingsPanel(); return; }
  if(e.target instanceof Element`,
`  if(mode === 'welcome'){ dismissWelcome(); return; }
  if(mode === 'settings'){ closeSettingsPanel(); return; }
  if(e.target instanceof Element`,
  'escape welcome');

/* 7f. icône de notification / raccourci global : commande « toggle » */
replaceOnce('renderer/app.js',
`  setWindowMouseIgnored(false);
  if(command === 'settings') openSettingsPanel();
  else if(!OUTSIDE_COLLAPSIBLE_MODES.has(mode)) openCurrentView();
});`,
`  setWindowMouseIgnored(false);
  // Pendant la capture d'une nouvelle combinaison, la combinaison actuelle
  // déclencherait « toggle » : on l'ignore.
  if(command === 'toggle' && shortcutCapturing) return;
  if(mode === 'welcome' && command !== 'toggle') dismissWelcome();
  if(command === 'toggle'){
    // Raccourci global : ouvre si compact, replie si ouvert.
    if(mode === 'welcome') dismissWelcome();
    else if(OUTSIDE_COLLAPSIBLE_MODES.has(mode)) collapseToCompact();
    else openCurrentView();
  }
  else if(command === 'settings') openSettingsPanel();
  else if(!OUTSIDE_COLLAPSIBLE_MODES.has(mode)) openCurrentView();
});`,
  'tray-command');

/* 7g. réglages : lignes ajoutées + interrupteurs */
replaceOnce('renderer/app.js',
`  $('s-collapseOnOutsideClick').checked = settings.collapseOnOutsideClick !== false;
  renderUpdateState(updateState);`,
`  $('s-collapseOnOutsideClick').checked = settings.collapseOnOutsideClick !== false;
  $('s-autoHide').checked = !!settings.autoHide;
  $('s-globalShortcutEnabled').checked = settings.globalShortcutEnabled !== false;
  renderShortcutSettings();
  refreshShortcutStatus();
  renderUpdateState(updateState);`,
  'populateSettingsUI');

replaceOnce('renderer/app.js',
  `'collapseOnOutsideClick', 'soundEnabled'`,
  `'collapseOnOutsideClick', 'autoHide', 'globalShortcutEnabled', 'soundEnabled'`,
  'liste interrupteurs');

/* 7h. accueil, raccourci, « Add calendar » */
replaceOnce('renderer/app.js',
  `/* ---- steppers (durées pomodoro) ---- */`,
  String.raw`/* ---- ouvrir les réglages directement sur un groupe (ex. « Add calendar ») ---- */
window.openSettingsAt = function openSettingsAt(groupId, focusId){
  openSettingsPanel();
  setTimeout(() => {
    const group = $(groupId);
    const scroller = document.querySelector('.settings-scroll');
    if(group && scroller){
      // On règle scrollTop nous-mêmes : scrollIntoView ferait aussi défiler la
      // capsule (overflow:hidden) et décalerait toute la vue.
      scroller.scrollTop += group.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 2;
    }
    const field = focusId && $(focusId);
    if(field) field.focus({ preventScroll: true });
  }, 80);
};
$('calendar-empty-action').addEventListener('click', () => window.openSettingsAt('settings-calendars', 'calendar-settings-url'));

/* ==================== ACCUEIL (premier lancement) ====================
   Vue 'welcome' : la capsule s'agrandit, lueur bleue, et ne se replie pas au clic
   extérieur (absente de OUTSIDE_COLLAPSIBLE_MODES) : on ne veut pas qu'elle
   disparaisse avant d'avoir été lue. Fermée par « Got it », Échap, ou le raccourci. */
function formatAccelerator(accelerator){
  return String(accelerator || '').replace(/\b(CommandOrControl|CmdOrCtrl|Control)\b/g, 'Ctrl').replace(/\bSuper\b/g, 'Win');
}
function renderWelcomeShortcut(){
  $('welcome-shortcut').textContent = formatAccelerator(settings.globalShortcut || 'Ctrl+Alt+N');
  $('welcome-shortcut-tip').hidden = settings.globalShortcutEnabled === false;
}
function showWelcome(){
  if(mode === 'welcome') return;
  renderWelcomeShortcut();
  requestWindowMode('notch');
  setEdge('blue', 'spin');
  setMode('welcome');
}
function dismissWelcome(){
  if(mode !== 'welcome') return;
  if(window.api.completeOnboarding) window.api.completeOnboarding().catch(() => {});
  restoreToolEdge();
  requestWindowMode('notch');
  setMode(activeTool ? 'running' : 'pill');
}
$('welcome-done').addEventListener('click', dismissWelcome);
$('btn-show-welcome').addEventListener('click', showWelcome);
if(window.api.getOnboarding){
  window.api.getOnboarding()
    .then((state) => { if(state && state.show) setTimeout(showWelcome, 1200); })
    .catch(() => {});
}

/* ==================== RACCOURCI CLAVIER GLOBAL ====================
   Le process principal enregistre la combinaison (shortcut.js valide le format).
   Ici : affichage, et capture d'une nouvelle combinaison au clic sur le bouton. */
const shortcutBtn = $('btn-shortcut-capture');
let shortcutCapturing = false;

function renderShortcutSettings(){
  shortcutBtn.textContent = shortcutCapturing ? 'Press keys…' : formatAccelerator(settings.globalShortcut || 'Ctrl+Alt+N');
  shortcutBtn.classList.toggle('capturing', shortcutCapturing);
  $('shortcut-row').classList.toggle('is-disabled', settings.globalShortcutEnabled === false);
}
function setShortcutStatus(text, warn){
  const el = $('shortcut-status');
  el.textContent = text || 'Open or collapse the notch from any app';
  el.classList.toggle('warn', !!warn);
}
function refreshShortcutStatus(){
  if(!window.api.getGlobalShortcutStatus) return;
  window.api.getGlobalShortcutStatus().then((status) => {
    if(status && status.enabled && !status.registered) setShortcutStatus('Unavailable: already used by another app. Pick another combination.', true);
    else setShortcutStatus('');
  }).catch(() => {});
}
// Combinaison pressée -> accélérateur Electron, ou null (touche seule) / 'unsupported'.
function acceleratorFromEvent(e){
  if(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta'].includes(e.key)) return null;
  const mods = [];
  if(e.ctrlKey) mods.push('Ctrl');
  if(e.altKey) mods.push('Alt');
  if(e.shiftKey) mods.push('Shift');
  if(e.metaKey) mods.push('Super');
  if(!mods.length) return 'needs-modifier';
  const named = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace', Tab: 'Tab', Enter: 'Enter' };
  let key = null;
  if(/^[a-z0-9]$/i.test(e.key)) key = e.key.toUpperCase();
  else if(/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  else if(named[e.key]) key = named[e.key];
  else if(/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  if(!key) return 'unsupported';
  return mods.join('+') + '+' + key;
}
function stopShortcutCapture(){
  shortcutCapturing = false;
  document.removeEventListener('keydown', onShortcutKeydown, true);
  renderShortcutSettings();
}
function onShortcutKeydown(e){
  e.preventDefault();
  e.stopPropagation();
  if(e.key === 'Escape'){ stopShortcutCapture(); return; }
  const result = acceleratorFromEvent(e);
  if(result === null) return; // seulement des modificateurs pour l'instant
  if(result === 'needs-modifier'){ setShortcutStatus('Hold Ctrl, Alt or Shift while pressing the key.', true); return; }
  if(result === 'unsupported'){ setShortcutStatus('This key is not supported. Try a letter, digit or F-key.', true); return; }
  stopShortcutCapture();
  if(!window.api.setGlobalShortcut) return;
  window.api.setGlobalShortcut(result).then((res) => {
    if(res && res.ok){ settings.globalShortcut = res.accelerator; renderShortcutSettings(); setShortcutStatus(''); }
    else setShortcutStatus('Already used by another app or reserved by Windows. Kept ' + formatAccelerator(res && res.accelerator) + '.', true);
  }).catch(() => setShortcutStatus('Could not change the shortcut.', true));
}
shortcutBtn.addEventListener('click', () => {
  if(shortcutCapturing){ stopShortcutCapture(); return; }
  shortcutCapturing = true;
  renderShortcutSettings();
  setShortcutStatus('Press the new combination, or Esc to cancel.');
  document.addEventListener('keydown', onShortcutKeydown, true);
});
shortcutBtn.addEventListener('blur', () => { if(shortcutCapturing) stopShortcutCapture(); });

/* ---- steppers (durées pomodoro) ---- */`,
  'bloc accueil + raccourci');

/* =====================================================================
 *  8. tests
 * ===================================================================== */
if (fs.existsSync(file('tests/electron-smoke.cjs'))) {
  const smoke = load('tests/electron-smoke.cjs');
  const anchor = "ipcMain.handle('reset-settings', () => ({}));";
  if (smoke.text.includes(anchor) && !smoke.text.includes("'get-onboarding'")) {
    smoke.text = smoke.text.replace(anchor, anchor + String.raw`
ipcMain.handle('get-onboarding', () => ({ show:false }));
ipcMain.handle('complete-onboarding', () => true);
ipcMain.handle('set-global-shortcut', (_, accelerator) => ({ ok:true, accelerator }));
ipcMain.handle('get-global-shortcut-status', () => ({ enabled:true, accelerator:'Ctrl+Alt+N', registered:true }));`);
  }
}

addNewFile('tests/onboarding-autohide.test.mjs', String.raw`import test from 'node:test';
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
`);

/* =====================================================================
 *  9. MODIFICATIONS.md
 * ===================================================================== */
{
  const entry = load('MODIFICATIONS.md');
  entry.text = entry.text.replace(/\s*$/, '\n') + String.raw`
## v1.5.0 — Welcome, calendar empty state, settings order, global shortcut, auto-hide

- First-launch welcome: the capsule expands with four tips (hover, click, shortcut, tray icon). Stored apart from the settings (new ${'`'}app-state${'`'} store) so "Reset settings" does not bring it back; existing installs are marked as seen. Replay it from Settings > Help > Welcome tour; ${'`'}NOTCH_FORCE_WELCOME=1${'`'} forces it for testing.
- Calendar tab with no calendar: an "Add calendar" banner opens Settings scrolled to the Calendars group with the URL field focused.
- Settings regrouped by frequency of use: Pomodoro, Appearance, Behavior, Pinned pages, Calendars, Reminders, Sound, Privacy, Updates, Help.
- Global keyboard shortcut (default Ctrl+Alt+N) opens the notch or collapses it from any app; it can be disabled or changed in Behavior (click the key box, press the new combination). A combination refused by the OS is reported and the previous one is kept. Validation lives in ${'`'}shortcut.js${'`'} (unit tested).
- Auto-hide notch (Behavior): the idle notch slides off-screen; pushing the mouse against the top of the screen for 50 ms brings it back. While hidden, only a 4 px strip at the top is interactive. It stays visible during timers, reminders, updates, Bluetooth notifications and any open view. The global shortcut and the tray icon also reveal it.
- Added tests/onboarding-autohide.test.mjs.
`.replace(/\$\{'`'\}/g, '`');
}

/* =====================================================================
 *  10. version (nouvelle fonctionnalité => version mineure)
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
      /("name": "notch-bar",\s*"version": ")[^"]+(")/g,
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
console.log('Voir l\'accueil (cmd) :   set NOTCH_FORCE_WELCOME=1 && npm start');
console.log('\nPuis publie :\n');
console.log('  git add -A');
console.log('  git commit -m "v' + version + ' : accueil, calendrier vide, réglages réordonnés, raccourci global, auto-hide"');
console.log('  git tag v' + version);
console.log('  git push origin main v' + version + '\n');
