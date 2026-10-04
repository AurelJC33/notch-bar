import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../preload.js', import.meta.url), 'utf8');
const planner = fs.readFileSync(new URL('../renderer/planner.js', import.meta.url), 'utf8');

 test('clipboard history is capped at 25 and exposed through IPC', () => {
  assert.match(main, /CLIPBOARD_HISTORY_MAX_ITEMS = 25/);
  assert.match(main, /clipboardHistoryStore/);
  assert.match(main, /ipcMain\.handle\('get-clipboard-history'/);
  assert.match(main, /ipcMain\.handle\('clipboard-history-copy'/);
  assert.match(main, /startClipboardHistoryLoop\(\)/);
  assert.match(app, /clipboardHistory\.slice\(0, 25\)/);
  assert.match(preload, /getClipboardHistory/);
  assert.match(preload, /copyClipboardHistoryItem/);
});

test('pinned pages are limited to four and configurable independently', () => {
  assert.match(app, /DEFAULT_PINNED_PAGES = \['pomodoro', 'schedule', 'time', 'weather'\]/);
  assert.match(app, /\.slice\(0, 4\)/);
  assert.match(app, /updateSetting\('pinnedPages'/);
  assert.match(html, /id="pinned-pages-list"/);
  assert.match(html, /data-tab="clipboard"/);
});

test('shelf scrollbar is visually hidden until interaction', () => {
  assert.match(css, /\.shelf-list::-webkit-scrollbar\{ width:4px; \}/);
  assert.match(css, /\.shelf-list::-webkit-scrollbar-thumb\{ background:transparent;/);
  assert.match(css, /\.shelf-list:hover.*scrollbar-color/);
});


test('analytics page has dual-size views, month navigation and accent-derived visuals', () => {
  assert.match(main, /analyticsStore/);
  assert.match(main, /ipcMain\.handle\('get-pomodoro-analytics'/);
  assert.match(main, /ipcMain\.handle\('record-pomodoro-session'/);
  assert.match(preload, /getPomodoroAnalytics/);
  assert.match(preload, /recordPomodoroSession/);
  assert.match(html, /data-tab="analytics"/);
  assert.match(app, /setMode\('analytics-expanded'\)/);
  assert.match(app, /recordPomoAnalyticsSession\(true\)/);
  assert.match(app, /recordPomoAnalyticsSession\(false\)/);
  assert.match(html, /id="analytics-grid"/);
  assert.match(html, /id="analytics-grid-next"/);
  assert.match(app, /slot === 'current' \? 'analytics-grid' : `analytics-grid-\${slot}`/);
  assert.match(css, /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(html, /id="analytics-expand"/);
  assert.match(html, /id="analytics-collapse"/);
  assert.match(css, /body\.mode-analytics #capsule\{ width:var\(--w-expanded\); height:var\(--h-expanded\); \}/);
  assert.match(css, /body\.mode-analytics-expanded #capsule\{ width:var\(--w-schedule\); height:var\(--h-schedule\); \}/);
  assert.match(css, /\.analytics-level-5\{background:var\(--accent\)/);
  assert.match(css, /\.analytics-chart-line\{.*stroke:var\(--accent\)/);
});


test('calendar links and reminders are wired through IPC and settings', () => {
  assert.match(main, /eventRemindersEnabled: false/);
  assert.match(main, /eventReminderMinutes: 10/);
  assert.match(main, /ipcMain\.handle\('fetch-ical-url'/);
  assert.match(main, /MAX_ICAL_RESPONSE_BYTES/);
  assert.match(preload, /fetchICalUrl/);
  assert.match(html, /id="calendar-settings-url"/);
  assert.match(html, /id="s-eventRemindersEnabled"/);
  assert.match(html, /data-field="eventReminderMinutes"/);
  assert.match(app, /window\.__notchShowCalendarReminder/);
  assert.match(app, /setTimeout\(finishCalendarReminder, 3000\)/);
  assert.match(app, /setEdge\('accent', 'pulse'\)/);
  assert.match(css, /body\.mode-reminder #capsule/);
  assert.match(css, /--reminder-width/);
  assert.match(html, /Calendar &amp; task reminders/);
  assert.match(planner, /const taskReminded = new Set\(\)/);
  assert.match(planner, /function taskStartEpoch\(task\)/);
  assert.match(planner, /function nextTaskReminder\(\)/);
  assert.match(planner, /function nextReminder\(\)/);
  assert.match(planner, /candidate\.kind === 'task'/);
});

test('calendar source settings expose manual refresh for remote feeds', () => {
  assert.match(planner, /syncRemoteCalendarSource\(source, false\)/);
  assert.match(planner, /CALENDAR_SYNC_INTERVAL_MS = 10 \* 60 \* 1000/);
  assert.match(planner, /syncRemoteCalendarSources\(true\)/);
  assert.match(html, /iCal links refresh automatically every 10 minutes/);
});
