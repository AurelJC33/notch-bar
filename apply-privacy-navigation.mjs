// Notch Bar — confidentialité + navigation + calendrier réduit/agrandi
//
// Usage (depuis la racine du projet) :
//   node tools/apply-privacy-navigation.mjs
//   npm run check
//
// Ce que fait le script :
//  1. Météo : retire le service ip-api.com (HTTP non chiffré), ajoute l'interrupteur
//     « Weather » dans Settings > Privacy (désactivé = plus aucune requête réseau).
//  2. Presse-papiers : bouton « Clear » (Settings > Privacy et en-tête de l'onglet
//     Clipboard, avec confirmation par second clic) qui supprime aussi les fichiers.
//  3. Onglets : icône seule, libellé visible uniquement sur l'onglet actif ; rôles ARIA
//     (tablist / tab / tabpanel) ; flèches, Début/Fin, Ctrl+1..6 ; onglet courant mémorisé.
//  4. Calendrier : vue réduite par défaut (Mois/Jour sans les tâches) + bouton
//     « Agrandir » qui affiche la vue complète avec les tâches (et « Réduire » pour revenir).
//
// Le script est tout-ou-rien : si un repère n'est pas trouvé, rien n'est écrit.
// Il peut être relancé sans danger (les modifications déjà faites sont ignorées).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const files = new Map(); // chemin -> { text, eol, changed }

function load(rel) {
  if (!files.has(rel)) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) fail(`Fichier introuvable : ${rel} (lance le script depuis la racine du projet).`);
    const raw = readFileSync(abs, 'utf8');
    files.set(rel, { text: raw, eol: raw.includes('\r\n') ? '\r\n' : '\n', changed: false });
  }
  return files.get(rel);
}

function fail(message) {
  console.error('\n✖ ' + message + '\nAucun fichier n\'a été modifié.');
  process.exit(1);
}

const log = [];

/** Remplace `find` par `replace` (une seule occurrence exigée). `skipIf` : déjà appliqué. */
function patch(rel, name, { find, replace, skipIf }) {
  const file = load(rel);
  const eol = (s) => s.replace(/\r?\n/g, file.eol);
  if (skipIf && file.text.includes(eol(skipIf))) return log.push(`= ${rel} — ${name} (déjà fait)`);
  const anchor = eol(find);
  const count = file.text.split(anchor).length - 1;
  if (count !== 1) fail(`${rel} — « ${name} » : repère trouvé ${count} fois (1 attendu).\nRepère :\n${find.slice(0, 300)}`);
  file.text = file.text.replace(anchor, () => eol(replace));
  file.changed = true;
  log.push(`✔ ${rel} — ${name}`);
}

/** Ajoute un bloc à la fin du fichier (une seule fois, repéré par un marqueur). */
function append(rel, name, marker, block) {
  const file = load(rel);
  if (file.text.includes(marker)) return log.push(`= ${rel} — ${name} (déjà fait)`);
  const eol = (s) => s.replace(/\r?\n/g, file.eol);
  file.text = file.text.replace(/\s*$/, '') + file.eol + file.eol + eol(block);
  file.changed = true;
  log.push(`✔ ${rel} — ${name}`);
}

/* =====================================================================
 *  main.js
 * ===================================================================== */

patch('main.js', 'réglages par défaut (météo, dernier onglet)', {
  skipIf: '    weatherEnabled: true,',
  find: `    globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
  },
});`,
  replace: `    globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
    weatherEnabled: true,
    lastTab: 'pomodoro',
  },
});`,
});

patch('main.js', 'retrait du fournisseur ip-api.com (HTTP)', {
  skipIf: '// HTTPS uniquement',
  find: `  async () => {
    const res = await withTimeout(fetch('http://ip-api.com/json/'), 6000);
    if (!res.ok) throw new Error('ip-api.com HTTP ' + res.status);
    const data = await res.json();
    if (data.status !== 'success' || typeof data.lat !== 'number' || typeof data.lon !== 'number') {
      throw new Error('ip-api.com: coordonnées manquantes (' + JSON.stringify(data).slice(0, 120) + ')');
    }
    return { lat: data.lat, lon: data.lon };
  },
];`,
  replace: `  // HTTPS uniquement : un service en HTTP clair laisserait l'adresse IP (et donc
  // la position approximative) lisible par n'importe qui sur le réseau.
];`,
});

patch('main.js', 'fetchWeather : respecte l\'interrupteur (avant et après les requêtes)', {
  skipIf: 'if (weatherDisabled()) return null;\n    const loc',
  find: `    const loc = await resolveLocation();
    if (!loc) return null;`,
  replace: `    if (weatherDisabled()) return null;
    const loc = await resolveLocation();
    if (!loc || weatherDisabled()) return null;`,
});

