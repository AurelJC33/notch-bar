(function initDurationInput(root, factory) {
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
