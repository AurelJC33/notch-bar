#!/usr/bin/env node
/*
 * Notch Bar — ergonomie (v1.4.0)
 *
 *   1. Bouton de repli : la croix ✕ devient un chevron ⌃ (la croix se lisait
 *      comme « fermer l'app »). Infobulle « Collapse (Esc) ».
 *   2. Échap replie la vue ouverte, une couche à la fois :
 *        réglages -> Shelf -> notch média -> vue principale.
 *      Échap ne replie pas quand un champ de saisie ou une fenêtre du planner
 *      (événement, tâche) est ouvert : ils gèrent Échap eux-mêmes.
 *   3. Timer : préréglages 5 / 10 / 15 / 25 / 45 min et saisie directe de la
 *      durée (clic sur le temps : « 45 », « 5:30 », « 1:30:00 », « 90s »...).
 *      L'analyse du texte vit dans renderer/duration-input.js (testée).
 *   4. Pomodoro : bouton « Skip » (Reset | Skip | Start). Passer une session de
 *      focus l'enregistre comme interrompue (pas comptée comme terminée) et mène
 *      à la pause ; passer une pause mène au focus. Skip ne change jamais
 *      l'état marche / pause du minuteur.
 *   5. Nouveau test : tests/ergonomics.test.mjs
 *
 * Usage (à la racine du dépôt) :   node apply-notch-ergonomics.mjs
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

/* ---------- déjà appliqué ? ---------- */
if (load('renderer/index.html').text.includes('id="pomo-skip"')) {
  console.log('✔ Cette mise à jour est déjà appliquée, rien à faire.');
  process.exit(0);
}

/* =====================================================================
 *  0. renderer/duration-input.js — analyse du texte saisi (testable en Node)
 * ===================================================================== */
addNewFile('renderer/duration-input.js', String.raw`(function initDurationInput(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DurationInput = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const MAX_SECONDS = 180 * 60; // même plafond que les flèches du Timer (180 min)

  /* Convertit un texte saisi en secondes, ou null s'il est invalide.
       "45"      -> 45 min          "45 min"  -> 45 min
       "90s"     -> 90 s            "5:30"    -> 5 min 30 s
       "1:30:00" -> 1 h 30 min
     Refusé : vide, 0, secondes ou minutes >= 60 dans une forme "m:s" / "h:m:s",
     et tout ce qui dépasse maxSeconds. */
  function parseDuration(text, options) {
    const max = options && Number.isFinite(options.maxSeconds) ? options.maxSeconds : MAX_SECONDS;
    const value = String(text == null ? '' : text).trim().toLowerCase();
    let total = null;
    let match;
    if ((match = value.match(/^(\d{1,4})\s*(?:m|min|mins|minute|minutes)?$/))) {
      total = Number(match[1]) * 60;
    } else if ((match = value.match(/^(\d{1,6})\s*(?:s|sec|secs|second|seconds)$/))) {
      total = Number(match[1]);
    } else if ((match = value.match(/^(\d{1,4}):(\d{1,2})$/))) {
      if (Number(match[2]) >= 60) return null;
      total = Number(match[1]) * 60 + Number(match[2]);
    } else if ((match = value.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/))) {
      if (Number(match[2]) >= 60 || Number(match[3]) >= 60) return null;
      total = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
    if (total === null || !Number.isInteger(total) || total <= 0 || total > max) return null;
    return total;
  }

  return { parseDuration, MAX_SECONDS };
});
`);

/* =====================================================================
 *  1. index.html
 * ===================================================================== */
replaceOnce('renderer/index.html',
  `<button class="icon-btn" id="btn-collapse" title="Collapse"><span class="icon" data-icon="close"></span></button>`,
  `<button class="icon-btn" id="btn-collapse" title="Collapse (Esc)" aria-label="Collapse"><span class="icon" data-icon="chevron-up"></span></button>`,
  'bouton repli');

