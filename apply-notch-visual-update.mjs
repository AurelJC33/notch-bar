#!/usr/bin/env node
/*
 * Notch Bar — mise à jour de l'identité visuelle
 *
 *   1. Liseré lumineux : remplacé par un "animated border glow" en conic-gradient
 *      (anneau net + calque flou), 100 % CSS, plus de SVG ni de requestAnimationFrame.
 *   2. Ombres parasites : suppression des box-shadow qui débordaient de la capsule
 *      et du notch média (cause du rectangle gris sans radius, voir plus bas).
 *   3. Bouton Réglages : l'engrenage était décentré de 0,9 unité (viewBox 24) par
 *      rapport à son cercle intérieur et au bouton ; il est recentré.
 *   4. Transitions : suppression de will-change inutile, vues entrantes légèrement
 *      décalées pour ne plus se chevaucher avec la vue sortante.
 *
 * Usage (à la racine du dépôt) :   node apply-notch-visual-update.mjs
 * Le script est idempotent et atomique : si une ancre est introuvable, rien n'est écrit.
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

/* ---------- utilitaires de lecture / écriture (gère LF et CRLF) ---------- */
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

function replaceBetween(rel, startMarker, endMarker, replacement, label) {
  const entry = load(rel);
  const start = entry.text.indexOf(startMarker);
  if (start === -1) fail(rel + ' : début de zone introuvable (' + label + ').');
  const end = entry.text.indexOf(endMarker, start);
  if (end === -1) fail(rel + ' : fin de zone introuvable (' + label + ').');
  entry.text = entry.text.slice(0, start) + replacement + entry.text.slice(end);
}

/* ---------- déjà appliqué ? ---------- */
if (load('renderer/index.html').text.includes('id="capsule-surface"')) {
  console.log('✔ Cette mise à jour est déjà appliquée, rien à faire.');
  process.exit(0);
}

/* =====================================================================
 *  1. index.html — calques du liseré + surface de la capsule
 * ===================================================================== */
replaceOnce('renderer/index.html',
`    <svg id="edge" xmlns="http://www.w3.org/2000/svg">
      <path id="edge-path" fill="none"></path>
      <path id="edge-path-core" fill="none"></path>
    </svg>
`,
`    <!-- Liseré lumineux (conic-gradient) : un calque flou (glow) + un anneau net,
         posés derrière la surface. Tout se pilote en CSS, voir #edge dans style.css. -->
    <div id="edge" aria-hidden="true">
      <div class="edge-box edge-glow"></div>
      <div class="edge-box edge-ring"></div>
    </div>

    <!-- Surface visible du notch : fond, coins arrondis et découpe du contenu.
         #capsule garde la taille / le positionnement, ce qui permet au liseré
         de déborder autour sans être rogné par overflow:hidden. -->
    <div id="capsule-surface">
`, 'svg #edge');

replaceOnce('renderer/index.html',
`<div class="planner-toast" id="planner-toast" role="status" aria-live="polite"></div>
  </div>
`,
`<div class="planner-toast" id="planner-toast" role="status" aria-live="polite"></div>
    </div><!-- /#capsule-surface -->
  </div>
`, 'fermeture capsule');

/* =====================================================================
 *  2. style.css
 * ===================================================================== */

/* 2a. tokens ---------------------------------------------------------- */
replaceOnce('renderer/style.css',
`  --radius:0 0 20px 20px;
`,
`  --r:20px;                         /* rayon des coins du bas (le haut reste carré) */
  --radius:0 0 var(--r) var(--r);

  /* Liseré lumineux (voir #edge plus bas) */
  --edge-w:2px;        /* épaisseur de l'anneau */
  --edge-blur:9px;     /* flou du glow ; EDGE_GLOW_PAD (app.js) doit rester >= 2,5 x cette valeur */
  --edge-size:1500px;  /* côté du calque tournant : > diagonale max de la capsule (~1390px) */
  --edge-speed:3.6s;   /* durée d'un tour */
`, ':root --radius');