patch('main.js', 'fetchWeather : ignore une réponse arrivée après la désactivation', {
  skipIf: '    if (weatherDisabled()) return null;\n    weatherCache = {',
  find: `    const data = await res.json();
    weatherCache = {`,
  replace: `    const data = await res.json();
    if (weatherDisabled()) return null;
    weatherCache = {`,
});

patch('main.js', 'boucle météo : démarrage / arrêt selon le réglage', {
  skipIf: 'function applyWeatherSetting()',
  find: `function startWeatherLoop() {
  fetchWeather();
  clearInterval(weatherTimer);
  weatherTimer = setInterval(fetchWeather, WEATHER_REFRESH_MS);
}`,
  replace: `function weatherDisabled() {
  return store.get('weatherEnabled') === false;
}

function startWeatherLoop() {
  clearInterval(weatherTimer);
  weatherTimer = null;
  if (weatherDisabled()) return; // interrupteur coupé : aucune requête réseau
  fetchWeather();
  weatherTimer = setInterval(fetchWeather, WEATHER_REFRESH_MS);
}

/** Arrête les requêtes et oublie la position et la dernière mesure. */
function stopWeatherLoop() {
  clearInterval(weatherTimer);
  weatherTimer = null;
  geoCache = null;
  weatherCache = { temp: null, icon: 'weather-clear', updatedAt: 0 };
}

function applyWeatherSetting() {
  if (weatherDisabled()) stopWeatherLoop();
  else if (!weatherTimer) startWeatherLoop();
}`,
});

patch('main.js', 'save-settings : applique le réglage météo', {
  skipIf: "if ('weatherEnabled' in partial) applyWeatherSetting();",
  find: `  if ('globalShortcutEnabled' in partial || 'globalShortcut' in partial) applyGlobalShortcut();`,
  replace: `  if ('globalShortcutEnabled' in partial || 'globalShortcut' in partial) applyGlobalShortcut();
  if ('weatherEnabled' in partial) applyWeatherSetting();`,
});

patch('main.js', 'reset-settings : réapplique le réglage météo', {
  skipIf: '  store.clear();\n  applyGlobalShortcut();\n  applyWeatherSetting();',
  find: `  store.clear();
  applyGlobalShortcut();
`,
  replace: `  store.clear();
  applyGlobalShortcut();
  applyWeatherSetting();
`,
});

patch('main.js', 'fonction clearClipboardHistory', {
  skipIf: 'function clearClipboardHistory()',
  find: `function addClipboardHistoryItem(snapshot) {`,
  replace: `/**
 * Vide tout l'historique : entrées, images et formats bruts sur le disque.
 * clipboardLastFingerprint n'est volontairement pas remis à zéro : le contenu
 * qui est encore dans le presse-papiers de Windows ne doit pas être ré-enregistré
 * aussitôt après avoir été effacé.
 */
function clearClipboardHistory() {
  for (const item of getClipboardHistoryRawItems()) removeClipboardHistoryItemFiles(item);
  clipboardHistoryStore.set('items', []);
  try { fs.rmSync(clipboardHistoryMediaDir(), { recursive: true, force: true }); } catch {}
  if (notchWin && !notchWin.isDestroyed()) notchWin.webContents.send('clipboard-history-updated', []);
  return [];
}

function addClipboardHistoryItem(snapshot) {`,
});

patch('main.js', 'IPC clear-clipboard-history', {
  skipIf: "ipcMain.handle('clear-clipboard-history'",
  find: `ipcMain.handle('clipboard-history-copy', (event, id) => restoreClipboardHistoryItem(id));`,
  replace: `ipcMain.handle('clipboard-history-copy', (event, id) => restoreClipboardHistoryItem(id));
ipcMain.handle('clear-clipboard-history', () => clearClipboardHistory());`,
});

/* =====================================================================
 *  preload.js
 * ===================================================================== */

patch('preload.js', 'pont clearClipboardHistory', {
  skipIf: 'clearClipboardHistory:',
  find: `  getClipboardHistory: () => ipcRenderer.invoke('get-clipboard-history'),`,
  replace: `  getClipboardHistory: () => ipcRenderer.invoke('get-clipboard-history'),
  clearClipboardHistory: () => ipcRenderer.invoke('clear-clipboard-history'),`,
});

/* =====================================================================
 *  renderer/index.html
 * ===================================================================== */

patch('renderer/index.html', 'CSP : ip-api.com retiré', {
  skipIf: 'connect-src https://ipapi.co https://ipwho.is https://api.open-meteo.com"',
  find: `https://ipwho.is http://ip-api.com https://api.open-meteo.com`,
  replace: `https://ipwho.is https://api.open-meteo.com`,
});

