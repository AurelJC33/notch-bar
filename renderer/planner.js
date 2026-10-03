import { parseIcs, wallTime } from './calendar-engine.js';
import { mergeEnabledCalendarEvents, normalizeCalendarSource, normalizeCalendarUrl } from './calendar-sources.js';

const byId = (id) => document.getElementById(id);
const state = {
  events: [],
  calendarSources: [],
  tasks: [],
  meta: {},
  view: 'month',
  taskFilter: 'selected',
  selectedDate: new Date(),
  cursor: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  editingTaskId: '',
  durationEditingTaskId: '',
  dayScrollTop: null,
  drag: {
    taskId: '',
    avatar: null,
    source: null,
    preview: null,
    previewMinutes: null,
    pointerX: 0,
    pointerY: 0,
  },
};

const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const weekdayNames = ['M','T','W','T','F','S','S'];
const MIN_DURATION_SECONDS = 5 * 60;
const DEFAULT_DURATION_SECONDS = 30 * 60;
const TIMELINE_HEIGHT = 1536;
const SNAP_MINUTES = 5;
let toastTimer;
let calendarSyncTimer = null;
const CALENDAR_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const calendarSyncInFlight = new Set();
const calendarReminded = new Set();
const taskReminded = new Set();
let calendarReminderTimer = null;

const pad = (value) => String(value).padStart(2, '0');
const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseDateKey = (key) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) return null;
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
};
const sameDay = (left, right) => dateKey(left) === dateKey(right);
const eventDateLabel = (date) => date?.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' }) || '';

function button(className, label, onClick) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  if (label) node.textContent = label;
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function icon(name) {
  const node = document.createElement('span');
  node.className = 'icon';
  node.dataset.icon = name;
  return node;
}

function durationSeconds(task) {
  const seconds = Number(task?.durationSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.max(MIN_DURATION_SECONDS, Math.round(seconds));
  const minutes = Number(task?.durationMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return Math.max(MIN_DURATION_SECONDS, Math.round(minutes * 60));
  return DEFAULT_DURATION_SECONDS;
}

function formatDuration(taskOrSeconds) {
  const total = typeof taskOrSeconds === 'number' ? taskOrSeconds : durationSeconds(taskOrSeconds);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (!seconds) return `${minutes} min`;
  return `${minutes}m ${pad(seconds)}s`;
}

function setCalendarSources(sources) {
  const seen = new Set();
  state.calendarSources = (Array.isArray(sources) ? sources : []).map((source, index) => {
    const normalized = normalizeCalendarSource(source, index);
    if (seen.has(normalized.id)) return null;
    seen.add(normalized.id);
    return normalized;
  }).filter(Boolean);
  state.events = mergeEnabledCalendarEvents(state.calendarSources);
}

async function persistCalendarSources() {
  const saved = await window.api.saveCalendarSources(state.calendarSources);
  setCalendarSources(saved.calendarSources);
  renderCalendarSettings();
}

function updateCalendarEventColors(source, color = source.color) {
  document.querySelectorAll('[data-calendar-source-id]').forEach((node) => {
    if (node.dataset.calendarSourceId === source.id) node.style.setProperty('--calendar-source-color', color);
  });
}

function formatCalendarSyncMeta(source) {
  if (source.meta?.syncError) return 'Sync error · retrying automatically';
  if (source.meta?.lastSyncedAt) {
    const date = new Date(source.meta.lastSyncedAt);
    if (!Number.isNaN(date.getTime())) return `Updated ${date.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}`;
  }
  return source.url ? 'iCal link' : `${source.events.length} event${source.events.length === 1 ? '' : 's'}`;
}

function calendarSourceHost(source) {
  if (!source.url) return '';
  try { return new URL(source.url).hostname.replace(/^www\./i, ''); } catch { return source.url; }
}

function renderCalendarSettings() {
  const list = byId('calendar-sources-list');
  const empty = byId('calendar-sources-empty');
  if (!list || !empty) return;
  list.replaceChildren();
  empty.hidden = state.calendarSources.length > 0;
  state.calendarSources.forEach((source) => {
    const row = document.createElement('div');
    row.className = `calendar-source-row${source.url ? ' calendar-source-remote' : ''}`;

    const toggle = document.createElement('label');
    toggle.className = 'switch calendar-source-switch';
    toggle.title = source.enabled ? 'Disable calendar' : 'Enable calendar';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = source.enabled;
    checkbox.addEventListener('change', async () => {
      source.enabled = checkbox.checked;
      try {
        await persistCalendarSources();
        renderCalendar();
      } catch (error) {
        source.enabled = !checkbox.checked;
        checkbox.checked = source.enabled;
        toast(error.message || 'Unable to update calendar', true);
      }
    });
    const track = document.createElement('span');
    track.className = 'switch-track';
    toggle.append(checkbox, track);

    const copy = document.createElement('div');
    copy.className = 'calendar-source-copy';

    const name = document.createElement('strong');
    name.className = 'calendar-source-name';
    name.textContent = source.name;
    name.title = source.url || 'Double-click to rename';
    name.tabIndex = 0;

    const startRename = () => {
      if (copy.querySelector('.calendar-source-name-input')) return;
      const input = document.createElement('input');
      input.className = 'calendar-source-name-input';
      input.type = 'text'; input.maxLength = 120; input.value = source.name;
      input.setAttribute('aria-label', `Rename ${source.name}`);
      name.replaceWith(input); input.focus(); input.select();
      let finished = false;
      const finish = async (save) => {
        if (finished) return;
        finished = true;
        const value = input.value.trim();
        if (!save || !value || value === source.name) { renderCalendarSettings(); return; }
        const previous = { name: source.name, meta: { ...(source.meta || {}) } };
        source.name = value;
        source.meta = { ...(source.meta || {}), sourceName: value };
        try { await persistCalendarSources(); renderCalendar(); }
        catch (error) { source.name = previous.name; source.meta = previous.meta; renderCalendarSettings(); toast(error.message || 'Unable to rename calendar', true); }
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
        else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true), { once:true });
    };
    name.addEventListener('dblclick', startRename);
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startRename(); }
    });

    const meta = document.createElement('span');
    const count = source.events.length;
    const zone = source.meta?.displayTimezone ? ` · ${source.meta.displayTimezone}` : '';
    meta.textContent = source.url
      ? `${count} event${count === 1 ? '' : 's'} · ${formatCalendarSyncMeta(source)}`
      : `${count} event${count === 1 ? '' : 's'}${zone}`;
    if (source.url) meta.title = source.url;
    copy.append(name, meta);

    const color = document.createElement('input');
    color.className = 'calendar-source-color'; color.type = 'color'; color.value = source.color;
    color.title = `Choose color for ${source.name}`;
    color.setAttribute('aria-label', `Choose color for ${source.name}`);
    color.addEventListener('input', () => { row.style.setProperty('--calendar-source-color', color.value); updateCalendarEventColors(source, color.value); });
    color.addEventListener('change', async () => {
      const previousColor = source.color; source.color = color.value;
      try { await persistCalendarSources(); renderCalendar(); }
      catch (error) { source.color = previousColor; renderCalendarSettings(); toast(error.message || 'Unable to update calendar color', true); }
    });
    row.style.setProperty('--calendar-source-color', source.color);

    const actions = document.createElement('div');
    actions.className = 'calendar-source-actions';
    if (source.url) {
      const refresh = button('icon-btn calendar-source-refresh', '', async (event) => {
        event.stopPropagation();
        await syncRemoteCalendarSource(source, false);
      });
      refresh.title = 'Refresh calendar'; refresh.setAttribute('aria-label', `Refresh ${source.name}`); refresh.append(icon('refresh'));
      actions.append(refresh);
    }
    const remove = button('icon-btn calendar-source-remove', '', async (event) => {
      event.stopPropagation();
      const previous = state.calendarSources;
      const remaining = previous.filter((item) => item.id !== source.id);
      try { setCalendarSources(remaining); await persistCalendarSources(); renderCalendar(); toast('Calendar removed'); }
      catch (error) { setCalendarSources(previous); renderCalendarSettings(); toast(error.message || 'Unable to remove calendar', true); }
    });
    remove.title = 'Remove calendar'; remove.setAttribute('aria-label', `Remove ${source.name}`); remove.append(icon('trash'));
    actions.append(remove);

    row.append(toggle, copy, color, actions);
    list.append(row);
  });
  if (window.paintIcons) window.paintIcons(list);
}