replaceOnce('renderer/index.html',
  `          <button class="btn ghost" id="pomo-reset">Reset</button>
          <button class="btn primary" id="pomo-toggle">Start</button>`,
  `          <button class="btn ghost" id="pomo-reset">Reset</button>
          <button class="btn ghost" id="pomo-skip" title="Skip to break" aria-label="Skip to next phase">Skip</button>
          <button class="btn primary" id="pomo-toggle">Start</button>`,
  'boutons pomodoro');

replaceOnce('renderer/index.html',
  `        <div class="big-time" id="timer-time">05:00</div>
        <div class="steppers" id="timer-steppers">`,
  `        <div class="big-time" id="timer-time" role="button" tabindex="0" title="Click to type a duration (e.g. 45, 5:30, 90s)">05:00</div>
        <input class="big-time-input" id="timer-time-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="8" aria-label="Timer duration" hidden>
        <div class="presets" id="timer-presets" role="group" aria-label="Timer presets">
          <button type="button" class="preset-chip" data-minutes="5">5 min</button>
          <button type="button" class="preset-chip" data-minutes="10">10 min</button>
          <button type="button" class="preset-chip" data-minutes="15">15 min</button>
          <button type="button" class="preset-chip" data-minutes="25">25 min</button>
          <button type="button" class="preset-chip" data-minutes="45">45 min</button>
        </div>
        <div class="steppers" id="timer-steppers">`,
  'panneau timer');

replaceOnce('renderer/index.html',
  `<script src="app.js"></script>`,
  `<script src="duration-input.js"></script>
<script src="app.js"></script>`,
  'script duration-input');

/* =====================================================================
 *  2. style.css
 * ===================================================================== */
replaceOnce('renderer/style.css',
  `.stepper .lbl{ font-size:9.5px; color:var(--sub); letter-spacing:.05em; margin:2px 0; }`,
  `.stepper .lbl{ font-size:9.5px; color:var(--sub); letter-spacing:.05em; margin:2px 0; }

/* ---- Timer : préréglages et saisie directe de la durée ---- */
#panel-timer{ gap:10px; }
.presets{ display:flex; gap:6px; }
.preset-chip{ background:var(--panel2); color:var(--sub); border:1px solid var(--border); border-radius:999px; padding:4px 10px; font-size:11px; font-family:inherit; cursor:pointer; transition:background .15s ease, color .15s ease, border-color .15s ease, transform .08s ease; }
.preset-chip:hover:not(:disabled){ color:var(--text); }
.preset-chip:active:not(:disabled){ transform:scale(.95); }
.preset-chip.active{ background:var(--accent); border-color:transparent; color:#fff; }
.preset-chip:disabled{ opacity:.45; cursor:default; }
/* Le temps et son champ de saisie ont exactement la même hauteur : pas de saut de mise en page. */
#timer-time{ height:52px; line-height:52px; padding:0 14px; border-radius:12px; cursor:text; transition:background .15s ease; }
#timer-time:not(.locked):hover{ background:var(--panel2); }
#timer-time.locked{ cursor:default; }
.big-time-input{ box-sizing:border-box; width:170px; height:52px; padding:0; text-align:center; font-family:inherit; font-size:42px; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:.02em; color:var(--text); background:var(--panel2); border:1px solid var(--accent); border-radius:12px; outline:none; transition:border-color .15s ease; }
.big-time-input.invalid{ border-color:var(--red); }`,
  'css timer');

/* =====================================================================
 *  3. app.js
 * ===================================================================== */

/* 3a. repli : fonction partagée bouton / Échap */
replaceOnce('renderer/app.js',
  `$('btn-collapse').addEventListener('click', () => {
  requestWindowMode('notch');
  setMode(activeTool ? 'running' : 'pill');
});`,
  `function collapseToCompact(){
  requestWindowMode('notch');
  setMode(activeTool ? 'running' : 'pill');
}
$('btn-collapse').addEventListener('click', collapseToCompact);`,
  'btn-collapse');

