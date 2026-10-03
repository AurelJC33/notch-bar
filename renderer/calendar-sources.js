const DEFAULT_CALENDAR_COLORS = [
  '#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#5e5ce6',
];

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function normalizeCalendarColor(value, index = 0) {
  const color = String(value || '').trim();
  return HEX_COLOR_RE.test(color) ? color.toLowerCase() : DEFAULT_CALENDAR_COLORS[index % DEFAULT_CALENDAR_COLORS.length];
}


export function normalizeCalendarUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'webcal:') {
      return new URL(`https://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`).href;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function mergeEnabledCalendarEvents(sources) {
  return (Array.isArray(sources) ? sources : [])
    .filter((source) => source?.enabled !== false)
    .flatMap((source) => Array.isArray(source.events) ? source.events : []);
}

export function normalizeCalendarSource(source, index = 0) {
  const id = String(source?.id || `calendar-${index + 1}`);
  const meta = source?.meta && typeof source.meta === 'object' ? source.meta : {};
  const name = String(source?.name || meta.sourceName || 'Calendar');
  const color = normalizeCalendarColor(source?.color, index);
  const url = normalizeCalendarUrl(source?.url || meta.sourceUrl);
  const events = Array.isArray(source?.events) ? source.events.map((event) => ({
    ...event,
    sourceId: id,
    sourceName: name,
    sourceColor: color,
  })) : [];
  return {
    id,
    name,
    color,
    enabled: source?.enabled !== false,
    url,
    events,
    meta,
  };
}
