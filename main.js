const { app, BrowserWindow, ipcMain, screen, shell, nativeImage, clipboard, Tray, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const { randomUUID } = require('crypto');
const Store = require('electron-store');
const { WindowsMediaService } = require('./media-service');
const { createUpdater } = require('./updater');
const { sanitizeSnapshot, isSnapshotFresh } = require('./resume-state');
const { DEFAULT_GLOBAL_SHORTCUT, isValidAccelerator } = require('./shortcut');

// Une seule instance : un second lancement créerait un deuxième notch, un
// deuxième sondeur de presse-papiers et un deuxième process PowerShell.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

// Lu AVANT la création du store (qui écrit son fichier) : sert à n'afficher
// l'accueil qu'aux nouvelles installations, pas à une mise à jour.
const configAlreadyExisted = fs.existsSync(path.join(app.getPath('userData'), 'config.json'));

const store = new Store({
  defaults: {
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    pomodorosBeforeLongBreak: 4,
    autoStartNext: false,
    autoUpdateEnabled: true,
    collapseOnOutsideClick: true,
    soundEnabled: true,
    soundVolume: 60,
    soundUi: false,
    soundNotifications: true,
    soundTimers: true,
    soundMuteWhenMedia: false,
    clipboardHistoryEnabled: true,
    theme: 'sombre',
    accentColor: '#0a84ff',
    reduceMotion: false,
    alwaysOnTop: true,
    launchAtStartup: false,
    eventRemindersEnabled: false,
    eventReminderMinutes: 10,
    pinnedPages: ['pomodoro', 'schedule', 'timer', 'stopwatch'],
    autoHide: false,
    globalShortcutEnabled: true,
    globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
    weatherEnabled: true,
    lastTab: 'pomodoro',
  },
});

// Les données d'organisation ont leur propre fichier de stockage. Elles ne
// transitent jamais par save-settings, ce qui évite qu'une réinitialisation
// des préférences efface cours et tâches.
const plannerStore = new Store({
  name: 'planner',
  defaults: { calendarSources: [], calendarEvents: [], calendarMeta: {}, plannerTasks: [] },
});

// La shelf ne conserve que des références locales. Les images déposées depuis
// le navigateur, qui n'ont pas de chemin natif, sont les seules copies créées.
const shelfStore = new Store({
  name: 'shelf',
  defaults: { items: [] },
});
const shelfIconCache = new Map();
const clipboardHistoryStore = new Store({
  name: 'clipboard-history',
  defaults: { items: [] },
});
const CLIPBOARD_HISTORY_MAX_ITEMS = 25;
const CLIPBOARD_MAX_RAW_FORMAT_BYTES = 2 * 1024 * 1024;
const analyticsStore = new Store({
  name: 'analytics',
  defaults: { sessions: [] },
});
const ANALYTICS_MAX_SESSIONS = 20000;
const CLIPBOARD_MAX_TOTAL_RAW_BYTES = 6 * 1024 * 1024;
let clipboardPollTimer = null;
let clipboardPollBusy = false;
let clipboardHistoryEnabled = true; // copie en mémoire du réglage (évite de relire le fichier à chaque tick)
let clipboardLastFingerprint = '';

function cleanAnalyticsSession(value) {
  if (!value || typeof value !== 'object') return null;
  const startedAt = new Date(value.startedAt);
  if (Number.isNaN(startedAt.getTime())) return null;
  const endedAt = new Date(value.endedAt || startedAt);
  const durationSeconds = Math.max(0, Math.min(24 * 60 * 60, Number(value.durationSeconds) || 0));
  if (!(durationSeconds > 0)) return null;
  const completed = value.completed === true;
  return {
    id: cleanText(value.id, 120) || randomUUID(),
    startedAt: startedAt.toISOString(),
    endedAt: Number.isNaN(endedAt.getTime()) ? new Date(startedAt.getTime() + durationSeconds * 1000).toISOString() : endedAt.toISOString(),
    durationSeconds: Math.round(durationSeconds),
    completed,
    interrupted: !completed,
  };
}

function getAnalyticsSessions() {
  const raw = analyticsStore.get('sessions');
  if (!Array.isArray(raw)) return [];
  const sessions = raw.map(cleanAnalyticsSession).filter(Boolean).slice(-ANALYTICS_MAX_SESSIONS);
  if (sessions.length !== raw.length) analyticsStore.set('sessions', sessions);
  return sessions;
}

function clipboardHistoryMediaDir() {
  return path.join(app.getPath('userData'), 'clipboard-history-media');
}

function ensureClipboardHistoryMediaDir() {
  const dir = clipboardHistoryMediaDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanClipboardHistoryItem(value) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanText(value.id, 120);
  const kind = ['text', 'image', 'html', 'rtf', 'other'].includes(value.kind) ? value.kind : 'other';
  if (!id) return null;
  const rawFormats = Array.isArray(value.rawFormats) ? value.rawFormats.slice(0, 6).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const format = cleanText(item.format, 300);
    const filePath = cleanText(item.filePath, 10000);
    if (!format || !filePath || !path.isAbsolute(filePath)) return null;
    return { format, filePath: path.normalize(filePath) };
  }).filter(Boolean) : [];
  return {
    id,
    kind,
    preview: cleanText(value.preview, 1200),
    text: cleanText(value.text, 10000),
    html: cleanText(value.html, 50000),
    rtf: cleanText(value.rtf, 50000),
    imagePath: cleanText(value.imagePath, 10000),
    bookmark: value.bookmark && typeof value.bookmark === 'object' ? {
      title: cleanText(value.bookmark.title, 500),
      url: cleanText(value.bookmark.url, 4000),
    } : null,
    rawFormats,
    formats: Array.isArray(value.formats) ? value.formats.slice(0, 32).map((item) => cleanText(item, 300)).filter(Boolean) : [],
    addedAt: cleanText(value.addedAt, 50) || new Date().toISOString(),
  };
}

function getClipboardHistoryRawItems() {
  const raw = clipboardHistoryStore.get('items');
  if (!Array.isArray(raw)) return [];
  const items = raw.map(cleanClipboardHistoryItem).filter(Boolean).slice(0, CLIPBOARD_HISTORY_MAX_ITEMS);
  if (items.length !== raw.length) clipboardHistoryStore.set('items', items);
  return items;
}

function imageThumbnailData(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return '';
    return image.resize({ width: 92, height: 64 }).toDataURL();
  } catch { return ''; }
}

function getClipboardHistoryData() {
  return getClipboardHistoryRawItems().map((item) => ({
    id: item.id,
    kind: item.kind,
    preview: item.preview,
    text: item.text,
    formats: item.formats,
    addedAt: item.addedAt,
    thumbnail: item.imagePath ? imageThumbnailData(item.imagePath) : '',
  }));
}

function clipboardFingerprint(parts) {
  const { createHash } = require('crypto');
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ formats: parts.formats || [], text: parts.text || '', html: parts.html || '', rtf: parts.rtf || '', bookmark: parts.bookmark || null }));
  if (parts.imageBuffer?.length) hash.update(parts.imageBuffer);
  for (const raw of parts.rawFormats || []) {
    hash.update(raw.format);
    hash.update(raw.buffer);
  }
  return hash.digest('hex');
}