patch('renderer/index.html', 'onglets : ARIA + libellé réservé à l\'onglet actif', {
  skipIf: 'role="tablist"',
  find: `        <div class="tabs">
          <button class="tab active" data-tab="pomodoro"><span class="icon" data-icon="focus"></span>Pomodoro</button>
          <button class="tab" data-tab="schedule"><span class="icon" data-icon="calendar"></span>Calendar</button>
          <button class="tab" data-tab="timer"><span class="icon" data-icon="timer"></span>Timer</button>
          <button class="tab" data-tab="stopwatch"><span class="icon" data-icon="stopwatch"></span>Stopwatch</button>
          <button class="tab" data-tab="clipboard"><span class="icon" data-icon="clipboard"></span>Clipboard</button>
          <button class="tab" data-tab="analytics"><span class="icon" data-icon="analytics"></span>Analytics</button>
        </div>`,
  replace: `        <div class="tabs" role="tablist" aria-label="Pages">
          <button class="tab active" id="tab-pomodoro" role="tab" aria-selected="true" aria-controls="panel-pomodoro" aria-label="Pomodoro" title="Pomodoro (Ctrl+1)" tabindex="0" data-tab="pomodoro"><span class="icon" data-icon="focus"></span><span class="tab-label">Pomodoro</span></button>
          <button class="tab" id="tab-schedule" role="tab" aria-selected="false" aria-controls="panel-schedule" aria-label="Calendar" title="Calendar (Ctrl+2)" tabindex="-1" data-tab="schedule"><span class="icon" data-icon="calendar"></span><span class="tab-label">Calendar</span></button>
          <button class="tab" id="tab-timer" role="tab" aria-selected="false" aria-controls="panel-timer" aria-label="Timer" title="Timer (Ctrl+3)" tabindex="-1" data-tab="timer"><span class="icon" data-icon="timer"></span><span class="tab-label">Timer</span></button>
          <button class="tab" id="tab-stopwatch" role="tab" aria-selected="false" aria-controls="panel-stopwatch" aria-label="Stopwatch" title="Stopwatch (Ctrl+4)" tabindex="-1" data-tab="stopwatch"><span class="icon" data-icon="stopwatch"></span><span class="tab-label">Stopwatch</span></button>
          <button class="tab" id="tab-clipboard" role="tab" aria-selected="false" aria-controls="panel-clipboard" aria-label="Clipboard" title="Clipboard (Ctrl+5)" tabindex="-1" data-tab="clipboard"><span class="icon" data-icon="clipboard"></span><span class="tab-label">Clipboard</span></button>
          <button class="tab" id="tab-analytics" role="tab" aria-selected="false" aria-controls="panel-analytics" aria-label="Analytics" title="Analytics (Ctrl+6)" tabindex="-1" data-tab="analytics"><span class="icon" data-icon="analytics"></span><span class="tab-label">Analytics</span></button>
        </div>`,
});

patch('renderer/index.html', 'calendrier : boutons Agrandir / Réduire', {
  skipIf: 'id="calendar-expand"',
  find: `                  <button class="seg-btn" data-view="day">Day</button>
                </div>
`,
  replace: `                  <button class="seg-btn" data-view="day">Day</button>
                </div>
                <button class="icon-btn calendar-expand-btn" id="calendar-expand" type="button" title="Expand calendar (show tasks)" aria-label="Expand calendar"><span class="icon" data-icon="expand"></span></button>
                <button class="icon-btn calendar-expand-btn" id="calendar-collapse" type="button" title="Collapse calendar (hide tasks)" aria-label="Collapse calendar"><span class="icon" data-icon="shrink"></span></button>
`,
});

patch('renderer/index.html', 'Clipboard : bouton « vider l\'historique »', {
  skipIf: 'id="clipboard-clear"',
  find: `          <button class="icon-btn" id="clipboard-refresh" type="button" title="Refresh clipboard history" aria-label="Refresh clipboard history"><span class="icon" data-icon="refresh"></span></button>`,
  replace: `          <div class="clipboard-actions">
            <button class="icon-btn" id="clipboard-refresh" type="button" title="Refresh clipboard history" aria-label="Refresh clipboard history"><span class="icon" data-icon="refresh"></span></button>
            <button class="icon-btn" id="clipboard-clear" type="button" title="Clear clipboard history" aria-label="Clear clipboard history" disabled><span class="icon" data-icon="trash"></span></button>
          </div>`,
});

patch('renderer/index.html', 'Settings > Privacy : Clear + Weather', {
  skipIf: 'id="s-weatherEnabled"',
  find: `            <label class="switch"><input type="checkbox" id="s-clipboardHistoryEnabled"><span class="switch-track"></span></label>
          </div>
`,
  replace: `            <label class="switch"><input type="checkbox" id="s-clipboardHistoryEnabled"><span class="switch-track"></span></label>
          </div>
          <div class="settings-row">
            <div class="update-info">
              <span class="row-label">Clear clipboard history</span>
              <p class="settings-help">Deletes every saved copy (text, images) from this computer.</p>
            </div>
            <button class="btn ghost" id="btn-clear-clipboard" type="button">Clear</button>
          </div>
          <div class="settings-row">
            <div class="update-info">
              <span class="row-label">Weather</span>
              <p class="settings-help">Finds your approximate location from your IP address (ipapi.co, ipwho.is), then asks open-meteo.com for the temperature. Turn off to stop all requests.</p>
            </div>
            <label class="switch"><input type="checkbox" id="s-weatherEnabled"><span class="switch-track"></span></label>
          </div>
`,
});

