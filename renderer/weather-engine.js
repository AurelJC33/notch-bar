/* Moteur météo : fonctions pures, sans DOM ni réseau.
   Partagé par le process principal (require), le renderer (window.WeatherEngine)
   et les tests. Format de données de la bulle (identique au prototype) :

   { date:"2026-10-04", city:"Pessac", condition:"partly-cloudy", temperature:24, wind:18,
     hourly:[{ hour:0..23, condition, temperature, wind }] }

   conditions : clear | partly-cloudy | cloudy | rain | storm | snow | fog | windy

   Pour brancher une autre API météo : produire un tableau de jours à ce format
   (voir buildForecast pour Open-Meteo) et le renvoyer via get-weather-forecast. */
(function initWeatherEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WeatherEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  const pad = (n) => String(n).padStart(2, '0');

  const CONDITIONS = ['clear', 'partly-cloudy', 'cloudy', 'rain', 'storm', 'snow', 'fog', 'windy'];
  const LABEL = {
    clear: 'Clear', 'partly-cloudy': 'Partly cloudy', cloudy: 'Cloudy', rain: 'Rain',
    storm: 'Thunderstorm', snow: 'Snow', fog: 'Fog', windy: 'Windy',
  };
  const WINDY_KMH = 35;       // au-delà, un ciel dégagé / nuageux s'affiche « Windy »
  const PAST_DAYS = 2;        // jours précédents affichés
  const FORECAST_DAYS = 6;    // aujourd'hui + 5

  /* ---------- Open-Meteo ---------- */
  /** Code WMO -> condition de la bulle. */
  function conditionFromWmo(code) {
    if (code === 0 || code === 1) return 'clear';
    if (code === 2) return 'partly-cloudy';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
    if ([95, 96, 99].includes(code)) return 'storm';
    return 'cloudy';
  }

  /** Condition réellement affichée (le vent fort remplace un ciel sans précipitation). */
  function displayCondition(condition, wind) {
    return wind >= WINDY_KMH && ['clear', 'partly-cloudy', 'cloudy'].includes(condition) ? 'windy' : condition;
  }

  const isNight = (hourDecimal) => hourDecimal < 8 || hourDecimal >= 20;

  /** Query-string Open-Meteo pour la bulle (une seule requête : actuel + horaire). */
  function openMeteoQuery(lat, lon) {
    return `latitude=${lat}&longitude=${lon}`
      + '&current=temperature_2m,weather_code,wind_speed_10m'
      + '&hourly=temperature_2m,weather_code,wind_speed_10m'
      + `&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}`
      + '&wind_speed_unit=kmh&timezone=auto';
  }

  /** Réponse Open-Meteo -> { source, city, days }. Renvoie null si la forme est inattendue. */
  function buildForecast(data, city) {
    const h = data && data.hourly;
    if (!h || !Array.isArray(h.time) || !Array.isArray(h.temperature_2m) || !Array.isArray(h.weather_code)) return null;
    const winds = Array.isArray(h.wind_speed_10m) ? h.wind_speed_10m : [];
    const byDate = new Map();
    h.time.forEach((stamp, i) => {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})/.exec(String(stamp));
      if (!m) return;
      const temp = h.temperature_2m[i];
      const code = h.weather_code[i];
      if (typeof temp !== 'number' || typeof code !== 'number') return;
      if (!byDate.has(m[1])) byDate.set(m[1], new Array(24).fill(null));
      byDate.get(m[1])[Number(m[2])] = {
        hour: Number(m[2]),
        condition: conditionFromWmo(code),
        temperature: Math.round(temp),
        wind: Math.round(typeof winds[i] === 'number' ? winds[i] : 0),
      };
    });
    const days = [];
    for (const [date, slots] of [...byDate].sort((a, b) => a[0].localeCompare(b[0]))) {
      const known = slots.filter(Boolean);
      if (known.length < 12) continue; // journée tronquée : on ne l'affiche pas
      let last = known[0];
      const hourly = slots.map((slot, hour) => {
        if (slot) { last = slot; return slot; }
        return { ...last, hour };
      });
      days.push({
        date,
        city: city || '',
        condition: hourly[15].condition,
        temperature: Math.max(...hourly.map((e) => e.temperature)),
        wind: Math.max(...hourly.map((e) => e.wind)),
        hourly,
      });
    }
    return days.length ? { source: 'open-meteo', city: city || '', days } : null;
  }

  /* ---------- Données simulées (aucune API / météo désactivée / hors ligne) ---------- */
  const SIM_SPEC = [ // jours -2 … +5 autour d'aujourd'hui
    { seg: [[0, 'clear']], tmin: 11, tmax: 22, w: 12 },
    { seg: [[0, 'partly-cloudy']], tmin: 12, tmax: 23, w: 16 },
    { seg: [[0, 'clear'], [7, 'partly-cloudy'], [11, 'cloudy'], [19, 'clear']], tmin: 14, tmax: 24, w: 14, gust: [11, 20, 38] },
    { seg: [[0, 'cloudy'], [11, 'rain']], tmin: 13, tmax: 19, w: 24 },
    { seg: [[0, 'rain'], [15, 'storm'], [21, 'rain']], tmin: 13, tmax: 20, w: 30 },
    { seg: [[0, 'fog'], [12, 'partly-cloudy']], tmin: 9, tmax: 17, w: 6 },
    { seg: [[0, 'cloudy'], [10, 'snow']], tmin: -3, tmax: 2, w: 14 },
    { seg: [[0, 'clear']], tmin: 8, tmax: 21, w: 10 },
  ];

  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function simulatedForecast(now = new Date(), city = '') {
    const days = SIM_SPEC.map((spec, i) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i - PAST_DAYS, 12);
      const hourly = Array.from({ length: 24 }, (_, hour) => {
        const condition = spec.seg.filter((s) => s[0] <= hour).pop()[1];
        const k = 0.5 - 0.5 * Math.cos(2 * Math.PI * (hour - 3) / 24);
        const gust = spec.gust && hour >= spec.gust[0] && hour < spec.gust[1];
        return {
          hour, condition,
          temperature: Math.round(spec.tmin + (spec.tmax - spec.tmin) * k),
          wind: gust ? spec.gust[2] : spec.w,
        };
      });
      return {
        date: dateKey(d), city, condition: hourly[15].condition,
        temperature: spec.tmax, wind: Math.max(...hourly.map((e) => e.wind)), hourly,
      };
    });
    return { source: 'simulated', city, days };
  }

  /** Index du jour courant dans `days` (jour exact, sinon le plus proche). */
  function findTodayIndex(days, now = new Date()) {
    if (!Array.isArray(days) || !days.length) return 0;
    const key = dateKey(now);
    const exact = days.findIndex((d) => d.date === key);
    if (exact >= 0) return exact;
    const t = Date.parse(key + 'T12:00:00');
    let best = 0;
    days.forEach((d, i) => {
      if (Math.abs(Date.parse(d.date + 'T12:00:00') - t) < Math.abs(Date.parse(days[best].date + 'T12:00:00') - t)) best = i;
    });
    return best;
  }

  /* ---------- Thème : heure du jour × météo ---------- */
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const SKY_KEYFRAMES = [ // heure, haut, milieu, bas
    [0, '#050918', '#0a1330', '#14224a'], [6, '#060b1f', '#0c1738', '#17285a'], [7.2, '#142a66', '#5b5598', '#d9899a'],
    [8.1, '#2f5eb0', '#d98f8c', '#ffc48a'], [9.6, '#1d68c4', '#58a6e4', '#bfe3f4'], [12, '#0b52b3', '#1b78d6', '#3aaae8'],
    [15.5, '#0d55b6', '#2480dc', '#47b2ec'], [17.8, '#2a5fb8', '#6a90d0', '#f0b57c'], [19.2, '#3a4aa6', '#c7678f', '#ff9d5c'],
    [20, '#3a2f86', '#a8508f', '#ff8a63'], [20.8, '#1d2570', '#4d4a9e', '#c9709a'], [21.7, '#0c1a58', '#18408a', '#2f78b0'],
    [23, '#060c26', '#0a1638', '#122650'], [24, '#050918', '#0a1330', '#14224a'],
  ].map((k) => [k[0], k.slice(1).map(hex).flat()]);

  /* a = intensité du voile météo ; r pluie, s neige, st étoiles, f brume, w vent, z orage */
  const WEATHER_VEIL = {
    clear: { a: 0, t: 0, st: 1 },
    'partly-cloudy': { a: 0.15, t: ['#7fa0c8', '#8fb0d4', '#a6c2de'], st: 0.6 },
    cloudy: { a: 0.5, t: ['#6f86a6', '#8497b3', '#9fb0c6'], st: 0.15 },
    rain: { a: 0.65, t: ['#3c5069', '#4d647e', '#6a8099'], r: 1 },
    storm: { a: 0.8, t: ['#1f2838', '#2c3647', '#3e4a5e'], r: 1, z: 1 },
    snow: { a: 0.55, t: ['#5f86b0', '#7a9fc6', '#9dbbd8'], s: 1, st: 0.1 },
    fog: { a: 0.7, t: ['#7b8da1', '#8fa0b3', '#a6b4c3'], f: 1 },
    windy: { a: 0.05, t: 0, w: 1, st: 0.6 },
  };

  function skyAt(hour) {
    let i = 0;
    while (i < SKY_KEYFRAMES.length - 2 && hour >= SKY_KEYFRAMES[i + 1][0]) i++;
    const [a, b] = [SKY_KEYFRAMES[i], SKY_KEYFRAMES[i + 1]];
    const k = smooth(a[0], b[0], hour);
    return a[1].map((v, j) => v + (b[1][j] - v) * k);
  }

  /** Vecteur cible du ciel (21 nombres) pour une heure décimale et une condition.
      [0-8] 3 couleurs RGB (haut/milieu/bas) · [9-10] position du soleil (px dans width×height)
      [11-13] couleur du soleil · [14] opacité du soleil · [15-20] intensités pluie, neige, étoiles, brume, vent, orage. */
  function themeTarget(hour, condition, width = 380, height = 320) {
    const base = skyAt(hour);
    const lum = (0.3 * base[3] + 0.6 * base[4] + 0.1 * base[5]) / 255;
    const d = clamp((lum - 0.05) / 0.4, 0, 1);
    const veil = WEATHER_VEIL[condition] || WEATHER_VEIL.clear;
    const col = base.map((v, j) => (veil.t ? v + (hex(veil.t[(j / 3) | 0])[j % 3] * (0.28 + 0.72 * d) - v) * veil.a : v));
    const day = hour >= 7.4 && hour < 20.2;
    const hh = hour < 7.4 ? hour + 24 : hour;
    const u = day ? (hour - 7.4) / 12.8 : (hh - 20.2) / 11.2;
    const hg = Math.sin(Math.PI * u);
    const fade = smooth(0, 0.12, u) * smooth(0, 0.12, 1 - u);
    const sunRgb = day
      ? [0, 1, 2].map((j) => [255, 150, 90][j] + ([255, 248, 230][j] - [255, 150, 90][j]) * Math.min(1, hg * 2.2))
      : [170, 200, 255];
    return [
      ...col,
      width * (0.12 + 0.78 * u), height * (0.95 - 0.9 * hg),
      ...sunRgb, (day ? 0.6 : 0.3) * fade * (1 - veil.a * 0.85),
      veil.r || 0, veil.s || 0, (veil.st || 0) * Math.pow(1 - d, 1.5), veil.f || 0, veil.w || 0, veil.z || 0,
    ];
  }

  return {
    CONDITIONS, LABEL, WINDY_KMH, PAST_DAYS, FORECAST_DAYS,
    conditionFromWmo, displayCondition, isNight, openMeteoQuery, buildForecast,
    simulatedForecast, findTodayIndex, dateKey, skyAt, themeTarget,
  };
});