/**
 * Windows permet aux gestionnaires de mots de passe de marquer une copie comme
 * sensible. Les deux formats ci-dessous sont ceux que Windows lui-même respecte
 * pour son propre historique (Win+V) :
 *  - ExcludeClipboardContentFromMonitorProcessing : présence = ne pas surveiller
 *  - CanIncludeInClipboardHistory : DWORD à 0 = ne pas conserver dans l'historique
 * Dans ce cas on n'enregistre rien (ni texte, ni image, ni formats bruts).
 */
function clipboardIsMarkedSensitive(formats) {
  if (process.platform !== 'win32') return false;
  const names = (Array.isArray(formats) ? formats : []).map((format) => String(format).toLowerCase());
  if (names.includes('excludeclipboardcontentfrommonitorprocessing')) return true;
  try {
    const exclude = clipboard.readBuffer('ExcludeClipboardContentFromMonitorProcessing');
    if (Buffer.isBuffer(exclude) && exclude.length > 0) return true;
  } catch {}
  try {
    const history = clipboard.readBuffer('CanIncludeInClipboardHistory');
    if (Buffer.isBuffer(history) && history.length >= 4 && history.readUInt32LE(0) === 0) return true;
  } catch {}
  return false;
}

async function readClipboardSnapshot() {
  const formats = typeof clipboard.availableFormats === 'function' ? clipboard.availableFormats() : [];
  if (!Array.isArray(formats) || !formats.length) return null;
  if (clipboardIsMarkedSensitive(formats)) return null;

  let text = '';
  let html = '';
  let rtf = '';
  let imageBuffer = null;
  let bookmark = null;
  try { text = clipboard.readText() || ''; } catch {}
  try { html = clipboard.readHTML() || ''; } catch {}
  try { rtf = clipboard.readRTF() || ''; } catch {}
  try {
    const image = clipboard.readImage();
    if (image && !image.isEmpty()) imageBuffer = image.toPNG();
  } catch {}
  try {
    if (typeof clipboard.readBookmark === 'function' && formats.some((format) => /bookmark/i.test(format))) {
      bookmark = clipboard.readBookmark();
    }
  } catch {}

  const rawFormats = [];
  let totalRawBytes = 0;
  for (const format of formats.slice(0, 12)) {
    if (/^(text|html|rtf|image\/|application\/rtf)/i.test(format) || /bookmark/i.test(format)) continue;
    try {
      const buffer = clipboard.readBuffer(format);
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > CLIPBOARD_MAX_RAW_FORMAT_BYTES) continue;
      if (totalRawBytes + buffer.length > CLIPBOARD_MAX_TOTAL_RAW_BYTES) break;
      totalRawBytes += buffer.length;
      rawFormats.push({ format, buffer });
    } catch {}
  }

  const hasImage = !!imageBuffer?.length;
  const hasText = !!text;
  const hasHtml = !!html;
  const hasRtf = !!rtf;
  const hasBookmark = !!bookmark?.url;
  const hasRaw = rawFormats.length > 0;
  if (!hasImage && !hasText && !hasHtml && !hasRtf && !hasBookmark && !hasRaw) return null;

  let kind = hasImage ? 'image' : hasText ? 'text' : hasHtml ? 'html' : hasRtf ? 'rtf' : 'other';
  if (hasHtml && hasText) kind = 'html';
  const preview = hasText ? text.trim().replace(/\s+/g, ' ').slice(0, 1000)
    : hasHtml ? html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)
    : hasRtf ? rtf.replace(/\[a-z]+[-]?\d* ?/gi, ' ').replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)
    : hasBookmark ? (bookmark.title || bookmark.url || '').slice(0, 1000)
    : hasImage ? 'Image'
    : 'Other clipboard content';

  return { formats, text, html, rtf, imageBuffer, bookmark, rawFormats, preview, kind };
}

function clipboardHistoryItemFingerprint(item) {
  const imageBuffer = item?.imagePath && fs.existsSync(item.imagePath) ? fs.readFileSync(item.imagePath) : null;
  const rawFormats = [];
  for (const raw of item?.rawFormats || []) {
    try {
      if (fs.existsSync(raw.filePath)) rawFormats.push({ format: raw.format, buffer: fs.readFileSync(raw.filePath) });
    } catch {}
  }
  return clipboardFingerprint({
    formats: item?.formats || [], text: item?.text || '', html: item?.html || '', rtf: item?.rtf || '',
    bookmark: item?.bookmark || null, imageBuffer, rawFormats,
  });
}

function removeClipboardHistoryItemFiles(item) {
  const paths = [item.imagePath, ...(item.rawFormats || []).map((entry) => entry.filePath)];
  for (const filePath of paths) {
    try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  }
}