async function syncRemoteCalendarSource(source, silent = true) {
  if (!source?.url || calendarSyncInFlight.has(source.id)) return false;
  calendarSyncInFlight.add(source.id);
  const previousEvents = source.events;
  const previousMeta = { ...(source.meta || {}) };
  try {
    const response = await window.api.fetchICalUrl(source.url);
    const parsed = parseIcs(response.text, { now: new Date() });
    source.url = normalizeCalendarUrl(response.url || source.url) || source.url;
    source.events = parsed.events;
    source.meta = {
      ...(source.meta || {}),
      ...parsed.meta,
      sourceName: source.name,
      sourceUrl: source.url,
      lastSyncedAt: new Date().toISOString(),
      syncError: '',
    };
    setCalendarSources(state.calendarSources);
    await window.api.saveCalendarSources(state.calendarSources);
    renderCalendarSettings();
    renderCalendar();
    if (!silent) toast('Calendar refreshed');
    return true;
  } catch (error) {
    source.events = previousEvents;
    source.meta = { ...previousMeta, sourceUrl: source.url, syncError: error.message || 'Unable to sync calendar' };
    try { await window.api.saveCalendarSources(state.calendarSources); } catch {}
    renderCalendarSettings();
    if (!silent) toast(error.message || 'Unable to refresh calendar', true);
    return false;
  } finally {
    calendarSyncInFlight.delete(source.id);
  }
}

async function syncRemoteCalendarSources(silent = true) {
  const remoteSources = state.calendarSources.filter((source) => source.url && source.enabled !== false);
  if (!remoteSources.length) return;
  await Promise.all(remoteSources.map((source) => syncRemoteCalendarSource(source, silent)));
}

async function addCalendarUrl(rawUrl) {
  const url = normalizeCalendarUrl(rawUrl);
  if (!url) { toast('Enter a valid HTTP(S) or webcal iCal link.', true); return; }
  if (state.calendarSources.some((source) => source.url === url)) { toast('This calendar is already added.', true); return; }
  const previous = state.calendarSources;
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./i, '') || url; } catch {}
  const source = {
    id: crypto.randomUUID(),
    name: host,
    url,
    enabled: true,
    color: '',
    events: [],
    meta: { sourceUrl: url, sourceName: host },
  };
  if (previous.length >= 20) { toast('You can add up to 20 calendars.', true); return; }
  setCalendarSources([...previous, source]);
  // setCalendarSources() stocke des copies normalisées : il faut synchroniser
  // l'objet réellement présent dans l'état, sinon les événements téléchargés
  // sont écrits dans une copie orpheline et le calendrier reste vide.
  const liveSource = state.calendarSources.find((item) => item.id === source.id) || source;
  try {
    await syncRemoteCalendarSource(liveSource, true);
    renderCalendarSettings(); renderCalendar();
    toast(liveSource.meta?.syncError ? 'Calendar added, sync failed' : 'Calendar added');
  } catch (error) {
    setCalendarSources(previous); renderCalendarSettings();
    toast(error.message || 'Unable to add calendar', true);
  }
}

async function importCalendarSource(file) {
  try {
    const parsed = parseIcs(await file.text());
    const source = {
      id: crypto.randomUUID(),
      name: file.name,
      enabled: true,
      color: '',
      events: parsed.events,
      meta: { ...parsed.meta, sourceName: file.name },
    };
    const previous = state.calendarSources;
    const next = [...previous, source];
    if (next.length > 20) throw new Error('You can add up to 20 calendars.');
    setCalendarSources(next);
    try {
      await persistCalendarSources();
      renderCalendar();
      toast('Calendar added');
    } catch (error) {
      setCalendarSources(previous);
      renderCalendarSettings();
      throw error;
    }
  } catch (error) {
    toast(error.message || 'Import failed', true);
  } finally {
    const input = byId('calendar-settings-file');
    if (input) input.value = '';
  }
}

