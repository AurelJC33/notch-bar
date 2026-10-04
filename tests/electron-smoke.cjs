const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
let tasks = [];
let calendarSources = [];
let shelfItems = [];
let shelfDragRequests = [];
let analyticsSessions = [];

ipcMain.on('set-ignore-mouse-events', () => {});
ipcMain.handle('get-settings', () => ({ focusMinutes:25, shortBreakMinutes:5, longBreakMinutes:15, pomodorosBeforeLongBreak:4, theme:'sombre', accentColor:'#0a84ff', reduceMotion:true }));
ipcMain.handle('save-settings', (_, patch) => patch);
ipcMain.handle('reset-settings', () => ({}));
ipcMain.handle('get-onboarding', () => ({ show:false }));
ipcMain.handle('complete-onboarding', () => true);
ipcMain.handle('set-global-shortcut', (_, accelerator) => ({ ok:true, accelerator }));
ipcMain.handle('get-global-shortcut-status', () => ({ enabled:true, accelerator:'Ctrl+Alt+N', registered:true }));
ipcMain.handle('get-weather', () => ({ temp:18, icon:'weather-clear' }));
ipcMain.handle('get-weather-forecast', () => null);
ipcMain.handle('get-planner-data', () => ({ calendarSources, calendarEvents:calendarSources.flatMap((source) => source.events), calendarMeta:calendarSources[0]?.meta || {}, plannerTasks:tasks }));
ipcMain.handle('save-planner-tasks', (_, value) => (tasks = value));
ipcMain.handle('save-calendar-sources', (_, value) => { calendarSources = value; return { calendarSources }; });
ipcMain.handle('set-window-mode', () => ({}));
ipcMain.handle('get-window-input-capabilities', () => ({ shape:false }));
ipcMain.on('set-interactive-region', () => {});
ipcMain.handle('get-shelf-data', () => ({ items:shelfItems }));
ipcMain.handle('shelf-add-paths', (_, paths) => {
  for (const filePath of Array.isArray(paths) ? paths : []) {
    if (!shelfItems.some((item) => item.path === filePath)) shelfItems.push({ id:`shelf-${shelfItems.length+1}`, path:filePath, name:path.basename(filePath), kind:'file', temporary:false, addedAt:new Date().toISOString(), exists:fs.existsSync(filePath) });
  }
  return { items:shelfItems };
});
ipcMain.handle('shelf-add-web-image', async (_, payload) => {
  const name = payload.name || 'web-image.png';
  shelfItems.push({ id:`shelf-${shelfItems.length+1}`, path:path.join(root, name), name, kind:'file', temporary:true, addedAt:new Date().toISOString(), exists:false });
  return { items:shelfItems };
});
ipcMain.handle('shelf-add-web-bytes', async (_, payload) => {
  const name = payload.name || 'Web image';
  shelfItems.push({ id:`shelf-${shelfItems.length+1}`, path:path.join(root, name), name, kind:'file', temporary:true, addedAt:new Date().toISOString(), exists:false });
  return { items:shelfItems };
});
ipcMain.handle('shelf-remove', (_, id) => { shelfItems = shelfItems.filter((item) => item.id !== id); return { items:shelfItems }; });
ipcMain.handle('shelf-clear', () => { shelfItems = []; return { items:shelfItems }; });
ipcMain.handle('shelf-open-location', () => true);
ipcMain.on('shelf-start-drag', (_, ids) => { shelfDragRequests.push(ids); });
ipcMain.handle('get-media-state', () => ({ available:false }));
ipcMain.handle('refresh-media-state', () => ({ available:false }));
ipcMain.handle('media-command', () => ({ ok:false, error:'no-media-session' }));
ipcMain.handle('get-audio-accessory-state', () => ({ connected:false }));
ipcMain.handle('get-clipboard-history', () => []);
ipcMain.handle('clipboard-history-copy', () => ({ ok:true }));
ipcMain.on('clipboard-history-request-refresh', () => {});
const icalFeeds = {};
ipcMain.handle('fetch-ical-url', (_, url) => {
  if (!(url in icalFeeds)) throw new Error('Unknown test feed');
  return { ok:true, url, text:icalFeeds[url] };
});
ipcMain.handle('get-pomodoro-analytics', () => ({ sessions:analyticsSessions }));
ipcMain.handle('record-pomodoro-session', (_, session) => { const saved={...session, id:`analytics-${analyticsSessions.length+1}`}; analyticsSessions.push(saved); return {ok:true,session:saved}; });

