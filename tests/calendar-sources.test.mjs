import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEnabledCalendarEvents, normalizeCalendarSource, normalizeCalendarUrl } from '../renderer/calendar-sources.js';

test('multiple iCal sources keep their events separate and merge when enabled', () => {
  const event = { id: 'same-uid', title: 'Cours', dateKey: '2026-09-30' };
  const first = normalizeCalendarSource({ id: 'school', name: 'École', enabled: true, events: [event] }, 0);
  const second = normalizeCalendarSource({ id: 'personal', name: 'Perso', enabled: true, events: [{ ...event, title: 'Rendez-vous' }] }, 1);

  const merged = mergeEnabledCalendarEvents([first, second]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].sourceId, 'school');
  assert.equal(merged[1].sourceId, 'personal');
  assert.deepEqual(merged.map((item) => item.title), ['Cours', 'Rendez-vous']);
});

test('disabling a calendar removes only its events from the active projection', () => {
  const first = normalizeCalendarSource({ id: 'school', enabled: true, events: [{ id: 'a', title: 'Cours' }] }, 0);
  const second = normalizeCalendarSource({ id: 'personal', enabled: false, events: [{ id: 'b', title: 'Rendez-vous' }] }, 1);

  const merged = mergeEnabledCalendarEvents([first, second]);
  assert.deepEqual(merged.map((item) => item.id), ['a']);
  assert.equal(second.events.length, 1);
});


test('calendar colors normalize and propagate to merged events', () => {
  const first = normalizeCalendarSource({ id: 'school', name: 'École', color: '#12AB34', events: [{ id: 'a' }] }, 0);
  const second = normalizeCalendarSource({ id: 'personal', name: 'Perso', color: 'invalid', events: [{ id: 'b' }] }, 1);

  assert.equal(first.color, '#12ab34');
  assert.equal(first.events[0].sourceColor, '#12ab34');
  assert.match(second.color, /^#[0-9a-f]{6}$/);
  assert.equal(second.events[0].sourceColor, second.color);
});


test('iCal URLs accept HTTP(S) and webcal links, while rejecting local or unsupported schemes', () => {
  assert.equal(normalizeCalendarUrl('https://example.com/calendar.ics'), 'https://example.com/calendar.ics');
  assert.equal(normalizeCalendarUrl('webcal://example.com/calendar.ics'), 'https://example.com/calendar.ics');
  assert.equal(normalizeCalendarUrl('file:///C:/calendar.ics'), '');
  assert.equal(normalizeCalendarUrl('javascript:alert(1)'), '');
});

test('remote calendar source keeps its normalized URL', () => {
  const source = normalizeCalendarSource({ id:'remote', url:'webcal://example.com/a.ics', meta:{ sourceUrl:'webcal://example.com/a.ics' } }, 0);
  assert.equal(source.url, 'https://example.com/a.ics');
  assert.equal(source.events.length, 0);
});
