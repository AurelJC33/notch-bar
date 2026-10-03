import test from 'node:test';
import assert from 'node:assert/strict';
import AnalyticsEngine from '../renderer/analytics-engine.js';

const { activityLevel, buildMonthGrid, monthAnalytics, monthLabel } = AnalyticsEngine;

const session = (day, hour, minutes, completed = true) => ({
  id: `${day}-${hour}-${minutes}-${completed}`,
  startedAt: `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`,
  endedAt: `2026-09-${String(day).padStart(2, '0')}T${String(hour + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`,
  durationSeconds: minutes * 60,
  completed,
});

test('month grid is Monday-first and covers every day', () => {
  const grid = buildMonthGrid(2026, 9, []);
  assert.equal(grid.totalDays, 30);
  assert.ok(grid.weeks >= 5 && grid.weeks <= 6);
  assert.equal(grid.days.at(-1).day, 30);
  assert.ok(grid.cells.filter((cell) => !cell.empty).length === 30);
});

test('activity levels combine focus duration and completed sessions', () => {
  assert.equal(activityLevel({ seconds: 0, completed: 0, interrupted: 0 }, 100), 0);
  assert.equal(activityLevel({ seconds: 600, completed: 1, interrupted: 0 }, 100), 1);
  assert.equal(activityLevel({ seconds: 6000, completed: 4, interrupted: 0 }, 100), 5);
});

test('month analytics aggregates sessions and identifies productive hour/day', () => {
  const data = [
    session(12, 10, 50, true),
    session(12, 11, 25, false),
    session(18, 15, 90, true),
    session(18, 15, 30, true),
    session(4, 8, 25, true),
  ];
  const result = monthAnalytics(2026, 9, data);
  assert.equal(result.totalSessions, 5);
  assert.equal(result.completedSessions, 4);
  assert.equal(result.interruptedSessions, 1);
  assert.equal(result.totalSeconds, (50 + 25 + 90 + 30 + 25) * 60);
  assert.equal(result.mostProductiveDay.day, 18);
  assert.equal(result.bestHour.hour, 15);
  assert.equal(result.days.find((day) => day.day === 12).sessions, 2);
});

test('month label stays readable for current UI', () => {
  assert.equal(monthLabel(2026, 9), 'September 2026');
});
