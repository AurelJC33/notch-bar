import ICAL from './vendor/ical.js';

const pad = (value) => String(value).padStart(2, '0');

export function wallKey(wall) {
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

export function wallTime(wall) {
  return `${pad(wall.hour || 0)}:${pad(wall.minute || 0)}`;
}

function wallFromIcal(time) {
  return {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.isDate ? 0 : time.hour,
    minute: time.isDate ? 0 : time.minute,
    second: time.isDate ? 0 : time.second,
  };
}

function partsInZone(epochMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(epochMs))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

export function wallToEpoch(wall, timeZone) {
  if (!timeZone || timeZone === 'floating') return null;
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC' || timeZone === 'Z') {
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour || 0, wall.minute || 0, wall.second || 0);
  }
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour || 0, wall.minute || 0, wall.second || 0);
  let guess = target;
  try {
    for (let index = 0; index < 4; index += 1) {
      const seen = partsInZone(guess, timeZone);
      const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
      const delta = target - seenUtc;
      if (!delta) break;
      guess += delta;
    }
    return guess;
  } catch {
    return null;
  }
}

function timeZoneId(component, propertyName, time) {
  const property = component.getFirstProperty(propertyName);
  const explicit = property && property.getParameter('tzid');
  if (explicit) return String(explicit);
  if (time && time.zone && time.zone.tzid === 'UTC') return 'UTC';
  return 'floating';
}

function displayWall(time, sourceZone, displayZone) {
  const sourceWall = wallFromIcal(time);
  if (time.isDate || sourceZone === 'floating' || sourceZone === displayZone) return sourceWall;
  let instantMs = null;
  try {
    if (sourceZone === 'UTC' || (time.zone && time.zone.tzid === 'UTC')) instantMs = time.toUnixTime() * 1000;
    else if (ICAL.TimezoneService.has(sourceZone)) instantMs = time.toUnixTime() * 1000;
  } catch { /* Intl fallback below */ }
  if (instantMs === null) instantMs = wallToEpoch(sourceWall, sourceZone);
  if (instantMs === null) return sourceWall;
  try { return partsInZone(instantMs, displayZone); } catch { return sourceWall; }
}

function plainValue(component, name) {
  const value = component.getFirstPropertyValue(name);
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
}

function propertyValues(component, name) {
  return component.getAllProperties(name).map((property) => {
    const value = property.getFirstValue();
    return value && typeof value.toString === 'function' ? value.toString() : String(value || '');
  }).filter(Boolean);
}