/* 2b. capsule + liseré ------------------------------------------------ */
replaceBetween('renderer/style.css',
  '/* La capsule change de taille en CSS pur',
  '/* ---- vues : empilées, ancrées en haut',
`/* La capsule change de taille en CSS pur (transition sur width/height) :
   plus aucun redimensionnement de fenêtre pendant le survol / le clic.

   #capsule ne porte ni fond ni découpe : elle fixe la taille et la position
   (et porte la translation du groupe média). Le fond arrondi et le clip du
   contenu vivent dans #capsule-surface ; le liseré lumineux (#edge) est un
   calque frère, derrière la surface, qui peut donc déborder proprement.

   IMPORTANT — plus aucune box-shadow / drop-shadow autour de la capsule :
   la fenêtre Electron est découpée par setShape() selon un RECTANGLE (voir
   syncInteractiveRegion). Toute ombre ou lueur qui se dessine dans les coins
   arrondis, à l'intérieur de ce rectangle, apparaît comme un rectangle gris
   sans radius derrière le notch. Les lueurs passent par #edge, dont la zone
   est ajoutée à la région interactive (EDGE_GLOW_PAD dans app.js). */
#capsule{
  position:relative; color:var(--text);
  width:var(--w-pill); height:var(--h-pill);
  transition: width var(--capsule-dur) var(--capsule-ease),
              height var(--capsule-dur) var(--capsule-ease);
  transform:translateZ(0);
}
#capsule-surface{
  position:absolute; inset:0; z-index:2;
  background:var(--bg);
  border-radius:var(--radius); overflow:hidden;
}
body.mode-hover #capsule{ width:var(--w-hover); height:var(--h-hover); }
body.mode-expanded #capsule{ width:var(--w-expanded); height:var(--h-expanded); }
body.mode-analytics #capsule{ width:var(--w-expanded); height:var(--h-expanded); }
body.mode-reminder #capsule{
  width:min(var(--reminder-width, 420px),92vw); height:28px;
}
body.mode-analytics-expanded #capsule{ width:var(--w-schedule); height:var(--h-schedule); }
body.mode-shelf #capsule{ width:min(var(--w-shelf),100vw); height:min(var(--h-shelf),100vh); }
body.mode-running #capsule{ width:var(--w-running); height:var(--h-running); }
body.mode-settings #capsule{ width:min(var(--w-settings),100vw); height:min(var(--h-settings),100vh); }
body.mode-schedule #capsule{ width:var(--w-schedule); height:var(--h-schedule); }
body.mode-pill[data-accessory-state="visible"] #capsule{
  width:var(--w-pill-device); height:var(--h-pill-device);
}
body.mode-update #capsule{
  width:var(--w-update); height:var(--h-update);
}
body.reduce-motion #capsule{ transition:none; }

/* ---- liseré lumineux : "animated border glow" en conic-gradient ----
   Deux calques identiques, posés DERRIÈRE #capsule-surface :
     .edge-ring  net : il dessine le trait de --edge-w autour de la capsule ;
     .edge-glow  identique mais flouté : c'est la lueur qui déborde.
   Dans chaque calque, un pseudo-élément très grand tourne sur lui-même avec un
   conic-gradient transparent -> couleur -> transparent. Seul le quart lumineux
   qui passe sous le bord du calque est visible (overflow:hidden + radius).
   La surface opaque recouvre le centre : seul l'anneau dépasse, donc pas de
   masque à poser. Le haut reste collé au bord de l'écran : le liseré n'apparaît
   que sur les côtés et le dessous, comme une encoche qui s'illumine.
   Modes (classes posées par setEdge() dans app.js) :
     .spin   le quart lumineux fait le tour de la capsule
     .pulse  tout le contour respire en opacité */
@property --edge-color{ syntax:'<color>'; inherits:true; initial-value:rgba(0,0,0,0); }

#edge{
  position:absolute; z-index:0; pointer-events:none;
  inset:0 calc(-1 * var(--edge-w)) calc(-1 * var(--edge-w));
  opacity:0;
  transition:opacity .35s ease, --edge-color .5s ease;
}
#edge.on{ opacity:1; }

.edge-box{
  position:absolute; inset:0; overflow:hidden; isolation:isolate;
  border-radius:0 0 calc(var(--r) + var(--edge-w)) calc(var(--r) + var(--edge-w));
}
.edge-glow{ filter:blur(var(--edge-blur)); opacity:.75; }

.edge-box::before{
  content:''; position:absolute; top:50%; left:50%;
  width:var(--edge-size); height:var(--edge-size);
  transform:translate(-50%,-50%) rotate(0deg);
  background-image:conic-gradient(rgba(0,0,0,0), var(--edge-color), rgba(0,0,0,0) 25%);
  animation:edge-rotate var(--edge-speed) linear infinite;
}
@keyframes edge-rotate{ to{ transform:translate(-50%,-50%) rotate(1turn); } }

/* Mode "pulse" (Timer, Stopwatch, rappels) : anneau plein qui respire.
   Le halo vert de l'accessoire audio (notch replié) utilise le même rendu. */
body.mode-pill #edge[data-accessory="on"]:not(.on){ opacity:1; --edge-color:var(--green); }
:is(#edge.pulse, body.mode-pill #edge[data-accessory="on"]:not(.on)) .edge-box::before{
  animation:none;
  background-image:conic-gradient(var(--edge-color), var(--edge-color));
}
:is(#edge.pulse, body.mode-pill #edge[data-accessory="on"]:not(.on)) .edge-ring{ animation:edge-breathe-ring 2.1s ease-in-out infinite; }
:is(#edge.pulse, body.mode-pill #edge[data-accessory="on"]:not(.on)) .edge-glow{ animation:edge-breathe-glow 2.1s ease-in-out infinite; }
@keyframes edge-breathe-ring{ 0%,100%{ opacity:.4; } 50%{ opacity:1; } }
@keyframes edge-breathe-glow{ 0%,100%{ opacity:.18; } 50%{ opacity:.75; } }

.edge-orange{ --edge-color:var(--orange); }
.edge-blue{ --edge-color:var(--blue); }
.edge-green{ --edge-color:var(--green); }
.edge-amber{ --edge-color:var(--amber); }
.edge-neutral{ --edge-color:var(--neutral); }

/* Mouvement réduit : rotation plus lente, pas de respiration. */
body.reduce-motion #edge{ transition:none; }
body.reduce-motion #edge .edge-box::before{ animation-duration:7s; }
body.reduce-motion :is(#edge.pulse, body.mode-pill #edge[data-accessory="on"]:not(.on)) .edge-ring{ animation:none; opacity:.85; }
body.reduce-motion :is(#edge.pulse, body.mode-pill #edge[data-accessory="on"]:not(.on)) .edge-glow{ animation:none; opacity:.45; }

`, 'bloc capsule + edge');

