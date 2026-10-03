/* ==================== ÉTAT GLOBAL ==================== */
let settings = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  pomodorosBeforeLongBreak: 4,
  autoStartNext: false,
  autoUpdateEnabled: true,
  soundEnabled: true,
  soundVolume: 60,
  soundUi: false,
  soundNotifications: true,
  soundTimers: true,
  soundMuteWhenMedia: false,
  clipboardHistoryEnabled: true,
  reduceMotion: false,
  theme: 'sombre',
  accentColor: '#0a84ff',
  pinnedPages: ['pomodoro', 'schedule', 'timer', 'stopwatch'],
};
window.__notchSettings = settings;

let mode = null; // pill | hover | expanded | schedule | running | settings | shelf
let activeTool = null; // 'pomodoro' | 'timer' | 'stopwatch' | null
let currentTab = 'pomodoro';
const NOTCH_PAGES = [
  { id: 'pomodoro', label: 'Pomodoro', icon: 'focus' },
  { id: 'schedule', label: 'Calendar', icon: 'calendar' },
  { id: 'timer', label: 'Timer', icon: 'timer' },
  { id: 'stopwatch', label: 'Stopwatch', icon: 'stopwatch' },
  { id: 'clipboard', label: 'Clipboard', icon: 'clipboard' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics' },
];
const DEFAULT_PINNED_PAGES = ['pomodoro', 'schedule', 'timer', 'stopwatch'];
let pinnedPages = [...DEFAULT_PINNED_PAGES];
let clipboardHistory = [];
let clipboardScrollTimer = null;
let analyticsSessions = [];
let analyticsYear = new Date().getFullYear();
let analyticsMonthNumber = new Date().getMonth() + 1;
let analyticsTooltipTimer = null;

function normalizePinnedPages(value) {
  const source = Array.isArray(value) ? value : DEFAULT_PINNED_PAGES;
  return [...new Set(source.filter((id) => NOTCH_PAGES.some((page) => page.id === id)))].slice(0, 4);
}
function pageDefinition(id) {
  return NOTCH_PAGES.find((page) => page.id === id) || null;
}

const $ = (id) => document.getElementById(id);
const body = document.body;
window.addEventListener('error', (event) => {
  if (event.error?.stack) console.error('[DEBUG-a4f2]', event.error.stack);
});

/* ==================== MACHINE À ÉTATS DE LA CAPSULE ====================
   setMode ne fait plus AUCUN calcul de taille ni d'appel à la fenêtre OS :
   il pose juste la classe mode-XXX sur <body>, et c'est le CSS (transition
   sur width/height dans style.css) qui anime la capsule. La fenêtre
   Electron, elle, ne bouge plus jamais (voir main.js) — plus de décalage
   ni de "téléportation" liés à un redimensionnement natif de fenêtre. */
function setMode(next){
  if(next === mode) return;
  mode = next;
  body.className = 'mode-' + next + (settings.reduceMotion ? ' reduce-motion' : '');
}

const capsuleEl = $('capsule');
let windowShapeSupported = false;
let shelfItems = [];
let shelfSelectedIds = new Set();
let shelfPreviousMode = 'pill';
let shelfDragActive = false;

function setWindowMouseIgnored(ignore, options) {
  if(!windowShapeSupported) window.api.setIgnoreMouseEvents(ignore, options);
}

function rectForInput(el) {
  if(!el || el.hidden) return null;
  const rect = el.getBoundingClientRect();
  if(rect.width < 1 || rect.height < 1) return null;
  return {
    x: Math.max(0, Math.floor(rect.left)),
    y: Math.max(0, Math.floor(rect.top)),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  };
}

function syncInteractiveRegion() {
  if(!windowShapeSupported || !window.api.setInteractiveRegion) return;
  const rects = [rectForInput(capsuleEl)];
  const media = $('media-notch');
  if(media && !media.hidden) rects.push(rectForInput(media));
  window.api.setInteractiveRegion(rects.filter(Boolean));
}

function initWindowInputShape() {
  window.api.getWindowInputCapabilities?.().then((capabilities) => {
    windowShapeSupported = !!capabilities?.shape;
    if(windowShapeSupported) {
      const observer = new ResizeObserver(syncInteractiveRegion);
      observer.observe(capsuleEl);
      const media = $('media-notch');
      if(media) observer.observe(media);
      window.addEventListener('resize', syncInteractiveRegion);
      syncInteractiveRegion();
    }
  }).catch(() => {});
}


/* La fenêtre entière ignore la souris par défaut (clic-au-travers, voir
   main.js) ; on ne la réactive que pendant qu'on est réellement sur la
   capsule visible, exactement comme le recommande la doc Electron pour
   les fenêtres "click-through" partielles. */
capsuleEl.addEventListener('mouseenter', () => {
  setWindowMouseIgnored(false);
  if(mode==='pill') setMode('hover');
});
capsuleEl.addEventListener('mouseleave', () => {
  // Pendant un glisser natif vers la Shelf, le passage de la capsule
  // compacte à la capsule étendue peut provoquer un faux mouseleave.
  // Ne surtout pas repasser la fenêtre en click-through ici : cela
  // interromprait les dragover/drop provenant de l'Explorateur.
  if(shelfDragActive) return;
  setWindowMouseIgnored(true, { forward: true });
  if(mode==='hover') setMode('pill');
});

function requestWindowMode(kind){
  // L'IPC ne redimensionne plus la fenêtre native ; on le conserve pour que
  // le process principal connaisse la vue courante. Ne jamais attendre sa
  // résolution avant de rendre la vue : le CSS doit démarrer immédiatement.
  const pending = window.api.setWindowMode?.(kind);
  if(pending && typeof pending.catch === 'function') pending.catch(() => {});
}

function openCurrentView(){
  if(currentTab === 'schedule'){
    requestWindowMode('schedule');
    setMode('schedule');
    return;
  }
  requestWindowMode('notch');
  setMode(currentTab === 'analytics' ? 'analytics' : 'expanded');
}

$('view-pill').addEventListener('click', openCurrentView);
$('view-hover').addEventListener('click', (e) => {
  const shortcut = e.target.closest('.hover-shortcut[data-page]');
  if(shortcut){
    e.stopPropagation();
    selectTab(shortcut.dataset.page);
    return;
  }
  const shelfShortcut = e.target.closest('#shelf-hover-shortcut');
  if(shelfShortcut){
    e.stopPropagation();
    openShelfPanel();
    return;
  }
  openCurrentView();
});
$('view-running').addEventListener('click', (e) => {
  if(e.target.closest('#run-pause')) return; // géré séparément
  openCurrentView();
});
$('shelf-pill-badge').addEventListener('click', (e) => { e.stopPropagation(); openShelfPanel(); });
$('shelf-hover-shortcut').addEventListener('click', (e) => { e.stopPropagation(); openShelfPanel(); });
$('btn-collapse').addEventListener('click', () => {
  requestWindowMode('notch');
  setMode(activeTool ? 'running' : 'pill');
});
$('btn-settings').addEventListener('click', () => openSettingsPanel());

/* ==================== SHELF ==================== */
function isShelfDragEvent(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html');
}

function openShelfPanel() {
  if(mode === 'shelf') return;
  shelfPreviousMode = mode && mode !== 'settings' ? mode : (activeTool ? 'running' : 'pill');
  requestWindowMode('notch');
  renderShelf();
  setMode('shelf');
}

function closeShelfPanel() {
  const target = shelfPreviousMode === 'schedule' ? 'schedule' : (shelfPreviousMode || (activeTool ? 'running' : 'pill'));
  requestWindowMode(target === 'schedule' ? 'schedule' : 'notch');
  setMode(target);
}

function shelfDragEnter() {
  if(shelfDragActive) return;
  shelfDragActive = true;
  // Le drag doit rester interactif pendant toute l'ouverture animée du Shelf.
  setWindowMouseIgnored(false);
  openShelfPanel();
}

function shelfDragLeave() {
  if(!shelfDragActive) return;
  shelfDragActive = false;
  if(mode === 'shelf') closeShelfPanel();
}

async function handleShelfDrop(event) {
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  const localPaths = [];
  const webFiles = [];
  for(const file of files) {
    try {
      const nativePath = window.api.getPathForFile(file);
      if(nativePath) localPaths.push(nativePath);
      else if(file.type?.startsWith('image/')) webFiles.push(file);
    } catch {}
  }
  if(localPaths.length) await window.api.addShelfPaths(localPaths).then((data) => applyShelfData(data)).catch(() => {});

  const uriTypes = ['text/uri-list', 'text/html'];
  let imageUrl = '';
  for(const type of uriTypes) {
    try {
      const data = event.dataTransfer?.getData(type) || '';
      if(type === 'text/uri-list') {
        imageUrl = data.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//i.test(line)) || '';
      } else if(!imageUrl && data) {
        const match = data.match(/<img[^>]+src=["']([^"']+)["']/i);
        if(match && /^https?:\/\//i.test(match[1])) imageUrl = match[1];
      }
    } catch {}
    if(imageUrl) break;
  }

  try {
    if(imageUrl) {
      await window.api.addShelfWebImage({ url: imageUrl }).then((data) => applyShelfData(data)).catch(() => {});
    } else {
      for(const file of webFiles) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await window.api.addShelfWebBytes({ name: file.name || 'Web image', mime: file.type, bytes })
            .then((data) => applyShelfData(data)).catch(() => {});
        } catch {}
      }
    }
    renderShelf();
  } finally {
    shelfDragLeave();
  }
}

function applyShelfData(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  shelfItems = items;
  const existingIds = new Set(items.map((item) => item.id));
  shelfSelectedIds = new Set([...shelfSelectedIds].filter((id) => existingIds.has(id)));
  renderShelf();
}