/**
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

function addClipboardHistoryItem(snapshot) {
  const fingerprint = clipboardFingerprint(snapshot);
  if (fingerprint === clipboardLastFingerprint) return getClipboardHistoryData();
  clipboardLastFingerprint = fingerprint;

  const dir = ensureClipboardHistoryMediaDir();
  const id = `clip-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let imagePath = '';
  if (snapshot.imageBuffer?.length) {
    imagePath = path.join(dir, `${id}.png`);
    fs.writeFileSync(imagePath, snapshot.imageBuffer);
  }
  const rawFormats = [];
  for (let index = 0; index < (snapshot.rawFormats || []).length; index++) {
    const entry = snapshot.rawFormats[index];
    const filePath = path.join(dir, `${id}-${index}.bin`);
    try {
      fs.writeFileSync(filePath, entry.buffer);
      rawFormats.push({ format: entry.format, filePath });
    } catch {}
  }

  const items = getClipboardHistoryRawItems();
  const next = {
    id, kind: snapshot.kind, preview: snapshot.preview, text: snapshot.text.slice(0, 10000),
    html: snapshot.html.slice(0, 50000), rtf: snapshot.rtf.slice(0, 50000), imagePath,
    bookmark: snapshot.bookmark ? { title: snapshot.bookmark.title || '', url: snapshot.bookmark.url || '' } : null,
    rawFormats, formats: snapshot.formats.slice(0, 32), addedAt: new Date().toISOString(),
  };
  const trimmed = [next, ...items].slice(0, CLIPBOARD_HISTORY_MAX_ITEMS);
  for (const old of items.slice(CLIPBOARD_HISTORY_MAX_ITEMS - 1)) removeClipboardHistoryItemFiles(old);
  clipboardHistoryStore.set('items', trimmed);
  if (notchWin && !notchWin.isDestroyed()) notchWin.webContents.send('clipboard-history-updated', getClipboardHistoryData());
  return getClipboardHistoryData();
}

async function pollClipboardHistory() {
  if (!clipboardHistoryEnabled || clipboardPollBusy || !app.isReady()) return;
  clipboardPollBusy = true;
  try {
    const snapshot = await readClipboardSnapshot();
    if (snapshot) addClipboardHistoryItem(snapshot);
  } catch (error) {
    console.error('[clipboard-history]', error.message);
  } finally {
    clipboardPollBusy = false;
  }
}

function startClipboardHistoryLoop() {
  clearInterval(clipboardPollTimer);
  pollClipboardHistory();
  clipboardPollTimer = setInterval(pollClipboardHistory, 700);
}

async function restoreClipboardHistoryItem(id) {
  const item = getClipboardHistoryRawItems().find((candidate) => candidate.id === cleanText(id, 120));
  if (!item) return { ok: false };
  try {
    if (item.imagePath && fs.existsSync(item.imagePath) && typeof clipboard.writeImage === 'function') {
      const image = nativeImage.createFromPath(item.imagePath);
      clipboard.write({ text: item.text || item.bookmark?.url || '', html: item.html || '', rtf: item.rtf || '', image, bookmark: item.bookmark?.title || undefined });
    } else if (item.text) {
      clipboard.write({ text: item.text || item.bookmark?.url || '', html: item.html || undefined, rtf: item.rtf || undefined, bookmark: item.bookmark?.title || undefined });
    } else if (item.html || item.rtf) {
      clipboard.write({ text: item.text || '', html: item.html || undefined, rtf: item.rtf || undefined });
    } else if (item.bookmark?.url && typeof clipboard.writeBookmark === 'function') {
      clipboard.writeBookmark(item.bookmark.title || '', item.bookmark.url);
    } else if (item.rawFormats?.length) {
      const raw = item.rawFormats.find((entry) => fs.existsSync(entry.filePath));
      if (!raw) return { ok: false };
      clipboard.writeBuffer(raw.format, fs.readFileSync(raw.filePath));
    } else {
      return { ok: false };
    }
    clipboardLastFingerprint = clipboardHistoryItemFingerprint(item);
    return { ok: true };
  } catch (error) {
    console.error('[clipboard-history] restore failed:', error.message);
    return { ok: false };
  }
}

const SHELF_MAX_ITEMS = 200;
const SHELF_MAX_WEB_BYTES = 25 * 1024 * 1024;
const SHELF_FALLBACK_ICON = nativeImage.createFromDataURL(
  'data:image/svg+xml;base64,' + Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="5" y="4" width="22" height="24" rx="4" fill="#1c1c1e"/><path d="M10 11h12M10 16h12M10 21h8" stroke="#f5f5f7" stroke-width="2" stroke-linecap="round"/></svg>'
  ).toString('base64')
);

function shelfTempDir() {
  return path.join(app.getPath('temp'), 'Notch Bar', 'shelf');
}

function normalizeShelfName(value, fallback = 'Dropped image') {
  const name = cleanText(value, 500).trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[ .]+$/, '');
  return name || fallback;
}

function cleanShelfItem(value, index = 0) {
  if (!value || typeof value !== 'object') return null;
  const rawPath = cleanText(value.path, 10000).trim();
  if (!rawPath || !path.isAbsolute(rawPath)) return null;
  const normalizedPath = path.normalize(rawPath);
  return {
    id: cleanText(value.id, 100) || `shelf-${index + 1}-${randomUUID().slice(0, 8)}`,
    path: normalizedPath,
    name: normalizeShelfName(value.name, path.basename(normalizedPath) || 'File'),
    kind: value.kind === 'directory' ? 'directory' : 'file',
    temporary: value.temporary === true,
    addedAt: cleanText(value.addedAt, 50) || new Date().toISOString(),
  };
}

function getShelfRawItems() {
  const raw = shelfStore.get('items');
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const items = raw.map((value, index) => cleanShelfItem(value, index)).filter((item) => {
    if (!item) return false;
    const key = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, SHELF_MAX_ITEMS);
  if (items.length !== raw.length) shelfStore.set('items', items);
  return items;
}

function getShelfData() {
  return {
    items: getShelfRawItems().map((item) => ({ ...item, exists: fs.existsSync(item.path) })),
  };
}

async function cacheShelfIcon(id, filePath) {
  try {
    const icon = await app.getFileIcon(filePath, { size: 'small' });
    if (icon && !icon.isEmpty()) shelfIconCache.set(id, icon);
  } catch {}
}

async function warmShelfIcons() {
  const items = getShelfRawItems();
  await Promise.allSettled(
    items.filter((item) => fs.existsSync(item.path)).map((item) => cacheShelfIcon(item.id, item.path))
  );
}

function addShelfPath(filePath, options = {}) {
  const absolutePath = path.resolve(String(filePath || ''));
  if (!path.isAbsolute(absolutePath) || !fs.existsSync(absolutePath)) return null;
  const items = getShelfRawItems();
  const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
  const duplicate = items.find((item) => {
    const itemKey = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
    return itemKey === key;
  });
  if (duplicate) return duplicate;
  if (items.length >= SHELF_MAX_ITEMS) return null;
  let kind = 'file';
  try { kind = fs.statSync(absolutePath).isDirectory() ? 'directory' : 'file'; } catch {}
  const item = {
    id: randomUUID(),
    path: absolutePath,
    name: normalizeShelfName(options.name, path.basename(absolutePath) || 'File'),
    kind,
    temporary: options.temporary === true,
    addedAt: new Date().toISOString(),
  };
  items.push(item);
  shelfStore.set('items', items);
  return item;
}

async function addShelfPaths(paths) {
  for (const filePath of Array.isArray(paths) ? paths : []) {
    const item = addShelfPath(filePath);
    if (item) await cacheShelfIcon(item.id, item.path);
  }
  return getShelfData();
}

function extensionForImageMime(mime) {
  const value = String(mime || '').toLowerCase();
  return ({
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
  })[value] || '';
}

function filenameFromUrl(url, mime) {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    const name = normalizeShelfName(last, 'Web image');
    if (path.extname(name)) return name;
    return name + extensionForImageMime(mime);
  } catch {
    return 'Web image' + extensionForImageMime(mime);
  }
}

async function saveTemporaryImage(buffer, name, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > SHELF_MAX_WEB_BYTES) {
    throw new Error('Image too large or empty.');
  }
  if (!String(mime || '').toLowerCase().startsWith('image/')) throw new Error('Unsupported dropped content.');
  const dir = shelfTempDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}-${normalizeShelfName(name, 'Web image')}`;
  const target = path.join(dir, fileName);
  await fs.promises.writeFile(target, buffer, { flag: 'wx' });
  const item = addShelfPath(target, { name: name || fileName, temporary: true });
  if (!item) {
    try { await fs.promises.unlink(target); } catch {}
    throw new Error('Shelf is full.');
  }
  await cacheShelfIcon(item.id, item.path);
  return getShelfData();
}

async function downloadShelfImage(url, nameHint = '') {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { throw new Error('Invalid image URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported image URL.');
  const response = await withTimeout(fetch(parsed.href), 12000);
  if (!response.ok) throw new Error(`Image download failed (${response.status}).`);
  const mime = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) throw new Error('Dropped URL is not an image.');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > SHELF_MAX_WEB_BYTES) throw new Error('Image too large.');
  const buffer = Buffer.from(await response.arrayBuffer());
  const name = nameHint || filenameFromUrl(parsed.href, mime);
  return saveTemporaryImage(buffer, name, mime);
}

async function deleteTemporaryShelfItem(item) {
  if (!item?.temporary) return;
  try {
    const tempRoot = path.resolve(shelfTempDir());
    const candidate = path.resolve(item.path);
    const relative = path.relative(tempRoot, candidate);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.promises.unlink(candidate);
  } catch {}
}

/**
 * Une seule enveloppe native, dimensionnée pour la plus grande vue.
 *
 * Sur Windows, redimensionner/recentrer BrowserWindow pendant que la capsule
 * CSS s'anime provoquait le saut visible, le flash noir et le premier rendu
 * du calendrier dans les dimensions Pomodoro. La fenêtre Electron reste donc
 * désormais stable ; seule #capsule interpole entre ses tailles en CSS.
 *
 * Les zones transparentes de cette enveloppe restent click-through (voir
 * setIgnoreMouseEvents), donc garder cette surface native n'empêche pas
 * d'utiliser les fenêtres situées derrière l'application.
 */