/* =====================================================================
 *  renderer/app.js
 * ===================================================================== */

patch('renderer/app.js', 'réglages par défaut (météo, dernier onglet)', {
  skipIf: '  weatherEnabled: true,\n  lastTab',
  find: `  pinnedPages: ['pomodoro', 'schedule', 'timer', 'stopwatch'],
};
window.__notchSettings = settings;`,
  replace: `  pinnedPages: ['pomodoro', 'schedule', 'timer', 'stopwatch'],
  weatherEnabled: true,
  lastTab: 'pomodoro',
};
window.__notchSettings = settings;`,
});

patch('renderer/app.js', 'état « calendrier agrandi »', {
  skipIf: 'let calendarExpanded',
  find: `let currentTab = 'pomodoro';
`,
  replace: `let currentTab = 'pomodoro';
// Calendrier : réduit (Mois/Jour seuls, mode 'expanded') ou agrandi (avec les tâches,
// mode 'schedule'). Garde en mémoire pour la session uniquement ; réduit au lancement.
let calendarExpanded = false;
`,
});

patch('renderer/app.js', 'openCurrentView : calendrier réduit ou agrandi', {
  skipIf: "requestWindowMode(calendarExpanded ? 'schedule' : 'notch');\n    setMode(calendarExpanded",
  find: `function openCurrentView(){
  if(currentTab === 'schedule'){
    requestWindowMode('schedule');
    setMode('schedule');
    return;
  }`,
  replace: `function openCurrentView(){
  if(currentTab === 'schedule'){
    requestWindowMode(calendarExpanded ? 'schedule' : 'notch');
    setMode(calendarExpanded ? 'schedule' : 'expanded');
    return;
  }`,
});

patch('renderer/app.js', 'selectTab : ARIA, mémoire de l\'onglet, clavier, calendrier', {
  skipIf: 'function rememberTab(',
  find: `function selectTab(name, updateMode = true){
  const tab = document.querySelector(\`.tab[data-tab="\${name}"]\`);
  const panel = $('panel-' + name);
  if(!tab || !panel) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p === panel));
  currentTab = name;
  if(!updateMode) return;
  if(name === 'schedule'){
    // La vue et sa taille CSS basculent dans la même frame : aucun état
    // Pomodoro intermédiaire, même au premier clic.
    requestWindowMode('schedule');
    setMode('schedule');
  } else {
    requestWindowMode('notch');
    setMode(name === 'analytics' ? 'analytics' : 'expanded');
  }
}

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));`,
  replace: `/* Dernier onglet utilisé : enregistré dans les réglages (écriture différée, sans
   repeindre l'interface : rien ne change visuellement). */
function rememberTab(name){
  settings.lastTab = name;
  pendingPatch.lastTab = name;
  queueSave();
}

function selectTab(name, updateMode = true){
  const tab = document.querySelector(\`.tab[data-tab="\${name}"]\`);
  const panel = $('panel-' + name);
  if(!tab || !panel) return;
  document.querySelectorAll('.tab').forEach(t => {
    const active = t === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
    t.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p === panel));
  currentTab = name;
  if(!updateMode) return;
  rememberTab(name);
  if(name === 'schedule' && calendarExpanded){
    // La vue et sa taille CSS basculent dans la même frame : aucun état
    // Pomodoro intermédiaire, même au premier clic.
    requestWindowMode('schedule');
    setMode('schedule');
  } else {
    requestWindowMode('notch');
    setMode(name === 'analytics' ? 'analytics' : 'expanded');
  }
}

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));

/* Accessibilité : chaque panneau est relié à son onglet. */
for(const page of NOTCH_PAGES){
  const panel = $('panel-' + page.id);
  if(!panel) continue;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'tab-' + page.id);
}

/* Clavier sur la barre d'onglets : ← → Début Fin déplacent le focus (un seul onglet
   est dans l'ordre de tabulation) ; Entrée ou Espace ouvre l'onglet. Pas d'ouverture
   automatique au déplacement : elle redimensionnerait la capsule à chaque flèche. */
const tabListEl = document.querySelector('.tabs');
tabListEl.addEventListener('keydown', (e) => {
  const tabs = [...tabListEl.querySelectorAll('.tab')];
  const index = tabs.indexOf(e.target.closest('.tab'));
  if(index < 0) return;
  let next = -1;
  if(e.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if(e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if(e.key === 'Home') next = 0;
  else if(e.key === 'End') next = tabs.length - 1;
  else return;
  e.preventDefault();
  tabs[next].focus();
});

/* Ctrl+1 … Ctrl+6 : ouvre directement la page correspondante (même ordre que les onglets). */
const TAB_SHORTCUT_MODES = new Set(['expanded', 'schedule', 'analytics', 'analytics-expanded']);
document.addEventListener('keydown', (e) => {
  if(!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || !/^[1-6]$/.test(e.key)) return;
  if(!TAB_SHORTCUT_MODES.has(mode)) return;
  if(e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const page = NOTCH_PAGES[Number(e.key) - 1];
  if(!page) return;
  e.preventDefault();
  selectTab(page.id);
});

/* Calendrier : « Agrandir » ajoute le panneau des tâches, « Réduire » revient à Mois/Jour seuls. */
function setCalendarExpanded(next){
  calendarExpanded = !!next;
  if(currentTab !== 'schedule') return;
  requestWindowMode(calendarExpanded ? 'schedule' : 'notch');
  setMode(calendarExpanded ? 'schedule' : 'expanded');
}
$('calendar-expand').addEventListener('click', (e) => { e.stopPropagation(); setCalendarExpanded(true); });
$('calendar-collapse').addEventListener('click', (e) => { e.stopPropagation(); setCalendarExpanded(false); });`,
});

