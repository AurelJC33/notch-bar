const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const ALLOWED_COMMANDS = new Set(['playPause', 'play', 'pause', 'next', 'previous', 'seek']);

function normalizeBoolean(value) {
  return value === true;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeState(raw) {
  if (!raw || raw.available !== true) {
    return {
      available: false,
      playing: false,
      isPlaying: false,
      title: '', artist: '', album: '', albumArtist: '', subtitle: '',
      artworkUrl: null, cover: '', artworkResolved: false, sourceApp: null, source: '', playbackStatus: 'Closed',
      playbackType: '', position: 0, duration: 0, positionSeconds: 0, durationSeconds: 0,
      timelineUpdatedAtMs: Date.now(), canPlay: false, canPause: false,
      canTogglePlayPause: false, canNext: false, canPrevious: false, canSeek: false,
    };
  }

  const position = Math.max(0, normalizeNumber(raw.position ?? raw.positionSeconds));
  const duration = Math.max(0, normalizeNumber(raw.duration ?? raw.durationSeconds));
  const artworkUrl = typeof raw.artworkUrl === 'string' && raw.artworkUrl ? raw.artworkUrl
    : (typeof raw.cover === 'string' && raw.cover ? raw.cover : null);
  const sourceApp = typeof raw.sourceApp === 'string' && raw.sourceApp ? raw.sourceApp
    : (typeof raw.source === 'string' && raw.source ? raw.source : null);
  const playing = normalizeBoolean(raw.playing ?? raw.isPlaying);

  return {
    available: true,
    playing,
    isPlaying: playing,
    title: String(raw.title || ''),
    artist: String(raw.artist || ''),
    album: String(raw.album || ''),
    albumArtist: String(raw.albumArtist || ''),
    subtitle: String(raw.subtitle || ''),
    trackNumber: Math.max(0, Math.trunc(normalizeNumber(raw.trackNumber))),
    artworkUrl,
    cover: artworkUrl || '',
    artworkResolved: raw.artworkResolved === true,
    sourceApp,
    source: sourceApp || '',
    playbackStatus: String(raw.playbackStatus || (playing ? 'Playing' : 'Paused')),
    playbackType: String(raw.playbackType || ''),
    position,
    duration,
    positionSeconds: position,
    durationSeconds: duration,
    timelineUpdatedAtMs: normalizeNumber(raw.timelineUpdatedAtMs) || Date.now(),
    canPlay: normalizeBoolean(raw.canPlay),
    canPause: normalizeBoolean(raw.canPause),
    canTogglePlayPause: normalizeBoolean(raw.canTogglePlayPause),
    canNext: normalizeBoolean(raw.canNext),
    canPrevious: normalizeBoolean(raw.canPrevious),
    canSeek: normalizeBoolean(raw.canSeek),
  };
}

function stateIdentity(state) {
  if (!state || !state.available) return '';
  return [
    state.sourceApp || state.source || '',
    state.title || '',
    state.artist || '',
    state.album || '',
    state.albumArtist || '',
    state.trackNumber ?? '',
  ].join('\u001f');
}

function reconcileState(previous, incoming) {
  const next = { ...incoming };
  if (previous?.available && next.available && stateIdentity(previous) === stateIdentity(next)
    && !next.artworkUrl && previous.artworkUrl) {
    next.artworkUrl = previous.artworkUrl;
    next.cover = previous.cover || previous.artworkUrl;
    next.artworkResolved = previous.artworkResolved;
  }
  return next;
}

function mediaPresentationKey(state) {
  if (!state?.available) return 'unavailable';
  return [
    'available', state.playing, stateIdentity(state), state.artworkUrl || '', state.artworkResolved,
    state.canPlay, state.canPause, state.canTogglePlayPause, state.canNext, state.canPrevious, state.canSeek,
  ].join('\u001f');
}

function shouldEmitMediaUpdate(previous, next) {
  return mediaPresentationKey(previous) !== mediaPresentationKey(next);
}

class WindowsMediaService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.scriptPath = options.scriptPath || path.join(__dirname, 'media-service.ps1');
    this.child = null;
    this.state = normalizeState(null);
    this.lastEmittedState = normalizeState(null);
    this.pending = new Map();
    this.sequence = 0;
    this.stopping = false;
    this.restartTimer = null;
    this.restartDelay = 900;
    // Some desktop players (notably Deezer) temporarily remove or stop their
    // GSMTC session while advancing to the next track. Keep the last valid
    // state visible long enough for the replacement session/metadata to appear.
    this.transientUnavailableGraceMs = 5000;
    this.unavailableTimer = null;
    this.unavailableSince = 0;
    this.transitionHoldUntil = 0;
    this.transitionFromIdentity = '';
    this.refreshBurstTimers = new Set();
  }

  start() {
    if (process.platform !== 'win32' || this.child || this.stopping) return;
    this.#spawn();
  }

  #spawn() {
    if (this.stopping || process.platform !== 'win32') return;
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-Sta', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.#onLine(line));
    child.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message) this.emit('diagnostic', { level: 'warn', message });
    });
    child.on('error', (error) => {
      this.emit('diagnostic', { level: 'error', message: `media service error: ${error.message}` });
    });
    child.on('close', (code) => {
      rl.close();
      if (this.child === child) this.child = null;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error: 'media-service-closed' });
      }
      this.pending.clear();

      if (!this.stopping) {
        this.#publishState(normalizeState(null));
        this.emit('diagnostic', { level: 'warn', message: `media service exited (${code}); restarting` });
        clearTimeout(this.restartTimer);
        clearTimeout(this.unavailableTimer);
        this.unavailableTimer = null;
        this.unavailableSince = 0;
        this.transitionHoldUntil = 0;
        this.transitionFromIdentity = '';
        for (const timer of this.refreshBurstTimers) clearTimeout(timer);
        this.refreshBurstTimers.clear();
        this.restartTimer = setTimeout(() => this.#spawn(), this.restartDelay);
      }
    });
  }

  #onLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.emit('diagnostic', { level: 'debug', message: `ignored media output: ${trimmed.slice(0, 220)}` });
      return;
    }

    if (message.type === 'state') {
      const nextState = normalizeState(message.state);

      // GSMTC can briefly report no eligible session while an app is
      // switching tracks (Playing -> Changing -> Playing). Hiding the UI on
      // that transient frame makes the companion notch blink/disappear even
      // though playback immediately continues. Keep the last valid state for
      // a short grace period; any fresh available state cancels the hide.
      if (!nextState.available && this.state.available) {
        // Do not blink the media notch during a track hand-off. Deezer can
        // expose no eligible GSMTC session for a couple of seconds between
        // tracks, especially when WinRT events are unavailable and we are
        // polling. Start the grace window only once so repeated `unavailable`
        // frames cannot keep extending it forever. A manual Next/Previous gets
        // a slightly longer hold window.
        if (!this.unavailableSince) this.unavailableSince = Date.now();
        const genericDeadline = this.unavailableSince + this.transientUnavailableGraceMs;
        const deadline = Math.max(genericDeadline, this.transitionHoldUntil || 0);
        const delay = Math.max(0, deadline - Date.now());
        if (!this.unavailableTimer) {
          this.unavailableTimer = setTimeout(() => {
            this.unavailableTimer = null;
            this.unavailableSince = 0;
            this.transitionHoldUntil = 0;
            this.transitionFromIdentity = '';
            this.#publishState(nextState);
          }, delay);
        }
        return;
      }

      clearTimeout(this.unavailableTimer);
      this.unavailableTimer = null;
      this.unavailableSince = 0;

      if (nextState.available && this.transitionHoldUntil) {
        const nextIdentity = this.#stateIdentity(nextState);
        if (nextIdentity && nextIdentity !== this.transitionFromIdentity) {
          this.transitionHoldUntil = 0;
          this.transitionFromIdentity = '';
        }
      }

      // During a track hand-off some apps expose the session as Changing
      // before the new media properties are populated. Preserve the previous
      // textual metadata/artwork for that short state so the panel morphs
      // directly from old track to new track instead of flashing empty text.
      if (nextState.available && nextState.playbackStatus === 'Changing' && this.state.available) {
        if (!nextState.title) nextState.title = this.state.title;
        if (!nextState.artist) nextState.artist = this.state.artist;
        if (!nextState.album) nextState.album = this.state.album;
        if (!nextState.artworkUrl && this.state.artworkUrl) {
          nextState.artworkUrl = this.state.artworkUrl;
          nextState.cover = this.state.cover || this.state.artworkUrl;
          nextState.artworkResolved = false;
        }
      }

      this.#publishState(nextState);
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(String(message.id || ''));
      if (!pending) return;
      this.pending.delete(String(message.id || ''));
      clearTimeout(pending.timer);
      pending.resolve({ ok: message.ok === true, error: message.error || null });
      return;
    }
    if (message.type === 'diagnostic') {
      this.emit('diagnostic', {
        level: String(message.level || 'info'),
        message: String(message.message || ''),
      });
    }
  }

  #stateIdentity(state) {
    return stateIdentity(state);
  }

  #publishState(incoming) {
    this.state = reconcileState(this.state, incoming);
    if (!shouldEmitMediaUpdate(this.lastEmittedState, this.state)) return;
    this.lastEmittedState = this.state;
    this.emit('state', this.state);
  }

  #scheduleRefreshBurst() {
    // WinRT event subscription is unreliable in Windows PowerShell for these
    // GSMTC objects. After a skip, actively resample the manager for a few
    // seconds so the replacement track is discovered as soon as it exists.
    for (const delay of [120, 280, 500, 800, 1200, 1800, 2600, 3600, 5000]) {
      const timer = setTimeout(() => {
        this.refreshBurstTimers.delete(timer);
        this.refresh();
      }, delay);
      this.refreshBurstTimers.add(timer);
    }
  }

  command(command, payload = {}) {
    if (!ALLOWED_COMMANDS.has(command)) {
      return Promise.resolve({ ok: false, error: 'unsupported-command' });
    }
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      return Promise.resolve({ ok: false, error: 'media-service-unavailable' });
    }

    if (command === 'next' || command === 'previous') {
      this.transitionFromIdentity = this.#stateIdentity(this.state);
      this.transitionHoldUntil = Date.now() + 7000;
      this.#scheduleRefreshBurst();
    }

    const id = `m${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'media-command-timeout' });
      }, 4500);
      this.pending.set(id, { resolve, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ type: 'command', id, command, payload })}\n`, 'utf8');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: error.message });
      }
    });
  }

  refresh(options = {}) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) return;
    const reacquire = options && options.reacquire === true;
    try { this.child.stdin.write(`${JSON.stringify({ type: 'refresh', reacquire })}\n`, 'utf8'); } catch {}
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.unavailableTimer);
    this.unavailableTimer = null;
    this.unavailableSince = 0;
    this.transitionHoldUntil = 0;
    this.transitionFromIdentity = '';
    for (const timer of this.refreshBurstTimers) clearTimeout(timer);
    this.refreshBurstTimers.clear();
    if (!this.child) return;
    try { this.child.stdin.write('{"type":"shutdown"}\n', 'utf8'); } catch {}
    const child = this.child;
    setTimeout(() => {
      try { if (!child.killed) child.kill(); } catch {}
    }, 600);
  }
}

module.exports = { WindowsMediaService, normalizeState, reconcileState, shouldEmitMediaUpdate };