function renderShelf() {
  const list = $('shelf-list');
  if(!list) return;
  list.innerHTML = '';
  const count = shelfItems.length;
  $('shelf-pill-badge').hidden = count === 0;
  $('shelf-pill-count').textContent = count;
  $('shelf-hover-shortcut').hidden = count === 0;
  $('shelf-hover-count').textContent = count;
  $('shelf-subtitle').textContent = `${count} ${count === 1 ? 'file' : 'files'}`;
  $('shelf-clear').disabled = count === 0;
  $('shelf-empty').hidden = count !== 0;

  for(const item of shelfItems) {
    const row = document.createElement('article');
    row.className = 'shelf-item' + (!item.exists ? ' missing' : '') + (shelfSelectedIds.has(item.id) ? ' selected' : '');
    row.draggable = !!item.exists;
    row.dataset.shelfId = item.id;
    row.title = item.path;

    const select = document.createElement('button');
    select.className = 'shelf-select';
    select.type = 'button';
    select.setAttribute('aria-pressed', shelfSelectedIds.has(item.id) ? 'true' : 'false');
    select.title = 'Select for multi-file drag';
    select.innerHTML = '<span class="icon" data-icon="check"></span>';
    select.addEventListener('click', (event) => {
      event.stopPropagation();
      if(shelfSelectedIds.has(item.id)) shelfSelectedIds.delete(item.id);
      else shelfSelectedIds.add(item.id);
      renderShelf();
    });

    const icon = document.createElement('span');
    icon.className = 'shelf-item-icon icon';
    icon.dataset.icon = item.kind === 'directory' ? 'folder' : 'shelf';

    const copy = document.createElement('div');
    copy.className = 'shelf-item-copy';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.textContent = item.exists ? (item.kind === 'directory' ? 'Folder' : 'File') : 'Missing';
    copy.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'shelf-item-actions';
    const open = document.createElement('button');
    open.className = 'icon-btn'; open.type = 'button'; open.title = 'Open location';
    open.disabled = !item.exists;
    open.innerHTML = '<span class="icon" data-icon="folder"></span>';
    open.addEventListener('click', (event) => { event.stopPropagation(); window.api.openShelfLocation(item.id); });
    const remove = document.createElement('button');
    remove.className = 'icon-btn'; remove.type = 'button'; remove.title = 'Remove from shelf';
    remove.innerHTML = '<span class="icon" data-icon="trash"></span>';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      applyShelfData(await window.api.removeShelfItem(item.id));
    });
    actions.append(open, remove);

    row.append(select, icon, copy, actions);
    row.addEventListener('dragstart', (event) => {
      if(!item.exists) { event.preventDefault(); return; }
      const selected = shelfSelectedIds.has(item.id) ? [...shelfSelectedIds] : [item.id];
      event.preventDefault();
      window.api.startShelfDrag(selected);
    });
    row.addEventListener('click', () => {
      if(!item.exists) return;
      window.api.openShelfLocation(item.id);
    });
    list.appendChild(row);
  }
  paintIcons(list);
}

$('shelf-close').addEventListener('click', closeShelfPanel);
$('shelf-clear').addEventListener('click', async () => {
  applyShelfData(await window.api.clearShelf());
});

capsuleEl.addEventListener('dragenter', (event) => {
  if(!isShelfDragEvent(event)) return;
  event.preventDefault();
  shelfDragEnter();
});
capsuleEl.addEventListener('dragover', (event) => {
  if(!isShelfDragEvent(event)) return;
  event.preventDefault();
});
capsuleEl.addEventListener('dragleave', (event) => {
  if(!isShelfDragEvent(event)) return;
  event.preventDefault();
  const next = event.relatedTarget;
  if(next && capsuleEl.contains(next)) return;
  shelfDragLeave();
});
capsuleEl.addEventListener('drop', (event) => {
  if(!isShelfDragEvent(event)) return;
  handleShelfDrop(event);
});

window.api.getShelfData?.().then(applyShelfData).catch(() => renderShelf());

/* ==================== ONGLETS ==================== */
function selectTab(name, updateMode = true){
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
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

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));

function renderPinnedPages() {
  pinnedPages = normalizePinnedPages(pinnedPages);
  const hover = $('hover-pages');
  if (hover) {
    hover.innerHTML = '';
    for (const pageId of pinnedPages) {
      const page = pageDefinition(pageId);
      if (!page) continue;
      const button = document.createElement('button');
      button.className = 'hover-shortcut pinned-page';
      button.type = 'button';
      button.dataset.page = page.id;
      button.title = page.label;
      button.setAttribute('aria-label', page.label);
      button.innerHTML = `<span class="icon" data-icon="${page.icon}"></span>`;
      hover.appendChild(button);
    }
    hover.hidden = pinnedPages.length === 0;
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    const isPinned = pinnedPages.includes(tab.dataset.tab);
    tab.classList.toggle('pinned', isPinned);
    tab.dataset.pinned = isPinned ? 'true' : 'false';
  });
  paintIcons(hover);
}

