(function initSoundEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SoundEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  /* Trois catégories, pour qu'on puisse couper le bruit d'interface sans perdre
     les alertes importantes. */
  const SOUND_CATEGORY = {
    tick: 'interface',
    reminder: 'notifications',
    connect: 'notifications',
    disconnect: 'notifications',
    timerDone: 'timers',
    pomoFocusEnd: 'timers',
    pomoBreakEnd: 'timers',
    updateAvailable: 'notifications',
  };

  const CATEGORY_SETTING = {
    interface: 'soundUi',
    notifications: 'soundNotifications',
    timers: 'soundTimers',
  };

  const SOUND_DEFAULTS = {
    soundEnabled: true,
    soundVolume: 60,           // 0-100
    soundUi: false,            // tick d'interface : opt-in
    soundNotifications: true,
    soundTimers: true,
    soundMuteWhenMedia: false, // « ne pas déranger » pendant la lecture média
  };

  // Niveau relatif par son : le tick reste bien en dessous des alertes.
  const SOUND_LEVEL = { tick: 0.35, updateAvailable: 0.7 };

  const MIN_REPLAY_MS = 80;

  function normalizeVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return SOUND_DEFAULTS.soundVolume;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  // Courbe quadratique : le curseur paraît plus linéaire à l'oreille et les
  // réglages bas restent vraiment discrets.
  function volumeToGain(value) {
    const v = normalizeVolume(value) / 100;
    return v * v;
  }

  function isOn(settings, key) {
    const value = settings ? settings[key] : undefined;
    return value === undefined ? SOUND_DEFAULTS[key] !== false : value !== false;
  }

  function shouldPlay(settings, name, context = {}) {
    const category = SOUND_CATEGORY[name];
    if (!category) return false;
    if (!isOn(settings, 'soundEnabled')) return false;
    if (normalizeVolume(settings && settings.soundVolume !== undefined ? settings.soundVolume : SOUND_DEFAULTS.soundVolume) === 0) return false;
    const categoryKey = CATEGORY_SETTING[category];
    const categoryOn = settings && settings[categoryKey] !== undefined
      ? settings[categoryKey] === true
      : SOUND_DEFAULTS[categoryKey] === true;
    if (!categoryOn) return false;
    const muteWhenMedia = settings && settings.soundMuteWhenMedia !== undefined
      ? settings.soundMuteWhenMedia === true
      : SOUND_DEFAULTS.soundMuteWhenMedia;
    if (muteWhenMedia && context.mediaPlaying) return false;
    return true;
  }

  function base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /* Lecteur : un AudioContext partagé, tous les sons décodés une seule fois au
     démarrage, un GainNode maître pour le volume. */
  function createSoundPlayer({ AudioContextClass, assets, getSettings, isMediaPlaying, now = () => Date.now() }) {
    let ctx = null;
    let master = null;
    const buffers = new Map();
    const lastPlayed = new Map();
    let preloadPromise = null;

    function ensureContext() {
      if (ctx) return ctx;
      if (!AudioContextClass) return null;
      ctx = new AudioContextClass();
      master = ctx.createGain();
      master.connect(ctx.destination);
      return ctx;
    }

    function preload() {
      if (preloadPromise) return preloadPromise;
      preloadPromise = (async () => {
        const audio = ensureContext();
        if (!audio || !assets) return;
        await Promise.all(Object.keys(assets).map(async (name) => {
          try {
            const decoded = await audio.decodeAudioData(base64ToArrayBuffer(assets[name]));
            buffers.set(name, decoded);
          } catch (error) {
            console.warn('[sound] décodage impossible :', name, error && error.message);
          }
        }));
      })();
      return preloadPromise;
    }

    function play(name, { force = false } = {}) {
      try {
        const settings = getSettings();
        const allowed = force
          ? isOn(settings, 'soundEnabled') && normalizeVolume(settings.soundVolume) > 0
          : shouldPlay(settings, name, { mediaPlaying: !!(isMediaPlaying && isMediaPlaying()) });
        if (!allowed) return false;
        const buffer = buffers.get(name);
        const audio = ensureContext();
        if (!buffer || !audio) return false;
        const t = now();
        if (t - (lastPlayed.get(name) || 0) < MIN_REPLAY_MS) return false;
        lastPlayed.set(name, t);
        if (audio.state === 'suspended') audio.resume().catch(() => {});
        master.gain.value = volumeToGain(settings.soundVolume);
        const source = audio.createBufferSource();
        source.buffer = buffer;
        const level = audio.createGain();
        level.gain.value = SOUND_LEVEL[name] ?? 1;
        source.connect(level);
        level.connect(master);
        source.start();
        return true;
      } catch (error) {
        return false; // silence si l'audio est indisponible
      }
    }

    return { preload, play };
  }

  return {
    SOUND_CATEGORY,
    SOUND_DEFAULTS,
    normalizeVolume,
    volumeToGain,
    shouldPlay,
    createSoundPlayer,
  };
});