/* 2c. vues : la vue entrante démarre juste après la sortante ------------ */
{
  const entry = load('renderer/style.css');
  const start = entry.text.indexOf('.view{\n  position:absolute; top:0; left:0; width:100%;');
  const end = entry.text.indexOf('body.reduce-motion .view{ transition:none; }', start);
  if (start === -1 || end === -1) fail('renderer/style.css : bloc .view introuvable.');
  let block = entry.text.slice(start, end);

  const oldTransition =
`  transition: opacity .22s ease,
              transform .28s var(--capsule-ease);
}`;
  if (!block.includes(oldTransition)) fail('renderer/style.css : transition de .view introuvable.');
  block = block.replace(oldTransition,
`  /* La vue qui apparaît attend --view-delay (posé uniquement sur l'état actif) :
     l'ancienne vue a le temps de s'effacer, les deux ne se superposent plus. */
  --view-delay:0s;
  transition: opacity .2s ease var(--view-delay),
              transform .3s var(--capsule-ease) var(--view-delay);
}`);

  const active = 'transform:translateY(0) scale(1);';
  const count = block.split(active).length - 1;
  if (count < 3) fail('renderer/style.css : états actifs des vues introuvables.');
  block = block.split(active).join(active + ' --view-delay:.09s;');

  entry.text = entry.text.slice(0, start) + block + entry.text.slice(end);
}

/* 2d. notch média : plus d'ombre ni de will-change --------------------- */
replaceOnce('renderer/style.css',
`  box-shadow:0 8px 22px rgba(0,0,0,.24);
  transform:translateZ(0);
  transition:left .42s var(--capsule-ease),`,
`  transform:translateZ(0);
  transition:left .42s var(--capsule-ease),`, 'ombre #media-notch');

replaceOnce('renderer/style.css',
`             opacity .2s ease;
  will-change:left,width,height;
}`,
`             opacity .2s ease;
}`, 'will-change #media-notch');

/* 2e. éléments décoratifs dont la lueur sortait de la capsule ----------- */
replaceOnce('renderer/style.css',
`.pill-accessory .icon{ width:18px; height:18px; color:#fff; filter:drop-shadow(0 0 10px rgba(48,209,88,.25)); }`,
`.pill-accessory .icon{ width:18px; height:18px; color:#fff; }`, 'drop-shadow icône accessoire');

/* =====================================================================
 *  3. app.js
 * ===================================================================== */