patch('renderer/app.js', 'applyAppearance : météo masquable dans la pill', {
  skipIf: 'body.dataset.weather =',
  find: `function applyAppearance(){
`,
  replace: `function applyAppearance(){
  // Interrupteur Settings > Privacy > Weather : masque l'heure/température de la pill.
  body.dataset.weather = settings.weatherEnabled === false ? 'off' : 'on';
`,
});

patch('renderer/app.js', 'démarrage : restaure le dernier onglet', {
  skipIf: 'const savedTab =',
  find: `  pinnedPages = [...settings.pinnedPages];
  renderPinnedPages();
  applyAppearance();`,
  replace: `  pinnedPages = [...settings.pinnedPages];
  const savedTab = pageDefinition(settings.lastTab) ? settings.lastTab : 'pomodoro';
  if(savedTab !== currentTab) selectTab(savedTab, false);
  renderPinnedPages();
  applyAppearance();`,
});

patch('renderer/app.js', 'Settings : case Weather', {
  skipIf: "$('s-weatherEnabled').checked",
  find: `  $('s-clipboardHistoryEnabled').checked = settings.clipboardHistoryEnabled !== false;`,
  replace: `  $('s-clipboardHistoryEnabled').checked = settings.clipboardHistoryEnabled !== false;
  $('s-weatherEnabled').checked = settings.weatherEnabled !== false;`,
});

patch('renderer/app.js', 'Settings : interrupteur Weather branché', {
  skipIf: "'clipboardHistoryEnabled', 'weatherEnabled'",
  find: `'clipboardHistoryEnabled', 'eventRemindersEnabled'].forEach((key) => {`,
  replace: `'clipboardHistoryEnabled', 'weatherEnabled', 'eventRemindersEnabled'].forEach((key) => {`,
});

patch('renderer/app.js', 'Clipboard : bouton désactivé quand l\'historique est vide', {
  skipIf: "$('clipboard-clear')",
  find: `  empty.hidden = clipboardHistory.length !== 0;
`,
  replace: `  empty.hidden = clipboardHistory.length !== 0;
  const clearButton = $('clipboard-clear');
  if(clearButton) clearButton.disabled = clipboardHistory.length === 0;
`,
});

patch('renderer/app.js', 'Clipboard : vider l\'historique (confirmation par second clic)', {
  skipIf: 'function setupConfirmButton(',
  find: `$('clipboard-refresh').addEventListener('click', () => {`,
  replace: `/* Bouton à double clic : le premier arme (3 s), le second exécute. Pas de confirm()
   natif, qui détonnerait dans une bulle transparente sans chrome. */
function setupConfirmButton(button, run, { idleText = null, confirmText = null, idleTitle = '', confirmTitle = '' } = {}){
  let pending = false;
  let timer = null;
  const setLabel = (text, title) => {
    if(text !== null) button.textContent = text;
    if(title){ button.title = title; button.setAttribute('aria-label', title); }
  };
  const reset = () => {
    pending = false;
    clearTimeout(timer);
    button.classList.remove('danger-pending');
    setLabel(idleText, idleTitle);
  };
  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    if(button.disabled) return;
    if(!pending){
      pending = true;
      button.classList.add('danger-pending');
      setLabel(confirmText, confirmTitle);
      clearTimeout(timer);
      timer = setTimeout(reset, 3000);
      return;
    }
    reset();
    await run();
  });
}
async function clearClipboardHistoryNow(){
  const result = await window.api.clearClipboardHistory?.();
  applyClipboardHistory(Array.isArray(result) ? result : []);
}
setupConfirmButton($('clipboard-clear'), clearClipboardHistoryNow, {
  idleTitle: 'Clear clipboard history',
  confirmTitle: 'Click again to clear',
});
setupConfirmButton($('btn-clear-clipboard'), clearClipboardHistoryNow, {
  idleText: 'Clear',
  confirmText: 'Confirm',
});

$('clipboard-refresh').addEventListener('click', () => {`,
});