function eventStartEpoch(event) {
  if (!event || event.allDay) return null;
  if (Number.isFinite(event.startInstant)) return event.startInstant;
  const wall = event.start;
  if (!wall || !Number.isFinite(wall.year) || !Number.isFinite(wall.month) || !Number.isFinite(wall.day)) return null;
  return new Date(wall.year, wall.month - 1, wall.day, wall.hour || 0, wall.minute || 0, wall.second || 0).getTime();
}

function calendarReminderKey(event, startMs) {
  return `${event.uid || event.id || 'event'}::${event.recurrenceId || ''}::${startMs}`;
}

function nextCalendarReminder() {
  if (!window.__notchShowCalendarReminder || !window.__notchSettings) return null;
  if (!window.__notchSettings.eventRemindersEnabled) return null;
  const reminderMinutes = Math.max(1, Math.min(180, Number(window.__notchSettings.eventReminderMinutes) || 10));
  const now = Date.now();
  const windowMs = reminderMinutes * 60 * 1000;
  const candidates = state.events
    .filter((event) => event && event.allDay !== true)
    .map((event) => ({ kind: 'event', event, startMs: eventStartEpoch(event) }))
    .filter((item) => Number.isFinite(item.startMs) && item.startMs > now)
    .filter((item) => now >= item.startMs - windowMs)
    .filter((item) => !calendarReminded.has(calendarReminderKey(item.event, item.startMs)))
    .sort((a, b) => a.startMs - b.startMs);
  return candidates[0] || null;
}

function taskStartEpoch(task) {
  if (!task?.date || !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.time || '')) return null;
  const date = parseDateKey(task.date);
  if (!date) return null;
  const [hour, minute] = task.time.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0).getTime();
}

function taskReminderKey(task, startMs) {
  return `${task.id || 'task'}::${startMs}`;
}

function nextTaskReminder() {
  if (!window.__notchShowCalendarReminder || !window.__notchSettings) return null;
  if (!window.__notchSettings.eventRemindersEnabled) return null;
  const reminderMinutes = Math.max(1, Math.min(180, Number(window.__notchSettings.eventReminderMinutes) || 10));
  const now = Date.now();
  const windowMs = reminderMinutes * 60 * 1000;
  const candidates = state.tasks
    .filter((task) => task && !task.completed)
    .map((task) => ({ kind: 'task', event: task, startMs: taskStartEpoch(task) }))
    .filter((item) => Number.isFinite(item.startMs) && item.startMs > now)
    .filter((item) => now >= item.startMs - windowMs)
    .filter((item) => !taskReminded.has(taskReminderKey(item.event, item.startMs)))
    .sort((a, b) => a.startMs - b.startMs);
  return candidates[0] || null;
}

function nextReminder() {
  const calendar = nextCalendarReminder();
  const task = nextTaskReminder();
  if (!calendar) return task;
  if (!task) return calendar;
  return calendar.startMs <= task.startMs ? calendar : task;
}

function checkCalendarReminders() {
  const candidate = nextReminder();
  if (!candidate) return;
  if (candidate.kind === 'task') {
    taskReminded.add(taskReminderKey(candidate.event, candidate.startMs));
  } else {
    calendarReminded.add(calendarReminderKey(candidate.event, candidate.startMs));
  }
  window.__notchShowCalendarReminder(candidate.event, candidate.startMs);
}

function startCalendarReminderLoop() {
  clearInterval(calendarReminderTimer);
  checkCalendarReminders();
  calendarReminderTimer = setInterval(checkCalendarReminders, 5000);
}

function normalizeTask(task) {
  const seconds = durationSeconds(task);
  return {
    id: task?.id || crypto.randomUUID(),
    title: task?.title || '',
    notes: task?.notes || '',
    date: /^\d{4}-\d{2}-\d{2}$/.test(task?.date || '') ? task.date : '',
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(task?.time || '') ? task.time : '',
    durationSeconds: seconds,
    durationMinutes: Math.max(5, Math.round(seconds / 60)),
    completed: !!task?.completed,
    createdAt: task?.createdAt || new Date().toISOString(),
    updatedAt: task?.updatedAt || new Date().toISOString(),
  };
}

function toast(message, isError = false) {
  const node = byId('planner-toast');
  node.textContent = message;
  node.style.background = isError ? 'var(--red)' : '';
  node.style.color = isError ? '#fff' : '';
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 2600);
}

function dateItems(key) {
  return {
    events: state.events.filter((event) => event.dateKey === key),
    tasks: state.tasks.filter((task) => task.date === key),
  };
}

function openEvent(event) {
  byId('event-sheet-title').textContent = event.title;
  const details = byId('event-details');
  details.replaceChildren();
  const startDate = parseDateKey(event.dateKey);
  const start = `${eventDateLabel(startDate)} · ${event.allDay ? 'All day' : wallTime(event.start)}`;
  const end = event.allDay ? '' : wallTime(event.end);
  const rows = [
    ['Date & time', end ? `${start} → ${end}` : start],
    ['Timezone', event.timezone === 'floating' ? `Floating local time (displayed in ${event.displayTimezone})` : `${event.timezone} (displayed in ${event.displayTimezone})`],
    ['Teacher', event.professor], ['Room', event.room], ['Location', event.location],
    ['Description', event.description], ['Organizer', event.organizer],
    ['Attendees', (event.attendees || []).join('\n')], ['Categories', (event.categories || []).join(', ')],
    ['Status', event.status], ['Link', event.url],
  ];
  Object.entries(event.xProperties || {}).forEach(([key, value]) => rows.push([key, value]));
  rows.filter(([, value]) => value).forEach(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt'); term.textContent = label;
    const description = document.createElement('dd'); description.textContent = value;
    row.append(term, description);
    details.append(row);
  });
  byId('event-backdrop').hidden = false;
  if (window.paintIcons) window.paintIcons(byId('event-backdrop'));
}

function closeEvent() {
  byId('event-backdrop').hidden = true;
}