/* 3a. région interactive : inclut la zone du glow --------------------- */
replaceOnce('renderer/app.js',
`function rectForInput(el) {
  if(!el || el.hidden) return null;
  const rect = el.getBoundingClientRect();
  if(rect.width < 1 || rect.height < 1) return null;
  return {
    x: Math.max(0, Math.floor(rect.left)),
    y: Math.max(0, Math.floor(rect.top)),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  };
}`,
`function rectForInput(el, pad = 0) {
  if(!el || el.hidden) return null;
  const rect = el.getBoundingClientRect();
  if(rect.width < 1 || rect.height < 1) return null;
  const left = Math.floor(rect.left);
  // pad : marge ajoutée à gauche, à droite et en dessous (jamais en haut, le
  // notch est collé au bord de l'écran) pour laisser passer le glow du liseré.
  const x = Math.max(0, left - pad);
  return {
    x,
    y: Math.max(0, Math.floor(rect.top)),
    width: Math.ceil(rect.width) + (left - x) + pad,
    height: Math.ceil(rect.height) + pad,
  };
}`, 'rectForInput');

replaceOnce('renderer/app.js',
`  const rects = [rectForInput(capsuleEl)];`,
`  const rects = [rectForInput(capsuleEl, edgePad)];`, 'syncInteractiveRegion');

/* 3b. liseré : tout le rendu est maintenant en CSS --------------------- */
replaceBetween('renderer/app.js',
  '/* ==================== LIGNE DE LUMIÈRE QUI SUIT LE CONTOUR',
  '/* ==================== HORLOGE ==================== */',
`/* ==================== LISERÉ LUMINEUX (border glow) ====================
   Tout le rendu est en CSS (voir #edge dans style.css) : un anneau net et un
   calque flou, tous deux animés par un conic-gradient rotatif. Le JS se
   contente de choisir la couleur et le mode : plus de tracé SVG recalculé à
   chaque frame de la transition de taille, plus de requestAnimationFrame.

   La fenêtre est découpée par setShape() (région interactive = rectangle de
   la capsule). Le glow débordant autour de la capsule, on élargit cette région
   de EDGE_GLOW_PAD px (côtés + dessous) tant qu'un liseré est visible, sinon il
   serait rogné en rectangle. Garder EDGE_GLOW_PAD >= 2,5 x --edge-blur. */
const EDGE = $('edge');
const EDGE_GLOW_PAD = 24; // px
let edgeKind = null;
let edgeColor = null;
let edgePad = 0;
let edgePadTimer = null;
let accessoryGlow = false;

function setEdgePad(pad){
  if(edgePad === pad) return;
  edgePad = pad;
  syncInteractiveRegion();
}

function refreshEdgePad(){
  clearTimeout(edgePadTimer);
  if(edgeColor || accessoryGlow){
    setEdgePad(EDGE_GLOW_PAD);
  } else {
    // On attend la fin du fondu (.35 s) avant de rendre la marge au clic-au-travers.
    edgePadTimer = setTimeout(() => setEdgePad(0), 450);
  }
}

function setEdge(color, kind){
  // color: orange | blue | green | amber | neutral | accent | null   kind: 'spin' | 'pulse'
  edgeColor = color || null;
  edgeKind = color ? (kind || 'pulse') : null;
  // #edge est un <div> : on pose les classes d'un bloc. Une valeur identique ne
  // relance pas l'animation CSS, la rotation continue donc sans à-coup quand
  // plusieurs tick consécutifs rappellent setEdge avec les mêmes paramètres.
  const next = edgeColor ? ('on ' + edgeKind + ' edge-' + edgeColor) : '';
  if(EDGE.getAttribute('class') !== next) EDGE.setAttribute('class', next);
  refreshEdgePad();
}

// Halo vert de l'accessoire audio (notch replié). Attribut dédié : il ne
// touche pas aux classes de setEdge, donc aucun état à sauvegarder / restaurer.
function setEdgeAccessoryGlow(on){
  accessoryGlow = !!on;
  if(accessoryGlow) EDGE.setAttribute('data-accessory', 'on');
  else EDGE.removeAttribute('data-accessory');
  refreshEdgePad();
}

`, 'bloc liseré JS');

/* 3c. accessoire audio : halo via le nouveau système ---------------------- */
replaceOnce('renderer/app.js',
`  audioAccessoryNotificationActive = false;
  body.dataset.accessoryState = 'hidden';`,
`  audioAccessoryNotificationActive = false;
  body.dataset.accessoryState = 'hidden';
  setEdgeAccessoryGlow(false);`, 'hide accessoire');

