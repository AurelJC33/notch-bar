/* Page Météo du notch (prototype « bulle météo » adapté aux dimensions du notch).

   - Données : window.api.getWeatherForecast() (process principal -> Open-Meteo, voir main.js).
     Hors ligne, météo désactivée ou pas encore chargée : données simulées (WeatherEngine).
   - Rendu : ciel dégradé qui évolue avec l'heure et la météo, effets canvas (pluie, neige,
     étoiles, brume, vent, éclairs), cartes horaires défilantes, changement de jour animé.
   - Le calcul (conditions, thème) vit dans weather-engine.js ; ici, uniquement le DOM.
   - La boucle d'animation ne tourne que lorsque la page est réellement visible. */
(() => {
  'use strict';
  const E = window.WeatherEngine;
  const $ = (id) => document.getElementById(id);
  const panel = $('panel-weather');
  const sky = $('weather-sky');
  if (!E || !panel || !sky) return;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);

  /* Dimensions : largeur de carte + espace, partagées avec le CSS via des variables. */
  const CARD_W = 54;
  const GAP = 6;
  const CW = CARD_W + GAP;
  panel.style.setProperty('--wx-card', CARD_W + 'px');
  panel.style.setProperty('--wx-gap', GAP + 'px');

  /* ============ 1. ICÔNES ============ */
  const cloud = (x, y, s, g = 'wx-cg') => `<g transform="translate(${x} ${y}) scale(${s})"><path fill="url(#${g})" d="M18 50a11 11 0 0 1-1-22 15 15 0 0 1 29-4 12 12 0 0 1 3 26z"/></g>`;
  const sun = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><circle r="21" fill="#ffd36b" opacity=".28"/><g stroke="#ffd36b" stroke-width="3.4" stroke-linecap="round">${[...Array(8)].map((_, i) => `<path transform="rotate(${i * 45})" d="M0-20V-25"/>`).join('')}</g><circle r="13" fill="url(#wx-sg)"/></g>`;
  const moon = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><circle r="20" fill="#cfd9ff" opacity=".16"/><path fill="url(#wx-mg)" d="M5-12A13 13 0 1 0 12 5A10 10 0 0 0 5-12Z"/></g>`;
  const star = (x, y, d = 0) => `<circle style="animation-delay:${d}s" cx="${x}" cy="${y}" r="1.5" fill="#fff"/>`;
  function icon(c, night) {
    let b = '';
    switch (c) {
      case 'clear': b = night ? moon(32, 32, 1.15) + star(50, 16) + star(14, 48, 1) : sun(32, 32, 1.2); break;
      case 'partly-cloudy': b = (night ? moon(24, 22, 0.8) : sun(23, 23, 0.8)) + cloud(6, 8, 0.9); break;
      case 'cloudy': b = cloud(-2, -6, 0.8, 'wx-cgd') + cloud(8, 4, 0.95); break;
      case 'rain': b = cloud(0, -8, 1, 'wx-cgd') + [22, 32, 42].map((x, i) => `<path style="animation-delay:${i * 0.28}s" d="M${x} 46l-2.5 7" stroke="#bfe6ff" stroke-width="3" stroke-linecap="round"/>`).join(''); break;
      case 'storm': b = cloud(0, -8, 1, 'wx-cgs') + '<path fill="url(#wx-bg2)" d="M35 38 27 52h6l-4 10 13-17h-7l5-7z"/>'; break;
      case 'snow': b = cloud(0, -8, 1, 'wx-cgd') + [22, 32, 42].map((x, i) => `<circle style="animation-delay:${i * 0.6}s" cx="${x}" cy="${48 + (i % 2) * 4}" r="2.4" fill="#fff"/>`).join(''); break;
      case 'fog': b = cloud(0, -10, 1) + [[44, 14, 50], [51, 20, 44], [58, 12, 46]].map(([y, a, z]) => `<path d="M${a} ${y}H${z}" stroke="#fff" stroke-opacity=".8" stroke-width="3.4" stroke-linecap="round"/>`).join(''); break;
      case 'windy': b = cloud(2, -8, 0.95) + '<g fill="none" stroke="#c4e6ff" stroke-width="3" stroke-linecap="round"><path d="M6 46H36a4.5 4.5 0 1 0-4.5-4.5"/><path d="M12 54H44a4.5 4.5 0 1 1-4.5 4.5"/><path d="M4 50H22"/></g>'; break;
      default: break;
    }
    return `<svg viewBox="0 0 64 64" aria-hidden="true">${b}</svg>`;
  }

  /* ============ 2. THÈME (ciel) ============ */
  const SKY_W = 380;
  const SKY_H = 320;
  const reduced = () => !!(window.__notchSettings && window.__notchSettings.reduceMotion)
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let cur = null;
  let themeRaf = 0;

  function paint(v) {
    const s = sky.style;
    for (let i = 0; i < 3; i++) s.setProperty('--c' + i, `rgb(${v[i * 3] | 0},${v[i * 3 + 1] | 0},${v[i * 3 + 2] | 0})`);
    s.setProperty('--sx', v[9].toFixed(1) + 'px');
    s.setProperty('--sy', v[10].toFixed(1) + 'px');
    s.setProperty('--sg', `rgb(${v[11] | 0},${v[12] | 0},${v[13] | 0})`);
    s.setProperty('--so', v[14].toFixed(3));
    s.setProperty('--sheen', (0.12 + v[14] * 0.8).toFixed(3));
  }
  function setTheme(to) {
    cancelAnimationFrame(themeRaf);
    if (!cur || reduced() || !isVisible()) { cur = to.slice(); paint(cur); return; }
    const from = cur.slice();
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 1100);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      cur = from.map((v, i) => v + (to[i] - v) * e);
      paint(cur);
      if (k < 1) themeRaf = requestAnimationFrame(step);
    };
    themeRaf = requestAnimationFrame(step);
  }

  /* ============ 3. EFFETS (canvas) ============ */
  const cv = $('wx-fx');
  const g = cv.getContext('2d');
  const flash = $('wx-flash');
  const W = SKY_W;
  const H = SKY_H;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr;
  cv.height = H * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const mk = (n, f) => [...Array(n)].map(f);
  // Effectifs ≈ prototype × (surface du notch / surface du prototype).
  const N = { rain: 54, snow: 34, stars: 32, fog: 3, wind: 8 };
  const rain = mk(N.rain, () => ({ x: rnd(0, W + 40), y: rnd(0, H), l: rnd(8, 16), v: rnd(0.4, 0.65) }));
  const snow = mk(N.snow, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(1, 2.4), v: rnd(0.015, 0.045), p: rnd(0, 6) }));
  const stars = mk(N.stars, () => ({ x: rnd(0, W), y: rnd(0, H * 0.7), r: rnd(0.5, 1.2), p: rnd(0, 6) }));
  const fogs = mk(N.fog, (_, i) => ({ x: rnd(0, W), y: 70 + i * 90, r: rnd(110, 160), v: rnd(0.006, 0.015) }));
  const wind = mk(N.wind, () => ({ x: rnd(0, W), y: rnd(20, H - 20), l: rnd(40, 90), v: rnd(0.35, 0.7) }));
  let last = performance.now();
  let nextFlash = last + 4000;
  let fxRaf = 0;

  function frame(now) {
    fxRaf = 0;
    if (!isVisible() || reduced()) { g.clearRect(0, 0, W, H); return; }
    const dt = Math.min(50, now - last);
    last = now;
    const v = cur || [];
    const R = v[15] || 0, S = v[16] || 0, ST = v[17] || 0, F = v[18] || 0, Wd = v[19] || 0, Z = v[20] || 0;
    g.clearRect(0, 0, W, H);
    if (ST > 0.01) {
      for (const s of stars.slice(0, Math.ceil(N.stars * Math.min(1, ST)))) {
        g.fillStyle = `rgba(255,255,255,${(0.25 + 0.45 * Math.sin(now / 1400 + s.p) ** 2) * Math.min(1, ST)})`;
        g.beginPath(); g.arc(s.x, s.y, s.r, 0, 6.3); g.fill();
      }
    }
    if (F > 0.01) {
      for (const f of fogs) {
        f.x += f.v * dt; if (f.x - f.r > W) f.x = -f.r;
        const gr = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
        gr.addColorStop(0, `rgba(235,242,250,${0.32 * F})`); gr.addColorStop(1, 'rgba(235,242,250,0)');
        g.fillStyle = gr; g.fillRect(f.x - f.r, f.y - f.r, f.r * 2, f.r * 2);
      }
    }
    if (Wd > 0.01) {
      g.strokeStyle = `rgba(255,255,255,${0.16 * Wd})`; g.lineWidth = 1.2; g.lineCap = 'round'; g.beginPath();
      for (const w of wind) {
        w.x += w.v * dt; if (w.x > W + 20) { w.x = -w.l; w.y = rnd(20, H - 20); }
        g.moveTo(w.x, w.y); g.lineTo(w.x + w.l, w.y);
      }
      g.stroke();
    }
    if (R > 0.01) {
      g.strokeStyle = `rgba(205,228,255,${0.38 * R})`; g.lineWidth = 1.2; g.beginPath();
      for (const r of rain.slice(0, Math.ceil(N.rain * R))) {
        r.y += r.v * dt; r.x -= r.v * dt * 0.22;
        if (r.y > H + 20) { r.y = -20; r.x = rnd(0, W + 40); }
        g.moveTo(r.x, r.y); g.lineTo(r.x - r.l * 0.22, r.y + r.l);
      }
      g.stroke();
    }
    if (S > 0.01) {
      g.fillStyle = `rgba(255,255,255,${0.8 * S})`; g.beginPath();
      for (const s of snow.slice(0, Math.ceil(N.snow * S))) {
        s.y += s.v * dt; s.p += 0.0015 * dt; if (s.y > H + 4) { s.y = -4; s.x = rnd(0, W); }
        const x = s.x + Math.sin(s.p) * 10; g.moveTo(x + s.r, s.y); g.arc(x, s.y, s.r, 0, 6.3);
      }
      g.fill();
    }
    if (Z > 0.3 && now > nextFlash) {
      nextFlash = now + rnd(5000, 11000);
      flash.animate([{ opacity: 0 }, { opacity: 0.2, offset: 0.12 }, { opacity: 0.04, offset: 0.3 }, { opacity: 0.14, offset: 0.45 }, { opacity: 0 }], { duration: 560 });
    }
    fxRaf = requestAnimationFrame(frame);
  }

  /* La page est visible quand son panneau est actif ET que le notch est ouvert en vue standard. */
  function isVisible() {
    return panel.classList.contains('active') && document.body.classList.contains('mode-expanded') && !document.hidden;
  }

  /* ============ 4. UI ============ */
  const left = $('wx-left');
  const track = $('wx-track');
  const label = $('wx-daylabel');
  const sc = $('wx-hours');
  const icn = $('wx-bigicon');
  const todayBtn = $('wx-today');

  let forecast = null;     // { source, city, days }
  let days = [];
  let TODAY = 0;
  let busy = false;
  let scrollDirty = false; // la position de défilement n'a pas pu être posée (panneau masqué)
  const st = { day: 0, sel: 0, ov: null, co: '' };
  const clockNow = () => { const d = new Date(); return { h: d.getHours(), dec: d.getHours() + d.getMinutes() / 60 }; };
  const h12 = (h) => [h % 12 || 12, h < 12 ? 'AM' : 'PM'];
  const shown = (e) => st.co || E.displayCondition(e.condition, e.wind);

  function updateLeft(instant) {
    const e = days[st.day].hourly[st.sel];
    const c = shown(e);
    const html = icon(c, E.isNight(st.ov ?? st.sel + 0.5));
    const apply = () => { icn.innerHTML = html; icn.classList.remove('wx-out'); };
    $('wx-temp').textContent = e.temperature + '°';
    $('wx-cond').textContent = E.LABEL[c];
    if (instant || icn.innerHTML === html || reduced()) return apply();
    icn.classList.add('wx-out');
    setTimeout(apply, 180);
  }
  function updateTheme() {
    const e = days[st.day].hourly[st.sel];
    const n = clockNow();
    const h = st.ov ?? (st.day === TODAY && st.sel === n.h ? n.dec : st.sel + 0.5);
    setTheme(E.themeTarget(h, shown(e), SKY_W, SKY_H));
  }
  function select(h, ov = null, instant = false) {
    st.sel = h; st.ov = ov;
    track.querySelectorAll('.wx-card').forEach((c) => {
      const on = +c.dataset.h === h;
      c.classList.toggle('sel', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    updateLeft(instant); updateTheme();
  }

  function dayLabelHtml(d, off) {
    const dt = new Date(d.date + 'T12:00:00');
    if (Math.abs(off) <= 1) {
      return `<b>${['Yesterday', 'Today', 'Tomorrow'][off + 1]}</b><small>${dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</small>`;
    }
    return `<b>${dt.toLocaleDateString('en-GB', { weekday: 'long' })}</b><small>${dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</small>`;
  }

  /* Défilement horizontal : molette / trackpad / glisser à la souris, avec inertie. */
  let cx = 0, tx = 0, raf = 0, vel = 0, drag = null, moved = false, block = false;
  const maxS = () => Math.max(0, track.scrollWidth - sc.clientWidth);
  const fade = () => sc.style.setProperty('--fl', Math.min(24, sc.scrollLeft) + 'px');
  function loop() {
    cx += (tx - cx) * 0.16;
    if (Math.abs(tx - cx) < 0.3) cx = tx;
    sc.scrollLeft = cx;
    raf = cx !== tx ? requestAnimationFrame(loop) : 0;
  }
  function go(v) { tx = clamp(v, 0, maxS()); if (!raf) raf = requestAnimationFrame(loop); }

  function positionScroll() {
    if (!sc.clientWidth) { scrollDirty = true; return; }
    scrollDirty = false;
    const off = st.day - TODAY;
    cancelAnimationFrame(raf); raf = 0;
    cx = tx = clamp((st.sel - (off === 0 ? 0 : 1)) * CW, 0, maxS());
    sc.scrollLeft = cx;
    fade();
  }

  function renderDay() {
    const d = days[st.day];
    const off = st.day - TODAY;
    const n = clockNow();
    label.innerHTML = dayLabelHtml(d, off);
    $('wx-city').textContent = d.city || forecast.city || 'Your location';
    track.innerHTML = d.hourly.map((e) => {
      const [n12, p] = h12(e.hour);
      const c = E.displayCondition(e.condition, e.wind);
      const text = `${n12} ${p}, ${e.temperature}°, ${E.LABEL[c]}, wind ${e.wind} km/h`;
      return `<button class="wx-card${off === 0 && e.hour < n.h ? ' past' : ''}" type="button" data-h="${e.hour}" title="${text}" aria-label="${text}"><span class="wx-h">${n12}<small>${p}</small></span><span class="wx-ic">${icon(e.condition, E.isNight(e.hour + 0.5))}</span><span class="wx-t">${e.temperature}°</span></button>`;
    }).join('');
    $('wx-prev').disabled = st.day === 0;
    $('wx-next').disabled = st.day === days.length - 1;
    todayBtn.classList.toggle('wx-off', off === 0);
    todayBtn.tabIndex = off === 0 ? -1 : 0;
    $('wx-source').hidden = forecast.source !== 'simulated';
    select(off === 0 ? n.h : 12, null, true);
    positionScroll();
  }

  async function goDay(i) {
    if (busy || !days.length || i < 0 || i >= days.length || i === st.day) return;
    busy = true;
    const dir = i > st.day ? 1 : -1;
    const els = [left, track, label];
    const A = dir > 0 ? 'wx-out-l' : 'wx-out-r';
    const B = dir > 0 ? 'wx-out-r' : 'wx-out-l';
    if (reduced()) { st.day = i; renderDay(); busy = false; return; }
    els.forEach((e) => e.classList.add(A));
    await wait(190);
    st.day = i; renderDay();
    els.forEach((e) => { e.style.transition = 'none'; e.classList.remove(A); e.classList.add(B); });
    void left.offsetWidth;
    els.forEach((e) => { e.style.transition = ''; e.classList.remove(B); });
    await wait(300);
    busy = false;
  }

  /** Applique un jeu de données ({ source, city, days }). Conserve le jour affiché si possible. */
  function setForecast(next) {
    if (!next || !Array.isArray(next.days) || !next.days.length) next = E.simulatedForecast(new Date(), '');
    const keepDate = days[st.day] && days[st.day].date;
    forecast = next;
    days = next.days;
    TODAY = E.findTodayIndex(days, new Date());
    const keep = keepDate ? days.findIndex((d) => d.date === keepDate) : -1;
    st.day = keep >= 0 ? keep : TODAY;
    st.co = '';
    renderDay();
  }

  $('wx-prev').addEventListener('click', () => goDay(st.day - 1));
  $('wx-next').addEventListener('click', () => goDay(st.day + 1));
  todayBtn.addEventListener('click', () => goDay(TODAY));
  document.addEventListener('keydown', (e) => {
    if (!isVisible() || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"], .tabs')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); goDay(st.day - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goDay(st.day + 1); }
  });

  sc.addEventListener('wheel', (e) => {
    e.preventDefault();
    go(tx + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * 1.1);
  }, { passive: false });
  sc.addEventListener('scroll', () => {
    fade();
    if (!raf && Math.abs(sc.scrollLeft - cx) > 1.5) cx = tx = sc.scrollLeft;
  });
  sc.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button) return;
    drag = { x: e.clientX, s: sc.scrollLeft, lx: e.clientX, lt: performance.now() };
    moved = false; vel = 0; cancelAnimationFrame(raf); raf = 0; cx = tx = sc.scrollLeft;
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 5) { moved = true; sc.classList.add('drag'); }
    if (!moved) return;
    const t = performance.now();
    vel = 0.8 * vel + 0.2 * ((drag.lx - e.clientX) / Math.max(1, t - drag.lt));
    drag.lx = e.clientX; drag.lt = t;
    cx = tx = clamp(drag.s - dx, 0, maxS()); sc.scrollLeft = cx;
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    sc.classList.remove('drag');
    if (moved) { block = true; setTimeout(() => { block = false; }, 60); go(cx + vel * 220); }
    drag = null;
  });
  sc.addEventListener('click', (e) => {
    if (block) return;
    const c = e.target.closest('.wx-card');
    if (c) select(+c.dataset.h);
  });

  /* Heure réelle : met à jour les cartes « passées » et le ciel toutes les minutes. */
  setInterval(() => {
    if (!days.length || st.day !== TODAY || st.ov !== null) return;
    const h = clockNow().h;
    track.querySelectorAll('.wx-card').forEach((c) => c.classList.toggle('past', +c.dataset.h < h));
    if (isVisible()) updateTheme();
  }, 60000);

  /* ============ 5. API ============ */
  /** Appelé par app.js à chaque changement de vue / d'onglet : démarre ou arrête les animations. */
  function sync() {
    if (!days.length) return;
    if (isVisible()) {
      if (scrollDirty) positionScroll();
      updateTheme();
      if (!fxRaf && !reduced()) { last = performance.now(); fxRaf = requestAnimationFrame(frame); }
    } else if (fxRaf) {
      cancelAnimationFrame(fxRaf); fxRaf = 0;
    }
  }
  document.addEventListener('visibilitychange', sync);

  window.NotchWeather = {
    setForecast,
    sync,
    /** Aperçu / tests : force une heure décimale et/ou une condition. */
    preview(hour = null, condition = '') {
      st.co = condition || '';
      if (hour === null || hour === undefined) { st.ov = null; select(clockNow().h); return; }
      select(Math.floor(hour), hour);
    },
    goDay,
    get state() { return { day: st.day, today: TODAY, hour: st.sel, source: forecast && forecast.source, days: days.length }; },
  };

  /* Démarrage : simulation immédiate (la page n'est jamais vide), puis vraies données. */
  setForecast(E.simulatedForecast(new Date(), ''));
  const api = window.api || {};
  if (api.getWeatherForecast) api.getWeatherForecast().then((f) => { if (f) setForecast(f); }).catch(() => {});
  if (api.onWeatherForecastUpdated) api.onWeatherForecastUpdated((f) => setForecast(f));
})();