/* 3b. Échap : une couche à la fois */
replaceOnce('renderer/app.js',
  `document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape' && mode === 'settings') closeSettingsPanel();
});`,
  `/* Échap replie une couche à la fois : réglages, Shelf, notch média, puis vue principale.
   Il ne replie pas si un champ de saisie ou une fenêtre du planner est ouvert :
   eux gèrent Échap (planner.js ferme l'événement / l'éditeur de tâche). */
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape' || e.defaultPrevented) return;
  if(mode === 'settings'){ closeSettingsPanel(); return; }
  if(e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if(!$('event-backdrop').hidden || !$('task-editor-shell').hidden) return;
  if(mode === 'shelf'){ closeShelfPanel(); return; }
  if(typeof mediaExpanded !== 'undefined' && mediaExpanded){ setMediaExpanded(false); return; }
  if(OUTSIDE_COLLAPSIBLE_MODES.has(mode)) collapseToCompact();
});`,
  'escape');

/* 3c. Pomodoro : titre du bouton Skip selon la phase */
replaceOnce('renderer/app.js',
  `  $('pomo-toggle').textContent = pomo.running ? 'Pause' : (pomo.remaining < pomoPhaseDuration(pomo.phase) ? 'Resume' : 'Start');
  renderPomoDots();`,
  `  $('pomo-toggle').textContent = pomo.running ? 'Pause' : (pomo.remaining < pomoPhaseDuration(pomo.phase) ? 'Resume' : 'Start');
  $('pomo-skip').title = pomo.phase === 'focus' ? 'Skip to break' : 'Skip to focus';
  renderPomoDots();`,
  'renderPomo');

/* 3d. Pomodoro : Skip */
replaceOnce('renderer/app.js',
  `$('pomo-reset').addEventListener('click', pomoReset);`,
  `$('pomo-reset').addEventListener('click', pomoReset);

/* Skip : passe à la phase suivante sans changer l'état marche / pause.
   Sauter un focus ne le compte pas comme terminé : la session est enregistrée
   comme interrompue (si elle a duré) et le compteur de pomodoros n'avance pas ;
   on va à la courte pause. Sauter une pause ramène au focus. */
function pomoSkip(){
  const wasRunning = pomo.running;
  if(pomo.phase === 'focus'){
    if(pomoSession){ accruePomoSession(); recordPomoAnalyticsSession(false); }
    pomo.phase = 'short';
  } else {
    pomo.phase = 'focus';
  }
  pomo.remaining = pomoPhaseDuration(pomo.phase);
  if(wasRunning){
    // L'intervalle déjà armé relit pomo.endAt / pomo.phase à chaque tick : on
    // repart simplement de la nouvelle échéance (sans refermer la vue ouverte).
    pomo.endAt = Date.now() + pomo.remaining * 1000;
    if(pomo.phase === 'focus'){ beginPomoSessionIfNeeded(); resumePomoSession(); }
    const [c,k] = pomoEdge(pomo.phase); setEdge(c,k);
  }
  renderPomo();
}
$('pomo-skip').addEventListener('click', () => { playSound('tick'); pomoSkip(); });`,
  'pomo-reset listener');

/* 3e. Timer : état verrouillé / préréglage actif dans renderTimer */
replaceOnce('renderer/app.js',
  `function renderTimer(){
  $('timer-time').textContent = fmt(timer.remaining);`,
  `function renderTimer(){
  $('timer-time').textContent = fmt(timer.remaining);
  $('timer-time').classList.toggle('locked', !!timer.running);
  document.querySelectorAll('#timer-presets .preset-chip').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.minutes) * 60 === timer.minutes*60 + timer.seconds);
    chip.disabled = !!timer.running;
  });`,
  'renderTimer');