async function persistTasks() {
  const payload = state.tasks.map((task) => {
    const normalized = normalizeTask(task);
    return {
      ...normalized,
      durationMinutes: Math.max(5, Math.round(normalized.durationSeconds / 60)),
    };
  });
  state.tasks = (await window.api.savePlannerTasks(payload)).map(normalizeTask);
}


function selectDate(day) {
  state.selectedDate = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  state.cursor = new Date(state.selectedDate.getFullYear(), state.selectedDate.getMonth(), 1);
  renderCalendar();
  if (state.taskFilter === 'selected') renderTasks();
}

function minuteToTime(minute) {
  const safe = Math.max(0, Math.min(1435, minute));
  return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
}

function timeToMinute(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')) return 0;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function snapMinute(value) {
  return Math.round(value / SNAP_MINUTES) * SNAP_MINUTES;
}

async function scheduleTaskOnDay(taskId, key) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  task.date = key;
  task.time = '';
  task.updatedAt = new Date().toISOString();
  await persistTasks();
  render();
  toast('Task scheduled');
}

async function unscheduleTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  task.date = '';
  task.time = '';
  task.updatedAt = new Date().toISOString();
  await persistTasks();
  state.taskFilter = 'unscheduled';
  render();
  toast('Task moved to Unscheduled');
}

function clearDragPreview() {
  if (state.drag.preview) state.drag.preview.remove();
  state.drag.preview = null;
  state.drag.previewMinutes = null;
  document.querySelectorAll('.month-day.drop-target, .seg-btn.drop-target, .tasks-list.drop-target').forEach((node) => node.classList.remove('drop-target'));
  document.querySelectorAll('.timeline.drag-active').forEach((node) => node.classList.remove('drag-active'));
}

function destroyDragAvatar() {
  if (state.drag.avatar) state.drag.avatar.remove();
  if (state.drag.source) state.drag.source.classList.remove('is-dragging');
  state.drag.avatar = null;
  state.drag.source = null;
}

function updateDragAvatar(x, y) {
  state.drag.pointerX = x;
  state.drag.pointerY = y;
  if (!state.drag.avatar) return;
  state.drag.avatar.style.transform = `translate3d(${x - 19}px, ${y - 19}px, 0)`;
}

function createDragAvatar(task) {
  if (state.drag.avatar) state.drag.avatar.remove();
  state.drag.avatar = null;
  const avatar = document.createElement('div');
  avatar.className = 'task-drag-avatar';
  const initial = (task.title || 'T').trim().charAt(0).toUpperCase() || 'T';
  avatar.innerHTML = `<div class="task-drag-avatar-core"><span>${initial}</span></div>`;
  document.body.append(avatar);
  state.drag.avatar = avatar;
  updateDragAvatar(state.drag.pointerX, state.drag.pointerY);
  requestAnimationFrame(() => avatar.classList.add('compact'));
}

function dragStart(task, event, source) {
  destroyDragAvatar();
  state.drag.taskId = task.id;
  state.drag.source = source || null;
  if (source) source.classList.add('is-dragging');
  updateDragAvatar(event.clientX || 0, event.clientY || 0);
  createDragAvatar(task);

  const ghost = document.createElement('div');
  ghost.style.cssText = 'width:1px;height:1px;opacity:0;position:fixed;left:-20px;top:-20px;';
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, 0, 0);
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', task.id);
  setTimeout(() => ghost.remove(), 0);
}

function dragEnd() {
  state.drag.taskId = '';
  clearDragPreview();
  destroyDragAvatar();
}

function timelineDropMinutes(event, timeline) {
  const rect = timeline.getBoundingClientRect();
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  const rawMinute = y / rect.height * 1440;
  return Math.max(0, Math.min(1435, snapMinute(rawMinute)));
}

function showTimelinePreview(timeline, minute, task) {
  const seconds = durationSeconds(task);
  const minutes = seconds / 60;
  const preview = state.drag.preview || document.createElement('div');
  preview.className = 'timeline-drop-preview';
  preview.style.top = `${minute / 1440 * TIMELINE_HEIGHT}px`;
  preview.style.height = `${Math.max(28, minutes / 1440 * TIMELINE_HEIGHT)}px`;
  preview.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = task.title;
  const meta = document.createElement('span');
  meta.textContent = `${minuteToTime(minute)} · ${formatDuration(task)}`;
  preview.append(title, meta);
  if (!preview.parentElement) timeline.append(preview);
  state.drag.preview = preview;
  state.drag.previewMinutes = minute;
  timeline.classList.add('drag-active');
}

function renderMonth() {
  const stage = byId('calendar-stage');
  const grid = document.createElement('div');
  grid.className = 'month-view';

  weekdayNames.forEach((name) => {
    const cell = document.createElement('div');
    cell.className = 'month-weekday';
    cell.textContent = name;
    grid.append(cell);
  });

  const first = new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);

  for (let index = 0; index < 42; index += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    const key = dateKey(day);
    const cell = document.createElement('div');
    cell.className = 'month-day';
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.classList.toggle('outside', day.getMonth() !== state.cursor.getMonth());
    cell.classList.toggle('selected', sameDay(day, state.selectedDate));
    cell.classList.toggle('today', sameDay(day, new Date()));

    const choose = () => selectDate(day);
    cell.addEventListener('click', choose);
    cell.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose();
      }
    });

    const number = document.createElement('span');
    number.className = 'day-number';
    number.textContent = day.getDate();
    cell.append(number);

    cell.addEventListener('dragover', (event) => {
      if (!state.drag.taskId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.month-day.drop-target').forEach((node) => node.classList.remove('drop-target'));
      cell.classList.add('drop-target');
    });
    cell.addEventListener('dragleave', (event) => {
      if (!cell.contains(event.relatedTarget)) cell.classList.remove('drop-target');
    });
    cell.addEventListener('drop', (event) => {
      if (!state.drag.taskId) return;
      event.preventDefault();
      cell.classList.remove('drop-target');
      scheduleTaskOnDay(state.drag.taskId, key);
    });

    grid.append(cell);
  }

  stage.replaceChildren(grid);
}