/* =====================================================================
 *  renderer/style.css
 * ===================================================================== */

append('renderer/style.css', 'onglets compacts, calendrier réduit, météo, focus', 'v1.6 — onglets compacts', `/* ==================== v1.6 — onglets compacts, calendrier réduit, météo masquable ====================
   Bloc placé en dernier volontairement : le fichier empile des correctifs successifs,
   celui-ci a donc le dernier mot. */
:root{ --h-calendar-compact:440px; }

/* Onglets : icône seule, libellé uniquement pour la page active (six pages tiennent sans défiler). */
.tab{ padding:6px 9px; }
.tab:not(.active) .tab-label{ display:none; }

/* Focus clavier visible (le contour reste à l'intérieur : .tabs coupe ce qui déborde). */
.tab:focus-visible{ outline:2px solid var(--accent); outline-offset:-2px; }
.icon-btn:focus-visible,
.btn:focus-visible,
.seg-btn:focus-visible,
.toolbar-btn:focus-visible,
.swatch:focus-visible{ outline:2px solid var(--accent); outline-offset:1px; }
.switch input:focus-visible + .switch-track{ outline:2px solid var(--accent); outline-offset:2px; }

/* Calendrier réduit : Mois/Jour seuls, sans le panneau des tâches (mode 'expanded' + onglet Calendar). */
body.mode-expanded:has(#panel-schedule.active) #capsule{ height:var(--h-calendar-compact); }
body.mode-expanded:has(#panel-schedule.active) #view-expanded{ height:var(--h-calendar-compact); }
body.mode-expanded .schedule-panel.active{ display:flex; }
body.mode-expanded .schedule-panel.active .schedule-shell{
  display:flex; flex-direction:column; opacity:1; transform:none;
}
body.mode-expanded .schedule-panel.active .tasks-pane,
body.mode-expanded .schedule-panel.active .focus-fab{ display:none; }
body.mode-expanded .schedule-panel.active .calendar-pane{
  flex:1; width:100%; padding-right:0; border-right:0;
}
body.mode-expanded .calendar-toolbar{ min-height:40px; gap:8px; padding:0 0 4px; }
body.mode-expanded .calendar-nav h1{ font-size:14px; margin-left:4px; }

/* Boutons Agrandir / Réduire du calendrier. */
.calendar-expand-btn{ width:26px; height:26px; flex:none; }
.calendar-expand-btn .icon{ width:13px; height:13px; }
#calendar-collapse{ display:none; }
body.mode-schedule #calendar-expand{ display:none; }
body.mode-schedule #calendar-collapse{ display:flex; }

/* Pill : météo masquée quand elle est désactivée. */
body[data-weather="off"] .pill-weather,
body[data-weather="off"] .pill-sep{ display:none; }

/* Vider l'historique du presse-papiers. */
.clipboard-actions{ display:flex; align-items:center; gap:4px; }
.icon-btn:disabled{ opacity:.35; cursor:default; pointer-events:none; }
.icon-btn.danger-pending{ background:var(--red); color:#fff; }
.settings-row .btn.danger-pending{ background:var(--red); color:#fff; border-color:transparent; }
`);

/* =====================================================================
 *  tests
 * ===================================================================== */

// Le test de fumée ouvrait le calendrier directement dans la grande vue : il faut maintenant l'agrandir.
patch('tests/electron-smoke.cjs', 'smoke : agrandir le calendrier avant de tester les tâches', {
  skipIf: '#calendar-expand',
  find: `  await win.webContents.executeJavaScript(\`document.querySelector('[data-tab="schedule"]').click()\`);
  await waitFor(win, \`document.body.classList.contains('mode-schedule')\`);
  assert.equal(await win.webContents.executeJavaScript(\`document.querySelectorAll('.month-day').length\`), 42);`,
  replace: `  await win.webContents.executeJavaScript(\`document.querySelector('[data-tab="schedule"]').click()\`);
  // Calendrier réduit par défaut : Mois/Jour seuls, sans le panneau des tâches.
  await waitFor(win, \`document.body.classList.contains('mode-expanded')\`);
  assert.equal(await win.webContents.executeJavaScript(\`getComputedStyle(document.querySelector('.tasks-pane')).display\`), 'none');
  assert.equal(await win.webContents.executeJavaScript(\`document.querySelectorAll('.month-day').length\`), 42);
  await win.webContents.executeJavaScript(\`document.querySelector('#calendar-expand').click()\`);
  await waitFor(win, \`document.body.classList.contains('mode-schedule')\`);
  assert.notEqual(await win.webContents.executeJavaScript(\`getComputedStyle(document.querySelector('.tasks-pane')).display\`), 'none');`,
});

const newTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Fins de ligne normalisées : le dépôt peut être en CRLF sous Windows (autocrlf).
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\\r\\n/g, '\\n');
const main = read('../main.js');
const preload = read('../preload.js');
const html = read('../renderer/index.html');
const app = read('../renderer/app.js');
const css = read('../renderer/style.css');

test('weather: no plain-HTTP provider remains and the CSP no longer allows one', () => {
  assert.ok(!/http:\\/\\/ip-api/.test(main));
  assert.ok(!/ip-api\\.com/.test(html));
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(!/connect-src[^;]*\\bhttp:/.test(csp), 'connect-src must be HTTPS only');
  assert.match(csp, /connect-src https:\\/\\/ipapi\\.co https:\\/\\/ipwho\\.is https:\\/\\/api\\.open-meteo\\.com/);
});

test('weather: the switch defaults to on, stops every request and clears the cached location', () => {
  assert.match(main, /weatherEnabled: true,/);
  const fetchWeather = main.match(/async function fetchWeather\\(\\) \\{[\\s\\S]*?\\n\\}/)[0];
  assert.ok((fetchWeather.match(/weatherDisabled\\(\\)/g) || []).length >= 3, 'checked before and after each await');
  const start = main.match(/function startWeatherLoop\\(\\) \\{[\\s\\S]*?\\n\\}/)[0];
  assert.ok(start.indexOf('weatherDisabled()') < start.indexOf('fetchWeather()'), 'no request when disabled');
  const stop = main.match(/function stopWeatherLoop\\(\\) \\{[\\s\\S]*?\\n\\}/)[0];
  assert.match(stop, /clearInterval\\(weatherTimer\\)/);
  assert.match(stop, /geoCache = null/);
  assert.match(main, /if \\('weatherEnabled' in partial\\) applyWeatherSetting\\(\\);/);
  assert.match(main, /store\\.clear\\(\\);\\n  applyGlobalShortcut\\(\\);\\n  applyWeatherSetting\\(\\);/);
});

test('weather: Settings > Privacy toggle is wired and hides the pill block', () => {
  assert.match(html, /id="s-weatherEnabled"/);
  assert.match(app, /'clipboardHistoryEnabled', 'weatherEnabled'/);
  assert.match(app, /\\$\\('s-weatherEnabled'\\)\\.checked = settings\\.weatherEnabled !== false/);
  assert.match(app, /body\\.dataset\\.weather = settings\\.weatherEnabled === false \\? 'off' : 'on'/);
  assert.match(css, /body\\[data-weather="off"\\] \\.pill-weather/);
});

test('clipboard: clearing deletes entries and files, and keeps the live clipboard from being re-added', () => {
  const source = main.match(/function clearClipboardHistory\\(\\) \\{[\\s\\S]*?\\n\\}/)[0];
  assert.ok(!/clipboardLastFingerprint\\s*=/.test(source), 'fingerprint must be kept');
  const removed = [];
  let stored = null;
  let sent = null;
  let rmArgs = null;
  const items = [{ id: 'a', imagePath: '/x/a.png' }, { id: 'b', rawFormats: [{ filePath: '/x/b.bin' }] }];
  const run = new Function(
    'getClipboardHistoryRawItems', 'removeClipboardHistoryItemFiles', 'clipboardHistoryStore',
    'fs', 'clipboardHistoryMediaDir', 'notchWin',
    source + '\\nreturn clearClipboardHistory();'
  );
  const result = run(
    () => items,
    (item) => removed.push(item.id),
    { set: (key, value) => { stored = [key, value]; } },
    { rmSync: (...args) => { rmArgs = args; } },
    () => '/x',
    { isDestroyed: () => false, webContents: { send: (...args) => { sent = args; } } }
  );
  assert.deepEqual(result, []);
  assert.deepEqual(removed, ['a', 'b']);
  assert.deepEqual(stored, ['items', []]);
  assert.deepEqual(rmArgs, ['/x', { recursive: true, force: true }]);
  assert.deepEqual(sent, ['clipboard-history-updated', []]);
});