/* ==================== UTILS ==================== */
function fmt(totalSeconds){
  const m = Math.floor(totalSeconds/60), s = Math.floor(totalSeconds%60);
  return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function fmtTenths(totalMs){
  const s = Math.floor(totalMs/1000);
  const m = Math.floor(s/60), sec = s%60, tenths = Math.floor((totalMs%1000)/100);
  return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0')+'.'+tenths;
}

/* ==================== EFFETS SONORES ====================
   Sons courts (50-300 ms) embarqués dans sound-assets.js (la CSP interdit
   fetch/XHR vers des fichiers locaux), décodés UNE fois au démarrage et
   joués via un AudioContext partagé (voir sound-engine.js). Trois catégories
   — interface / notifications / minuteurs — plus un volume global et un
   mode « ne pas déranger » pendant la lecture média. */
const soundPlayer = window.SoundEngine.createSoundPlayer({
  AudioContextClass: window.AudioContext || window.webkitAudioContext,
  assets: window.NOTCH_SOUND_ASSETS,
  getSettings: () => settings,
  isMediaPlaying: () => !!(mediaState && mediaState.isPlaying),
});
soundPlayer.preload();
function playSound(name, options){ return soundPlayer.play(name, options); }

/* ==================== LIGNE DE LUMIÈRE QUI SUIT LE CONTOUR ====================
   Le rectangle a des coins carrés en haut et arrondis en bas (comme la
   capsule elle-même, voir --radius dans le CSS). On dessine ce contour
   exact en SVG et on fait progresser un segment lumineux le long de ce
   tracé (stroke-dasharray/stroke-dashoffset), à vitesse constante en
   pixels : la lumière suit donc réellement la forme, sans "sauter" du
   centre vers les côtés comme le faisait l'ancien dégradé conique. */
const EDGE = $('edge');
const EDGE_PATH = $('edge-path');
const EDGE_PATH_CORE = $('edge-path-core'); // le filament blanc, superposé au halo coloré
const EDGE_STROKE = 2;      // px
const CORNER_RADIUS = 20;   // doit correspondre à --radius dans style.css
const SEGMENT_RATIO = 0.16; // portion du pourtour occupée par le segment lumineux (plus discret qu'avant)
const CORE_SEGMENT_RATIO = 0.5; // longueur du cœur blanc, en proportion du segment coloré, centré dedans

let edgePerimeter = 0;
let edgeRAF = null;
let edgeSpinStart = null;
let edgeKind = null;
let edgeColor = null;
let coreOffsetShift = 0; // décalage constant (px) pour centrer le cœur dans le segment coloré

function clampRadii(w, h, tl, tr, br, bl){
  const edges = [
    (tl + tr) > 0 ? w / (tl + tr) : Infinity,
    (bl + br) > 0 ? w / (bl + br) : Infinity,
    (tl + bl) > 0 ? h / (tl + bl) : Infinity,
    (tr + br) > 0 ? h / (tr + br) : Infinity,
  ];
  const f = Math.min(1, ...edges);
  return [tl * f, tr * f, br * f, bl * f];
}

function roundedRectPath(x, y, w, h, tl, tr, br, bl){
  [tl, tr, br, bl] = clampRadii(w, h, tl, tr, br, bl);
  return `M ${x + tl} ${y} H ${x + w - tr} A ${tr} ${tr} 0 0 1 ${x + w} ${y + tr} `
       + `V ${y + h - br} A ${br} ${br} 0 0 1 ${x + w - br} ${y + h} `
       + `H ${x + bl} A ${bl} ${bl} 0 0 1 ${x} ${y + h - bl} `
       + `V ${y + tl} A ${tl} ${tl} 0 0 1 ${x + tl} ${y} Z`;
}

function applyDash(){
  const seg = edgePerimeter * SEGMENT_RATIO;
  EDGE_PATH.style.strokeDasharray = `${seg} ${Math.max(0, edgePerimeter - seg)}`;

  // Le cœur blanc est un segment plus court que le halo coloré, avec le
  // même pas total (perimeter) dans son dasharray : à décalage identique,
  // son "on" démarre donc au même endroit que celui du halo. On ajoute un
  // décalage constant (coreOffsetShift) pour le recentrer dans le segment
  // coloré plutôt que de le laisser collé à son bord de tête.
  const coreSeg = seg * CORE_SEGMENT_RATIO;
  EDGE_PATH_CORE.style.strokeDasharray = `${coreSeg} ${Math.max(0, edgePerimeter - coreSeg)}`;
  coreOffsetShift = (seg - coreSeg) / 2;
}

function updateEdgeGeometry(w, h){
  if(w < 4 || h < 4) return;
  EDGE.setAttribute('width', w);
  EDGE.setAttribute('height', h);
  EDGE.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const inset = EDGE_STROKE / 2;
  const r = Math.max(0, CORNER_RADIUS - inset);
  const d = roundedRectPath(inset, inset, w - EDGE_STROKE, h - EDGE_STROKE, 0, 0, r, r);
  EDGE_PATH.setAttribute('d', d);
  EDGE_PATH_CORE.setAttribute('d', d);
  edgePerimeter = EDGE_PATH.getTotalLength();
  if(edgeKind === 'spin') applyDash();
}

/* La capsule change maintenant de taille en CSS (transition width/height),
   plus par un vrai redimensionnement de la fenêtre OS : l'event "resize"
   de window ne se déclenche donc plus jamais pendant l'animation, ce qui
   laissait le tracé SVG bloqué à sa taille initiale (donc invisible ou
   mal placé une fois la capsule agrandie). Un ResizeObserver sur #capsule
   elle-même se déclenche à chaque frame pendant la transition CSS, quelle
   qu'en soit la cause : c'est la bonne source de vérité ici. */
const edgeResizeObserver = new ResizeObserver((entries) => {
  const box = entries[0].contentRect;
  updateEdgeGeometry(box.width, box.height);
});
edgeResizeObserver.observe(capsuleEl);

function stopEdgeSpin(){
  if(edgeRAF){ cancelAnimationFrame(edgeRAF); edgeRAF = null; }
  edgeSpinStart = null;
}
function edgeSpinStep(ts){
  if(!edgeSpinStart) edgeSpinStart = ts;
  const elapsed = (ts - edgeSpinStart) / 1000;
  const loopDuration = settings.reduceMotion ? 6 : 2.6; // secondes pour un tour complet
  const speed = edgePerimeter / loopDuration;           // px/s
  const offset = -((elapsed * speed) % edgePerimeter);
  EDGE_PATH.style.strokeDashoffset = offset;
  EDGE_PATH_CORE.style.strokeDashoffset = offset - coreOffsetShift;
  edgeRAF = requestAnimationFrame(edgeSpinStep);
}

function setEdge(color, kind){
  // color: orange | blue | green | amber | neutral | accent | null   kind: 'spin' | 'pulse'
  edgeColor = color || null;
  edgeKind = kind || null;
  if(!color){
    // #edge est un <svg> : .className y est un SVGAnimatedString, pas une
    // chaîne — une simple affectation ne fait rien. setAttribute fonctionne
    // aussi bien sur les éléments HTML que SVG.
    EDGE.setAttribute('class', '');
    stopEdgeSpin();
    return;
  }
  EDGE.setAttribute('class', `on ${kind} edge-${color}`);
  if(kind === 'spin'){
    applyDash();
    stopEdgeSpin();
    edgeRAF = requestAnimationFrame(edgeSpinStep);
  } else {
    stopEdgeSpin();
    EDGE_PATH.style.strokeDasharray = 'none';
    EDGE_PATH.style.strokeDashoffset = '0';
    EDGE_PATH_CORE.style.strokeDasharray = 'none';
    EDGE_PATH_CORE.style.strokeDashoffset = '0';
  }
}
// (pas besoin d'appel initial : observe() ci-dessus déclenche déjà une
// première mesure dès qu'il est enregistré, avec la taille de départ.)

/* ==================== HORLOGE ==================== */
function renderClock(){
  const now = new Date();
  $('pill-time').textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
renderClock();
setInterval(renderClock, 15000);

/* ==================== MÉTÉO ==================== */
function renderWeather(w){
  if(!w || typeof w.temp !== 'number') return;
  const iconEl = $('pill-weather-icon');
  iconEl.dataset.icon = w.icon || 'weather-clear';
  paintIcons(iconEl.parentElement);
  $('pill-temp').textContent = `${Math.round(w.temp)}°`;
}
if(window.api.getWeather) window.api.getWeather().then(renderWeather);
if(window.api.onWeatherUpdated) window.api.onWeatherUpdated(renderWeather);

/* ==================== APPARENCE (thème / accent) ==================== */
function applyAppearance(){
  document.documentElement.setAttribute(
    'data-theme',
    settings.theme === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'clair' : 'sombre')
      : settings.theme
  );
  document.documentElement.style.setProperty('--accent', settings.accentColor || '#0a84ff');
}

/* ==================== POMODORO ==================== */
const pomo = {
  phase: 'focus', // focus | short | long
  remaining: settings.focusMinutes * 60,
  running: false,
  handle: null,
  endAt: 0,
  count: 0,
};
let pomoSession = null;

function beginPomoSessionIfNeeded(){
  if(pomo.phase !== 'focus' || pomoSession) return;
  pomoSession = {
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    durationSeconds: pomoPhaseDuration('focus'),
    elapsedSeconds: 0,
  };
}

function accruePomoSession(){
  if(!pomoSession || !pomoSession.runningSinceMs) return;
  const delta = Math.max(0, (Date.now() - pomoSession.runningSinceMs) / 1000);
  pomoSession.elapsedSeconds = Math.min(pomoSession.durationSeconds, pomoSession.elapsedSeconds + delta);
  pomoSession.runningSinceMs = 0;
}

function resumePomoSession(){
  if(pomoSession) pomoSession.runningSinceMs = Date.now();
}

function recordPomoAnalyticsSession(completed){
  if(!pomoSession) return;
  accruePomoSession();
  const durationSeconds = completed
    ? pomoSession.durationSeconds
    : Math.round(Math.min(pomoSession.durationSeconds, pomoSession.elapsedSeconds));
  const session = {
    startedAt: pomoSession.startedAt,
    endedAt: new Date().toISOString(),
    durationSeconds,
    completed: !!completed,
  };
  pomoSession = null;
  if(durationSeconds <= 0 || !window.api.recordPomodoroSession) return;
  window.api.recordPomodoroSession(session).then((result) => {
    if(result?.session) addAnalyticsSession(result.session);
  }).catch(() => {});
}

function interruptPomoSession(){
  if(!pomoSession) return;
  recordPomoAnalyticsSession(false);
}

function pomoPhaseDuration(phase){
  if(phase==='focus') return settings.focusMinutes*60;
  if(phase==='short') return settings.shortBreakMinutes*60;
  return settings.longBreakMinutes*60;
}
function pomoPhaseLabel(phase){
  return phase==='focus' ? 'Focus' : phase==='short' ? 'Short break' : 'Long break';
}
function pomoEdge(phase){
  return phase==='focus' ? ['orange','spin'] : phase==='short' ? ['blue','pulse'] : ['green','pulse'];
}

function renderPomoDots(){
  const total = settings.pomodorosBeforeLongBreak;
  $('pomo-dots').innerHTML = Array.from({length: total}, (_,i) =>
    `<span class="d ${i < pomo.count % total ? 'on' : ''}"></span>`).join('');
}
function renderPomo(){
  $('pomo-phase').textContent = pomoPhaseLabel(pomo.phase);
  $('pomo-time').textContent = fmt(pomo.remaining);
  $('pomo-toggle').textContent = pomo.running ? 'Pause' : (pomo.remaining < pomoPhaseDuration(pomo.phase) ? 'Resume' : 'Start');
  renderPomoDots();
  if(mode==='running' && activeTool==='pomodoro'){
    $('run-icon').dataset.icon = 'focus';
    paintIcons($('run-icon').parentElement);
    $('run-time').textContent = fmt(pomo.remaining);
    $('run-label').textContent = pomoPhaseLabel(pomo.phase);
  }
}

function stopAllTools(exceptTool){
  if(exceptTool!=='pomodoro' && pomo.running){
    pomoSyncRemaining();
    accruePomoSession();
    pomo.running=false;
    pomo.endAt=0;
    clearInterval(pomo.handle);
    interruptPomoSession();
  }
  if(exceptTool!=='timer' && timer.running){ timerSyncRemaining(); timer.running=false; timer.endAt=0; clearInterval(timer.handle); }
  if(exceptTool!=='stopwatch' && sw.running){ sw.running=false; clearInterval(sw.handle); }
}

function pomoAdvancePhase(){
  if(pomo.phase==='focus'){
    recordPomoAnalyticsSession(true);
    pomo.count++;
    pomo.phase = (pomo.count % settings.pomodorosBeforeLongBreak === 0) ? 'long' : 'short';
  } else {
    pomo.phase = 'focus';
    if(settings.autoStartNext){
      beginPomoSessionIfNeeded();
      resumePomoSession();
    }
  }
  pomo.remaining = pomoPhaseDuration(pomo.phase);
}

/* Le temps restant est toujours recalculé depuis une échéance absolue (endAt)
   et non décrémenté à chaque tick : une mise en veille, un setInterval
   retardé ou un process ralenti ne font plus dériver le compte à rebours. */
function pomoSyncRemaining(){
  if(pomo.running && pomo.endAt) pomo.remaining = Math.max(0, Math.ceil((pomo.endAt - Date.now()) / 1000));
}

function pomoStart(){
  stopAllTools('pomodoro');
  beginPomoSessionIfNeeded();
  resumePomoSession();
  activeTool = 'pomodoro';
  pomo.running = true;
  pomo.endAt = Date.now() + pomo.remaining * 1000;
  const [c,k] = pomoEdge(pomo.phase); setEdge(c,k);
  setMode('running');
  clearInterval(pomo.handle);
  pomo.handle = setInterval(() => {
    const previous = pomo.remaining;
    pomoSyncRemaining();
    if(pomo.remaining <= 0){
      playSound(pomo.phase === 'focus' ? 'pomoFocusEnd' : 'pomoBreakEnd');
      pomoAdvancePhase();
      pomo.endAt = Date.now() + pomo.remaining * 1000;
      const [c2,k2] = pomoEdge(pomo.phase); setEdge(c2,k2);
      renderPomo();
      if(!settings.autoStartNext){ pomoPause(); }
      return;
    }
    if(pomo.remaining !== previous) renderPomo();
  }, 250);
  renderPomo();
}
window.startPlannerFocus = function startPlannerFocus(){
  requestWindowMode('notch');
  selectTab('pomodoro', false);
  if(pomo.running){ setMode('running'); return; }
  if(pomo.phase !== 'focus'){
    pomo.phase = 'focus';
    pomo.remaining = pomoPhaseDuration('focus');
  }
  pomoStart();
};
function pomoPause(){
  pomoSyncRemaining();
  accruePomoSession();
  pomo.running = false;
  pomo.endAt = 0;
  if(pomoSession) pomoSession.runningSinceMs = 0;
  clearInterval(pomo.handle);
  activeTool = null;
  setEdge(null);
  renderPomo();
}
function pomoReset(){
  if(pomoSession){
    accruePomoSession();
    recordPomoAnalyticsSession(false);
  }
  pomoPause();
  pomo.phase = 'focus'; pomo.count = 0;
  pomo.remaining = pomoPhaseDuration('focus');
  renderPomo();
}
$('pomo-toggle').addEventListener('click', () => { playSound('tick'); pomo.running ? pomoPause() : pomoStart(); });
$('pomo-reset').addEventListener('click', pomoReset);

/* ==================== MINUTEUR ==================== */
const timer = { minutes: 5, seconds: 0, remaining: 5*60, running: false, handle: null, endAt: 0 };

function timerSyncRemaining(){
  if(timer.running && timer.endAt) timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
}

function renderTimer(){
  $('timer-time').textContent = fmt(timer.remaining);
  $('timer-toggle').textContent = timer.running ? 'Pause' : (timer.remaining < timer.minutes*60+timer.seconds ? 'Resume' : 'Start');
  if(mode==='running' && activeTool==='timer'){
    $('run-icon').dataset.icon = 'timer';
    paintIcons($('run-icon').parentElement);
    $('run-time').textContent = fmt(timer.remaining);
    $('run-label').textContent = 'Timer';
  }
}
document.querySelectorAll('#timer-steppers button').forEach(btn => {
  btn.addEventListener('click', () => {
    if(timer.running) return;
    const delta = parseInt(btn.dataset.delta, 10);
    if(btn.dataset.target === 'timer-min'){
      timer.minutes = Math.max(0, Math.min(180, timer.minutes + delta));
    } else {
      timer.seconds = (timer.seconds + delta + 60) % 60;
    }
    timer.remaining = timer.minutes*60 + timer.seconds;
    renderTimer();
  });
});
function timerStart(){
  if(timer.remaining<=0) timer.remaining = timer.minutes*60 + timer.seconds;
  if(timer.remaining<=0) return;
  stopAllTools('timer');
  activeTool = 'timer';
  timer.running = true;
  timer.endAt = Date.now() + timer.remaining * 1000;
  setEdge('amber','pulse');
  setMode('running');
  clearInterval(timer.handle);
  timer.handle = setInterval(() => {
    const previous = timer.remaining;
    timerSyncRemaining();
    if(timer.remaining <= 0){
      timer.remaining = 0;
      playSound('timerDone');
      timerPause();
      renderTimer();
      return;
    }
    if(timer.remaining !== previous) renderTimer();
  }, 250);
  renderTimer();
}
function timerPause(){
  timerSyncRemaining();
  timer.running = false;
  timer.endAt = 0;
  clearInterval(timer.handle);
  activeTool = null;
  setEdge(null);
  renderTimer();
}
function timerReset(){
  timerPause();
  timer.remaining = timer.minutes*60 + timer.seconds;
  renderTimer();
}
$('timer-toggle').addEventListener('click', () => { playSound('tick'); timer.running ? timerPause() : timerStart(); });
$('timer-reset').addEventListener('click', timerReset);

/* ==================== CHRONOMÈTRE ==================== */
const sw = { elapsedMs: 0, startedAt: 0, running: false, handle: null };

function renderStopwatch(){
  $('sw-time').textContent = fmtTenths(sw.elapsedMs);
  $('sw-toggle').textContent = sw.running ? 'Pause' : (sw.elapsedMs>0 ? 'Resume' : 'Start');
  if(mode==='running' && activeTool==='stopwatch'){
    $('run-icon').dataset.icon = 'stopwatch';
    paintIcons($('run-icon').parentElement);
    $('run-time').textContent = fmtTenths(sw.elapsedMs).slice(0,5);
    $('run-label').textContent = 'Stopwatch';
  }
}
function swStart(){
  stopAllTools('stopwatch');
  activeTool = 'stopwatch';
  sw.running = true;
  sw.startedAt = Date.now() - sw.elapsedMs;
  setEdge('neutral','pulse');
  setMode('running');
  clearInterval(sw.handle);
  sw.handle = setInterval(() => {
    sw.elapsedMs = Date.now() - sw.startedAt;
    renderStopwatch();
  }, 100);
  renderStopwatch();
}
function swPause(){
  sw.running = false;
  clearInterval(sw.handle);
  activeTool = null;
  setEdge(null);
  renderStopwatch();
}
function swReset(){
  swPause();
  sw.elapsedMs = 0;
  renderStopwatch();
}
$('sw-toggle').addEventListener('click', () => { playSound('tick'); sw.running ? swPause() : swStart(); });
$('sw-reset').addEventListener('click', swReset);

/* ==================== BOUTON PAUSE DEPUIS LE MODE COMPACT ==================== */
$('run-pause').addEventListener('click', (e) => {
  e.stopPropagation();
  playSound('tick');
  if(activeTool==='pomodoro') pomoPause();
  else if(activeTool==='timer') timerPause();
  else if(activeTool==='stopwatch') swPause();
  setMode('expanded');
});

/* ==================== PARAMÈTRES ====================
   La bulle de réglages vit DANS le même renderer que le notch (mode
   "settings" de la machine à états ci-dessus) : plus de fenêtre Electron
   séparée à ouvrir/fermer par IPC. On applique chaque changement
   immédiatement en local (retour visuel instantané) et on ne persiste
   dans le store (via IPC) qu'après un court debounce, pour ne pas
   spammer le process principal pendant qu'on clique vite sur un stepper. */
function applySettings(s){
  settings = { ...settings, ...s, pinnedPages: normalizePinnedPages(s.pinnedPages ?? settings.pinnedPages) };
  window.__notchSettings = settings;
  pinnedPages = normalizePinnedPages(settings.pinnedPages);
  renderPinnedPages();
  applyAppearance();
  body.classList.toggle('reduce-motion', !!settings.reduceMotion);

  // Resynchronise les compteurs au repos avec les nouvelles durées
  // (corrige le bug où changer une durée de focus/pause n'avait aucun effet
  // tant qu'on n'avait pas cliqué sur Réinitialiser).
  if(!pomo.running){ pomo.remaining = pomoPhaseDuration(pomo.phase); }

  renderPomo(); renderTimer(); renderStopwatch();
  renderAnalytics();
}

let pendingPatch = {};
let saveTimer = null;
function queueSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const patch = pendingPatch;
    pendingPatch = {};
    window.api.saveSettings(patch);
  }, 250);
}
function updateSetting(key, value){
  applySettings({ [key]: value });
  pendingPatch[key] = value;
  queueSave();
}

