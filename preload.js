const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
  getWindowInputCapabilities: () => ipcRenderer.invoke('get-window-input-capabilities'),
  setInteractiveRegion: (rects) => ipcRenderer.send('set-interactive-region', rects),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  onSettingsUpdated: (callback) => {
    ipcRenderer.on('settings-updated', (event, settings) => callback(settings));
  },
  onWindowBlur: (callback) => {
    ipcRenderer.on('window-blurred', () => callback());
  },
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateState: (callback) => {
    ipcRenderer.on('update-state', (event, state) => callback(state));
  },
  getWeather: () => ipcRenderer.invoke('get-weather'),
  fetchICalUrl: (url) => ipcRenderer.invoke('fetch-ical-url', url),
  getMediaState: () => ipcRenderer.invoke('get-media-state'),
  getAudioAccessoryState: () => ipcRenderer.invoke('get-audio-accessory-state'),
  refreshMedia: () => ipcRenderer.invoke('refresh-media-state'),
  mediaCommand: (command, payload) => ipcRenderer.invoke('media-command', command, payload),
  onMediaUpdated: (callback) => {
    ipcRenderer.on('media-updated', (event, media) => callback(media));
  },
  onAudioAccessoryUpdated: (callback) => {
    ipcRenderer.on('audio-accessory-updated', (event, state) => callback(state));
  },
  getPlannerData: () => ipcRenderer.invoke('get-planner-data'),
  saveCalendarSources: (sources) => ipcRenderer.invoke('save-calendar-sources', sources),
  savePlannerTasks: (tasks) => ipcRenderer.invoke('save-planner-tasks', tasks),
  setWindowMode: (mode) => ipcRenderer.invoke('set-window-mode', mode),
  getShelfData: () => ipcRenderer.invoke('get-shelf-data'),
  addShelfPaths: (paths) => ipcRenderer.invoke('shelf-add-paths', paths),
  addShelfWebImage: (payload) => ipcRenderer.invoke('shelf-add-web-image', payload),
  addShelfWebBytes: (payload) => ipcRenderer.invoke('shelf-add-web-bytes', payload),
  removeShelfItem: (id) => ipcRenderer.invoke('shelf-remove', id),
  clearShelf: () => ipcRenderer.invoke('shelf-clear'),
  openShelfLocation: (id) => ipcRenderer.invoke('shelf-open-location', id),
  startShelfDrag: (ids) => ipcRenderer.send('shelf-start-drag', ids),
  getPomodoroAnalytics: () => ipcRenderer.invoke('get-pomodoro-analytics'),
  recordPomodoroSession: (session) => ipcRenderer.invoke('record-pomodoro-session', session),
  onPomodoroAnalyticsUpdated: (callback) => {
    ipcRenderer.on('pomodoro-analytics-updated', (event, session) => callback(session));
  },
  getClipboardHistory: () => ipcRenderer.invoke('get-clipboard-history'),
  copyClipboardHistoryItem: (id) => ipcRenderer.invoke('clipboard-history-copy', id),
  requestClipboardHistoryRefresh: () => ipcRenderer.send('clipboard-history-request-refresh'),
  onClipboardHistoryUpdated: (callback) => {
    ipcRenderer.on('clipboard-history-updated', (event, history) => callback(history));
  },
  onWeatherUpdated: (callback) => {
    ipcRenderer.on('weather-updated', (event, weather) => callback(weather));
  },
});
