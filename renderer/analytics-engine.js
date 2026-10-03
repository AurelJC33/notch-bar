(function initAnalyticsEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AnalyticsEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const pad = (value) => String(value).padStart(2, '0');

  function monthKey(year, month) {
    return `${year}-${pad(month)}`;
  }

  function dayKeyFromDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function monthLabel(year, month, locale = 'en-GB') {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' })
      .format(new Date(year, month - 1, 1));
  }

  function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function normalizeSession(value) {
    if (!value || typeof value !== 'object') return null;
    const startedAt = new Date(value.startedAt);
    if (Number.isNaN(startedAt.getTime())) return null;
    const endedAt = new Date(value.endedAt || startedAt);
    const durationSeconds = Math.max(0, Math.min(24 * 60 * 60, Number(value.durationSeconds) || 0));
    if (!(durationSeconds > 0)) return null;
    const completed = value.completed === true;
    return {
      id: String(value.id || `${startedAt.getTime()}-${durationSeconds}`),
      startedAt: startedAt.toISOString(),
      endedAt: Number.isNaN(endedAt.getTime()) ? startedAt.toISOString() : endedAt.toISOString(),
      durationSeconds,
      completed,
      interrupted: !completed,
    };
  }

  function aggregateSessions(sessions = []) {
    const days = new Map();
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, seconds: 0, sessions: 0 }));

    for (const raw of Array.isArray(sessions) ? sessions : []) {
      const session = normalizeSession(raw);
      if (!session) continue;
      const start = new Date(session.startedAt);
      const key = dayKeyFromDate(start);
      if (!key) continue;
      if (!days.has(key)) days.set(key, { dateKey: key, seconds: 0, sessions: 0, completed: 0, interrupted: 0 });
      const day = days.get(key);
      day.seconds += session.durationSeconds;
      day.sessions += 1;
      if (session.completed) day.completed += 1;
      else day.interrupted += 1;

      const hour = start.getHours();
      hours[hour].seconds += session.durationSeconds;
      hours[hour].sessions += 1;
    }

    return { days, hours };
  }

  function activityLevel(day, maxScore = 0) {
    if (!day || !(day.seconds > 0)) return 0;
    const score = day.seconds / 60 + day.completed * 5 + day.interrupted * 2;
    if (!(maxScore > 0)) return 1;
    return Math.max(1, Math.min(5, Math.ceil((score / maxScore) * 5)));
  }

  function buildMonthGrid(year, month, sessions = []) {
    const totalDays = daysInMonth(year, month);
    const first = new Date(year, month - 1, 1);
    const leading = (first.getDay() + 6) % 7; // Monday-first.
    const weeks = Math.ceil((leading + totalDays) / 7);
    const { days } = aggregateSessions(sessions);
    const monthDays = [];
    let maxScore = 0;

    for (let day = 1; day <= totalDays; day += 1) {
      const date = new Date(year, month - 1, day);
      const key = dayKeyFromDate(date);
      const stats = days.get(key) || { dateKey: key, seconds: 0, sessions: 0, completed: 0, interrupted: 0 };
      const score = stats.seconds / 60 + stats.completed * 5 + stats.interrupted * 2;
      maxScore = Math.max(maxScore, score);
      monthDays.push({ ...stats, day, month, year, date });
    }

    const cells = Array.from({ length: weeks * 7 }, (_, index) => {
      const row = index % 7;
      const column = Math.floor(index / 7);
      const dayNumber = column * 7 + row - leading + 1;
      if (dayNumber < 1 || dayNumber > totalDays) return { row, column, empty: true };
      const day = monthDays[dayNumber - 1];
      return { row, column, empty: false, ...day, level: activityLevel(day, maxScore) };
    });

    return { year, month, totalDays, leading, weeks, cells, days: monthDays, maxScore };
  }

  function monthAnalytics(year, month, sessions = []) {
    const normalized = (Array.isArray(sessions) ? sessions : [])
      .map(normalizeSession)
      .filter(Boolean)
      .filter((session) => {
        const date = new Date(session.startedAt);
        return date.getFullYear() === year && date.getMonth() + 1 === month;
      });

    const { days, hours } = aggregateSessions(normalized);
    const grid = buildMonthGrid(year, month, normalized);
    const totalSeconds = normalized.reduce((sum, session) => sum + session.durationSeconds, 0);
    const completed = normalized.filter((session) => session.completed).length;
    const interrupted = normalized.length - completed;
    const activeDayCount = [...days.values()].filter((day) => day.seconds > 0).length;

    let mostProductiveDay = null;
    for (const day of grid.days) {
      if (!mostProductiveDay || day.seconds > mostProductiveDay.seconds) mostProductiveDay = day;
    }
    if (!mostProductiveDay || mostProductiveDay.seconds <= 0) mostProductiveDay = null;

    let bestHour = null;
    for (const entry of hours) {
      if (entry.seconds <= 0) continue;
      if (!bestHour || entry.seconds > bestHour.seconds) bestHour = entry;
    }

    return {
      year,
      month,
      label: monthLabel(year, month),
      daysInMonth: grid.totalDays,
      grid,
      totalSeconds,
      totalSessions: normalized.length,
      completedSessions: completed,
      interruptedSessions: interrupted,
      averageSessionSeconds: normalized.length ? totalSeconds / normalized.length : 0,
      dailyAverageSeconds: grid.totalDays ? totalSeconds / grid.totalDays : 0,
      activeDayCount,
      mostProductiveDay,
      bestHour,
      days: grid.days,
      hours,
    };
  }

  return {
    monthKey,
    dayKeyFromDate,
    monthLabel,
    daysInMonth,
    normalizeSession,
    aggregateSessions,
    activityLevel,
    buildMonthGrid,
    monthAnalytics,
  };
});