function populateSettingsUI(){
  document.querySelectorAll('.stepper-inline').forEach((el) => {
    const field = el.dataset.field;
    const suffix = el.dataset.suffix || '';
    const valueEl = el.querySelector('[data-value]');
    valueEl.textContent = (settings[field] ?? 0) + suffix;
  });
  $('s-autoStartNext').checked = !!settings.autoStartNext;
  $('s-alwaysOnTop').checked = !!settings.alwaysOnTop;
  $('s-launchAtStartup').checked = !!settings.launchAtStartup;
  $('s-reduceMotion').checked = !!settings.reduceMotion;
  $('s-autoUpdateEnabled').checked = settings.autoUpdateEnabled !== false;
  renderUpdateState(updateState);
  $('s-soundEnabled').checked = !!settings.soundEnabled;
  $('s-soundUi').checked = !!settings.soundUi;
  $('s-soundNotifications').checked = settings.soundNotifications !== false;
  $('s-soundTimers').checked = settings.soundTimers !== false;
  $('s-soundMuteWhenMedia').checked = !!settings.soundMuteWhenMedia;
  const volumeInput = $('s-soundVolume');
  volumeInput.value = window.SoundEngine.normalizeVolume(settings.soundVolume);
  $('s-soundVolume-value').textContent = volumeInput.value + '%';
  volumeInput.style.setProperty('--progress', volumeInput.value + '%');
  volumeInput.closest('.settings-row').classList.toggle('is-disabled', !settings.soundEnabled);
  $('s-clipboardHistoryEnabled').checked = settings.clipboardHistoryEnabled !== false;
  $('s-eventRemindersEnabled').checked = !!settings.eventRemindersEnabled;
  pinnedPages = normalizePinnedPages(settings.pinnedPages);
  renderPinnedPages();
  renderPinnedSettings();

  document.querySelectorAll('#s-theme .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.value === settings.theme);
  });
  document.querySelectorAll('#s-accent .swatch').forEach((b) => {
    b.classList.toggle('active', b.dataset.color.toLowerCase() === String(settings.accentColor || '').toLowerCase());
  });
}

let previousMode = 'pill';
function openSettingsPanel(){
  if(mode === 'settings') return;
  previousMode = mode;
  requestWindowMode('notch');
  populateSettingsUI();
  setMode('settings');
}
function closeSettingsPanel(){
  const target = previousMode && previousMode !== 'settings' ? previousMode : (activeTool ? 'running' : 'pill');
  if(target === 'schedule') requestWindowMode('schedule');
  else requestWindowMode('notch');
  setMode(target);
}
$('btn-close-settings').addEventListener('click', closeSettingsPanel);
document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape' && mode === 'settings') closeSettingsPanel();
});

/* ---- steppers (durées pomodoro) ---- */
document.querySelectorAll('.stepper-inline').forEach((el) => {
  const field = el.dataset.field;
  const min = Number(el.dataset.min);
  const max = Number(el.dataset.max);
  const suffix = el.dataset.suffix || '';
  const valueEl = el.querySelector('[data-value]');
  el.querySelectorAll('.step-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.delta);
      const next = Math.max(min, Math.min(max, (Number(settings[field]) || 0) + delta));
      valueEl.textContent = next + suffix;
      updateSetting(field, next);
    });
  });
});

/* ---- interrupteurs ---- */
['autoStartNext', 'alwaysOnTop', 'launchAtStartup', 'reduceMotion', 'autoUpdateEnabled', 'soundEnabled', 'soundUi', 'soundNotifications', 'soundTimers', 'soundMuteWhenMedia', 'clipboardHistoryEnabled', 'eventRemindersEnabled'].forEach((key) => {
  $('s-' + key).addEventListener('change', (e) => {
    updateSetting(key, e.target.checked);
    if(key.startsWith('sound')) $('s-soundVolume').closest('.settings-row').classList.toggle('is-disabled', !settings.soundEnabled);
  });
});

/* ---- volume : mise à jour en direct, aperçu sonore au relâchement ---- */
$('s-soundVolume').addEventListener('input', (e) => {
  const value = window.SoundEngine.normalizeVolume(e.target.value);
  e.target.style.setProperty('--progress', value + '%');
  $('s-soundVolume-value').textContent = value + '%';
  updateSetting('soundVolume', value);
});
$('s-soundVolume').addEventListener('change', () => playSound('reminder', { force: true }));


/* ---- mises à jour (état piloté par le process principal, voir updater.js) ---- */
let updateState = { status: 'disabled', version: '', percent: 0 };
function updateStatusText(state){
  switch(state.status){
    case 'checking': return 'Checking for updates…';
    case 'downloading': return `Downloading v${state.availableVersion || ''} — ${state.percent || 0}%`;
    case 'downloaded': return `v${state.availableVersion || ''} is ready. It installs when you quit, or restart now.`;
    case 'uptodate': return 'You are up to date.';
    case 'error': return state.error || 'Update check failed.';
    case 'disabled': return 'Updates are disabled in development builds.';
    default: return 'Updates are checked automatically.';
  }
}
function renderUpdateState(state){
  updateState = state || updateState;
  const action = $('update-action');
  $('update-version').textContent = updateState.version ? `Version ${updateState.version}` : 'Version —';
  $('update-status').textContent = updateStatusText(updateState);
  const downloaded = updateState.status === 'downloaded';
  action.textContent = downloaded ? 'Restart to update' : 'Check now';
  action.disabled = ['checking', 'downloading', 'disabled'].includes(updateState.status);
}
$('update-action').addEventListener('click', () => {
  if(updateState.status === 'downloaded') window.api.installUpdate();
  else window.api.checkForUpdates();
});
if(window.api.onUpdateState) window.api.onUpdateState(renderUpdateState);
if(window.api.getUpdateState) window.api.getUpdateState().then(renderUpdateState).catch(() => {});