const WINDOW_ENVELOPE = { width: 1360, height: 760 };
const VIEW_SIZES = {
  notch: { width: 380, height: 560 },
  schedule: { width: 960, height: 620 },
};

let notchWin = null;
let windowMode = 'notch';

/* ---------------- Météo (géolocalisation IP + Open-Meteo, sans clé) ---------------- */
let geoCache = null; // { lat, lon }
let weatherCache = { temp: null, icon: 'weather-clear', updatedAt: 0 };
let weatherTimer = null;
const WEATHER_REFRESH_MS = 20 * 60 * 1000; // 20 min


/* ---------------- Windows system media session ----------------
 * A persistent Windows GSMTC service is the single source of truth for
 * Now Playing. It subscribes to GlobalSystemMediaTransportControlsSessionManager
 * and session events, then streams normalized state to Electron over stdio.
 * No renderer scraping, active-window heuristics, audio-level detection or
 * service-specific Spotify/Deezer integration is used. */
let mediaCache = { available: false };
let mediaRecoveryTimer = null;

/* Journal média : écritures asynchrones, sérialisées, avec rotation à 1 Mo
   (media-service.log -> media-service.log.1). Plus d'appendFileSync sur le
   thread principal et plus de fichier qui grossit indéfiniment. */
const MEDIA_LOG_MAX_BYTES = 1024 * 1024;
let mediaLogSize = null;
let mediaLogChain = Promise.resolve();
let lastMediaBreadcrumb = '';

function appendMediaLog(line) {
  mediaLogChain = mediaLogChain.then(async () => {
    const logPath = path.join(app.getPath('userData'), 'media-service.log');
    if (mediaLogSize === null) {
      try { mediaLogSize = (await fs.promises.stat(logPath)).size; } catch { mediaLogSize = 0; }
    }
    if (mediaLogSize > MEDIA_LOG_MAX_BYTES) {
      try { await fs.promises.rename(logPath, logPath + '.1'); } catch {}
      mediaLogSize = 0;
    }
    const data = line + '\n';
    await fs.promises.appendFile(logPath, data, 'utf8');
    mediaLogSize += Buffer.byteLength(data);
  }).catch(() => {});
}
const mediaService = new WindowsMediaService({
  scriptPath: app.isPackaged
    ? path.join(process.resourcesPath, 'media-service.ps1')
    : path.join(__dirname, 'media-service.ps1'),
});


/* ---------------- Connected audio accessory (headphones / earbuds) ---------------- */
let audioAccessoryCache = { connected: false, name: '', batteryPercent: null, deviceType: 'headphones' };
let audioAccessoryProcess = null;
let audioAccessoryRestartTimer = null;
let appIsQuitting = false;
const audioAccessoryScriptPath = app.isPackaged
  ? path.join(process.resourcesPath, 'audio-device-state.ps1')
  : path.join(__dirname, 'audio-device-state.ps1');

function normalizeAudioAccessoryState(raw) {
  if (!raw || typeof raw !== 'object' || raw.connected !== true) {
    return { connected: false, name: '', batteryPercent: null, deviceType: 'headphones' };
  }
  const battery = Number(raw.batteryPercent);
  return {
    connected: true,
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : 'Audio device',
    batteryPercent: Number.isFinite(battery) && battery >= 0 && battery <= 100 ? Math.round(battery) : null,
    deviceType: raw.deviceType === 'earbuds' ? 'earbuds' : 'headphones',
  };
}

function emitAudioAccessoryState() {
  if (notchWin && !notchWin.isDestroyed()) {
    notchWin.webContents.send('audio-accessory-updated', audioAccessoryCache);
  }
}

function applyAudioAccessoryState(raw) {
  const next = normalizeAudioAccessoryState(raw);
  if (JSON.stringify(next) === JSON.stringify(audioAccessoryCache)) return;
  audioAccessoryCache = next;
  emitAudioAccessoryState();
}

function startAudioAccessoryLoop() {
  if (process.platform !== 'win32' || audioAccessoryProcess) return;
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', audioAccessoryScriptPath, '-Watch', '-PollMilliseconds', '750',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  audioAccessoryProcess = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on('line', (line) => {
    try { applyAudioAccessoryState(JSON.parse(line)); }
    catch { if (process.env.NOTCH_MEDIA_DEBUG) console.warn('[audio-accessory] invalid json'); }
  });
  child.stderr.on('data', (chunk) => {
    if (process.env.NOTCH_MEDIA_DEBUG && String(chunk).trim()) console.warn('[audio-accessory]', String(chunk).trim());
  });
  child.on('close', () => {
    output.close();
    if (audioAccessoryProcess === child) audioAccessoryProcess = null;
    if (!appIsQuitting) {
      clearTimeout(audioAccessoryRestartTimer);
      audioAccessoryRestartTimer = setTimeout(startAudioAccessoryLoop, 1200);
    }
  });
}

function stopAudioAccessoryLoop() {
  clearTimeout(audioAccessoryRestartTimer);
  audioAccessoryRestartTimer = null;
  const child = audioAccessoryProcess;
  audioAccessoryProcess = null;
  if (child && !child.killed) {
    try { child.kill(); } catch {}
  }
}

function emitMediaState() {
  if (notchWin && !notchWin.isDestroyed()) {
    notchWin.webContents.send('media-updated', mediaCache);
  }
}