test('clipboard: IPC, preload bridge and both buttons are in place', () => {
  assert.match(main, /ipcMain\\.handle\\('clear-clipboard-history', \\(\\) => clearClipboardHistory\\(\\)\\)/);
  assert.match(preload, /clearClipboardHistory: \\(\\) => ipcRenderer\\.invoke\\('clear-clipboard-history'\\)/);
  assert.match(html, /id="clipboard-clear"/);
  assert.match(html, /id="btn-clear-clipboard"/);
  assert.match(app, /setupConfirmButton\\(\\$\\('clipboard-clear'\\)/);
  assert.match(app, /setupConfirmButton\\(\\$\\('btn-clear-clipboard'\\)/);
  assert.match(app, /clearButton\\.disabled = clipboardHistory\\.length === 0/);
});

test('tabs: ARIA roles, labels only on the active tab, roving tabindex', () => {
  assert.match(html, /<div class="tabs" role="tablist"/);
  const tabs = [...html.matchAll(/<button class="tab[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tabs.length, 6);
  for (const tab of tabs) {
    const page = tab.match(/data-tab="(\\w+)"/)[1];
    assert.match(tab, /role="tab"/);
    assert.ok(tab.includes('id="tab-' + page + '"'), page);
    assert.ok(tab.includes('aria-controls="panel-' + page + '"'), page);
    assert.match(tab, /aria-label="[^"]+"/);
    assert.ok(html.includes('id="panel-' + page + '"'), 'panel for ' + page);
  }
  assert.equal(tabs.filter((tab) => /aria-selected="true"/.test(tab)).length, 1);
  assert.equal((html.match(/class="tab-label"/g) || []).length, 6);
  assert.match(css, /\\.tab:not\\(\\.active\\) \\.tab-label\\{ display:none; \\}/);
  assert.match(app, /panel\\.setAttribute\\('role', 'tabpanel'\\)/);
  assert.match(app, /t\\.setAttribute\\('aria-selected'/);
  assert.match(app, /t\\.tabIndex = active \\? 0 : -1/);
});

test('tabs: arrows, Home/End and Ctrl+1..6 are handled, but never inside a text field', () => {
  const keys = app.match(/tabListEl\\.addEventListener\\('keydown'[\\s\\S]*?\\n\\}\\);/)[0];
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(keys.includes(key), key);
  const ctrl = app.match(/const TAB_SHORTCUT_MODES[\\s\\S]*?\\n\\}\\);/)[0];
  assert.match(ctrl, /\\/\\^\\[1-6\\]\\$\\/\\.test\\(e\\.key\\)/);
  assert.match(ctrl, /closest\\('input, textarea, select, \\[contenteditable="true"\\]'\\)/);
  assert.ok(!ctrl.includes("'settings'"), 'inactive while Settings is open');
});

test('tabs: the current page is remembered and restored at startup', () => {
  assert.match(main, /lastTab: 'pomodoro',/);
  assert.match(app, /function rememberTab\\(name\\)\\{[\\s\\S]*?pendingPatch\\.lastTab = name;[\\s\\S]*?queueSave\\(\\);/);
  const select = app.match(/function selectTab\\(name, updateMode = true\\)\\{[\\s\\S]*?\\n\\}/)[0];
  assert.ok(select.indexOf('if(!updateMode) return;') < select.indexOf('rememberTab(name)'), 'restoring does not rewrite the setting');
  assert.match(app, /const savedTab = pageDefinition\\(settings\\.lastTab\\) \\? settings\\.lastTab : 'pomodoro';\\n  if\\(savedTab !== currentTab\\) selectTab\\(savedTab, false\\);/);
});

test('calendar: compact by default (month/day only), Expand shows the tasks, Collapse goes back', () => {
  assert.match(app, /let calendarExpanded = false;/);
  assert.match(html, /id="calendar-expand"/);
  assert.match(html, /id="calendar-collapse"/);
  const open = app.match(/function openCurrentView\\(\\)\\{[\\s\\S]*?\\n\\}/)[0];
  assert.match(open, /setMode\\(calendarExpanded \\? 'schedule' : 'expanded'\\)/);
  const select = app.match(/function selectTab\\(name, updateMode = true\\)\\{[\\s\\S]*?\\n\\}/)[0];
  assert.match(select, /if\\(name === 'schedule' && calendarExpanded\\)/);
  assert.match(app, /\\$\\('calendar-expand'\\)\\.addEventListener\\('click', \\(e\\) => \\{ e\\.stopPropagation\\(\\); setCalendarExpanded\\(true\\); \\}\\)/);
  assert.match(app, /\\$\\('calendar-collapse'\\)\\.addEventListener\\('click', \\(e\\) => \\{ e\\.stopPropagation\\(\\); setCalendarExpanded\\(false\\); \\}\\)/);
  assert.match(css, /body\\.mode-expanded \\.schedule-panel\\.active \\.tasks-pane,/);
  assert.match(css, /body\\.mode-schedule #calendar-expand\\{ display:none; \\}/);
  assert.match(css, /#calendar-collapse\\{ display:none; \\}/);
});
`;

{
  const rel = 'tests/privacy-navigation.test.mjs';
  const abs = resolve(ROOT, rel);
  if (existsSync(abs)) {
    log.push(`= ${rel} (déjà présent)`);
  } else {
    files.set(rel, { text: newTest, eol: '\n', changed: true, isNew: true });
    log.push(`✔ ${rel} — nouveaux tests`);
  }
}

/* =====================================================================
 *  écriture (seulement si tous les repères ont été trouvés)
 * ===================================================================== */

let written = 0;
for (const [rel, file] of files) {
  if (!file.changed) continue;
  writeFileSync(resolve(ROOT, rel), file.text);
  written += 1;
}

console.log(log.join('\n'));
console.log(`\n${written} fichier(s) écrit(s). Lance maintenant : npm run check`);