async function waitFor(win, expression, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Délai dépassé : ${expression}`);
}

app.whenReady().then(async () => {
  const errors = [];
  const win = new BrowserWindow({
    show:false, width:1160, height:760,
    webPreferences:{ preload:path.join(root, 'preload.js'), contextIsolation:true, nodeIntegration:false, offscreen:true, backgroundThrottling:false },
  });
  win.webContents.on('console-message', (_, level, message, line, sourceId) => { if (level >= 2) { errors.push(message); console.error(`[renderer] ${sourceId}:${line}`, message); } });
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await waitFor(win, `document.querySelector('.month-view')`);

  // Analytics : page compacte, grille mensuelle, couleur accent et bascule
  // vers exactement les dimensions de la vue Calendrier.
  await win.webContents.executeJavaScript(`document.querySelector('[data-tab=\"analytics\"]').click()`);
  await waitFor(win, `document.body.classList.contains('mode-analytics')`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.analytics-month-card').length`), 2);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#analytics-grid .analytics-day:not(.analytics-day-empty)').length`), new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate());
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#analytics-grid-next .analytics-day:not(.analytics-day-empty)').length`), new Date(new Date().getFullYear(), new Date().getMonth() + 2, 0).getDate());
  assert.match(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.analytics-level-3')).backgroundColor`), /rgb|color/);
  await win.webContents.executeJavaScript(`document.querySelector('#analytics-expand').click()`);
  await waitFor(win, `document.body.classList.contains('mode-analytics-expanded')`);
  const analyticsBounds = await win.webContents.executeJavaScript(`(() => { const r=document.querySelector('#capsule').getBoundingClientRect(); return {width:r.width,height:r.height}; })()`);
  assert.equal(Math.round(analyticsBounds.width), 960);
  assert.equal(Math.round(analyticsBounds.height), 620);
  await win.webContents.executeJavaScript(`document.querySelector('#analytics-collapse').click()`);
  await waitFor(win, `document.body.classList.contains('mode-analytics')`);
  await win.webContents.executeJavaScript(`document.querySelector('#btn-collapse').click()`);
  await waitFor(win, `document.body.classList.contains('mode-pill')`);

  const shelfSmokePath = path.join(root, 'tests', 'fixtures', 'shelf-smoke.txt');
  fs.writeFileSync(shelfSmokePath, 'shelf smoke');
  await win.webContents.executeJavaScript(`window.api.addShelfPaths([${JSON.stringify(shelfSmokePath)}]).then(applyShelfData)`);
  await waitFor(win, `document.querySelector('#shelf-pill-badge').hidden === false`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#shelf-pill-count').textContent`), '1');
  await win.webContents.executeJavaScript(`document.querySelector('#shelf-pill-badge').click()`);
  await waitFor(win, `document.body.classList.contains('mode-shelf')`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.shelf-item').length`), 1);
  await win.webContents.executeJavaScript(`document.querySelector('#shelf-close').click()`);
  await waitFor(win, `document.body.classList.contains('mode-pill')`);

  // Régression Shelf : entrer dans la capsule ouvre la shelf, mais un
  // dragleave vers l'extérieur doit la refermer même si le drag a traversé
  // des enfants de la capsule.
  await win.webContents.executeJavaScript(`(() => {
    const dt={types:['text/uri-list'],files:[],getData:()=>''};
    const ev=new Event('dragenter',{bubbles:true,cancelable:true});
    Object.defineProperty(ev,'dataTransfer',{value:dt});
    document.querySelector('#capsule').dispatchEvent(ev);
  })()`);
  await waitFor(win, `document.body.classList.contains('mode-shelf')`);

  // Régression : le resize compact -> Shelf peut déclencher un mouseleave
  // synthétique. Il ne doit pas désactiver la fenêtre pendant le drag.
  await win.webContents.executeJavaScript(`(() => {
    const ev=new Event('mouseleave',{bubbles:false,cancelable:false});
    document.querySelector('#capsule').dispatchEvent(ev);
  })()`);
  assert.equal(await win.webContents.executeJavaScript(`shelfDragActive`), true);
  assert.equal(await win.webContents.executeJavaScript(`document.body.classList.contains('mode-shelf')`), true);

  await win.webContents.executeJavaScript(`(() => {
    const dt={types:['text/uri-list'],files:[],getData:()=>''};
    const ev=new Event('dragleave',{bubbles:true,cancelable:true});
    Object.defineProperties(ev,{dataTransfer:{value:dt},relatedTarget:{value:document.body}});
    document.querySelector('#capsule').dispatchEvent(ev);
  })()`);
  await waitFor(win, `document.body.classList.contains('mode-pill')`);

  // Régression Shelf : après un dépôt effectif, l'interface étendue se replie
  // quand les opérations asynchrones de sauvegarde sont terminées.
  await win.webContents.executeJavaScript(`(() => {
    const capsule=document.querySelector('#capsule');
    const dt={types:['text/uri-list'],files:[],getData:(type)=>type==='text/uri-list'?'https://example.com/smoke.png':''};
    const enter=new Event('dragenter',{bubbles:true,cancelable:true});
    Object.defineProperty(enter,'dataTransfer',{value:dt});
    capsule.dispatchEvent(enter);
    const drop=new Event('drop',{bubbles:true,cancelable:true});
    Object.defineProperty(drop,'dataTransfer',{value:dt});
    capsule.dispatchEvent(drop);
  })()`);
  await waitFor(win, `document.body.classList.contains('mode-pill')`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.shelf-item').length`), 2);

  // La zone cliquable de l'accès Shelf reste discrète visuellement mais est
  // volontairement plus large que l'icône elle-même.
  await win.webContents.executeJavaScript(`document.querySelector('#capsule').dispatchEvent(new MouseEvent('mouseenter'))`);
  await waitFor(win, `document.body.classList.contains('mode-hover')`);
  const shelfHitbox = await win.webContents.executeJavaScript(`(() => { const r=document.querySelector('#shelf-hover-shortcut').getBoundingClientRect(); return {width:r.width,height:r.height}; })()`);
  assert.ok(shelfHitbox.width >= 40 && shelfHitbox.height >= 32);
  await win.webContents.executeJavaScript(`document.querySelector('#capsule').dispatchEvent(new MouseEvent('mouseleave'))`);
  await waitFor(win, `document.body.classList.contains('mode-pill')`);

  await win.webContents.executeJavaScript(`document.querySelector('#shelf-pill-badge').click()`);
  await waitFor(win, `document.body.classList.contains('mode-shelf')`);
  await win.webContents.executeJavaScript(`window.api.startShelfDrag(['shelf-1'])`);
  assert.deepEqual(shelfDragRequests.at(-1), ['shelf-1']);
  await win.webContents.executeJavaScript(`document.querySelector('#shelf-clear').click()`);
  await waitFor(win, `document.querySelector('#shelf-pill-badge').hidden === true`);
  await win.webContents.executeJavaScript(`document.querySelector('#shelf-close').click()`);
  await waitFor(win, `document.body.classList.contains('mode-pill')`);
  fs.rmSync(shelfSmokePath, { force:true });

  // Connection notification regression: a new audio device temporarily takes
  // priority over the expanded media panel, then restores it after 3 seconds.
  win.webContents.send('media-updated', {
    available:true, playing:true, isPlaying:true, title:'Smoke track', artist:'Smoke artist',
    album:'Smoke album', albumArtist:'Smoke artist', trackNumber:1, duration:180, position:10,
    canPlay:true, canPause:true, canTogglePlayPause:true, canNext:true, canPrevious:true, canSeek:true,
    artworkUrl:null, artworkResolved:false, sourceApp:'SmokePlayer'
  });
  await waitFor(win, `document.body.dataset.mediaState === 'compact'`);
  await win.webContents.executeJavaScript(`document.querySelector('#media-compact').click()`);
  await waitFor(win, `document.body.dataset.mediaState === 'expanded'`);
  win.webContents.send('audio-accessory-updated', { connected:true, name:'Smoke Headphones', batteryPercent:73, deviceType:'headphones' });
  await waitFor(win, `document.body.dataset.accessoryState === 'visible' && document.body.dataset.mediaState === 'compact'`);
  await new Promise((resolve) => setTimeout(resolve, 3050));
  assert.equal(await win.webContents.executeJavaScript(`document.body.dataset.accessoryState`), 'hidden');
  assert.equal(await win.webContents.executeJavaScript(`document.body.dataset.mediaState`), 'expanded');

  await win.webContents.executeJavaScript(`document.querySelector('[data-tab="schedule"]').click()`);
  // Calendrier réduit par défaut : Mois/Jour seuls, sans le panneau des tâches.
  await waitFor(win, `document.body.classList.contains('mode-expanded')`);
  assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.tasks-pane')).display`), 'none');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.month-day').length`), 42);
  await win.webContents.executeJavaScript(`document.querySelector('#calendar-expand').click()`);
  await waitFor(win, `document.body.classList.contains('mode-schedule')`);
  assert.notEqual(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.tasks-pane')).display`), 'none');

  // Régression : si Emploi du temps est l'onglet courant, réduire puis rouvrir
  // la bulle doit revenir directement au calendrier, sans second clic.
  await win.webContents.executeJavaScript(`document.querySelector('#btn-collapse').click()`);
  await waitFor(win, `document.body.classList.contains('mode-pill')`);
  await win.webContents.executeJavaScript(`document.querySelector('#view-pill').click()`);
  await waitFor(win, `document.body.classList.contains('mode-schedule')`);

  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const slots = [['080000','100000','Mathématiques'],['083000','093000','Rendez-vous'],['084500','101500','Option sciences'],['110000','120000','Anglais'],['130000','140000','Histoire'],['150000','160000','Espagnol']];
  const bodies = slots.map(([start,end,title], index) => `BEGIN:VEVENT\r\nUID:smoke-${index}\r\nDTSTART;TZID=Europe/Paris:${ymd}T${start}\r\nDTEND;TZID=Europe/Paris:${ymd}T${end}\r\nSUMMARY:${title}\r\n${index === 0 ? 'DESCRIPTION:Professeur: M. Dupont\nSalle: B204\r\nLOCATION:Lycée\r\n' : ''}END:VEVENT`).join('\r\n');
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:Europe/Paris\r\n${bodies}\r\nEND:VCALENDAR`;
  const secondIcs = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:Europe/Paris\r\nBEGIN:VEVENT\r\nUID:smoke-extra\r\nDTSTART;TZID=Europe/Paris:${ymd}T160000\r\nDTEND;TZID=Europe/Paris:${ymd}T170000\r\nSUMMARY:Musique\r\nEND:VEVENT\r\nEND:VCALENDAR`;

  await win.webContents.executeJavaScript(`document.querySelector('#btn-settings').click()`);
  await waitFor(win, `document.body.classList.contains('mode-settings')`);
  async function importSettingsCalendar(contents, name) {
    const url = `https://smoke.test/${name}`;
    icalFeeds[url] = contents;
    await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#calendar-settings-url'); input.value = ${JSON.stringify(url)}; document.querySelector('#calendar-settings-add').click(); })()`);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !(calendarSources.length >= (name === 'emploi-du-temps.ics' ? 1 : 2) && calendarSources.every((source) => source.events.length))) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await importSettingsCalendar(ics, 'emploi-du-temps.ics');
  await importSettingsCalendar(secondIcs, 'agenda-perso.ics');
  assert.equal(calendarSources.length, 2);
  assert.equal(calendarSources[0].enabled, true);
  assert.equal(calendarSources[1].enabled, true);
  assert.equal(calendarSources.reduce((sum, source) => sum + source.events.length, 0), 7);
  await win.webContents.executeJavaScript(`document.querySelectorAll('.calendar-source-switch input')[1].click()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calendarSources[1].enabled, false);
  await win.webContents.executeJavaScript(`document.querySelector('#btn-close-settings').click()`);
  await waitFor(win, `document.body.classList.contains('mode-schedule')`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-tab="schedule"]').click()`);
  await waitFor(win, `document.querySelector('.month-view')`);
  const importDeadline = Date.now() + 6000;
  while ((calendarSources[0]?.events.length || 0) !== 6 && Date.now() < importDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(calendarSources[0].events.length, 6);
  await waitFor(win, `document.querySelector('.month-more')?.textContent.includes('4')`);
  assert.equal(calendarSources[0].events[0].title, 'Mathématiques');
  assert.equal(calendarSources[0].events[0].professor, 'M. Dupont');
  assert.equal(calendarSources[0].events[0].room, 'B204');
  assert.equal(calendarSources[0].events[0].start.hour, 8);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.month-item.event').length`), 6);
  const crowded = await win.webContents.executeJavaScript(`(() => { const more=document.querySelector('.month-more'); const day=more.closest('.month-day'); const a=more.getBoundingClientRect(), b=day.getBoundingClientRect(); return {text:more.textContent, visible:a.bottom<=b.bottom && a.top>=b.top}; })()`);
  assert.equal(crowded.text, '+ 4 autres'); assert.equal(crowded.visible, true);
  await win.webContents.executeJavaScript(`document.querySelector('#btn-settings').click()`);
  await waitFor(win, `document.body.classList.contains('mode-settings')`);
  await win.webContents.executeJavaScript(`document.querySelectorAll('.calendar-source-switch input')[1].click()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calendarSources[1].enabled, true);
  await win.webContents.executeJavaScript(`document.querySelector('#btn-close-settings').click()`);
  await waitFor(win, `document.body.classList.contains('mode-schedule')`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.month-item.event').length`), 7);
  await win.webContents.executeJavaScript(`document.querySelector('.month-item.event').click()`);
  await waitFor(win, `!document.querySelector('#event-backdrop').hidden`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#event-sheet-title').textContent`), 'Mathématiques');
  await win.webContents.executeJavaScript(`document.querySelector('#event-close').click()`);

  await win.webContents.executeJavaScript(`document.querySelector('#calendar-view-switch [data-view="day"]').click()`);
  await waitFor(win, `document.querySelector('.timeline')`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.timeline-hour').length`), 24);
  const dayLayout = await win.webContents.executeJavaScript(`({scrollTop:document.querySelector('.timeline-scroll').scrollTop, client:document.querySelector('.timeline-scroll').clientHeight, full:document.querySelector('.timeline-scroll').scrollHeight, stageClient:document.querySelector('#calendar-stage').clientHeight, stageFull:document.querySelector('#calendar-stage').scrollHeight, strip:document.querySelector('.all-day-strip').getBoundingClientRect().height})`);
  assert.ok(dayLayout.scrollTop > 0); assert.ok(dayLayout.full > dayLayout.client); assert.equal(dayLayout.stageFull, dayLayout.stageClient); assert.ok(dayLayout.strip > 0);

  await win.webContents.executeJavaScript(`
    document.querySelector('#task-add').click();
    document.querySelector('#task-quick-title').value='Réviser maths';
    document.querySelector('#task-quick-title').dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#task-quick-form').requestSubmit();
  `);
  await waitFor(win, `document.querySelector('.task-card h3')?.textContent === 'Réviser maths'`);
  assert.equal(tasks[0].durationMinutes, 25);
  await win.webContents.executeJavaScript(`
    document.querySelector('.task-edit').click();
    document.querySelector('#task-duration').value='90';
    document.querySelector('#task-time').value='08:50';
    document.querySelector('#task-form').requestSubmit();
  `);
  await waitFor(win, `document.querySelector('.timeline-item.task')`);
  assert.equal(tasks[0].durationMinutes, 90);
  assert.equal(await win.webContents.executeJavaScript(`Math.round(parseFloat(document.querySelector('.timeline-item.task').style.height))`), 96);
  const collision = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.timeline-item')].filter((node)=>parseFloat(node.style.top)<700).map((node)=>node.style.left)`);
  assert.equal(new Set(collision).size, 4);
  await win.webContents.executeJavaScript(`document.querySelector('.task-check').click()`);
  await waitFor(win, `document.querySelector('.task-card').classList.contains('completed')`);
  assert.equal(tasks[0].completed, true);
  await win.webContents.executeJavaScript(`document.querySelector('.task-edit').click(); document.querySelector('#task-title').value='Réviser algèbre'; document.querySelector('#task-form').requestSubmit()`);
  await waitFor(win, `document.querySelector('.task-card h3')?.textContent === 'Réviser algèbre'`);
  assert.equal(tasks[0].title, 'Réviser algèbre');
  if (process.env.NOTCH_CAPTURE_PLANNER) {
    const captureState = await win.webContents.executeJavaScript(`({mode:document.body.className, capsule:[document.querySelector('#capsule').offsetWidth,document.querySelector('#capsule').offsetHeight]})`);
    console.log('Capture planner:', captureState);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(process.env.NOTCH_CAPTURE_PLANNER), { recursive:true });
    fs.writeFileSync(process.env.NOTCH_CAPTURE_PLANNER, image.toPNG());
  }
  await win.webContents.executeJavaScript(`document.querySelector('.task-edit').click(); document.querySelector('#task-delete').click()`);
  await waitFor(win, `!document.querySelector('.task-card')`);
  assert.equal(tasks.length, 0);

  await win.webContents.executeJavaScript(`document.querySelector('#calendar-view-switch [data-view="month"]').click()`);
  await waitFor(win, `document.querySelector('.month-item')`);
  const fonts = await win.webContents.executeJavaScript(`({toolbar:getComputedStyle(document.querySelector('.toolbar-btn')).fontFamily, chip:getComputedStyle(document.querySelector('.month-item')).fontSize, textarea:getComputedStyle(document.querySelector('#task-notes')).fontFamily})`);
  assert.match(fonts.toolbar, /Segoe UI/i); assert.equal(fonts.chip, '9.5px'); assert.match(fonts.textarea, /Segoe UI/i);

  win.setSize(768, 720); await waitFor(win, `innerWidth <= 780`);
  const focusLayout = await win.webContents.executeJavaScript(`(() => { const f=document.querySelector('.focus-fab').getBoundingClientRect(), s=document.querySelector('.schedule-shell').getBoundingClientRect(); return {focusTop:f.top, shellBottom:s.bottom, focusBottom:f.bottom, panelBottom:document.querySelector('.schedule-panel').getBoundingClientRect().bottom}; })()`);
  assert.ok(focusLayout.focusTop >= focusLayout.shellBottom); assert.ok(focusLayout.focusBottom <= focusLayout.panelBottom + 1);

  await win.webContents.executeJavaScript(`document.querySelector('#schedule-focus').click()`);
  await waitFor(win, `document.body.classList.contains('mode-running')`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-tab="pomodoro"]').classList.contains('active')`), true);

  win.setSize(380, 420);
  await waitFor(win, `innerWidth <= 400 && innerHeight <= 430`);
  await win.webContents.executeJavaScript(`document.querySelector('#btn-settings').click()`);
  await waitFor(win, `document.body.classList.contains('mode-settings')`);
  const layout = await win.webContents.executeJavaScript(`(() => { const scroll=document.querySelector('.settings-scroll'); const sound=document.querySelector('#s-soundEnabled'); sound.closest('.settings-row').scrollIntoView({block:'end'}); sound.click(); const a=sound.closest('.settings-row').getBoundingClientRect(), b=scroll.getBoundingClientRect(); return {capsule:document.querySelector('#capsule').getBoundingClientRect().height, viewport:innerHeight, overflow:getComputedStyle(scroll).overflowY, minHeight:getComputedStyle(scroll).minHeight, client:scroll.clientHeight, full:scroll.scrollHeight, lastVisible:a.bottom<=b.bottom+2 && a.top>=b.top-2, sound:sound.checked}; })()`);
  assert.ok(layout.capsule <= layout.viewport); assert.equal(layout.overflow, 'auto'); assert.equal(layout.minHeight, '0px'); assert.ok(layout.full > layout.client); assert.equal(layout.lastVisible, true); assert.equal(layout.sound, false);
  assert.deepEqual(errors, []);
  console.log('Electron smoke: multi-iCal, notification audio 3s, média, mois, jour, tâche CRUD, Focus et Paramètres OK');
  win.destroy(); app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