function startMediaService() {
  if (process.platform !== 'win32') return;
  mediaService.on('state', (state) => {
    mediaCache = { ...state, receivedAtMs: Date.now() };
    // Keep a lightweight breadcrumb in the log. Do not log title/artist.
    // Only written when availability / playback / source actually changes.
    const breadcrumb = `available=${!!mediaCache.available} playing=${!!mediaCache.playing} source=${mediaCache.sourceApp || ''}`;
    if (breadcrumb !== lastMediaBreadcrumb) {
      lastMediaBreadcrumb = breadcrumb;
      appendMediaLog(`${new Date().toISOString()} [state] ${breadcrumb}`);
    }
    emitMediaState();
  });
  mediaService.on('diagnostic', ({ level, message }) => {
    const prefix = '[media-service]';
    if (level === 'error') console.error(prefix, message);
    else if (level === 'warn') console.warn(prefix, message);
    else if (process.env.NOTCH_MEDIA_DEBUG) console.log(prefix, message);
    appendMediaLog(`${new Date().toISOString()} [${level}] ${String(message).replace(/[\r\n]+/g, ' ')}`);
  });
  mediaService.start();
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout après ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Code météo WMO (renvoyé par Open-Meteo) -> nom d'icône minimaliste. */
function mapWeatherCode(code) {
  if (code === 0) return 'weather-clear';
  if (code === 1 || code === 2) return 'weather-partly';
  if (code === 3) return 'weather-cloudy';
  if (code === 45 || code === 48) return 'weather-fog';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'weather-rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'weather-snow';
  if ([95, 96, 99].includes(code)) return 'weather-storm';
  return 'weather-cloudy';
}

/** Plusieurs fournisseurs de géolocalisation IP, essayés dans l'ordre :
 *  si l'un est bloqué/en panne/limité, on tente le suivant plutôt que
 *  d'abandonner silencieusement. */
const GEO_PROVIDERS = [
  async () => {
    const res = await withTimeout(fetch('https://ipapi.co/json/'), 6000);
    if (!res.ok) throw new Error('ipapi.co HTTP ' + res.status);
    const data = await res.json();
    if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
      throw new Error('ipapi.co: coordonnées manquantes (' + JSON.stringify(data).slice(0, 120) + ')');
    }
    return { lat: data.latitude, lon: data.longitude };
  },
  async () => {
    const res = await withTimeout(fetch('https://ipwho.is/'), 6000);
    if (!res.ok) throw new Error('ipwho.is HTTP ' + res.status);
    const data = await res.json();
    if (data.success === false || typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
      throw new Error('ipwho.is: coordonnées manquantes (' + JSON.stringify(data).slice(0, 120) + ')');
    }
    return { lat: data.latitude, lon: data.longitude };
  },
  // HTTPS uniquement : un service en HTTP clair laisserait l'adresse IP (et donc
  // la position approximative) lisible par n'importe qui sur le réseau.
];

async function resolveLocation() {
  if (geoCache) return geoCache;
  for (const provider of GEO_PROVIDERS) {
    try {
      geoCache = await provider();
      return geoCache;
    } catch (e) {
      console.error('[météo] géolocalisation échouée:', e.message);
    }
  }
  console.error('[météo] tous les fournisseurs de géolocalisation ont échoué — vérifie la connexion internet / le pare-feu.');
  return null;
}

async function fetchWeather() {
  try {
    if (weatherDisabled()) return null;
    const loc = await resolveLocation();
    if (!loc || weatherDisabled()) return null;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code&timezone=auto`;
    const res = await withTimeout(fetch(url), 6000);
    if (!res.ok) throw new Error('open-meteo HTTP ' + res.status);
    const data = await res.json();
    if (weatherDisabled()) return null;
    weatherCache = {
      temp: Math.round(data.current.temperature_2m),
      icon: mapWeatherCode(data.current.weather_code),
      updatedAt: Date.now(),
    };
    console.log('[météo] mise à jour:', weatherCache.temp + '°', weatherCache.icon);
    if (notchWin && !notchWin.isDestroyed()) {
      notchWin.webContents.send('weather-updated', weatherCache);
    }
    return weatherCache;
  } catch (e) {
    console.error('[météo] récupération échouée:', e.message);
    return null; // on garde le dernier résultat valide en cache, pas d'erreur bloquante
  }
}

function weatherDisabled() {
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
}

function primaryBounds() {
  return screen.getPrimaryDisplay().workArea;
}

/** Enveloppe native stable, centrée en haut et bornée au workArea. */
function notchWindowBounds() {
  const area = primaryBounds();
  const width = Math.min(WINDOW_ENVELOPE.width, area.width);
  const height = Math.min(WINDOW_ENVELOPE.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y,
    width,
    height,
  };
}

function supportsNativeWindowShape(win = notchWin) {
  return !!win && typeof win.setShape === 'function' && ['win32', 'linux'].includes(process.platform);
}

function applyDefaultWindowShape() {
  if (!supportsNativeWindowShape()) return;
  const bounds = notchWin.getContentBounds();
  const width = Math.min(150, bounds.width);
  notchWin.setShape([{
    x: Math.round((bounds.width - width) / 2),
    y: 0,
    width,
    height: Math.min(28, bounds.height),
  }]);
}

// Le clic en dehors du notch traverse la fenêtre (clic-au-travers) : le renderer ne
// le voit jamais. On détecte donc la perte de focus de la fenêtre, qui survient dès
// qu'on clique sur une autre application, le bureau ou la barre des tâches.
// Le glisser natif depuis la Shelf peut faire perdre le focus un instant : on
// ignore alors les blur pendant quelques secondes.
let ignoreBlurUntil = 0;

function createNotchWindow() {
  notchWin = new BrowserWindow({
    ...notchWindowBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Les alertes sonores (Bluetooth, rappels, fin de minuteur) doivent pouvoir
      // jouer sans qu'on ait cliqué dans le notch depuis le démarrage.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  notchWin.on('blur', () => {
    if (!notchWin || notchWin.isDestroyed()) return;
    if (store.get('collapseOnOutsideClick') === false) return;
    if (Date.now() < ignoreBlurUntil) return;
    notchWin.webContents.send('window-blurred');
  });

  notchWin.setAlwaysOnTop(store.get('alwaysOnTop'), 'screen-saver');
  notchWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  notchWin.webContents.on('did-finish-load', () => {
    // Re-send the latest cached state once the renderer is definitely ready.
    // This removes the startup race where GSMTC can emit before app.js has
    // registered its IPC listener.
    emitMediaState();
    emitAudioAccessoryState();
    mediaService.refresh();
  });
  notchWin.once('ready-to-show', () => {
    notchWin.show();
    // Sur Windows/Linux, l'input shape limite réellement la zone interactive
    // à la capsule (et au compagnon média quand le renderer l'annonce).
    // Cela évite que le grand conteneur transparent intercepte les drops.
    if (supportsNativeWindowShape()) applyDefaultWindowShape();
    else notchWin.setIgnoreMouseEvents(true, { forward: true });
  });

  // Recentrer et reborner si la résolution / le moniteur change.
  const reposition = () => {
    if (!notchWin || notchWin.isDestroyed()) return;
    notchWin.setBounds(notchWindowBounds());
  };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
}

/* ---------------- Icône de la zone de notification ----------------
 * Le notch n'a ni fenêtre classique ni bouton dans la barre des tâches
 * (skipTaskbar) : sans cette icône, impossible de quitter l'app, ni de la
 * retrouver si la fenêtre a disparu. Clic gauche = ouvrir ; clic droit = menu.
 * Les deux PNG (16 px et 32 px pour les écrans à 200 %) sont embarqués ici en
 * base64 : rien de plus à livrer dans l'installeur. */
const TRAY_ICON_16 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQUlEQVR4nGMQEZH4TwlmwCXx9et3FEy0AegaCRnEQIpmbIYwkKoZ3RDqGECqZmRDhosBAx8LVElIVEnKVMlMpGIAAiTEMwwhXy4AAAAASUVORK5CYII=';
const TRAY_ICON_32 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAdUlEQVR4nO3XMRLAIAgEQB9Bkf//0bE0D0gUJDhcnCvoHG4rwCJy9cwqBKw8rrWZKhxgDfZAVIA33IoYAr4GWyGYgOjwGeIB2BU+QmABdoe/IQgggAACsADpoxgCkL6OIQ4SCEAUROuPf5Z7ICs9//U1OxJwA7/5vMej0oCHAAAAAElFTkSuQmCC';
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

/* ---------------- Raccourci clavier global ----------------
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

/* ---------------- IPC ----------------
 * Le panneau de réglages n'est plus une fenêtre Electron séparée : il vit
 * dans le même renderer que le notch, comme une vue de plus dans #capsule
 * (voir index.html / style.css / app.js, mode "settings"). Il n'y a donc
 * plus besoin d'IPC "open-settings" / "close-settings" ni de fenêtre
 * dédiée : tout se passe côté renderer, ce qui évite un aller-retour
 * process principal <-> renderer et supprime la fenêtre "Electron" moche
 * qui s'ouvrait par-dessus tout le reste. */
ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
  if (notchWin && !notchWin.isDestroyed()) notchWin.setIgnoreMouseEvents(ignore, options || {});
});

ipcMain.handle('get-settings', () => store.store);
ipcMain.handle('get-weather', () => weatherCache);

const MAX_ICAL_RESPONSE_BYTES = 8 * 1024 * 1024;
ipcMain.handle('fetch-ical-url', async (event, rawUrl) => {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('Invalid iCal URL.');
  }
  if (url.protocol === 'webcal:') url = new URL(url.href.replace(/^webcal:/i, 'https:'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('iCal links must use HTTP, HTTPS or webcal.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'Accept': 'text/calendar, text/plain;q=0.9, */*;q=0.1',
        'User-Agent': 'Notch-Bar/1.0 iCal sync',
      },
    });
    if (!response.ok) throw new Error(`iCal server returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ICAL_RESPONSE_BYTES) throw new Error('iCal feed is too large.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ICAL_RESPONSE_BYTES) throw new Error('iCal feed is too large.');
    return { ok: true, url: response.url || url.href, text: buffer.toString('utf8') };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('iCal request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
});

ipcMain.handle('get-media-state', () => mediaCache);
ipcMain.handle('get-audio-accessory-state', () => audioAccessoryCache);
ipcMain.handle('refresh-media-state', () => {
  mediaService.refresh({ reacquire: !mediaCache.available });
  return mediaCache;
});
ipcMain.handle('media-command', async (event, command, payload = {}) => {
  const allowed = new Set(['playPause', 'play', 'pause', 'next', 'previous', 'seek']);
  if (!allowed.has(command)) return { ok: false, error: 'unsupported-command' };
  const normalizedPayload = command === 'seek'
    ? { positionSeconds: Math.max(0, Number(payload.positionSeconds) || 0) }
    : {};
  return mediaService.command(command, normalizedPayload);
});

ipcMain.handle('save-settings', (event, partial) => {
  store.set(partial);
  if ('clipboardHistoryEnabled' in partial) clipboardHistoryEnabled = partial.clipboardHistoryEnabled !== false;
  if ('alwaysOnTop' in partial && notchWin) {
    notchWin.setAlwaysOnTop(partial.alwaysOnTop, 'screen-saver');
  }
  if ('launchAtStartup' in partial) {
    app.setLoginItemSettings({ openAtLogin: !!partial.launchAtStartup });
  }
  if ('globalShortcutEnabled' in partial || 'globalShortcut' in partial) applyGlobalShortcut();
  if ('weatherEnabled' in partial) applyWeatherSetting();
  if (notchWin) notchWin.webContents.send('settings-updated', store.store);
  return store.store;
});

ipcMain.handle('reset-settings', () => {
  store.clear();
  applyGlobalShortcut();
  applyWeatherSetting();
  clipboardHistoryEnabled = store.get('clipboardHistoryEnabled') !== false;
  if (notchWin) notchWin.webContents.send('settings-updated', store.store);
  return store.store;
});

function cleanText(value, max = 4000) {
  return typeof value === 'string' ? value.replace(/\0/g, '').slice(0, max) : '';
}

function cleanWall(value) {
  if (!value || typeof value !== 'object') return null;
  const output = {};
  for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second']) {
    const number = Number(value[key]);
    if (!Number.isFinite(number)) return null;
    output[key] = Math.trunc(number);
  }
  return output;
}