function minutesFromWall(wall) {
  return (wall.hour || 0) * 60 + (wall.minute || 0);
}

function arrangeTimelineItems(events, tasks) {
  const entries = [
    ...events.filter((item) => !item.allDay).map((item) => ({ kind:'event', item })),
    ...tasks.filter((item) => item.time).map((item) => ({ kind:'task', item })),
  ].map((entry) => {
    const start = entry.kind === 'event' ? minutesFromWall(entry.item.start) : timeToMinute(entry.item.time);
    let duration = entry.kind === 'event'
      ? minutesFromWall(entry.item.end) - start
      : durationSeconds(entry.item) / 60;
    if (duration <= 0) duration += 1440;
    return { ...entry, start, end:start + duration, duration, column:0, columns:1 };
  }).sort((a,b) => a.start - b.start || a.end - b.end);

  let group = [];
  let groupEnd = -1;
  const flush = () => {
    if (!group.length) return;
    const active = [];
    let maxColumns = 1;
    group.forEach((entry) => {
      for (let index = active.length - 1; index >= 0; index -= 1) {
        if (active[index].end <= entry.start) active.splice(index, 1);
      }
      const used = new Set(active.map((item) => item.column));
      let column = 0;
      while (used.has(column)) column += 1;
      entry.column = column;
      active.push(entry);
      maxColumns = Math.max(maxColumns, active.length, column + 1);
    });
    group.forEach((entry) => { entry.columns = maxColumns; });
    group = [];
  };

  entries.forEach((entry) => {
    if (group.length && entry.start >= groupEnd) flush();
    group.push(entry);
    groupEnd = Math.max(groupEnd, entry.end);
  });
  flush();
  return entries;
}

function updateTimelineTaskMeta(node, task, startMinute = timeToMinute(task.time), durationSec = durationSeconds(task)) {
  const meta = node.querySelector('.timeline-task-meta');
  if (meta) meta.textContent = `${minuteToTime(startMinute)} · ${formatDuration(durationSec)}`;
}

function beginTaskResize(task, node, edge, event) {
  event.preventDefault();
  event.stopPropagation();
  const startMinute = timeToMinute(task.time);
  const startDurationMinutes = durationSeconds(task) / 60;
  const endMinute = Math.min(1440, startMinute + startDurationMinutes);
  const startY = event.clientY;
  node.classList.add('resizing');

  const onMove = (moveEvent) => {
    const deltaMinutes = snapMinute((moveEvent.clientY - startY) / TIMELINE_HEIGHT * 1440);
    if (edge === 'bottom') {
      const newEnd = Math.max(startMinute + 5, Math.min(1440, endMinute + deltaMinutes));
      const newDuration = newEnd - startMinute;
      node.style.height = `${Math.max(28, newDuration / 1440 * TIMELINE_HEIGHT)}px`;
      node.dataset.resizeStart = String(startMinute);
      node.dataset.resizeDuration = String(newDuration);
      updateTimelineTaskMeta(node, task, startMinute, newDuration * 60);
    } else {
      const newStart = Math.max(0, Math.min(endMinute - 5, startMinute + deltaMinutes));
      const newDuration = endMinute - newStart;
      node.style.top = `${newStart / 1440 * TIMELINE_HEIGHT}px`;
      node.style.height = `${Math.max(28, newDuration / 1440 * TIMELINE_HEIGHT)}px`;
      node.dataset.resizeStart = String(newStart);
      node.dataset.resizeDuration = String(newDuration);
      updateTimelineTaskMeta(node, task, newStart, newDuration * 60);
    }
  };

  const onUp = async () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    node.classList.remove('resizing');
    const nextStart = Number(node.dataset.resizeStart || startMinute);
    const nextDuration = Number(node.dataset.resizeDuration || startDurationMinutes);
    delete node.dataset.resizeStart;
    delete node.dataset.resizeDuration;
    task.time = minuteToTime(nextStart);
    task.durationSeconds = Math.max(MIN_DURATION_SECONDS, Math.round(nextDuration * 60));
    task.durationMinutes = Math.max(5, Math.round(task.durationSeconds / 60));
    task.updatedAt = new Date().toISOString();
    await persistTasks();
    render();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once:true });
}

function timelineBlock(entry) {
  const { kind, item, start, duration, column, columns } = entry;
  const node = document.createElement('div');
  node.className = `timeline-item ${kind}`;
  if (kind === 'event') {
    node.dataset.calendarSourceId = item.sourceId || '';
    if (item.sourceColor) node.style.setProperty('--calendar-source-color', item.sourceColor);
  }
  node.tabIndex = 0;
  node.style.top = `${start / 1440 * TIMELINE_HEIGHT}px`;
  node.style.height = `${Math.max(28, duration / 1440 * TIMELINE_HEIGHT)}px`;
  node.style.left = `calc(${column * 100 / columns}% + 4px)`;
  node.style.width = `calc(${100 / columns}% - 8px)`;

  const title = document.createElement('strong');
  title.textContent = item.title;
  const meta = document.createElement('span');
  meta.className = kind === 'task' ? 'timeline-task-meta' : '';
  meta.textContent = kind === 'event'
    ? `${wallTime(item.start)} → ${wallTime(item.end)}${item.room ? ` · ${item.room}` : ''}`
    : `${item.time} · ${formatDuration(item)}`;
  node.append(title, meta);

  if (kind === 'event') {
    node.addEventListener('click', () => openEvent(item));
    node.addEventListener('keydown', (event) => { if (event.key === 'Enter') openEvent(item); });
  } else {
    node.draggable = true;
    node.addEventListener('dragstart', (event) => dragStart(item, event, node));
    node.addEventListener('dragend', dragEnd);
    node.addEventListener('click', (event) => {
      if (event.target.closest('.resize-handle')) return;
      openTaskEditor(item);
    });
    const topHandle = document.createElement('span');
    topHandle.className = 'resize-handle resize-handle-top';
    topHandle.title = 'Resize from start';
    const bottomHandle = document.createElement('span');
    bottomHandle.className = 'resize-handle resize-handle-bottom';
    bottomHandle.title = 'Resize from end';
    topHandle.addEventListener('pointerdown', (event) => beginTaskResize(item, node, 'top', event));
    bottomHandle.addEventListener('pointerdown', (event) => beginTaskResize(item, node, 'bottom', event));
    node.append(topHandle, bottomHandle);
  }

  return node;
}