/* 3f. Timer : préréglages + saisie directe */
replaceOnce('renderer/app.js',
  `function timerStart(){
  if(timer.remaining<=0) timer.remaining = timer.minutes*60 + timer.seconds;`,
  `/* ---- préréglages et saisie directe de la durée ---- */
function timerSetDuration(totalSeconds){
  timer.minutes = Math.floor(totalSeconds / 60);
  timer.seconds = totalSeconds % 60;
  timer.remaining = totalSeconds;
  renderTimer();
}
document.querySelectorAll('#timer-presets .preset-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    if(timer.running) return;
    playSound('tick');
    timerSetDuration(Number(chip.dataset.minutes) * 60);
  });
});

const timerTimeEl = $('timer-time');
const timerInputEl = $('timer-time-input');
function timerEditBegin(){
  if(timer.running || !timerInputEl.hidden) return;
  timerInputEl.value = fmt(timer.minutes*60 + timer.seconds);
  timerInputEl.classList.remove('invalid');
  timerTimeEl.hidden = true;
  timerInputEl.hidden = false;
  timerInputEl.focus();
  timerInputEl.select();
}
// Renvoie false (et garde le champ ouvert) si on valide un texte invalide.
function timerEditEnd(commit){
  if(timerInputEl.hidden) return true;
  if(commit){
    const total = window.DurationInput ? window.DurationInput.parseDuration(timerInputEl.value) : null;
    if(total === null){ timerInputEl.classList.add('invalid'); return false; }
    timerSetDuration(total);
  }
  timerInputEl.hidden = true;
  timerTimeEl.hidden = false;
  renderTimer();
  return true;
}
timerTimeEl.addEventListener('click', timerEditBegin);
timerTimeEl.addEventListener('keydown', (e) => {
  if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); timerEditBegin(); }
});
timerInputEl.addEventListener('input', () => timerInputEl.classList.remove('invalid'));
timerInputEl.addEventListener('keydown', (e) => {
  if(e.key === 'Enter'){ e.preventDefault(); timerEditEnd(true); }
  else if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); timerEditEnd(false); }
});
// En quittant le champ : on valide si le texte est correct, sinon on annule.
timerInputEl.addEventListener('blur', () => { if(!timerEditEnd(true)) timerEditEnd(false); });

function timerStart(){
  if(timer.remaining<=0) timer.remaining = timer.minutes*60 + timer.seconds;`,
  'timerStart');

/* =====================================================================
 *  4. nouveau test
 * ===================================================================== */
addNewFile('tests/ergonomics.test.mjs', String.raw`import test from 'node:test';
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
`);

/* =====================================================================
 *  5. MODIFICATIONS.md
 * ===================================================================== */
{
  const entry = load('MODIFICATIONS.md');
  entry.text = entry.text.replace(/\s*$/, '\n') + `
## v1.4.0 — Ergonomics

- The collapse button in the open view is now a chevron instead of a close cross, which was easy to read as "quit the app" (tooltip: "Collapse (Esc)").
- Escape now collapses the open view one layer at a time: Settings, then Shelf, then the expanded media notch, then the main view. It is ignored while a text field or a planner dialog (event, task editor) is open, since those handle Escape themselves.
- Timer: preset chips (5 / 10 / 15 / 25 / 45 min) and direct typing of the duration by clicking the time ("45", "5:30", "1:30:00", "90s"). Invalid input is outlined in red and Escape cancels. Parsing lives in \`renderer/duration-input.js\` (unit tested).
- Pomodoro: new Skip button (Reset | Skip | Start). Skipping a focus session records it as interrupted (it is not counted as completed) and goes to the short break; skipping a break goes back to focus. Skip never changes whether the timer is running.
- Added tests/ergonomics.test.mjs.
`;
}

/* =====================================================================
 *  6. version (nouvelle fonctionnalité => version mineure)
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
console.log('\nPuis publie :\n');
console.log('  git add -A');
console.log('  git commit -m "v' + version + ' : chevron de repli, Échap, préréglages et saisie du Timer, Skip Pomodoro"');
console.log('  git tag v' + version);
console.log('  git push origin main v' + version + '\n');