function cleanEvent(value) {
  if (!value || typeof value !== 'object') return null;
  const start = cleanWall(value.start);
  const end = cleanWall(value.end);
  if (!start || !end) return null;
  return {
    id: cleanText(value.id, 500), uid: cleanText(value.uid, 500), recurrenceId: cleanText(value.recurrenceId, 500),
    title: cleanText(value.title, 500) || 'Untitled', description: cleanText(value.description, 20000),
    professor: cleanText(value.professor, 500), room: cleanText(value.room, 500), location: cleanText(value.location, 1000),
    organizer: cleanText(value.organizer, 1000), attendees: Array.isArray(value.attendees) ? value.attendees.slice(0, 200).map((item) => cleanText(item, 1000)) : [],
    categories: Array.isArray(value.categories) ? value.categories.slice(0, 100).map((item) => cleanText(item, 300)) : [],
    url: cleanText(value.url, 2000), status: cleanText(value.status, 100), xProperties: value.xProperties && typeof value.xProperties === 'object' ? value.xProperties : {},
    allDay: !!value.allDay, timezone: cleanText(value.timezone, 200), displayTimezone: cleanText(value.displayTimezone, 200),
    sourceStart: cleanWall(value.sourceStart) || start, sourceEnd: cleanWall(value.sourceEnd) || end,
    start, end, dateKey: cleanText(value.dateKey, 20),
    startInstant: Number.isFinite(value.startInstant) ? value.startInstant : null,
    endInstant: Number.isFinite(value.endInstant) ? value.endInstant : null,
  };
}

const CALENDAR_COLOR_RE = /^#[0-9a-f]{6}$/i;
const DEFAULT_CALENDAR_COLORS = [
  '#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#5e5ce6',
];

function cleanCalendarColor(value, index = 0) {
  const color = cleanText(value, 20).trim();
  return CALENDAR_COLOR_RE.test(color) ? color.toLowerCase() : DEFAULT_CALENDAR_COLORS[index % DEFAULT_CALENDAR_COLORS.length];
}

function cleanCalendarSource(value, index = 0) {
  if (!value || typeof value !== 'object') return null;
  const rawId = cleanText(value.id, 100);
  const id = rawId || `calendar-${index + 1}-${randomUUID().slice(0, 8)}`;
  const events = Array.isArray(value.events)
    ? value.events.slice(0, 20000).map(cleanEvent).filter(Boolean)
    : [];
  const meta = value.meta && typeof value.meta === 'object' ? {
    displayTimezone: cleanText(value.meta.displayTimezone, 200),
    importedAt: cleanText(value.meta.importedAt, 50),
    sourceName: cleanText(value.meta.sourceName, 500),
    sourceEventCount: Math.max(0, Math.trunc(Number(value.meta.sourceEventCount) || 0)),
    sourceUrl: cleanText(value.meta.sourceUrl, 4000),
    lastSyncedAt: cleanText(value.meta.lastSyncedAt, 50),
    syncError: cleanText(value.meta.syncError, 800),
  } : {};
  return {
    id,
    name: cleanText(value.name, 500) || meta.sourceName || 'Calendar',
    color: cleanCalendarColor(value.color, index),
    enabled: value.enabled !== false,
    url: cleanText(value.url || meta.sourceUrl, 4000),
    events,
    meta,
  };
}

