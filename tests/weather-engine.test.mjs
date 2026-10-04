import test from 'node:test';
import assert from 'node:assert/strict';
import WeatherEngine from '../renderer/weather-engine.js';

const {
  conditionFromWmo, displayCondition, isNight, openMeteoQuery, buildForecast,
  simulatedForecast, findTodayIndex, themeTarget, skyAt, LABEL, CONDITIONS,
} = WeatherEngine;

test('WMO codes map to the eight bubble conditions', () => {
  assert.equal(conditionFromWmo(0), 'clear');
  assert.equal(conditionFromWmo(2), 'partly-cloudy');
  assert.equal(conditionFromWmo(3), 'cloudy');
  assert.equal(conditionFromWmo(45), 'fog');
  assert.equal(conditionFromWmo(63), 'rain');
  assert.equal(conditionFromWmo(81), 'rain');
  assert.equal(conditionFromWmo(75), 'snow');
  assert.equal(conditionFromWmo(96), 'storm');
  assert.equal(conditionFromWmo(12345), 'cloudy');
  for (const c of CONDITIONS) assert.ok(LABEL[c], 'label for ' + c);
});

test('strong wind only replaces dry conditions', () => {
  assert.equal(displayCondition('clear', 36), 'windy');
  assert.equal(displayCondition('cloudy', 40), 'windy');
  assert.equal(displayCondition('clear', 20), 'clear');
  assert.equal(displayCondition('rain', 60), 'rain');
  assert.equal(displayCondition('storm', 60), 'storm');
});

test('night is before 8:00 and from 20:00', () => {
  assert.equal(isNight(7.9), true);
  assert.equal(isNight(8), false);
  assert.equal(isNight(19.99), false);
  assert.equal(isNight(20), true);
});

test('one Open-Meteo request carries current + hourly data (no extra privacy surface)', () => {
  const q = openMeteoQuery(44.8, -0.6);
  assert.match(q, /latitude=44\.8&longitude=-0\.6/);
  assert.match(q, /current=temperature_2m,weather_code,wind_speed_10m/);
  assert.match(q, /hourly=temperature_2m,weather_code,wind_speed_10m/);
  assert.match(q, /past_days=2&forecast_days=6/);
  assert.match(q, /timezone=auto/);
});

function openMeteoSample(dates, { missingHours = [] } = {}) {
  const time = [], temperature_2m = [], weather_code = [], wind_speed_10m = [];
  dates.forEach((date, di) => {
    for (let h = 0; h < 24; h++) {
      if (di === 0 && missingHours.includes(h)) continue;
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      temperature_2m.push(10 + h * 0.5 + di);
      weather_code.push(h < 12 ? 0 : 61);
      wind_speed_10m.push(h === 14 ? 41.4 : 10);
    }
  });
  return { hourly: { time, temperature_2m, weather_code, wind_speed_10m } };
}

test('buildForecast groups hours by day in the bubble format', () => {
  const out = buildForecast(openMeteoSample(['2026-10-03', '2026-10-04']), 'Pessac');
  assert.equal(out.source, 'open-meteo');
  assert.equal(out.city, 'Pessac');
  assert.equal(out.days.length, 2);
  const d = out.days[1];
  assert.equal(d.date, '2026-10-04');
  assert.equal(d.city, 'Pessac');
  assert.equal(d.hourly.length, 24);
  assert.deepEqual(d.hourly[0], { hour: 0, condition: 'clear', temperature: 11, wind: 10 });
  assert.equal(d.hourly[14].wind, 41);
  assert.equal(d.hourly[15].condition, 'rain');
  assert.equal(d.condition, 'rain');          // condition de 15 h
  assert.equal(d.temperature, 23);            // maximum du jour (11 + 11.5 -> 22.5 -> arrondi)
  assert.equal(d.wind, 41);
});

test('buildForecast fills small gaps, drops truncated days and rejects malformed data', () => {
  const gap = buildForecast(openMeteoSample(['2026-10-03'], { missingHours: [3, 4] }), '');
  assert.equal(gap.days[0].hourly.length, 24);
  assert.equal(gap.days[0].hourly[3].hour, 3);
  assert.equal(gap.days[0].hourly[3].temperature, gap.days[0].hourly[2].temperature);
  const truncated = openMeteoSample(['2026-10-03']);
  truncated.hourly.time.length = 6; truncated.hourly.temperature_2m.length = 6; truncated.hourly.weather_code.length = 6;
  assert.equal(buildForecast(truncated, ''), null);
  assert.equal(buildForecast(null, ''), null);
  assert.equal(buildForecast({ hourly: { time: [] } }, ''), null);
});

test('simulated forecast: 8 days around today, 24 valid hours each', () => {
  const now = new Date(2026, 9, 4, 18, 30);
  const sim = simulatedForecast(now, 'Demo');
  assert.equal(sim.source, 'simulated');
  assert.equal(sim.days.length, 8);
  assert.equal(sim.days[2].date, '2026-10-04');
  assert.equal(findTodayIndex(sim.days, now), 2);
  for (const day of sim.days) {
    assert.equal(day.hourly.length, 24);
    for (const e of day.hourly) {
      assert.ok(CONDITIONS.includes(e.condition));
      assert.ok(Number.isFinite(e.temperature) && Number.isFinite(e.wind));
    }
  }
  // Tous les types de météo du prototype sont représentés dans la simulation.
  const seen = new Set(sim.days.flatMap((d) => d.hourly.map((e) => displayCondition(e.condition, e.wind))));
  for (const c of CONDITIONS) assert.ok(seen.has(c), 'simulation covers ' + c);
});

test('findTodayIndex falls back to the nearest day', () => {
  const sim = simulatedForecast(new Date(2026, 9, 4, 12), '');
  assert.equal(findTodayIndex(sim.days, new Date(2026, 9, 6, 9)), 4);
  assert.equal(findTodayIndex(sim.days, new Date(2030, 0, 1)), 7);
  assert.equal(findTodayIndex(sim.days, new Date(2020, 0, 1)), 0);
  assert.equal(findTodayIndex([], new Date()), 0);
});

test('theme: 21 finite values, day is brighter than night, weather veils the sky', () => {
  const noon = themeTarget(12, 'clear');
  const night = themeTarget(2, 'clear');
  assert.equal(noon.length, 21);
  assert.ok(noon.every(Number.isFinite) && night.every(Number.isFinite));
  assert.ok(noon[5] > night[5], 'bottom of the sky is brighter at noon');
  assert.ok(noon[14] > 0.3 && night[14] < noon[14], 'the sun fades at night');
  const storm = themeTarget(12, 'storm');
  assert.ok(storm[5] < noon[5], 'a storm darkens the sky');
  assert.equal(storm[15], 1); assert.equal(storm[20], 1);   // pluie + orage
  assert.equal(themeTarget(12, 'snow')[16], 1);
  assert.equal(themeTarget(12, 'fog')[18], 1);
  assert.equal(themeTarget(12, 'windy')[19], 1);
  assert.ok(night[17] > 0.8, 'stars at night when clear');
  assert.ok(themeTarget(12, 'clear')[17] < 0.1, 'no stars at noon');
});

test('theme: sun position scales with the notch dimensions', () => {
  const [sx, sy] = themeTarget(12, 'clear', 380, 320).slice(9, 11);
  const [bx, by] = themeTarget(12, 'clear', 760, 640).slice(9, 11);
  assert.ok(Math.abs(bx - sx * 2) < 1e-6 && Math.abs(by - sy * 2) < 1e-6);
  assert.equal(skyAt(0).length, 9);
});