function renderDay() {
  const stage = byId('calendar-stage');
  // Preserve the user's exact position in the day timeline before rebuilding
  // the DOM. Drag/drop, duration edits and task resizing can all re-render the
  // view; none of them should teleport the calendar back to the morning.
  const previousScroll = stage.querySelector('.timeline-scroll')?.scrollTop;
  if (Number.isFinite(previousScroll)) state.dayScrollTop = previousScroll;
  const key = dateKey(state.selectedDate);
  const { events, tasks } = dateItems(key);
  const root = document.createElement('div');
  root.className = 'day-view';

  const strip = document.createElement('div');
  strip.className = 'all-day-strip';
  const label = document.createElement('div');
  label.className = 'all-day-label';
  label.textContent = 'Any time';
  const items = document.createElement('div');
  items.className = 'all-day-items';

  events.filter((event) => event.allDay).forEach((event) => {
    const chip = button('all-day-chip', event.title, () => openEvent(event));
    chip.dataset.calendarSourceId = event.sourceId || '';
    if (event.sourceColor) chip.style.setProperty('--calendar-source-color', event.sourceColor);
    items.append(chip);
  });
  tasks.filter((task) => !task.time).forEach((task) => {
    const chip = button('all-day-chip task', `${task.completed ? '✓ ' : ''}${task.title} · ${formatDuration(task)}`, () => openTaskEditor(task));
    chip.draggable = true;
    chip.addEventListener('dragstart', (event) => dragStart(task, event, chip));
    chip.addEventListener('dragend', dragEnd);
    items.append(chip);
  });
  if (!items.children.length) {
    const empty = document.createElement('span');
    empty.className = 'month-more';
    empty.textContent = 'No all-day items';
    items.append(empty);
  }
  strip.append(label, items);
  root.append(strip);

  const scroll = document.createElement('div');
  scroll.className = 'timeline-scroll';
  const timeline = document.createElement('div');
  timeline.className = 'timeline';
  for (let hour = 0; hour < 24; hour += 1) {
    const tick = document.createElement('span');
    tick.className = 'timeline-hour';
    tick.style.top = `${hour * 64}px`;
    tick.textContent = `${pad(hour)}:00`;
    timeline.append(tick);
  }

  timeline.addEventListener('dragover', (event) => {
    if (!state.drag.taskId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const task = state.tasks.find((item) => item.id === state.drag.taskId);
    if (!task) return;
    showTimelinePreview(timeline, timelineDropMinutes(event, timeline), task);
  });
  timeline.addEventListener('dragleave', (event) => {
    if (!timeline.contains(event.relatedTarget)) clearDragPreview();
  });
  timeline.addEventListener('drop', async (event) => {
    if (!state.drag.taskId) return;
    event.preventDefault();
    const task = state.tasks.find((item) => item.id === state.drag.taskId);
    if (!task) return;
    const minute = state.drag.previewMinutes ?? timelineDropMinutes(event, timeline);
    task.date = key;
    task.time = minuteToTime(minute);
    task.updatedAt = new Date().toISOString();
    await persistTasks();
    clearDragPreview();
    render();
    toast('Task scheduled');
  });

  arrangeTimelineItems(events, tasks).forEach((entry) => timeline.append(timelineBlock(entry)));
  if (sameDay(state.selectedDate, new Date())) {
    const now = new Date();
    const line = document.createElement('span');
    line.className = 'timeline-now';
    line.style.top = `${(now.getHours() * 60 + now.getMinutes()) / 1440 * TIMELINE_HEIGHT}px`;
    timeline.append(line);
  }

  scroll.append(timeline);
  root.append(scroll);
  stage.replaceChildren(root);

  const initialScroll = Math.max(0, 7 * 64 - 30);
  const targetScroll = Number.isFinite(state.dayScrollTop) ? state.dayScrollTop : initialScroll;
  // Apply before the browser paints, then keep the state in sync with manual
  // scrolling. The rAF assignment only guards against layout settling; it
  // uses the same preserved value, so there is no visible jump.
  scroll.scrollTop = targetScroll;
  requestAnimationFrame(() => { scroll.scrollTop = targetScroll; });
  scroll.addEventListener('scroll', () => {
    state.dayScrollTop = scroll.scrollTop;
  }, { passive:true });
}

function renderCalendar() {
  byId('calendar-stage').classList.toggle('day-mode', state.view === 'day');
  byId('calendar-period').textContent = state.view === 'month'
    ? `${monthNames[state.cursor.getMonth()]} ${state.cursor.getFullYear()}`
    : state.selectedDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'long', year:'numeric' });
  document.querySelectorAll('#calendar-view-switch .seg-btn').forEach((node) => node.classList.toggle('active', node.dataset.view === state.view));
  if (state.view === 'month') renderMonth();
  else renderDay();
}

function filteredTasks() {
  const key = dateKey(state.selectedDate);
  let list;
  if (state.taskFilter === 'unscheduled') {
    list = state.tasks.filter((task) => !task.date);
  } else if (state.taskFilter === 'all') {
    list = [...state.tasks];
  } else {
    list = state.tasks.filter((task) => task.date === key);
  }

  return list.sort((a, b) => {
    const aScheduled = !!a.date;
    const bScheduled = !!b.date;
    if (aScheduled !== bScheduled) return aScheduled ? -1 : 1;
    if (aScheduled && bScheduled) {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare) return dateCompare;
      const timeCompare = (a.time || '99:99').localeCompare(b.time || '99:99');
      if (timeCompare) return timeCompare;
    }
    return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.title.localeCompare(b.title);
  });
}