/* ---- thème (contrôle segmenté) ---- */
document.querySelectorAll('#s-theme .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#s-theme .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    updateSetting('theme', btn.dataset.value);
  });
});

/* ---- couleur d'accent (pastilles) ---- */
document.querySelectorAll('#s-accent .swatch').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#s-accent .swatch').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    updateSetting('accentColor', btn.dataset.color);
  });
});

/* ==================== RAPPELS CALENDRIER ==================== */
let calendarReminderQueue = [];
let calendarReminderShowing = false;
let calendarReminderTimer = null;
let calendarReminderPreviousMode = 'pill';
let calendarReminderPreviousEdge = { color: null, kind: null };

function calendarReminderDurationLabel(startMs) {
  const diff = Math.max(0, Number(startMs) - Date.now());
  const minutes = Math.max(0, Math.ceil(diff / 60000));
  if (minutes < 1) return 'in less than 1 min';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest} min` : `in ${hours}h`;
}

function calendarReminderWidth(title) {
  const characters = Math.min(150, Math.max(12, String(title || '').length));
  return Math.min(1120, Math.max(250, Math.round(108 + characters * 7.25)));
}

function finishCalendarReminder() {
  calendarReminderShowing = false;
  clearTimeout(calendarReminderTimer);
  calendarReminderTimer = null;
  setEdge(calendarReminderPreviousEdge.color, calendarReminderPreviousEdge.kind);
  const target = calendarReminderPreviousMode || 'pill';
  if (target === 'schedule') requestWindowMode('schedule');
  else requestWindowMode('notch');
  setMode(target);
  capsuleEl.style.removeProperty('--reminder-width');
  body.style.removeProperty('--reminder-half');
  if (calendarReminderQueue.length) setTimeout(showNextCalendarReminder, settings.reduceMotion ? 0 : 120);
}

function showNextCalendarReminder() {
  if (calendarReminderShowing || !calendarReminderQueue.length) return;
  const entry = calendarReminderQueue.shift();
  calendarReminderShowing = true;
  calendarReminderPreviousMode = mode && mode !== 'reminder' ? mode : 'pill';
  calendarReminderPreviousEdge = { color: edgeColor, kind: edgeKind };
  const title = String(entry?.event?.title || 'Calendar event').trim() || 'Calendar event';
  $('calendar-reminder-title').textContent = title;
  $('calendar-reminder-countdown').textContent = calendarReminderDurationLabel(entry.startMs);
  const reminderWidth = calendarReminderWidth(title);
  capsuleEl.style.setProperty('--reminder-width', `${reminderWidth}px`);
  body.style.setProperty('--reminder-half', `${Math.round(reminderWidth / 2)}px`);
  setEdge('accent', 'pulse');
  setMode('reminder');
  playSound('reminder');
  calendarReminderTimer = setTimeout(finishCalendarReminder, 3000);
}

window.__notchShowCalendarReminder = (event, startMs) => {
  if (!event || !Number.isFinite(Number(startMs)) || !settings.eventRemindersEnabled) return;
  calendarReminderQueue.push({ event, startMs: Number(startMs) });
  if (calendarReminderQueue.length > 8) calendarReminderQueue = calendarReminderQueue.slice(-8);
  showNextCalendarReminder();
};

/* ---- réinitialisation (double clic de confirmation, sans confirm()
   natif qui détonnerait dans une bulle transparente sans chrome) ---- */
const resetBtn = $('btn-reset-settings');
let resetPending = false;
let resetTimer = null;
resetBtn.addEventListener('click', async () => {
  if(!resetPending){
    resetPending = true;
    resetBtn.textContent = 'Confirm reset';
    resetBtn.classList.add('danger-pending');
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      resetPending = false;
      resetBtn.textContent = 'Reset settings';
      resetBtn.classList.remove('danger-pending');
    }, 3000);
    return;
  }
  clearTimeout(resetTimer);
  resetPending = false;
  resetBtn.textContent = 'Reset settings';
  resetBtn.classList.remove('danger-pending');
  const defaults = await window.api.resetSettings();
  applySettings(defaults);
  populateSettingsUI();
});

window.api.onSettingsUpdated((s) => {
  applySettings(s);
  if(mode === 'settings') populateSettingsUI();
});
window.api.getSettings().then((s) => {
  settings = { ...settings, ...s };
  settings.pinnedPages = normalizePinnedPages(settings.pinnedPages);
  window.__notchSettings = settings;
  pinnedPages = [...settings.pinnedPages];
  renderPinnedPages();
  applyAppearance();
  body.classList.toggle('reduce-motion', !!settings.reduceMotion);
  pomo.remaining = pomoPhaseDuration('focus');
  timer.remaining = timer.minutes*60 + timer.seconds;
  renderPomo(); renderTimer(); renderStopwatch();
  populateSettingsUI();
});


/* ==================== ANALYTICS ==================== */
function analyticsPad(value){ return String(value).padStart(2,'0'); }
function analyticsDuration(seconds){
  const totalMinutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
  if(totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}
function analyticsDateLabel(year, month, day, withYear=false){
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-GB', { day:'numeric', month:'long', ...(withYear ? {year:'numeric'} : {}) });
}
function analyticsHourLabel(hour){ return `${analyticsPad(hour)}:00–${analyticsPad((hour + 1) % 24)}:00`; }
function shiftAnalyticsMonth(delta){
  const date = new Date(analyticsYear, analyticsMonthNumber - 1 + delta, 1);
  analyticsYear = date.getFullYear();
  analyticsMonthNumber = date.getMonth() + 1;
  renderAnalytics();
}

function showAnalyticsTooltip(cell, data){
  const tooltip = $('analytics-tooltip');
  const panel = $('panel-analytics');
  if(!tooltip || !panel || cell.empty) return;
  const dateLabel = analyticsDateLabel(data.year, data.month, data.day, true);
  tooltip.innerHTML = `<strong>${dateLabel}</strong><span>${analyticsDuration(data.seconds)} focus</span><span>${data.sessions} ${data.sessions === 1 ? 'Pomodoro' : 'Pomodoros'}</span><span>${data.completed} completed · ${data.interrupted} interrupted</span>`;
  tooltip.hidden = false;
  clearTimeout(analyticsTooltipTimer);
  requestAnimationFrame(() => {
    const panelRect = panel.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    let left = cellRect.left - panelRect.left + cellRect.width / 2 - tipRect.width / 2;
    let top = cellRect.bottom - panelRect.top + 7;
    const minLeft = 6;
    const maxLeft = Math.max(minLeft, panelRect.width - tipRect.width - 6);
    if(top + tipRect.height > panelRect.height - 6) top = cellRect.top - panelRect.top - tipRect.height - 7;
    tooltip.style.left = `${Math.max(minLeft, Math.min(maxLeft, left))}px`;
    tooltip.style.top = `${Math.max(6, top)}px`;
  });
}
function hideAnalyticsTooltip(){
  clearTimeout(analyticsTooltipTimer);
  analyticsTooltipTimer = setTimeout(() => {
    const tooltip = $('analytics-tooltip');
    if(tooltip) tooltip.hidden = true;
  }, 60);
}

function renderAnalyticsMonthCard(data, slot){
  const gridId = slot === 'current' ? 'analytics-grid' : `analytics-grid-${slot}`;
  const gridEl = $(gridId);
  const labelEl = $(`analytics-month-${slot}-label`);
  if(!gridEl) return;
  gridEl.innerHTML = '';
  gridEl.style.setProperty('--analytics-weeks', data.grid.weeks);
  if(labelEl) labelEl.textContent = data.label;
  const monthCard = gridEl.closest('.analytics-month-card');
  if(monthCard) monthCard.setAttribute('aria-label', `${data.label} concentration`);

  for(const cellData of data.grid.cells){
    if(cellData.empty){
      const empty = document.createElement('span');
      empty.className = 'analytics-day analytics-day-empty';
      gridEl.appendChild(empty);
      continue;
    }
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `analytics-day analytics-level-${cellData.level}`;
    cell.dataset.dateKey = cellData.dateKey;
    cell.setAttribute('role','gridcell');
    cell.setAttribute('aria-label', `${analyticsDateLabel(cellData.year, cellData.month, cellData.day, true)} — ${analyticsDuration(cellData.seconds)} focus, ${cellData.sessions} Pomodoros, ${cellData.completed} completed, ${cellData.interrupted} interrupted`);
    cell.addEventListener('mouseenter', () => showAnalyticsTooltip(cell, cellData));
    cell.addEventListener('mouseleave', hideAnalyticsTooltip);
    cell.addEventListener('focus', () => showAnalyticsTooltip(cell, cellData));
    cell.addEventListener('blur', hideAnalyticsTooltip);
    gridEl.appendChild(cell);
  }
}

function analyticsAdjacentMonth(year, month, delta){
  const date = new Date(year, month - 1 + delta, 1);
  return { year:date.getFullYear(), month:date.getMonth() + 1 };
}

function renderAnalyticsCalendar(data){
  const next = analyticsAdjacentMonth(data.year, data.month, 1);
  const nextData = window.AnalyticsEngine.monthAnalytics(next.year, next.month, analyticsSessions);
  renderAnalyticsMonthCard(data, 'current');
  renderAnalyticsMonthCard(nextData, 'next');
  setAnalyticsText('analytics-period', `${data.label} · ${nextData.label}`);
}

function setAnalyticsText(id, value){ const el=$(id); if(el) el.textContent=value; }
function renderAnalyticsDailyChart(data){
  const svg = $('analytics-daily-chart');
  if(!svg) return;
  svg.innerHTML = '';
  const width = 640, height = 150, padX = 10, top = 10, bottom = 28;
  const values = data.days.map(day => day.seconds / 60);
  const max = Math.max(1, ...values);
  const usableH = height - top - bottom;
  const x = (index) => values.length <= 1 ? width / 2 : padX + index * ((width - padX * 2) / (values.length - 1));
  const y = (value) => top + usableH - (value / max) * usableH;
  const baseline = document.createElementNS('http://www.w3.org/2000/svg','line');
  baseline.setAttribute('x1', padX); baseline.setAttribute('x2', width - padX); baseline.setAttribute('y1', top + usableH); baseline.setAttribute('y2', top + usableH);
  baseline.setAttribute('class','analytics-chart-axis'); svg.appendChild(baseline);
  if(data.totalSeconds <= 0){
    const empty = document.createElementNS('http://www.w3.org/2000/svg','text');
    empty.setAttribute('x', width / 2); empty.setAttribute('y', 78); empty.setAttribute('text-anchor','middle'); empty.setAttribute('class','analytics-chart-empty'); empty.textContent='No focus data yet'; svg.appendChild(empty); return;
  }
  const points = values.map((value,index)=>`${x(index)},${y(value)}`).join(' ');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg','polyline');
  polyline.setAttribute('points', points); polyline.setAttribute('class','analytics-chart-line'); svg.appendChild(polyline);
  values.forEach((value,index)=>{
    if(!value) return;
    const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
    circle.setAttribute('cx', x(index)); circle.setAttribute('cy', y(value)); circle.setAttribute('r','2.2'); circle.setAttribute('class','analytics-chart-point'); svg.appendChild(circle);
  });
  [0,4,9,14,19,24,29].filter(day => day < values.length).forEach((index) => {
    const label = document.createElementNS('http://www.w3.org/2000/svg','text');
    label.setAttribute('x', x(index)); label.setAttribute('y', height - 7); label.setAttribute('text-anchor', index === 0 ? 'start' : index === values.length-1 ? 'end' : 'middle'); label.setAttribute('class','analytics-chart-label'); label.textContent = String(index + 1); svg.appendChild(label);
  });
}

function renderAnalyticsHourChart(data){
  const chart = $('analytics-hour-chart');
  if(!chart) return;
  chart.innerHTML='';
  const max = Math.max(1, ...data.hours.map(item => item.seconds));
  data.hours.forEach((item) => {
    const wrap = document.createElement('div'); wrap.className='analytics-hour-item';
    const bar = document.createElement('span'); bar.className='analytics-hour-bar';
    bar.style.height = item.seconds > 0 ? `${Math.max(6,(item.seconds / max) * 100)}%` : '3%';
    bar.title = `${analyticsHourLabel(item.hour)} · ${analyticsDuration(item.seconds)}`;
    const label = document.createElement('span'); label.className='analytics-hour-label'; label.textContent = item.hour % 3 === 0 ? String(item.hour).padStart(2,'0') : '';
    wrap.appendChild(bar); wrap.appendChild(label); chart.appendChild(wrap);
  });
}

function renderAnalyticsStatus(data){
  const total = data.totalSessions || 0;
  const completedPct = total ? (data.completedSessions / total) * 100 : 0;
  const interruptedPct = total ? (data.interruptedSessions / total) * 100 : 0;
  $('analytics-status-completed').style.width = `${completedPct}%`;
  $('analytics-status-interrupted').style.width = `${interruptedPct}%`;
  setAnalyticsText('analytics-status-completed-count', data.completedSessions);
  setAnalyticsText('analytics-status-interrupted-count', data.interruptedSessions);
  setAnalyticsText('analytics-status-label', total ? `${Math.round(completedPct)}% completed` : 'No sessions');
}

function renderAnalytics(){
  if(!window.AnalyticsEngine || !$('panel-analytics')) return;
  const data = window.AnalyticsEngine.monthAnalytics(analyticsYear, analyticsMonthNumber, analyticsSessions);
  setAnalyticsText('analytics-period', data.label);
  renderAnalyticsCalendar(data);
  renderAnalyticsDailyChart(data);
  renderAnalyticsHourChart(data);
  renderAnalyticsStatus(data);
  setAnalyticsText('analytics-total-focus', analyticsDuration(data.totalSeconds));
  setAnalyticsText('analytics-total-sessions', data.totalSessions);
  setAnalyticsText('analytics-completed', data.completedSessions);
  setAnalyticsText('analytics-average-session', analyticsDuration(data.averageSessionSeconds));
  setAnalyticsText('analytics-best-day', data.mostProductiveDay ? analyticsDateLabel(data.mostProductiveDay.year, data.mostProductiveDay.month, data.mostProductiveDay.day) : '—');
  setAnalyticsText('analytics-best-hour', data.bestHour ? analyticsHourLabel(data.bestHour.hour) : '—');
  setAnalyticsText('analytics-daily-average', analyticsDuration(data.dailyAverageSeconds));
  setAnalyticsText('analytics-completion-rate', data.totalSessions ? `${Math.round((data.completedSessions / data.totalSessions) * 100)}%` : '—');
  setAnalyticsText('analytics-active-days', `${data.activeDayCount} active ${data.activeDayCount === 1 ? 'day' : 'days'}`);
  setAnalyticsText('analytics-hour-label', data.bestHour ? analyticsHourLabel(data.bestHour.hour) : 'No focus data');
}

function addAnalyticsSession(session){
  if(!session || !session.startedAt) return;
  analyticsSessions = analyticsSessions.filter(item => item.id !== session.id);
  analyticsSessions.push(session);
  analyticsSessions.sort((a,b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  renderAnalytics();
}

$('analytics-prev').addEventListener('click', (event) => { event.stopPropagation(); shiftAnalyticsMonth(-1); });
$('analytics-next').addEventListener('click', (event) => { event.stopPropagation(); shiftAnalyticsMonth(1); });
$('analytics-expand').addEventListener('click', (event) => { event.stopPropagation(); requestWindowMode('schedule'); setMode('analytics-expanded'); });
$('analytics-collapse').addEventListener('click', (event) => { event.stopPropagation(); requestWindowMode('notch'); setMode('analytics'); });

if(window.api.onPomodoroAnalyticsUpdated) window.api.onPomodoroAnalyticsUpdated(addAnalyticsSession);
if(window.api.getPomodoroAnalytics){
  window.api.getPomodoroAnalytics().then((result) => {
    analyticsSessions = Array.isArray(result?.sessions) ? result.sessions : [];
    renderAnalytics();
  }).catch(() => renderAnalytics());
}


/* ==================== HISTORIQUE DU PRESSE-PAPIERS ==================== */
function clipboardKindLabel(item) {
  if(item.kind === 'image') return 'Image';
  if(item.kind === 'html') return 'Rich text';
  if(item.kind === 'rtf') return 'Formatted text';
  if(item.kind === 'other') return 'Other';
  return 'Text';
}

function clipboardTime(iso) {
  const date = new Date(iso);
  if(Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function renderClipboardHistory() {
  const list = $('clipboard-list');
  const empty = $('clipboard-empty');
  const count = $('clipboard-count');
  if(!list) return;
  list.innerHTML = '';
  count.textContent = `${clipboardHistory.length} / 25`;
  empty.hidden = clipboardHistory.length !== 0;

  for(const item of clipboardHistory.slice(0, 25)) {
    const button = document.createElement('button');
    button.className = `clipboard-item clipboard-kind-${item.kind || 'other'}`;
    button.type = 'button';
    button.dataset.clipboardId = item.id;
    button.title = `Copy ${clipboardKindLabel(item).toLowerCase()} to clipboard`;

    const preview = document.createElement('div');
    preview.className = 'clipboard-preview';
    if(item.thumbnail) {
      const image = document.createElement('img');
      image.className = 'clipboard-thumb';
      image.src = item.thumbnail;
      image.alt = 'Clipboard image';
      preview.appendChild(image);
    } else {
      const icon = document.createElement('span');
      icon.className = 'icon clipboard-type-icon';
      icon.dataset.icon = item.kind === 'text' ? 'text' : item.kind === 'html' || item.kind === 'rtf' ? 'document' : 'clipboard';
      preview.appendChild(icon);
    }

    const copy = document.createElement('span');
    copy.className = 'clipboard-item-copy';
    const label = document.createElement('strong');
    label.textContent = clipboardKindLabel(item);
    const text = document.createElement('span');
    text.textContent = item.preview || 'Empty clipboard item';
    copy.append(label, text);

    const meta = document.createElement('span');
    meta.className = 'clipboard-item-meta';
    meta.textContent = clipboardTime(item.addedAt);
    const action = document.createElement('span');
    action.className = 'icon clipboard-copy-icon';
    action.dataset.icon = 'copy';

    button.append(preview, copy, meta, action);
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const result = await window.api.copyClipboardHistoryItem(item.id).catch(() => ({ ok:false }));
      if(result?.ok) {
        button.classList.add('copied');
        setTimeout(() => button.classList.remove('copied'), 650);
      }
    });
    list.appendChild(button);
  }
  paintIcons(list);
}

function applyClipboardHistory(history) {
  clipboardHistory = Array.isArray(history) ? history.slice(0, 25) : [];
  renderClipboardHistory();
}

$('clipboard-refresh').addEventListener('click', () => {
  window.api.requestClipboardHistoryRefresh?.();
  window.api.getClipboardHistory?.().then(applyClipboardHistory).catch(() => {});
});
$('clipboard-list').addEventListener('scroll', () => {
  const list = $('clipboard-list');
  list.classList.add('is-scrolling');
  clearTimeout(clipboardScrollTimer);
  clipboardScrollTimer = setTimeout(() => list.classList.remove('is-scrolling'), 600);
}, { passive:true });
if(window.api.onClipboardHistoryUpdated) window.api.onClipboardHistoryUpdated(applyClipboardHistory);
if(window.api.getClipboardHistory) window.api.getClipboardHistory().then(applyClipboardHistory).catch(() => renderClipboardHistory());

/* ==================== SYSTÈME DES PAGES ÉPINGLÉES ==================== */
function renderPinnedSettings() {
  const list = $('pinned-pages-list');
  if(!list) return;
  pinnedPages = normalizePinnedPages(pinnedPages);
  list.innerHTML = '';
  const orderedPages = [
    ...pinnedPages.map(pageDefinition).filter(Boolean),
    ...NOTCH_PAGES.filter((page) => !pinnedPages.includes(page.id)),
  ];

  for(const page of orderedPages) {
    const isPinned = pinnedPages.includes(page.id);
    const row = document.createElement('div');
    row.className = `pinned-page-row${isPinned ? ' is-pinned' : ''}`;
    const main = document.createElement('label');
    main.className = 'pinned-page-main';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isPinned;
    checkbox.dataset.page = page.id;
    const icon = document.createElement('span');
    icon.className = 'icon'; icon.dataset.icon = page.icon;
    const text = document.createElement('span');
    text.textContent = page.label;
    main.append(checkbox, icon, text);

    const controls = document.createElement('div');
    controls.className = 'pinned-page-order';
    const up = document.createElement('button');
    up.className = 'icon-btn'; up.type = 'button'; up.dataset.move = 'up'; up.dataset.page = page.id;
    up.title = 'Move up'; up.disabled = !isPinned || pinnedPages.indexOf(page.id) === 0;
    up.innerHTML = '<span class=\"icon\" data-icon=\"chevron-up\"></span>';
    const down = document.createElement('button');
    down.className = 'icon-btn'; down.type = 'button'; down.dataset.move = 'down'; down.dataset.page = page.id;
    down.title = 'Move down'; down.disabled = !isPinned || pinnedPages.indexOf(page.id) === pinnedPages.length - 1;
    down.innerHTML = '<span class=\"icon\" data-icon=\"chevron-down\"></span>';
    controls.append(up, down);
    row.append(main, controls);
    list.appendChild(row);

    checkbox.addEventListener('change', () => {
      if(checkbox.checked) {
        if(!pinnedPages.includes(page.id) && pinnedPages.length < 4) pinnedPages.push(page.id);
        else if(pinnedPages.length >= 4) checkbox.checked = false;
      } else {
        pinnedPages = pinnedPages.filter((id) => id !== page.id);
      }
      updateSetting('pinnedPages', [...pinnedPages]);
      renderPinnedPages();
      renderPinnedSettings();
    });
    for(const moveButton of [up, down]) {
      moveButton.addEventListener('click', () => {
        if(moveButton.disabled) return;
        const index = pinnedPages.indexOf(page.id);
        if(index < 0) return;
        const target = moveButton.dataset.move === 'up' ? index - 1 : index + 1;
        if(target < 0 || target >= pinnedPages.length) return;
        [pinnedPages[index], pinnedPages[target]] = [pinnedPages[target], pinnedPages[index]];
        updateSetting('pinnedPages', [...pinnedPages]);
        renderPinnedPages();
        renderPinnedSettings();
      });
    }
  }
  paintIcons(list);
}

/* ==================== SYSTEM MEDIA COMPANION ==================== */
const mediaUI = {
  notch: $('media-notch'),
  compact: $('media-compact'),
  compactCover: $('media-compact-cover'),
  panelCover: $('media-cover'),
  collapse: $('media-collapse'),
  title: $('media-title'),
  artist: $('media-artist'),
  source: $('media-source'),
  progress: $('media-progress'),
  current: $('media-current'),
  duration: $('media-duration'),
  previous: $('media-previous'),
  playPause: $('media-play-pause'),
  next: $('media-next'),
};

let mediaState = { available:false };
let mediaExpanded = false;
let mediaScrubbing = false;
let mediaBasePosition = 0;
let mediaTimelineReferenceMs = Date.now();
let mediaCoverSrc = '';
let mediaTrackIdentity = '';
let mediaTransitionTimer = null;
let mediaCoverClearTimer = null;
let mediaPendingSeek = null;
let mediaSeekToken = 0;
let audioAccessoryNotificationTimer = null;
let audioAccessoryNotificationActive = false;
let mediaExpandedBeforeAccessoryNotification = false;

function mediaTime(totalSeconds){
  const safe = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if(hours > 0) return `${hours}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
  return `${minutes}:${String(seconds).padStart(2,'0')}`;
}