function getCalendarSources() {
  const raw = plannerStore.get('calendarSources');
  if (Array.isArray(raw) && raw.length) {
    const used = new Set();
    const sources = raw.map((value, index) => {
      const source = cleanCalendarSource(value, index);
      if (!source || used.has(source.id)) return null;
      used.add(source.id);
      return source;
    }).filter(Boolean);
    if (sources.length !== raw.length) plannerStore.set('calendarSources', sources);
    return sources;
  }

  // Backward-compatible migration for projects that stored one calendar
  // directly as calendarEvents/calendarMeta.
  const legacyEvents = plannerStore.get('calendarEvents');
  if (Array.isArray(legacyEvents) && legacyEvents.length) {
    const source = cleanCalendarSource({
      id: 'legacy-calendar',
      name: plannerStore.get('calendarMeta')?.sourceName || 'Imported calendar',
      enabled: true,
      events: legacyEvents,
      meta: plannerStore.get('calendarMeta') || {},
    }, 0);
    if (source) {
      plannerStore.set('calendarSources', [source]);
      return [source];
    }
  }
  return [];
}

function cleanCalendarSources(value) {
  if (!Array.isArray(value)) throw new Error('Invalid calendar source list.');
  if (value.length > 20) throw new Error('Too many calendar sources.');
  const seen = new Set();
  const sources = value.map((item, index) => {
    const source = cleanCalendarSource(item, index);
    if (!source) return null;
    if (seen.has(source.id)) throw new Error('Duplicate calendar source id.');
    seen.add(source.id);
    return source;
  }).filter(Boolean);
  return sources;
}

function cleanTask(value) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanText(value.id, 100);
  const title = cleanText(value.title, 500);
  if (!id || !title) return null;

  // Unscheduled tasks intentionally have no date or time. Older versions
  // rejected them here, which made newly created tasks disappear after the
  // renderer persisted them. Keep an empty date as a valid first-class state.
  const rawDate = cleanText(value.date, 20);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : '';
  const time = date && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time || '') ? value.time : '';

  const rawSeconds = Math.trunc(Number(value.durationSeconds) || 0);
  const fallbackMinutes = Math.trunc(Number(value.durationMinutes) || 30);
  const durationSeconds = Math.max(300, Math.min(24 * 60 * 60, rawSeconds || fallbackMinutes * 60));
  const durationMinutes = Math.max(5, Math.round(durationSeconds / 60));

  return {
    id,
    title,
    notes: cleanText(value.notes, 5000),
    date,
    time,
    durationSeconds,
    durationMinutes,
    completed: !!value.completed,
    createdAt: cleanText(value.createdAt, 50),
    updatedAt: cleanText(value.updatedAt, 50),
  };
}

ipcMain.handle('get-window-input-capabilities', () => ({
  shape: supportsNativeWindowShape(),
}));
ipcMain.on('set-interactive-region', (event, rects) => {
  if (!supportsNativeWindowShape()) return;
  if (!Array.isArray(rects) || !rects.length) {
    applyDefaultWindowShape();
    return;
  }
  const bounds = notchWin.getContentBounds();
  const normalized = rects.map((rect) => {
    const x = Math.max(0, Math.round(Number(rect.x) || 0));
    const y = Math.max(0, Math.round(Number(rect.y) || 0));
    const width = Math.max(1, Math.min(bounds.width - x, Math.round(Number(rect.width) || 0)));
    const height = Math.max(1, Math.min(bounds.height - y, Math.round(Number(rect.height) || 0)));
    return { x, y, width, height };
  }).filter((rect) => rect.x < bounds.width && rect.y < bounds.height && rect.width > 0 && rect.height > 0);
  if (normalized.length) notchWin.setShape(normalized);
});

ipcMain.handle('get-pomodoro-analytics', () => ({ sessions: getAnalyticsSessions() }));
ipcMain.handle('record-pomodoro-session', (event, value) => {
  const session = cleanAnalyticsSession(value);
  if (!session) return { ok: false };
  const sessions = getAnalyticsSessions().filter((item) => item.id !== session.id);
  sessions.push(session);
  if (sessions.length > ANALYTICS_MAX_SESSIONS) sessions.splice(0, sessions.length - ANALYTICS_MAX_SESSIONS);
  analyticsStore.set('sessions', sessions);
  if (notchWin && !notchWin.isDestroyed()) notchWin.webContents.send('pomodoro-analytics-updated', session);
  return { ok: true, session };
});
ipcMain.handle('get-clipboard-history', () => getClipboardHistoryData());
ipcMain.handle('clipboard-history-copy', (event, id) => restoreClipboardHistoryItem(id));
ipcMain.handle('clear-clipboard-history', () => clearClipboardHistory());
ipcMain.on('clipboard-history-request-refresh', () => { pollClipboardHistory(); });

ipcMain.handle('get-shelf-data', () => getShelfData());
ipcMain.handle('shelf-add-paths', async (event, paths) => addShelfPaths(paths));
ipcMain.handle('shelf-add-web-image', async (event, payload = {}) => downloadShelfImage(payload.url, payload.name));
ipcMain.handle('shelf-add-web-bytes', async (event, payload = {}) => {
  const mime = cleanText(payload.mime, 100);
  const name = cleanText(payload.name, 500);
  const bytes = payload.bytes;
  const buffer = Buffer.isBuffer(bytes) ? bytes : (bytes instanceof Uint8Array ? Buffer.from(bytes) : null);
  return saveTemporaryImage(buffer, name || 'Web image' + extensionForImageMime(mime), mime);
});
ipcMain.handle('shelf-remove', async (event, id) => {
  const items = getShelfRawItems();
  const item = items.find((candidate) => candidate.id === cleanText(id, 100));
  if (!item) return getShelfData();
  shelfStore.set('items', items.filter((candidate) => candidate.id !== item.id));
  shelfIconCache.delete(item.id);
  await deleteTemporaryShelfItem(item);
  return getShelfData();
});
ipcMain.handle('shelf-clear', async () => {
  const items = getShelfRawItems();
  shelfStore.set('items', []);
  for (const item of items) {
    shelfIconCache.delete(item.id);
    await deleteTemporaryShelfItem(item);
  }
  return getShelfData();
});
ipcMain.handle('shelf-open-location', (event, id) => {
  const item = getShelfRawItems().find((candidate) => candidate.id === cleanText(id, 100));
  if (!item || !fs.existsSync(item.path)) return false;
  shell.showItemInFolder(item.path);
  return true;
});
ipcMain.on('shelf-start-drag', (event, ids) => {
  if (!notchWin || notchWin.isDestroyed()) return;
  const requested = Array.isArray(ids) ? ids : [ids];
  const items = getShelfRawItems().filter((item) => requested.includes(item.id) && fs.existsSync(item.path));
  if (!items.length) return;
  const files = items.map((item) => item.path);
  const icon = shelfIconCache.get(items[0].id) || SHELF_FALLBACK_ICON;
  ignoreBlurUntil = Date.now() + 3000;
  try {
    notchWin.webContents.startDrag(files.length > 1 ? { files, icon } : { file: files[0], icon });
  } catch (error) {
    console.error('[shelf] drag start failed:', error.message);
  }
});