function labeled(description, labels) {
  for (const label of labels) {
    const match = description.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:：-]\\s*([^\\n]+)`, 'i'));
    if (match) return match[1].trim();
  }
  return '';
}

function firstCustom(component, names) {
  for (const name of names) {
    const value = plainValue(component, name);
    if (value) return value;
  }
  return '';
}

function eventMetadata(component) {
  const description = plainValue(component, 'description');
  const location = plainValue(component, 'location');
  const room = firstCustom(component, ['x-room', 'x-salle', 'x-location-room'])
    || labeled(description, ['Salle', 'Room'])
    || labeled(location, ['Salle', 'Room']);
  const professor = firstCustom(component, ['x-professor', 'x-teacher', 'x-enseignant', 'x-professeur'])
    || labeled(description, ['Professeur', 'Enseignant', 'Teacher']);
  const xProperties = {};
  component.getAllProperties().forEach((property) => {
    const name = property.name;
    if (!name.startsWith('x-') || ['x-room', 'x-salle', 'x-location-room', 'x-professor', 'x-teacher', 'x-enseignant', 'x-professeur'].includes(name)) return;
    const value = property.getFirstValue();
    xProperties[name.toUpperCase()] = value && value.toString ? value.toString() : String(value || '');
  });
  return {
    title: plainValue(component, 'summary') || 'Untitled',
    description,
    professor,
    room,
    location,
    organizer: plainValue(component, 'organizer'),
    attendees: propertyValues(component, 'attendee'),
    categories: propertyValues(component, 'categories').flatMap((value) => value.split(',').map((item) => item.trim()).filter(Boolean)),
    url: plainValue(component, 'url'),
    status: plainValue(component, 'status'),
    xProperties,
  };
}

function normalizeOccurrence(master, item, start, end, recurrenceId, displayZone) {
  const component = item.component;
  const startZone = timeZoneId(component, 'dtstart', start);
  const endZone = timeZoneId(component, 'dtend', end) === 'floating' ? startZone : timeZoneId(component, 'dtend', end);
  const sourceStart = wallFromIcal(start);
  const sourceEnd = wallFromIcal(end);
  const shownStart = displayWall(start, startZone, displayZone);
  const shownEnd = displayWall(end, endZone, displayZone);
  return {
    id: `${master.uid || plainValue(component, 'uid') || 'event'}::${recurrenceId}`,
    uid: master.uid || plainValue(component, 'uid'),
    recurrenceId,
    ...eventMetadata(component),
    allDay: !!start.isDate,
    timezone: startZone,
    displayTimezone: displayZone,
    sourceStart,
    sourceEnd,
    start: shownStart,
    end: shownEnd,
    dateKey: wallKey(shownStart),
    startInstant: start.isDate ? null : wallToEpoch(sourceStart, startZone),
    endInstant: end.isDate ? null : wallToEpoch(sourceEnd, endZone),
  };
}

export function parseIcs(text, options = {}) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) throw new Error('Ce fichier ne contient pas de calendrier iCalendar valide.');
  const root = new ICAL.Component(ICAL.parse(text));
  root.getAllSubcomponents('vtimezone').forEach((zone) => {
    try { ICAL.TimezoneService.register(zone); } catch { /* malformed zones are reported by event fallback */ }
  });
  const systemZone = options.systemTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris';
  const displayZone = plainValue(root, 'x-wr-timezone') || systemZone;
  const now = options.now ? new Date(options.now) : new Date();
  const horizonStart = new Date(now.getFullYear() - 1, 0, 1);
  const horizonEnd = new Date(now.getFullYear() + 4, 0, 1);
  const components = root.getAllSubcomponents('vevent');
  const masters = components.filter((component) => !component.hasProperty('recurrence-id'));
  const events = [];
  const warnings = [];

  for (const component of masters) {
    try {
      const master = new ICAL.Event(component);
      if (!component.hasProperty('rrule') && !component.hasProperty('rdate')) {
        events.push(normalizeOccurrence(master, master, master.startDate, master.endDate, master.startDate.toString(), displayZone));
        continue;
      }
      const iterator = master.iterator();
      let count = 0;
      let next;
      while ((next = iterator.next()) && count < 5000) {
        count += 1;
        const occurrenceEpoch = wallToEpoch(wallFromIcal(next), timeZoneId(component, 'dtstart', next));
        if (occurrenceEpoch !== null && occurrenceEpoch >= horizonEnd.getTime()) break;
        if (occurrenceEpoch !== null && occurrenceEpoch < horizonStart.getTime()) continue;
        const details = master.getOccurrenceDetails(next);
        events.push(normalizeOccurrence(master, details.item, details.startDate, details.endDate, details.recurrenceId.toString(), displayZone));
      }
      if (count >= 5000) warnings.push(`The series “${master.summary || 'Untitled'}” was limited to 5,000 occurrences.`);
    } catch (error) {
      warnings.push(`Event skipped: ${error.message}`);
    }
  }

  const deduped = [...new Map(events.map((event) => [event.id, event])).values()]
    .sort((a, b) => `${a.dateKey}${wallTime(a.start)}`.localeCompare(`${b.dateKey}${wallTime(b.start)}`));
  return {
    events: deduped,
    meta: { displayTimezone: displayZone, importedAt: new Date().toISOString(), sourceEventCount: components.length },
    warnings,
  };
}

export const CalendarEngine = { parseIcs, wallToEpoch, wallKey, wallTime };
if (typeof window !== 'undefined') window.CalendarEngine = CalendarEngine;