function durationEditor(task) {
  const editor = document.createElement('div');
  editor.className = 'task-duration-inline';

  const heading = document.createElement('div');
  heading.className = 'task-duration-inline-title';
  heading.textContent = 'Focus duration';

  const controls = document.createElement('div');
  controls.className = 'task-duration-inline-controls';
  const minutes = Math.floor(durationSeconds(task) / 60);
  const seconds = durationSeconds(task) % 60;

  const createColumn = (label, value, upDelta, downDelta) => {
    const column = document.createElement('div');
    column.className = 'task-duration-column';
    const caption = document.createElement('span');
    caption.textContent = label;
    caption.className = 'task-duration-caption';
    const up = button('task-duration-step', '⌃', async () => adjustTaskDuration(task, upDelta));
    const box = document.createElement('div');
    box.className = 'task-duration-value';
    box.textContent = pad(value);
    const down = button('task-duration-step', '⌄', async () => adjustTaskDuration(task, downDelta));
    column.append(caption, up, box, down);
    return column;
  };

  controls.append(
    createColumn('MIN', minutes, 60, -60),
    Object.assign(document.createElement('span'), { className:'task-duration-colon', textContent:':' }),
    createColumn('SEC', seconds, 5, -5),
  );

  const done = button('task-duration-done', 'Done', () => {
    state.durationEditingTaskId = '';
    renderTasks();
  });
  editor.append(heading, controls, done);
  return editor;
}

async function adjustTaskDuration(task, deltaSeconds) {
  const next = Math.max(MIN_DURATION_SECONDS, Math.min(24 * 60 * 60, durationSeconds(task) + deltaSeconds));
  task.durationSeconds = next;
  task.durationMinutes = Math.max(5, Math.round(next / 60));
  task.updatedAt = new Date().toISOString();
  await persistTasks();
  renderTasks();
  if (state.view === 'day' && task.date === dateKey(state.selectedDate)) renderCalendar();
}

async function deleteTaskDirect(task) {
  state.tasks = state.tasks.filter((item) => item.id !== task.id);
  await persistTasks();
  if (state.editingTaskId === task.id) closeTaskEditor();
  if (state.durationEditingTaskId === task.id) state.durationEditingTaskId = '';
  render();
  toast('Task deleted');
}

function renderTasks() {
  const list = byId('tasks-list');
  list.replaceChildren();

  document.querySelectorAll('#tasks-filter .seg-btn').forEach((node) => {
    node.classList.toggle('active', node.dataset.filter === state.taskFilter);
  });

  const tasks = filteredTasks();
  const openCount = tasks.filter((task) => !task.completed).length;
  byId('tasks-open-count').textContent = `${openCount} open`;

  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state tasks-empty';
    empty.append(icon('check'));
    const heading = document.createElement('h3');
    heading.textContent = state.taskFilter === 'unscheduled' ? 'No unscheduled tasks' : 'No tasks';
    const text = document.createElement('p');
    text.textContent = state.taskFilter === 'unscheduled'
      ? 'New tasks appear here automatically until you drag them into the calendar.'
      : state.taskFilter === 'all'
        ? 'Create your first task.'
        : 'No tasks for the selected day.';
    empty.append(heading, text);
    list.append(empty);
  }

  tasks.forEach((task) => {
    const card = document.createElement('article');
    card.className = `task-card${task.completed ? ' completed' : ''}`;
    card.draggable = true;
    card.addEventListener('dragstart', (event) => dragStart(task, event, card));
    card.addEventListener('dragend', dragEnd);

    const check = button('task-check', '', async (event) => {
      event.stopPropagation();
      task.completed = !task.completed;
      task.updatedAt = new Date().toISOString();
      await persistTasks();
      renderTasks();
    });
    check.title = task.completed ? 'Mark as incomplete' : 'Mark as complete';
    check.append(icon('check'));

    const content = document.createElement('div');
    content.className = 'task-card-content';
    const title = document.createElement('h3');
    title.textContent = task.title;
    title.addEventListener('click', () => openTaskEditor(task));
    const note = document.createElement('p');
    note.textContent = task.notes || 'Drag to schedule';
    note.addEventListener('click', () => openTaskEditor(task));

    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const duration = button('task-duration-button', formatDuration(task), (event) => {
      event.stopPropagation();
      state.durationEditingTaskId = state.durationEditingTaskId === task.id ? '' : task.id;
      renderTasks();
    });
    duration.title = 'Change duration';
    meta.append(duration);

    if (!task.date) {
      const status = document.createElement('span');
      status.textContent = 'Unscheduled';
      meta.append(status);
    } else {
      const schedule = document.createElement('span');
      schedule.textContent = task.time ? `${task.date} · ${task.time}` : task.date;
      meta.append(schedule);
    }
    content.append(title, note, meta);
    if (state.durationEditingTaskId === task.id) content.append(durationEditor(task));

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    const edit = button('icon-btn task-edit', '', (event) => { event.stopPropagation(); openTaskEditor(task); });
    edit.title = 'Edit';
    edit.append(icon('edit'));
    const remove = button('icon-btn task-remove', '', async (event) => { event.stopPropagation(); await deleteTaskDirect(task); });
    remove.title = 'Delete';
    remove.append(icon('trash'));
    actions.append(edit, remove);

    card.append(check, content, actions);
    list.append(card);
  });

  if (window.paintIcons) window.paintIcons(list);
}

function openTaskEditor(task = null) {
  state.editingTaskId = task?.id || '';
  state.durationEditingTaskId = '';
  byId('task-editor-shell').hidden = false;
  byId('task-add-row').hidden = true;
  byId('task-editor-title').value = task?.title || '';
  byId('task-editor-note').value = task?.notes || '';
  byId('task-editor-submit').textContent = task ? 'Save' : 'Create';
  byId('task-editor-title-label').textContent = task ? 'Edit task' : 'New task';
  byId('task-editor-delete').hidden = !task;
  requestAnimationFrame(() => byId('task-editor-title').focus());
}

function closeTaskEditor() {
  state.editingTaskId = '';
  byId('task-editor-shell').hidden = true;
  byId('task-add-row').hidden = false;
  byId('task-editor').reset();
}