function friendlyMediaSource(source){
  const value = String(source || '');
  if(!value) return '';
  const lower = value.toLowerCase();
  if(lower.includes('spotify')) return 'Spotify';
  if(lower.includes('deezer')) return 'Deezer';
  if(lower.includes('chrome')) return 'Chrome';
  if(lower.includes('msedge') || lower.includes('microsoftedge')) return 'Edge';
  if(lower.includes('firefox')) return 'Firefox';
  if(lower.includes('vlc')) return 'VLC';
  const compact = value.split('!')[0].split('.').filter(Boolean).pop() || value;
  return compact.slice(0, 32);
}

function mediaIdentity(state){
  if(!state || !state.available) return '';
  return [
    state.sourceApp || state.source || '',
    state.title || '',
    state.artist || '',
    state.album || '',
    state.albumArtist || '',
    state.trackNumber ?? ''
  ].join('\u001f');
}

function setMediaExpanded(expanded){
  if(!mediaState.available) expanded = false;
  if(expanded && audioAccessoryNotificationActive) expanded = false;
  mediaExpanded = !!expanded;
  body.dataset.mediaState = mediaState.available
    ? (mediaExpanded ? 'expanded' : 'compact')
    : 'hidden';
  mediaUI.compact.setAttribute('aria-expanded', mediaExpanded ? 'true' : 'false');
}