ipcMain.handle('get-planner-data', () => {
  const calendarSources = getCalendarSources();
  return {
    calendarSources,
    // Keep legacy fields in the contract so older renderers do not crash if
    // they are ever loaded against this main process.
    calendarEvents: calendarSources.flatMap((source) => source.events),
    calendarMeta: calendarSources[0]?.meta || {},
    plannerTasks: plannerStore.get('plannerTasks'),
  };
});

ipcMain.handle('save-calendar-sources', (event, sources) => {
  const calendarSources = cleanCalendarSources(sources);
  plannerStore.set({ calendarSources });
  // Legacy mirrors are intentionally retained for one-source compatibility
  // with previous versions, but the renderer reads calendarSources only.
  if (calendarSources.length === 1) {
    plannerStore.set({
      calendarEvents: calendarSources[0].events,
      calendarMeta: calendarSources[0].meta,
    });
  } else {
    plannerStore.set({ calendarEvents: [], calendarMeta: {} });
  }
  return { calendarSources };
});

ipcMain.handle('save-planner-tasks', (event, tasks) => {
  if (!Array.isArray(tasks)) throw new Error('Invalid task list.');
  const plannerTasks = tasks.slice(0, 5000).map(cleanTask).filter(Boolean);
  plannerStore.set('plannerTasks', plannerTasks);
  return plannerTasks;
});

ipcMain.handle('set-window-mode', (event, kind) => {
  // Conservé comme contrat IPC pour le renderer et pour de futures vues.
  // Le changement de mode est logique uniquement : aucun resize natif ici.
  windowMode = kind === 'schedule' ? 'schedule' : 'notch';
  return {
    ...notchWindowBounds(),
    mode: windowMode,
    target: VIEW_SIZES[windowMode],
  };
});


/* ---------------- Mises à jour ---------------- */
/* Parcours : le notch annonce la version (état 'available'), l'utilisateur clique, on télécharge
   (download-update), puis le renderer fige l'état des minuteurs et appelle install-update(snapshot).
   Le snapshot est écrit sur disque AVANT la fermeture ; au redémarrage le renderer le récupère
   (take-resume-state : usage unique, 10 min maximum) et relance Pomodoro / Timer / Stopwatch. */
const resumeStore = new Store({ name: 'resume-state', defaults: { snapshot: null } });

// Dev : NOTCH_FAKE_UPDATE=1 simule tout le parcours (annonce, téléchargement, redémarrage)
// sans publier de release. PowerShell :  $env:NOTCH_FAKE_UPDATE=1; npm start
const fakeUpdate = !app.isPackaged && process.env.NOTCH_FAKE_UPDATE === '1';
function createFakeAutoUpdater() {
  const { EventEmitter } = require('events');
  const fake = new EventEmitter();
  fake.checkForUpdates = async () => {
    fake.emit('checking-for-update');
    setTimeout(() => fake.emit('update-available', { version: '9.9.9' }), 1200);
  };
  fake.downloadUpdate = async () => {
    let percent = 0;
    const timer = setInterval(() => {
      percent += 20;
      fake.emit('download-progress', { percent });
      if (percent >= 100) {
        clearInterval(timer);
        fake.emit('update-downloaded', { version: '9.9.9' });
      }
    }, 500);
  };
  fake.quitAndInstall = () => { app.relaunch(); app.exit(0); };
  return fake;
}

let updater = null;
function setupUpdater() {
  let autoUpdater = null;
  if (fakeUpdate) {
    autoUpdater = createFakeAutoUpdater();
  } else if (app.isPackaged) {
    try { ({ autoUpdater } = require('electron-updater')); }
    catch (error) { console.warn('[updater] electron-updater indisponible :', error.message); }
  }
  updater = createUpdater({
    autoUpdater,
    isPackaged: (app.isPackaged || fakeUpdate) && !!autoUpdater,
    version: app.getVersion(),
    getAutoEnabled: () => store.get('autoUpdateEnabled') !== false,
    send: (state) => { if (notchWin && !notchWin.isDestroyed()) notchWin.webContents.send('update-state', state); },
    log: (...args) => console.warn(...args),
  });
  updater.start();
  if (fakeUpdate) setTimeout(() => updater.check({ manual: true }), 4000);
}

ipcMain.handle('get-update-state', () => (updater ? updater.getState() : { status: 'disabled', version: app.getVersion(), percent: 0 }));
ipcMain.handle('check-for-updates', () => (updater ? updater.check({ manual: true }) : { status: 'disabled', version: app.getVersion(), percent: 0 }));
ipcMain.handle('download-update', () => (updater ? updater.download() : false));
ipcMain.handle('install-update', (event, snapshot) => {
  if (!updater) return false;
  // Le snapshot est écrit (synchrone) avant de quitter ; s'il est vide ou invalide on n'écrit rien.
  const tools = sanitizeSnapshot(snapshot);
  if (tools) resumeStore.set('snapshot', { savedAt: Date.now(), fromVersion: app.getVersion(), tools });
  else resumeStore.delete('snapshot');
  if (!updater.install()) {
    resumeStore.delete('snapshot');
    return false;
  }
  appIsQuitting = true;
  return true;
});
ipcMain.handle('take-resume-state', () => {
  const saved = resumeStore.get('snapshot');
  resumeStore.delete('snapshot'); // usage unique : jamais de minuteur « fantôme » au lancement suivant
  if (!saved || !isSnapshotFresh(saved)) return null;
  return sanitizeSnapshot(saved.tools);
});

/* ---------------- Cycle de vie app ---------------- */
app.on('second-instance', () => {
  // Relancer l'app alors qu'elle tourne déjà = « où est mon notch ? » : on l'ouvre.
  showNotchFromTray('open');
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  createNotchWindow();
  createTray();
  applyGlobalShortcut();
  setupUpdater();
  app.setLoginItemSettings({ openAtLogin: !!store.get('launchAtStartup') });
  startWeatherLoop();
  startMediaService();
  startAudioAccessoryLoop();
  warmShelfIcons();
  clipboardHistoryEnabled = store.get('clipboardHistoryEnabled') !== false;
  startClipboardHistoryLoop();
  clearInterval(mediaRecoveryTimer);
  mediaRecoveryTimer = setInterval(() => {
    // Keep probing after the last media session has disappeared. While a
    // session is available the 350 ms GSMTC poll already keeps it fresh; when
    // none exists we reacquire the manager so a newly started player is found.
    if (!mediaCache.available) mediaService.refresh({ reacquire: true });
  }, 1000);
});

app.on('before-quit', () => {
  appIsQuitting = true;
  unregisterGlobalShortcut();
  destroyTray();
  clearInterval(mediaRecoveryTimer);
  mediaRecoveryTimer = null;
  if (updater) updater.stop();
  stopAudioAccessoryLoop();
  mediaService.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createNotchWindow();
});