replaceOnce('renderer/app.js',
`  body.dataset.accessoryState = 'visible';
  audioAccessoryNotificationTimer = setTimeout(() => {`,
`  body.dataset.accessoryState = 'visible';
  setEdgeAccessoryGlow(true);
  audioAccessoryNotificationTimer = setTimeout(() => {`, 'show accessoire');

/* =====================================================================
 *  4. icons.js — engrenage recentré (décalage de -0,9 en x)
 * ===================================================================== */
replaceOnce('renderer/icons.js',
`<path d="M19.4 13a7.7 7.7 0 0 0 0-2l2-1.6-2-3.4-2.4.6a7.7 7.7 0 0 0-1.7-1L14.9 3h-4l-.4 2.6a7.7 7.7 0 0 0-1.7 1l-2.4-.6-2 3.4L6.4 11a7.7 7.7 0 0 0 0 2l-2 1.6 2 3.4 2.4-.6a7.7 7.7 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.7 7.7 0 0 0 1.7-1l2.4.6 2-3.4-2-1.6z"/>`,
`<path d="M18.5 13a7.7 7.7 0 0 0 0-2l2-1.6-2-3.4-2.4.6a7.7 7.7 0 0 0-1.7-1L14 3h-4l-.4 2.6a7.7 7.7 0 0 0-1.7 1l-2.4-.6-2 3.4L5.5 11a7.7 7.7 0 0 0 0 2l-2 1.6 2 3.4 2.4-.6a7.7 7.7 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.7 7.7 0 0 0 1.7-1l2.4.6 2-3.4-2-1.6z"/>`,
'gear path');

/* =====================================================================
 *  5. MODIFICATIONS.md
 * ===================================================================== */
{
  const entry = load('MODIFICATIONS.md');
  entry.text = entry.text.replace(/\s*$/, '\n') + `
## v14 — Visual identity: conic border glow, shadow cleanup, centered settings icon

- Replaced the SVG path + \`requestAnimationFrame\` edge light with a pure-CSS "animated border glow": two layers behind the notch surface (a sharp ring and a blurred glow), each driven by a rotating \`conic-gradient\`. \`setEdge(color, kind)\` keeps the same API (\`spin\` = rotating light, \`pulse\` = breathing contour) but only toggles classes now; color changes cross-fade through a registered \`--edge-color\` property.
- \`#capsule\` no longer clips its own content: background, rounded corners and \`overflow:hidden\` moved to the new \`#capsule-surface\`, so the glow can overflow around the shape. The ring is hidden along the top edge (the notch is flush with the screen).
- Removed every outer \`box-shadow\` / \`drop-shadow\` around the notch and the media companion. Cause of the grey, radius-less rectangle: the window is clipped by \`setShape()\` to a plain rectangle, so any shadow painted inside the rounded corners showed up as a grey square. The interactive region is now padded by \`EDGE_GLOW_PAD\` (24 px, sides and bottom) only while an edge glow is visible.
- Audio accessory (Bluetooth) green halo and update/reminder glows now go through the same edge system.
- Removed useless \`will-change: width,height\` on the capsule and \`left,width,height\` on the media notch.
- Incoming views now start 90 ms after the outgoing one begins to fade, so they no longer overlap during the size transition.
- Settings gear icon: the outline was centered on x = 12.9 while its inner circle and the button were centered on x = 12; the path is now centered.
`;
}

/* =====================================================================
 *  6. version
 * ===================================================================== */
let version = JSON.parse(load('package.json').text).version;
let tagExists = false;
try {
  tagExists = execSync('git tag --list v' + version, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim() === 'v' + version;
} catch { /* pas de dépôt git : on garde la version telle quelle */ }

if (tagExists) {
  const [major, minor, patch] = version.split('.').map(Number);
  const next = major + '.' + minor + '.' + (patch + 1);
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
  fs.writeFileSync(file(rel), entry.eol === '\r\n' ? entry.text.replace(/\n/g, '\r\n') : entry.text);
}

console.log('\n✔ Mise à jour appliquée : ' + [...pending.keys()].join(', '));
console.log('\nVersion : ' + version + (tagExists ? ' (incrémentée, le tag précédent existait déjà)' : ' (le tag v' + version + ' n\'existe pas encore)'));
console.log('\nVérifie (facultatif) :   npm run check');
console.log('\nPuis publie :\n');
console.log('  git add -A');
console.log('  git commit -m "v' + version + ' : liseré conic-gradient, ombres parasites supprimées, icône réglages centrée"');
console.log('  git tag v' + version);
console.log('  git push origin main v' + version + '\n');