function setMediaProgress(position, duration){
  const safeDuration = Math.max(0, Number(duration) || 0);
  const safePosition = Math.max(0, Math.min(safeDuration || Infinity, Number(position) || 0));
  if(!mediaScrubbing){
    mediaUI.progress.max = String(safeDuration || 1);
    mediaUI.progress.value = String(safePosition);
  }
  const shownPosition = mediaScrubbing ? Number(mediaUI.progress.value) || 0 : safePosition;
  const percentage = safeDuration > 0 ? Math.max(0, Math.min(100, shownPosition / safeDuration * 100)) : 0;
  mediaUI.progress.style.setProperty('--progress', `${percentage}%`);
  mediaUI.current.textContent = mediaTime(shownPosition);
  mediaUI.duration.textContent = mediaTime(safeDuration);
}

function clearMediaArtwork(){
  mediaCoverSrc = '';
  mediaUI.compactCover.removeAttribute('src');
  mediaUI.panelCover.removeAttribute('src');
  mediaUI.notch.classList.remove('has-cover');
}

function applyMediaArtwork(cover, identity){
  if(!cover) return;
  const probe = new Image();
  probe.decoding = 'async';
  probe.onload = () => {
    if(identity !== mediaTrackIdentity) return;
    clearTimeout(mediaCoverClearTimer);
    mediaCoverClearTimer = null;
    mediaCoverSrc = cover;
    mediaUI.compactCover.src = cover;
    mediaUI.panelCover.src = cover;
    mediaUI.notch.classList.add('has-cover');
  };
  probe.onerror = () => {
    // Keep the previous cover during a track transition rather than flashing
    // the fallback. A later GSMTC retry can still replace it.
    if(identity !== mediaTrackIdentity || mediaCoverSrc) return;
    clearMediaArtwork();
  };
  probe.src = cover;
}

function applyMediaMetadata(state){
  mediaUI.title.textContent = state.title || 'Now playing';
  mediaUI.artist.textContent = [state.artist, state.album].filter(Boolean).join(' · ');
  mediaUI.source.textContent = friendlyMediaSource(state.sourceApp || state.source);

  const identity = mediaIdentity(state);
  const cover = String(state.artworkUrl || state.cover || '');
  if(cover){
    clearTimeout(mediaCoverClearTimer);
    mediaCoverClearTimer = null;
    if(cover !== mediaCoverSrc) applyMediaArtwork(cover, identity);
  } else if(state.artworkResolved === true){
    // GSMTC metadata and artwork often arrive in separate updates. Preserve
    // the previous cover briefly so Next/Previous never flashes an empty
    // bubble; clear it only if Windows still reports no artwork afterward.
    clearTimeout(mediaCoverClearTimer);
    mediaCoverClearTimer = setTimeout(() => {
      if(identity !== mediaTrackIdentity) return;
      const latestCover = String(mediaState.artworkUrl || mediaState.cover || '');
      if(!latestCover) clearMediaArtwork();
    }, mediaCoverSrc ? 1200 : 0);
  } else if(!mediaCoverSrc){
    clearMediaArtwork();
  }
}

function transitionMediaMetadata(state, trackChanged){
  clearTimeout(mediaTransitionTimer);
  if(!trackChanged || settings.reduceMotion){
    applyMediaMetadata(state);
    mediaUI.notch.classList.remove('media-changing');
    return;
  }
  mediaUI.notch.classList.add('media-changing');
  mediaTransitionTimer = setTimeout(() => {
    applyMediaMetadata(state);
    requestAnimationFrame(() => mediaUI.notch.classList.remove('media-changing'));
  }, 95);
}

function renderMedia(next){
  const normalized = next && next.available ? { ...next } : { available:false };
  const isPlaying = !!(normalized.playing ?? normalized.isPlaying);

  // GSMTC is the source of truth. If Windows reports a controllable media
  // session, show the companion immediately. Artwork is optional and never
  // participates in the visibility decision.
  const previousIdentity = mediaTrackIdentity;
  const nextIdentity = mediaIdentity(normalized);
  const trackChanged = !!nextIdentity && nextIdentity !== previousIdentity;
  // A seek is applied optimistically in the renderer. Some players (including
  // Deezer) keep exposing the pre-seek GSMTC timeline for a few samples after
  // TryChangePlaybackPositionAsync succeeds. Do not let those stale samples
  // snap the thumb back to the old position.
  let preserveOptimisticSeek = false;
  const incomingPosition = Number(normalized.position ?? normalized.positionSeconds) || 0;
  if(mediaPendingSeek){
    const sameTrack = !!nextIdentity && nextIdentity === mediaPendingSeek.identity;
    if(!sameTrack || !normalized.available){
      mediaPendingSeek = null;
    } else {
      const delta = Math.abs(incomingPosition - mediaPendingSeek.target);
      const acknowledged = delta <= 2.5;
      if(acknowledged || Date.now() >= mediaPendingSeek.expiresAt){
        mediaPendingSeek = null;
      } else {
        preserveOptimisticSeek = true;
      }
    }
  }

  mediaTrackIdentity = nextIdentity;
  mediaState = normalized;
  mediaState.isPlaying = isPlaying;
  mediaState.playing = isPlaying;
  if(!preserveOptimisticSeek){
    mediaBasePosition = incomingPosition;
    mediaTimelineReferenceMs = Number(mediaState.timelineUpdatedAtMs) || Date.now();
  } else {
    mediaState.position = mediaPendingSeek.target;
    mediaState.positionSeconds = mediaPendingSeek.target;
  }

  if(!mediaState.available){
    mediaUI.notch.hidden = true;
    mediaUI.notch.classList.remove('media-visible');
    mediaExpanded = false;
    body.dataset.mediaState = 'hidden';
    if(!mediaState.available){
      clearTimeout(mediaCoverClearTimer);
      mediaCoverClearTimer = null;
      clearMediaArtwork();
      mediaTrackIdentity = '';
      mediaUI.notch.classList.remove('is-playing','media-changing');
    }
    syncInteractiveRegion();
    return;
  }

  mediaUI.notch.hidden = false;
  mediaUI.notch.classList.add('media-visible');
  if(!body.dataset.mediaState || body.dataset.mediaState === 'hidden') setMediaExpanded(false);
  else body.dataset.mediaState = mediaExpanded ? 'expanded' : 'compact';

  const incomingCover = String(mediaState.artworkUrl || mediaState.cover || '');
  const coverChanged = mediaState.artworkResolved === true && incomingCover !== mediaCoverSrc;
  transitionMediaMetadata(mediaState, trackChanged || coverChanged);
  mediaUI.notch.classList.toggle('is-playing', isPlaying);

  const playIcon = mediaUI.playPause.querySelector('.icon');
  playIcon.dataset.icon = isPlaying ? 'pause' : 'play';
  paintIcons(mediaUI.playPause);
  mediaUI.playPause.title = isPlaying ? 'Pause' : 'Play';
  mediaUI.previous.disabled = mediaState.canPrevious !== true;
  mediaUI.next.disabled = mediaState.canNext !== true;
  mediaUI.playPause.disabled = isPlaying
    ? (mediaState.canPause !== true && mediaState.canTogglePlayPause !== true)
    : (mediaState.canPlay !== true && mediaState.canTogglePlayPause !== true);
  const duration = Number(mediaState.duration ?? mediaState.durationSeconds) || 0;
  mediaUI.progress.disabled = mediaState.canSeek !== true || !(duration > 0);
  const renderedPosition = preserveOptimisticSeek && mediaState.isPlaying
    ? mediaBasePosition + Math.max(0, Date.now() - mediaTimelineReferenceMs) / 1000
    : mediaBasePosition;
  setMediaProgress(renderedPosition, duration);
  paintIcons(mediaUI.notch);
  syncInteractiveRegion();
}