async function submitTaskEditor(event) {
  event.preventDefault();
  const title = byId('task-editor-title').value.trim();
  if (!title) return;
  const now = new Date().toISOString();
  const existing = state.tasks.find((task) => task.id === state.editingTaskId);

  if (existing) {
    existing.title = title;
    existing.notes = byId('task-editor-note').value.trim();
    existing.updatedAt = now;
  } else {
    state.tasks.push(normalizeTask({
      id: crypto.randomUUID(),
      title,
      notes: byId('task-editor-note').value.trim(),
      date: '',
      time: '',
      durationSeconds: DEFAULT_DURATION_SECONDS,
      completed: false,
      createdAt: now,
      updatedAt: now,
    }));
    state.taskFilter = 'unscheduled';
  }

  await persistTasks();
  closeTaskEditor();
  render();
  toast(existing ? 'Task updated' : 'Task created');
}

async function deleteTaskFromEditor() {
  const task = state.tasks.find((item) => item.id === state.editingTaskId);
  if (task) await deleteTaskDirect(task);
}

function navigate(delta) {
  if (state.view === 'month') {
    state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + delta, 1);
  } else {
    const next = new Date(state.selectedDate);
    next.setDate(next.getDate() + delta);
    state.selectedDate = next;
    state.cursor = new Date(next.getFullYear(), next.getMonth(), 1);
  }
  render();
}

function render() {
  renderCalendar();
  renderTasks();
  if (window.paintIcons) window.paintIcons(byId('panel-schedule'));
}

byId('calendar-prev').addEventListener('click', () => navigate(-1));
byId('calendar-next').addEventListener('click', () => navigate(1));
byId('calendar-today').addEventListener('click', () => {
  state.selectedDate = new Date();
  state.cursor = new Date(state.selectedDate.getFullYear(), state.selectedDate.getMonth(), 1);
  render();
});
document.querySelectorAll('#calendar-view-switch .seg-btn').forEach((node) => node.addEventListener('click', () => {
  state.view = node.dataset.view;
  if (state.view === 'month') state.cursor = new Date(state.selectedDate.getFullYear(), state.selectedDate.getMonth(), 1);
  render();
}));
byId('calendar-settings-add').addEventListener('click', () => {
  const input = byId('calendar-settings-url');
  if (!input) return;
  input.focus();
  const value = input.value.trim();
  if (value) { addCalendarUrl(value); input.value = ''; }
});
byId('calendar-settings-url').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const input = event.currentTarget;
  const value = input.value.trim();
  if (value) { addCalendarUrl(value); input.value = ''; }
});

window.renderCalendarSettings = renderCalendarSettings;

byId('task-add').addEventListener('click', () => openTaskEditor());
byId('task-add-row').addEventListener('click', () => openTaskEditor());
byId('task-editor').addEventListener('submit', submitTaskEditor);
byId('task-editor-cancel').addEventListener('click', closeTaskEditor);
byId('task-editor-delete').addEventListener('click', deleteTaskFromEditor);

document.querySelectorAll('#tasks-filter .seg-btn').forEach((node) => {
  node.addEventListener('click', () => {
    state.taskFilter = node.dataset.filter;
    renderTasks();
  });
});

const unscheduledButton = document.querySelector('#tasks-filter [data-filter="unscheduled"]');
unscheduledButton.addEventListener('dragover', (event) => {
  if (!state.drag.taskId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  unscheduledButton.classList.add('drop-target');
});
unscheduledButton.addEventListener('dragleave', () => unscheduledButton.classList.remove('drop-target'));
unscheduledButton.addEventListener('drop', (event) => {
  if (!state.drag.taskId) return;
  event.preventDefault();
  unscheduledButton.classList.remove('drop-target');
  unscheduleTask(state.drag.taskId);
});

byId('tasks-list').addEventListener('dragover', (event) => {
  if (!state.drag.taskId || state.taskFilter !== 'unscheduled') return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  byId('tasks-list').classList.add('drop-target');
});
byId('tasks-list').addEventListener('dragleave', (event) => {
  if (!byId('tasks-list').contains(event.relatedTarget)) byId('tasks-list').classList.remove('drop-target');
});
byId('tasks-list').addEventListener('drop', (event) => {
  if (!state.drag.taskId || state.taskFilter !== 'unscheduled') return;
  event.preventDefault();
  byId('tasks-list').classList.remove('drop-target');
  unscheduleTask(state.drag.taskId);
});

byId('event-close').addEventListener('click', closeEvent);
byId('event-backdrop').addEventListener('click', (event) => { if (event.target === byId('event-backdrop')) closeEvent(); });
byId('schedule-focus').addEventListener('click', () => window.startPlannerFocus && window.startPlannerFocus());

document.addEventListener('dragover', (event) => updateDragAvatar(event.clientX, event.clientY));
document.addEventListener('mousemove', (event) => updateDragAvatar(event.clientX, event.clientY));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!byId('event-backdrop').hidden) closeEvent();
  else if (!byId('task-editor-shell').hidden) closeTaskEditor();
  else if (state.durationEditingTaskId) {
    state.durationEditingTaskId = '';
    renderTasks();
  }
});

try {
  const data = await window.api.getPlannerData();
  if (Array.isArray(data.calendarSources) && data.calendarSources.length) {
    setCalendarSources(data.calendarSources);
  } else if (Array.isArray(data.calendarEvents) && data.calendarEvents.length) {
    setCalendarSources([{
      id: 'legacy-calendar',
      name: data.calendarMeta?.sourceName || 'Imported calendar',
      enabled: true,
      events: data.calendarEvents,
      meta: data.calendarMeta || {},
    }]);
  } else {
    setCalendarSources([]);
  }
  state.tasks = Array.isArray(data.plannerTasks) ? data.plannerTasks.map(normalizeTask) : [];
  state.meta = data.calendarMeta || {};
  renderCalendarSettings();
  render();
} catch (error) {
  console.error('[planner] Unable to load local data:', error);
  render();
  toast('Unable to load planner data', true);
}

window.__notchPlannerState = state;
window.__notchSyncCalendars = () => syncRemoteCalendarSources(true);
calendarSyncTimer = setInterval(() => syncRemoteCalendarSources(true), CALENDAR_SYNC_INTERVAL_MS);
startCalendarReminderLoop();
