import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, wallToEpoch } from '../renderer/calendar-engine.js';

function calendar(body, zone = 'Europe/Paris') {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Notch Tests//FR\r\nX-WR-TIMEZONE:${zone}\r\n${body}\r\nEND:VCALENDAR`;
}

function event(lines) { return `BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT`; }

test('Europe/Paris winter event keeps 08:00 wall time', () => {
  const result = parseIcs(calendar(event(['UID:winter','DTSTART;TZID=Europe/Paris:20260115T080000','DTEND;TZID=Europe/Paris:20260115T100000','SUMMARY:Mathématiques'])), { now:'2026-01-01', systemTimeZone:'Europe/Paris' });
  assert.equal(result.events[0].start.hour, 8);
  assert.equal(result.events[0].dateKey, '2026-01-15');
  assert.equal(result.events[0].startInstant, Date.UTC(2026, 0, 15, 7));
});

test('Europe/Paris summer event keeps 08:00 wall time', () => {
  const result = parseIcs(calendar(event(['UID:summer','DTSTART;TZID=Europe/Paris:20260715T080000','DTEND;TZID=Europe/Paris:20260715T100000','SUMMARY:Physique'])), { now:'2026-01-01', systemTimeZone:'Europe/Paris' });
  assert.equal(result.events[0].start.hour, 8);
  assert.equal(result.events[0].startInstant, Date.UTC(2026, 6, 15, 6));
});

test('wall-to-instant respects spring and autumn DST offsets', () => {
  assert.equal(wallToEpoch({year:2026,month:3,day:28,hour:8,minute:0,second:0}, 'Europe/Paris'), Date.UTC(2026,2,28,7));
  assert.equal(wallToEpoch({year:2026,month:3,day:30,hour:8,minute:0,second:0}, 'Europe/Paris'), Date.UTC(2026,2,30,6));
  assert.equal(wallToEpoch({year:2026,month:10,day:24,hour:8,minute:0,second:0}, 'Europe/Paris'), Date.UTC(2026,9,24,6));
  assert.equal(wallToEpoch({year:2026,month:10,day:26,hour:8,minute:0,second:0}, 'Europe/Paris'), Date.UTC(2026,9,26,7));
});

test('UTC event is converted into calendar display timezone', () => {
  const result = parseIcs(calendar(event(['UID:utc','DTSTART:20260329T060000Z','DTEND:20260329T070000Z','SUMMARY:Cours UTC'])), { now:'2026-01-01', systemTimeZone:'Europe/Paris' });
  assert.equal(result.events[0].start.hour, 8);
  assert.equal(result.events[0].end.hour, 9);
  assert.equal(result.events[0].timezone, 'UTC');
});

test('floating event remains at the written local time', () => {
  const result = parseIcs(calendar(event(['UID:floating','DTSTART:20260402T080000','DTEND:20260402T093000','SUMMARY:Espagnol'])), { now:'2026-01-01', systemTimeZone:'Europe/Paris' });
  assert.equal(result.events[0].start.hour, 8);
  assert.equal(result.events[0].timezone, 'floating');
});

test('course metadata is preserved and labeled fields are extracted', () => {
  const result = parseIcs(calendar(event([
    'UID:details','DTSTART;TZID=Europe/Paris:20260203T080000','DTEND;TZID=Europe/Paris:20260203T100000',
    'SUMMARY:Mathématiques','DESCRIPTION:Professeur: M. Dupont\\nSalle: B204\\nContrôle chapitre 2',
    'LOCATION:Bâtiment B','ORGANIZER:mailto:direction@example.test','ATTENDEE:mailto:eleve@example.test','CATEGORIES:Cours,Sciences','STATUS:CONFIRMED',
  ])), { now:'2026-01-01', systemTimeZone:'Europe/Paris' });
  const item = result.events[0];
  assert.equal(item.title, 'Mathématiques'); assert.equal(item.professor, 'M. Dupont'); assert.equal(item.room, 'B204');
  assert.equal(item.location, 'Bâtiment B'); assert.match(item.description, /Contrôle chapitre 2/); assert.equal(item.status, 'CONFIRMED');
});

test('RRULE is expanded in the bounded planning horizon', () => {
  const result = parseIcs(calendar(event(['UID:weekly','DTSTART;TZID=Europe/Paris:20260907T080000','DTEND;TZID=Europe/Paris:20260907T090000','RRULE:FREQ=WEEKLY;COUNT=3','SUMMARY:Anglais'])), { now:'2026-09-01', systemTimeZone:'Europe/Paris' });
  assert.deepEqual(result.events.map((item) => item.dateKey), ['2026-09-07','2026-09-14','2026-09-21']);
  assert.ok(result.events.every((item) => item.start.hour === 8));
});
