'use strict';

/* Instantané des minuteurs, écrit juste avant l'installation d'une mise à jour et relu au
   redémarrage suivant. Le renderer est la source de vérité ; ce module ne fait que valider ce
   qui traverse l'IPC et le disque (types, bornes, un seul outil actif) et décider si
   l'instantané est encore frais. Usage unique : main.js le supprime dès qu'il est lu. */

const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000; // une installation lente reste couverte, un vieux fichier jamais
const PHASES = ['focus', 'short', 'long'];
const TOOLS = ['pomodoro', 'timer', 'stopwatch'];

function number(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startedAt = typeof raw.startedAt === 'string' && Number.isFinite(Date.parse(raw.startedAt)) ? raw.startedAt.slice(0, 40) : null;
  const durationSeconds = Math.round(number(raw.durationSeconds, 0, 24 * 3600, 0));
  if (!startedAt || !durationSeconds) return null;
  return {
    startedAt,
    startedAtMs: Math.round(number(raw.startedAtMs, 0, 8.64e15, Date.parse(startedAt))),
    durationSeconds,
    elapsedSeconds: number(raw.elapsedSeconds, 0, durationSeconds, 0),
  };
}

function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const p = raw.pomodoro;
  if (p && typeof p === 'object') {
    out.pomodoro = {
      phase: PHASES.includes(p.phase) ? p.phase : 'focus',
      remaining: Math.round(number(p.remaining, 0, 24 * 3600, 0)),
      running: p.running === true,
      count: Math.round(number(p.count, 0, 100000, 0)),
      session: sanitizeSession(p.session),
    };
  }
  const t = raw.timer;
  if (t && typeof t === 'object') {
    out.timer = {
      minutes: Math.round(number(t.minutes, 0, 180, 5)),
      seconds: Math.round(number(t.seconds, 0, 59, 0)),
      remaining: Math.round(number(t.remaining, 0, 180 * 60 + 59, 0)),
      running: t.running === true,
    };
  }
  const s = raw.stopwatch;
  if (s && typeof s === 'object') {
    out.stopwatch = {
      elapsedMs: Math.round(number(s.elapsedMs, 0, 1000 * 3600 * 1000, 0)),
      running: s.running === true,
    };
  }
  if (!out.pomodoro && !out.timer && !out.stopwatch) return null;
  // Un seul outil tourne à la fois (stopAllTools côté renderer) : on garde le premier.
  let runningSeen = false;
  for (const name of TOOLS) {
    if (!out[name] || !out[name].running) continue;
    if (runningSeen) out[name].running = false;
    else runningSeen = true;
  }
  return out;
}

function isSnapshotFresh(saved, now = Date.now()) {
  if (!saved || typeof saved !== 'object') return false;
  const age = now - Number(saved.savedAt);
  return Number.isFinite(age) && age >= 0 && age <= SNAPSHOT_MAX_AGE_MS;
}

module.exports = { sanitizeSnapshot, isSnapshotFresh, SNAPSHOT_MAX_AGE_MS };