function mediaProgressTick(){
  if(!mediaState.available || mediaScrubbing) return;
  let position = mediaBasePosition;
  if(mediaState.isPlaying){
    // Windows' timeline Position is a reference value at LastUpdatedTime.
    // Interpolate locally between WinRT events instead of querying GSMTC every frame.
    const elapsed = Math.max(0, Date.now() - mediaTimelineReferenceMs) / 1000;
    position += elapsed;
  }
  setMediaProgress(position, Number(mediaState.duration ?? mediaState.durationSeconds) || 0);
}
setInterval(mediaProgressTick, 100);

mediaUI.notch.addEventListener('mouseenter', () => setWindowMouseIgnored(false));
mediaUI.notch.addEventListener('mouseleave', () => setWindowMouseIgnored(true, { forward:true }));
mediaUI.compact.addEventListener('click', (event) => {
  event.stopPropagation();
  setMediaExpanded(true);
});
mediaUI.collapse.addEventListener('click', () => setMediaExpanded(false));

async function sendMediaCommand(command, payload){
  if(!window.api.mediaCommand) return { ok:false };
  try{ return await window.api.mediaCommand(command, payload || {}); }
  catch(error){ console.error('[media]', error); return { ok:false, error:String(error) }; }
}

mediaUI.playPause.addEventListener('click', async () => {
  const wasPlaying = !!mediaState.isPlaying;
  mediaState.isPlaying = !wasPlaying;
  mediaState.playing = !wasPlaying;
  mediaBasePosition = Number(mediaUI.progress.value) || mediaBasePosition;
  mediaTimelineReferenceMs = Date.now();
  renderMedia(mediaState);
  const result = await sendMediaCommand('playPause');
  if(!result?.ok){
    mediaState.isPlaying = wasPlaying;
    mediaState.playing = wasPlaying;
    mediaTimelineReferenceMs = Date.now();
    renderMedia(mediaState);
  }
});
mediaUI.previous.addEventListener('click', () => sendMediaCommand('previous'));
mediaUI.next.addEventListener('click', () => sendMediaCommand('next'));
mediaUI.progress.addEventListener('pointerdown', () => {
  if(mediaUI.progress.disabled) return;
  mediaScrubbing = true;
  mediaUI.progress.classList.add('is-scrubbing');
});
mediaUI.progress.addEventListener('input', () => {
  if(mediaUI.progress.disabled) return;
  mediaScrubbing = true;
  setMediaProgress(Number(mediaUI.progress.value), Number(mediaState.duration ?? mediaState.durationSeconds));
});
async function commitMediaSeek(){
  if(mediaUI.progress.disabled) return;
  const previousPosition = mediaBasePosition;
  const positionSeconds = Number(mediaUI.progress.value) || 0;
  const token = ++mediaSeekToken;
  mediaPendingSeek = {
    token,
    target: positionSeconds,
    identity: mediaTrackIdentity,
    expiresAt: Date.now() + 3000,
  };
  mediaBasePosition = positionSeconds;
  mediaTimelineReferenceMs = Date.now();
  mediaState.position = positionSeconds;
  mediaState.positionSeconds = positionSeconds;
  mediaScrubbing = false;
  mediaUI.progress.classList.remove('is-scrubbing');
  setMediaProgress(positionSeconds, Number(mediaState.duration ?? mediaState.durationSeconds));

  const result = await sendMediaCommand('seek', { positionSeconds });
  if(token !== mediaSeekToken || mediaTrackIdentity !== mediaPendingSeek?.identity) return;
  if(!result?.ok){
    mediaPendingSeek = null;
    mediaBasePosition = previousPosition;
    mediaTimelineReferenceMs = Date.now();
    setMediaProgress(previousPosition, Number(mediaState.duration ?? mediaState.durationSeconds));
    return;
  }

  // Ask the native bridge for a few fresh timeline samples after the seek.
  // The thumb remains optimistic until GSMTC acknowledges the new position.
  if(window.api.refreshMedia){
    for(const delay of [120, 360, 800, 1500]){
      setTimeout(() => window.api.refreshMedia().catch(() => {}), delay);
    }
  }
}
mediaUI.progress.addEventListener('change', commitMediaSeek);
mediaUI.progress.addEventListener('pointerup', () => {
  setTimeout(() => { if(mediaScrubbing) commitMediaSeek(); }, 0);
});
mediaUI.progress.addEventListener('pointercancel', () => {
  mediaScrubbing = false;
  mediaUI.progress.classList.remove('is-scrubbing');
  setMediaProgress(mediaBasePosition, Number(mediaState.duration ?? mediaState.durationSeconds));
});

if(window.api.onMediaUpdated) window.api.onMediaUpdated(renderMedia);
if(window.api.getMediaState) {
  window.api.getMediaState().then(renderMedia).catch(() => renderMedia({ available:false }));
  // IPC events are the primary path. This slow cache resync is intentionally
  // redundant so a renderer reload/startup race can never leave Now Playing
  // hidden while the main process already has a valid GSMTC state.
  setInterval(() => {
    window.api.getMediaState().then((state) => {
      // This periodic read is only a recovery path for a missed IPC message.
      // Never use it to hide Now Playing: a cache sample can land in the tiny
      // GSMTC gap between two tracks. Authoritative hide events come from the
      // media service after its unavailable grace window.
      if(state && state.available) renderMedia(state);
      else if(window.api.refreshMedia) window.api.refreshMedia().catch(() => {});
    }).catch(() => {});
  }, 1000);
}


/* ==================== CONNECTED AUDIO ACCESSORY ==================== */
const audioAccessoryUI = {
  icon: $('pill-accessory-icon'),
  name: $('pill-accessory-name'),
  battery: $('pill-accessory-battery'),
};
let audioAccessoryState = { connected:false };
let audioAccessoryInitialized = false;
let audioAccessoryWasConnected = false;

function hideAudioAccessoryNotification(restoreMedia = true){
  clearTimeout(audioAccessoryNotificationTimer);
  audioAccessoryNotificationTimer = null;
  if(!audioAccessoryNotificationActive) return;
  audioAccessoryNotificationActive = false;
  body.dataset.accessoryState = 'hidden';
  if(restoreMedia && mediaExpandedBeforeAccessoryNotification && mediaState.available){
    mediaExpandedBeforeAccessoryNotification = false;
    setMediaExpanded(true);
  } else {
    mediaExpandedBeforeAccessoryNotification = false;
  }
}

function showAudioAccessoryNotification(){
  clearTimeout(audioAccessoryNotificationTimer);
  audioAccessoryNotificationActive = true;
  mediaExpandedBeforeAccessoryNotification = mediaExpanded;
  // The accessory notification has priority over the expanded media panel.
  // Collapse it for the notification lifetime, then restore it once.
  if(mediaExpanded) setMediaExpanded(false);
  body.dataset.accessoryState = 'visible';
  audioAccessoryNotificationTimer = setTimeout(() => {
    hideAudioAccessoryNotification(true);
  }, 3000);
}

function renderAudioAccessory(state){
  const next = state && state.connected ? state : { connected:false };
  const connected = !!next.connected;
  const justConnected = audioAccessoryInitialized && !audioAccessoryWasConnected && connected;
  const justDisconnected = audioAccessoryInitialized && audioAccessoryWasConnected && !connected;
  audioAccessoryState = next;
  audioAccessoryWasConnected = connected;
  audioAccessoryInitialized = true;

  if(!connected){
    hideAudioAccessoryNotification(true);
    if(justDisconnected) playSound('disconnect');
    return;
  }

  audioAccessoryUI.icon.dataset.icon = next.deviceType === 'earbuds' ? 'earbuds' : 'headphones';
  audioAccessoryUI.name.textContent = next.name || 'Audio device';
  audioAccessoryUI.battery.textContent = Number.isFinite(next.batteryPercent)
    ? `${Math.max(0, Math.min(100, Math.round(next.batteryPercent)))}%`
    : '—%';
  paintIcons($('view-pill'));

  // Do not turn a renderer bootstrap sample into a fake connection event.
  if(justConnected){
    showAudioAccessoryNotification();
    playSound('connect'); // même condition que la notification : jamais au démarrage
  }
}

if(window.api.onAudioAccessoryUpdated) window.api.onAudioAccessoryUpdated(renderAudioAccessory);
if(window.api.getAudioAccessoryState) {
  window.api.getAudioAccessoryState().then(renderAudioAccessory).catch(() => renderAudioAccessory({ connected:false }));
}

/* ==================== INIT ==================== */
initWindowInputShape();
setMode('pill');
renderPomo(); renderTimer(); renderStopwatch(); renderShelf();
