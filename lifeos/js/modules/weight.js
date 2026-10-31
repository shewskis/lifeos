// weight.js — daily weigh-ins, 7-day trend, goal line & BMI.
// Store: weights { id, date, time ('HH:MM' when weighed, '' on old entries), kg (always kg), bodyFat (number|null), note ('' ok) }
// Settings: 'weight:goal' (kg|null), 'weight:height' (cm|null), 'weight:range' (chart range).
import { h, clear, dates, fmt, icon, toast, sheet, form, formSheet, confirm, segmented, empty, card, listItem, fab, stat, lineChart } from '../ui.js';

const STORE = 'weights';
const LB = 2.20462;
// css/app.css resets button padding to 0, so a bare .link is ~17px tall; pad it to a 44px touch target.
const LINK_STYLE = { padding: '10px 0 10px 12px', minHeight: '44px' };
const RANGES = [
  { value: '1M', label: '1M', days: 30 },
  { value: '3M', label: '3M', days: 90 },
  { value: '1Y', label: '1Y', days: 365 },
  { value: 'All', label: 'All', days: null },
];

// ---------- units ----------
function unitOf(ctx) { return ctx.settings.get('units', 'kg') === 'lb' ? 'lb' : 'kg'; }
function toDisplay(kg, unit) { return unit === 'lb' ? kg * LB : kg; }
function toKg(v, unit) { return unit === 'lb' ? v / LB : v; }
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function numW(kg, unit) { return fmt.num(round1(toDisplay(kg, unit)), 1); }
function fmtW(kg, unit) { return `${numW(kg, unit)} ${unit}`; }
/** Signed delta in display units, e.g. "−0.3 kg" / "+1.2". */
function fmtDelta(kgDelta, unit, withUnit = true) {
  const d = round1(toDisplay(kgDelta, unit));
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${fmt.num(Math.abs(d), 1)}${withUnit ? ' ' + unit : ''}`;
}
function signed(n) { return (n > 0 ? '+' : '') + n.toFixed(1); }

// ---------- time of weigh-in ----------
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isHM = (t) => typeof t === 'string' && HM_RE.test(t);
function nowHM() { const d = new Date(); return dates.pad(d.getHours()) + ':' + dates.pad(d.getMinutes()); }
/** '07:05' → '7:05 AM' / '07:05' in the device's locale; '' when there is no time. */
function timeLabel(t) {
  if (!isHM(t)) return '';
  const [hh, mm] = t.split(':').map(Number);
  return new Date(2000, 0, 1, hh, mm).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
/** 'Today · 7:05 AM' (date label plus the time when the entry has one). */
function whenLabel(e) { const t = timeLabel(e.time); return t ? `${dates.label(e.date)} · ${t}` : dates.label(e.date); }

// ---------- data ----------
/** Make an old/partial record safe to use, or null if unusable. */
function normalize(r) {
  if (!r || typeof r !== 'object' || typeof r.date !== 'string') return null;
  const kg = Number(r.kg ?? r.weight);
  if (!Number.isFinite(kg) || kg <= 0) return null;
  const bf = r.bodyFat === null || r.bodyFat === undefined || r.bodyFat === '' ? null : Number(r.bodyFat);
  return { ...r, kg, time: isHM(r.time) ? r.time : '', bodyFat: Number.isFinite(bf) && bf > 0 ? bf : null, note: typeof r.note === 'string' ? r.note : '' };
}
/** All entries, ascending by date. */
async function loadAll(ctx) {
  const rows = await ctx.db.all(STORE, { index: 'date' });
  return rows.map(normalize).filter(Boolean);
}
/** Last entry on or before dateKey (entries ascending). */
function entryAt(entries, dateKey) {
  let found = null;
  for (const e of entries) { if (e.date <= dateKey) found = e; else break; }
  return found;
}
/** Calendar-window moving average (default 7 days) for every entry: [{date, avg, n}]. */
function movingAvg(entries, days = 7) {
  const out = []; let j = 0, sum = 0;
  for (let i = 0; i < entries.length; i++) {
    sum += entries[i].kg;
    const from = dates.addDays(entries[i].date, -(days - 1));
    while (entries[j].date < from) { sum -= entries[j].kg; j++; }
    out.push({ date: entries[i].date, avg: sum / (i - j + 1), n: i - j + 1 });
  }
  return out;
}
/** latest.kg minus the weight `days` before latest. The reference weigh-in must fall within `tolerance` days before
 *  that date (so a sporadic logger is not shown "vs 7 days" against a months-old entry); otherwise null. */
function changeSince(entries, latest, days, tolerance = Math.max(3, Math.round(days / 5))) {
  const target = dates.addDays(latest.date, -days);
  const ref = entryAt(entries, target);
  if (!ref || ref === latest) return null;
  return dates.daysBetween(ref.date, target) <= tolerance ? latest.kg - ref.kg : null;
}
/** kg per week over the last `days` days (least-squares slope), or null when too little data. */
function weeklyRate(entries, days = 30) {
  const since = dates.addDays(dates.today(), -days);
  const pts = entries.filter((e) => e.date >= since);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => dates.daysBetween(pts[0].date, p.date)), ys = pts.map((p) => p.kg);
  if (xs[xs.length - 1] < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? (num / den) * 7 : null;
}
function bmi(kg, cm) { if (!cm || cm <= 0) return null; const m = cm / 100; return kg / (m * m); }
function bmiLabel(b) { return b < 18.5 ? 'Underweight' : b < 25 ? 'Healthy' : b < 30 ? 'Overweight' : 'Obese'; }
function goalOf(ctx) { const g = Number(ctx.settings.get('weight:goal')); return Number.isFinite(g) && g > 0 ? g : null; }
function heightOf(ctx) { const v = Number(ctx.settings.get('weight:height')); return Number.isFinite(v) && v > 0 ? v : null; }
/** 'good' when the delta moves toward the goal, 'bad' when away, '' when no goal / flat. */
function towardGoal(delta, current, goalKg) {
  if (delta == null || goalKg == null || Math.abs(delta) < 0.05) return '';
  const wantDown = goalKg < current;
  return (wantDown && delta < 0) || (!wantDown && delta > 0) ? 'good' : 'bad';
}

// ---------- persistence ----------
/** One entry per date: saving onto a date that already has an entry updates that entry. */
async function saveEntry(ctx, data, original) {
  const sameDate = (await ctx.db.where(STORE, 'date', data.date)).filter((e) => e.id !== original?.id);
  if (sameDate.length) {
    const target = sameDate[0], prev = normalize(target) || { bodyFat: null, note: '' };
    // Only overwrite what the user filled in: an empty body-fat / note / time keeps that day's existing values.
    const saved = await ctx.db.put(STORE, { ...target, kg: data.kg, time: data.time || prev.time || '', bodyFat: data.bodyFat ?? prev.bodyFat, note: data.note || prev.note });
    if (original?.id) await ctx.db.delete(STORE, original.id);
    for (const dupe of sameDate.slice(1)) await ctx.db.delete(STORE, dupe.id);
    return { rec: saved, merged: true };
  }
  const saved = await ctx.db.put(STORE, { ...(original || {}), date: data.date, time: data.time || '', kg: data.kg, bodyFat: data.bodyFat, note: data.note });
  return { rec: saved, merged: false };
}

/** Add (original = null) or edit a weigh-in. Weight input has a −0.1 / +0.1 stepper for sleepy mornings. */
async function openEntry(ctx, original = null) {
  const unit = unitOf(ctx);
  // A fresh "Log weight" stamps the current time. That includes re-logging today when today already has a weigh-in
  // (you just weighed again); only opening an existing entry from the list keeps the time it was taken.
  let stampNow = !original;
  if (!original) {
    // One entry per date: logging when today already has a weigh-in edits it (prefilled body fat / note, Delete shown).
    const existing = (await ctx.db.where(STORE, 'date', dates.today())).map(normalize).filter(Boolean);
    if (existing.length) original = existing[0];
  }
  let lastKg = original?.kg ?? null;
  if (lastKg == null) { const all = await loadAll(ctx); lastKg = all.length ? all[all.length - 1].kg : null; }
  const f = form([
    { name: 'date', label: 'Date', type: 'date', required: true, max: dates.today(), value: original?.date || dates.today() },
    { name: 'time', label: 'Time', type: 'time', value: stampNow ? nowHM() : (normalize(original)?.time || '') },
    { name: 'weight', label: `Weight (${unit})`, type: 'number', required: true, autofocus: true, step: 0.1, min: 1, placeholder: unit === 'lb' ? 'e.g. 180.4' : 'e.g. 82.4', value: lastKg != null ? round1(toDisplay(lastKg, unit)) : '' },
    { name: 'bodyFat', label: 'Body fat %', type: 'number', step: 0.1, min: 1, max: 80, placeholder: 'optional', value: original?.bodyFat ?? '' },
    { name: 'note', label: 'Note', type: 'text', placeholder: 'optional — e.g. after travel', value: original?.note || '' },
  ]);

  // Put the weight input between two big stepper buttons.
  const wIn = f.fields.weight.input;
  const bump = (d) => {
    const cur = parseFloat(String(wIn.value).replace(',', '.'));
    const base = Number.isFinite(cur) ? cur : (lastKg != null ? toDisplay(lastKg, unit) : 0);
    wIn.value = round1(Math.max(0, base + d)).toFixed(1);
    wIn.classList.remove('invalid');
    if (navigator.vibrate) navigator.vibrate(5);
  };
  const stepBtn = (label, d) => h('button.btn', {
    type: 'button', 'aria-label': `${d < 0 ? 'Decrease' : 'Increase'} weight by 0.1`,
    style: { minWidth: '72px', flex: '0 0 auto', fontSize: '17px' },
    onclick: (e) => { e.preventDefault(); bump(d); },
  }, label);
  const stepRow = h('div.row', { style: { gap: '8px' } });
  wIn.replaceWith(stepRow);
  Object.assign(wIn.style, { flex: '1', minWidth: '0', textAlign: 'center', fontSize: '22px', fontWeight: '700' });
  stepRow.append(stepBtn('−0.1', -0.1), wIn, stepBtn('+0.1', 0.1));
  // The field is prefilled with the last weight: select it on focus so typing replaces it instead of appending digits.
  wIn.addEventListener('focus', () => setTimeout(() => { try { wIn.select(); } catch { /* not all input types support select() */ } }, 0));

  // Date and time side by side: the time is already filled in, so it costs no extra tap.
  const dIn = f.fields.date.input, tIn = f.fields.time.input;
  const dRow = dIn.closest('.field'), tRow = tIn.closest('.field');
  if (dRow && tRow) { const pair = h('div.grid-2'); dRow.replaceWith(pair); pair.append(dRow, tRow); }

  // Moving the date onto a day that already has an entry: prefill its body fat / note so saving does not wipe them.
  dIn.addEventListener('change', async () => {
    const d = dIn.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d === original?.date) return;
    const ex = (await ctx.db.where(STORE, 'date', d)).map(normalize).filter(Boolean)[0];
    if (!ex || dIn.value !== d) return;
    const bfIn = f.fields.bodyFat.input, nIn = f.fields.note.input;
    if (String(bfIn.value).trim() === '' && ex.bodyFat != null) bfIn.value = ex.bodyFat;
    if (String(nIn.value).trim() === '' && ex.note) nIn.value = ex.note;
    toast(`${dates.label(d)} already has a weigh-in — saving will update it`);
  });

  const save = async () => {
    const err = f.validate(); if (err) { toast(err); return false; }
    const v = f.values();
    const kg = toKg(Number(v.weight), unit);
    if (!Number.isFinite(kg) || kg <= 0 || kg > 700) { wIn.classList.add('invalid'); toast('Enter a valid weight'); return false; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) { toast('Pick a date'); return false; }
    if (v.date > dates.today()) { dIn.classList.add('invalid'); toast("You can't log a future weigh-in"); return false; }
    dIn.classList.remove('invalid');
    const bf = v.bodyFat == null ? null : Number(v.bodyFat);
    const time = isHM(String(v.time || '').slice(0, 5)) ? String(v.time).slice(0, 5) : '';
    const data = { date: v.date, time, kg: round2(kg), bodyFat: Number.isFinite(bf) && bf > 0 ? round1(bf) : null, note: String(v.note || '').trim() };
    const { merged } = await saveEntry(ctx, data, original);
    toast(merged ? `Updated ${dates.label(data.date)} · ${fmtW(data.kg, unit)}` : original ? 'Entry updated' : `Logged ${fmtW(data.kg, unit)}`);
    return true;
  };

  const actions = [];
  if (original) {
    actions.push({
      label: 'Delete', danger: true,
      onClick: async () => {
        const ok = await confirm(`Delete the weigh-in from ${dates.label(original.date)}?`);
        if (!ok) return false;
        await ctx.db.delete(STORE, original.id);
        toast('Entry deleted', { action: 'Undo', onAction: () => ctx.db.put(STORE, original) });
        return true;
      },
    });
  }
  actions.push({ label: original ? 'Save' : 'Save weight', primary: true, onClick: save });
  const s = sheet({ title: original ? 'Edit weigh-in' : 'Log weight', content: f.el, actions });
  f.focus();
  f.el.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); if ((await save()) !== false) s.close(); }
  });
}

async function setGoal(ctx, onDone) {
  const unit = unitOf(ctx), goal = goalOf(ctx);
  const v = await formSheet({
    title: 'Goal weight',
    fields: [{ name: 'goal', label: `Goal (${unit})`, type: 'number', step: 0.1, min: 1, autofocus: true, placeholder: 'leave empty to remove the goal', value: goal != null ? round1(toDisplay(goal, unit)) : '', hint: 'Shown as a dashed line on the chart; change chips turn green when you move toward it.' }],
    saveLabel: 'Save goal',
  });
  if (!v) return;
  if (v.goal == null || !(v.goal > 0)) { ctx.settings.set('weight:goal', null); toast('Goal removed'); }
  else { ctx.settings.set('weight:goal', round2(toKg(v.goal, unit))); toast(`Goal set: ${fmtW(toKg(v.goal, unit), unit)}`); }
  onDone?.();
}

// ---------- chart ----------
/** Main smooth line = 7-day average when ≥7 points in range (raw days as faint dots), otherwise the raw series.
 *  `entries` is the FULL ascending list; `since` (date key or null) cuts the drawn window. The average is computed over
 *  all entries first and filtered afterwards, so the line is the same for a given date in every range. */
function trendChart(entries, since, goalKg, unit) {
  const H = 180;
  const toD = (kg) => round1(toDisplay(kg, unit));
  const inRange = (list) => (since ? list.filter((p) => p.date >= since) : list);
  const raw = inRange(entries).map((e) => ({ x: e.date, y: toD(e.kg) }));
  const useAvg = raw.length >= 7;
  const series = useAvg ? inRange(movingAvg(entries)).map((m) => ({ x: m.date, y: toD(m.avg) })) : raw;
  const goal = goalKg != null ? toD(goalKg) : undefined;
  const ys = raw.map((p) => p.y).concat(series.map((p) => p.y)); if (goal != null) ys.push(goal);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const chart = lineChart(series, { height: H, goal, yMin, yMax, showDots: useAvg ? false : raw.length <= 60 });
  const dotsDrawn = useAvg && overlayRawPoints(chart, raw, yMin, yMax, H);
  return h('div', chart, h('div.small.muted', { style: { textAlign: 'center', marginTop: '4px' } },
    useAvg ? (dotsDrawn ? 'Line: 7-day average · dots: daily weigh-ins' : 'Line: 7-day average') : `${raw.length} weigh-in${raw.length === 1 ? '' : 's'} · 7-day average appears from 7 entries`,
    goal != null ? ' · dashed: goal' : ''));
}
/** Draw raw daily points onto a lineChart svg using the same scale maths as ui.lineChart. Returns true when drawn. */
function overlayRawPoints(chart, raw, yMin0, yMax0, H) {
  try {
    const svg = chart.querySelector('svg'); if (!svg || raw.length > 400) return false;
    const W = 320, padL = 36, padR = 10, padT = 10, padB = 24;
    const xs = raw.map((p) => dates.parse(p.x).getTime());
    let xMin = Math.min(...xs), xMax = Math.max(...xs); if (xMin === xMax) { xMin -= 1; xMax += 1; }
    const span = (yMax0 - yMin0) || 1, yMin = yMin0 - span * 0.1, yMax = yMax0 + span * 0.1;
    const sx = (x) => padL + ((x - xMin) / (xMax - xMin)) * (W - padL - padR);
    const sy = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * (H - padT - padB);
    const r = raw.length > 120 ? 1.6 : 2.2;
    svg.insertAdjacentHTML('beforeend', raw.map((p, i) => `<circle cx="${sx(xs[i]).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${r}" fill="var(--text-2)" opacity="0.55"/>`).join(''));
    return true;
  } catch (e) { console.warn('weight: raw overlay failed', e); return false; }
}

// ---------- AI actions: private helpers ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Validate an optional 'YYYY-MM-DD' action arg (default today); weigh-ins can't be in the future. */
function actionDate(d) {
  if (d === undefined || d === null || d === '') return dates.today();
  if (typeof d !== 'string' || !DATE_RE.test(d)) throw new Error(`date must be YYYY-MM-DD, got "${d}"`);
  if (d > dates.today()) throw new Error(`Can't log a future weigh-in (${d} is after today ${dates.today()})`);
  return d;
}
/** Compact one-line description of an entry for the model, in the user's unit, with id. */
function entryLine(e, unit) {
  const parts = [`${e.date}${e.time ? ' ' + e.time : ''}: ${fmtW(e.kg, unit)}`];
  if (e.bodyFat != null) parts.push(`${fmt.num(e.bodyFat, 1)}% fat`);
  if (e.note) parts.push(e.note.length > 80 ? e.note.slice(0, 77) + '…' : e.note);
  return `${parts.join(' · ')} (id ${e.id})`;
}
/** How the UI names a weigh-in in confirmation previews: '82.4 kg from Yesterday · 18.0% fat · "after travel"'. */
function entryLabel(e, unit) {
  const parts = [`${fmtW(e.kg, unit)} from ${whenLabel(e)}`];
  if (e.bodyFat != null) parts.push(`${fmt.num(e.bodyFat, 1)}% fat`);
  if (e.note) parts.push(`"${e.note.length > 40 ? e.note.slice(0, 37) + '…' : e.note}"`);
  return parts.join(' · ');
}
/** Preview-only lookup: the normalized weigh-in for an id, or null (never throws). */
async function previewEntry(ctx, id) {
  try {
    const key = id == null ? '' : String(id).trim();
    if (!key || !ctx?.db) return null;
    return normalize(await ctx.db.get(STORE, key));
  } catch { return null; }
}

function changeChip(delta, label, current, goalKg, unit) {
  if (delta == null) return null;
  const dir = towardGoal(delta, current, goalKg);
  const arrow = Math.abs(round1(toDisplay(delta, unit))) < 0.05 ? null : icon(delta < 0 ? 'arrowDown' : 'arrowUp', 14);
  return h('span.chip', { class: dir }, arrow, `${fmtDelta(delta, unit)} · ${label}`);
}

// ---------- module ----------
export default {
  id: 'weight',
  title: 'Weight',
  subtitle: 'Daily weigh-ins & trend',
  icon: 'scale',
  tab: 'body',
  stores: { weights: { indexes: ['date'] } },

  async render(container, ctx) {
    let range = ctx.settings.get('weight:range', '3M');
    if (!RANGES.some((r) => r.value === range)) range = '3M';
    let showAll = false;
    const body = h('div');
    container.append(body, fab(() => openEntry(ctx), 'Log weight'));

    const draw = async () => {
      const entries = await loadAll(ctx);
      const unit = unitOf(ctx), goal = goalOf(ctx), height = heightOf(ctx);
      clear(body);

      if (!entries.length) {
        body.append(card(
          empty('No weigh-ins yet', 'Weigh yourself each morning after the bathroom, before breakfast — same scale, same clothes. Your trend line appears after 7 entries.', 'scale'),
          h('button.btn.primary.block', { onclick: () => openEntry(ctx) }, icon('plus'), 'Log your first weight'),
          h('button.btn.block.ghost', { style: { marginTop: '8px' }, onclick: () => setGoal(ctx, draw) }, icon('goal'), goal != null ? `Goal ${fmtW(goal, unit)}` : 'Set a goal weight')));
        return;
      }

      const latest = entries[entries.length - 1];
      const ma = movingAvg(entries);
      const avg7 = ma[ma.length - 1];
      const d7 = changeSince(entries, latest, 7), d30 = changeSince(entries, latest, 30);

      // --- current weight ---
      body.append(card(
        h('div.card-title', h('h3', 'Current'),
          h('button.link', { style: LINK_STYLE, onclick: () => setGoal(ctx, draw) }, goal != null ? `Goal ${fmtW(goal, unit)}` : 'Set goal')),
        h('div.big-number', numW(latest.kg, unit), h('small', unit)),
        h('div.small.muted', { style: { marginTop: '6px' } },
          whenLabel(latest), avg7.n >= 2 ? ` · 7-day avg ${fmtW(avg7.avg, unit)}` : ''),
        d7 != null || d30 != null
          ? h('div.chips.mt', changeChip(d7, 'vs 7 days', latest.kg, goal, unit), changeChip(d30, 'vs 30 days', latest.kg, goal, unit))
          : h('div.small.muted.mt', 'Keep logging — changes vs 7 and 30 days show up here.')));

      // --- trend chart ---
      const rangeDef = RANGES.find((r) => r.value === range);
      const since = rangeDef.days ? dates.addDays(dates.today(), -rangeDef.days) : null;
      const inRange = since ? entries.filter((e) => e.date >= since) : entries;
      const seg = segmented(RANGES.map((r) => ({ value: r.value, label: r.label })), range, (v) => { range = v; ctx.settings.set('weight:range', v); draw(); });
      body.append(card(
        h('div.card-title', h('h3', 'Trend'), h('span.small.muted', inRange.length ? `${inRange.length} weigh-in${inRange.length === 1 ? '' : 's'}` : '')),
        h('div.mb', seg),
        inRange.length ? trendChart(entries, since, goal, unit) : h('div.chart-empty', 'No weigh-ins in this range')));

      // --- stats ---
      const first = entries[0];
      const lowest = entries.reduce((a, e) => (e.kg < a.kg ? e : a), entries[0]);
      const toGo = goal != null ? goal - latest.kg : null;
      const goalStat = stat('Goal', goal != null ? numW(goal, unit) : '—',
        goal == null ? 'tap to set' : Math.abs(round1(toDisplay(toGo, unit))) < 0.05 ? 'reached!' : `${fmtDelta(toGo, unit, false)} to go`);
      goalStat.classList.add('tappable'); goalStat.onclick = () => setGoal(ctx, draw);
      const stats = [
        stat('Start', numW(first.kg, unit), dates.label(first.date)),
        stat('Lowest', numW(lowest.kg, unit), dates.label(lowest.date)),
        goalStat,
      ];
      if (height) { const b = bmi(latest.kg, height); stats.push(stat('BMI', fmt.num(b, 1), bmiLabel(b))); }
      body.append(h('div.stats.mb', { style: { gridTemplateColumns: `repeat(${stats.length}, 1fr)` } }, stats));

      // --- entries, newest first ---
      body.append(h('div.section-title', `Entries · ${entries.length}`));
      const desc = entries.slice().reverse();
      const shown = showAll ? desc : desc.slice(0, 30);
      const list = h('div.list');
      shown.forEach((e, i) => {
        const prev = entries[entries.length - 2 - i];
        const delta = prev ? e.kg - prev.kg : null;
        const sub = [whenLabel(e)];
        if (e.bodyFat != null) sub.push(`${fmt.num(e.bodyFat, 1)}% fat`);
        if (e.note) sub.push(e.note);
        list.append(listItem({
          title: fmtW(e.kg, unit),
          sub: sub.join(' · '),
          right: delta == null ? h('span.small.muted', 'first') : h('span.small', { class: towardGoal(delta, e.kg, goal) || 'muted' }, fmtDelta(delta, unit, false)),
          onClick: () => openEntry(ctx, e),
        }));
      });
      body.append(card(list,
        desc.length > shown.length ? h('button.btn.block.ghost', { onclick: () => { showAll = true; draw(); } }, `Show all ${desc.length}`) : null));
    };

    await draw();
    const off = ctx.db.onChange(STORE, draw);
    const onSettings = (e) => { const k = e.detail?.key || ''; if (k === 'units' || (k.startsWith('weight:') && k !== 'weight:range')) draw(); };
    window.addEventListener('settings:change', onSettings);
    if (ctx.params?.add === '1') openEntry(ctx);
    return () => { off(); window.removeEventListener('settings:change', onSettings); };
  },

  quickActions: [{ label: 'Log weight', icon: 'scale', run: (ctx) => openEntry(ctx) }],

  async todayCard(ctx) {
    const entries = await loadAll(ctx);
    const unit = unitOf(ctx), goal = goalOf(ctx);
    const open = () => ctx.nav('body/weight');
    const title = (link) => h('div.card-title', h('h3', 'Weight'), h('button.link', { style: LINK_STYLE, onclick: (e) => { e.stopPropagation(); open(); } }, link));
    if (!entries.length) {
      return card(title('Open'),
        h('p.small.muted', 'Weigh in each morning to see your trend.'),
        h('button.btn.primary.block', { onclick: () => openEntry(ctx) }, icon('scale'), "Log today's weight"));
    }
    const latest = entries[entries.length - 1];
    const d7 = changeSince(entries, latest, 7);
    if (latest.date === dates.today()) {
      const dir = towardGoal(d7, latest.kg, goal);
      return card({ class: 'tappable', onclick: open },
        title('Details'),
        h('div.row.between',
          h('div', h('div', { style: { fontWeight: 700, fontSize: '18px' } }, `Today ${fmtW(latest.kg, unit)}`),
            latest.time ? h('div.small.muted', `at ${timeLabel(latest.time)}`) : null),
          d7 != null
            ? h('span.chip', { class: dir }, Math.abs(d7) >= 0.05 ? icon(d7 < 0 ? 'arrowDown' : 'arrowUp', 14) : null, `${fmtDelta(d7, unit, false)} this week`)
            : h('span.chip', 'first week')));
    }
    return card(title('Details'),
      h('p.small.muted', `Last ${fmtW(latest.kg, unit)} · ${dates.ago(latest.date)}${d7 != null ? ` · ${fmtDelta(d7, unit, false)} that week` : ''}`),
      h('button.btn.primary.block', { onclick: () => openEntry(ctx) }, icon('scale'), "Log today's weight"));
  },

  async exportForAI(ctx, { since, days } = {}) {
    const entries = await loadAll(ctx);
    if (!entries.length) return '';
    const today = dates.today();
    since = since || dates.addDays(today, -(days || 90));
    const first = entries[0], latest = entries[entries.length - 1];
    const lowest = entries.reduce((a, e) => (e.kg < a.kg ? e : a), first);
    const highest = entries.reduce((a, e) => (e.kg > a.kg ? e : a), first);
    const goal = goalOf(ctx), height = heightOf(ctx);
    const ma = movingAvg(entries); const avg7 = ma[ma.length - 1];
    const d7 = changeSince(entries, latest, 7), d30 = changeSince(entries, latest, 30);
    const rate = weeklyRate(entries, 30);
    const k = (kg) => `${kg.toFixed(1)} kg`;
    const lines = [
      '## Weight (all values in kg)',
      `- Entries: ${entries.length} (${first.date} → ${latest.date})`,
      `- Latest: ${k(latest.kg)} on ${latest.date}${latest.time ? ' at ' + latest.time : ''} (${dates.ago(latest.date)}); 7-day average ${k(avg7.avg)} over ${avg7.n} day${avg7.n === 1 ? '' : 's'}`,
      `- First: ${k(first.kg)} on ${first.date}; total change ${signed(latest.kg - first.kg)} kg`,
      `- Lowest: ${k(lowest.kg)} (${lowest.date}); highest: ${k(highest.kg)} (${highest.date})`,
      goal != null ? `- Goal: ${k(goal)} (${signed(goal - latest.kg)} kg to go)` : '- Goal: not set',
      height ? `- Height ${height} cm → BMI ${bmi(latest.kg, height).toFixed(1)} (${bmiLabel(bmi(latest.kg, height))})` : null,
      rate != null ? `- Rate of change, last 30 days: ${signed(rate)} kg/week` : '- Rate of change, last 30 days: not enough data',
      d7 != null ? `- Change vs 7 days ago: ${signed(d7)} kg${d30 != null ? `; vs 30 days ago: ${signed(d30)} kg` : ''}` : null,
    ];
    const bf = entries.filter((e) => e.bodyFat != null);
    if (bf.length) {
      const l = bf[bf.length - 1];
      const ref = entryAt(bf, dates.addDays(l.date, -30));
      lines.push(`- Body fat: ${l.bodyFat.toFixed(1)}% on ${l.date}${ref && ref !== l ? `; ${ref.bodyFat.toFixed(1)}% on ${ref.date}` : ''} (${bf.length} reading${bf.length === 1 ? '' : 's'})`);
    }
    const period = entries.filter((e) => e.date >= since);
    if (period.length) {
      const weeks = new Map();
      for (const e of period) { const w = dates.weekStart(e.date); const a = weeks.get(w) || { sum: 0, n: 0 }; a.sum += e.kg; a.n++; weeks.set(w, a); }
      lines.push('', `Weekly averages since ${since} (week starting Monday):`);
      for (const [w, a] of [...weeks.entries()].slice(-26)) lines.push(`- ${w}: ${(a.sum / a.n).toFixed(1)} kg (${a.n} day${a.n === 1 ? '' : 's'})`);
    }
    const timed = entries.slice(-30).filter((e) => e.time);
    if (timed.length >= 3) {
      // Weigh-in time matters for comparability (morning vs evening can differ by 1 kg+).
      const mins = timed.map((e) => { const [hh, mm] = e.time.split(':').map(Number); return hh * 60 + mm; });
      const avgMin = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
      const spread = Math.max(...mins) - Math.min(...mins);
      lines.push(`- Usual weigh-in time: ~${dates.pad(Math.floor(avgMin / 60))}:${dates.pad(avgMin % 60)} (spread ${Math.floor(spread / 60)}h${dates.pad(spread % 60)}m over ${timed.length} timed entries)`);
    }
    lines.push('', 'Last 30 entries:');
    for (const e of entries.slice(-30).reverse()) {
      lines.push(`${e.date}${e.time ? ' ' + e.time : ''}: ${e.kg.toFixed(1)} kg${e.bodyFat != null ? ` · ${e.bodyFat.toFixed(1)}% fat` : ''}${e.note ? ` · ${e.note.slice(0, 300)}` : ''}`);
    }
    return lines.filter((l) => l !== null).join('\n');
  },

  actions: [
    {
      name: 'log',
      description: "Log a weigh-in in the user's unit (kg or lb, see settings). Dates are YYYY-MM-DD; omit date for today. One entry per day: logging onto a date that already has a weigh-in updates it. Use this for 'I weigh 82.4' / 'log 180 lb yesterday'.",
      params: {
        weight: { type: 'number', description: "Body weight in the user's unit (kg or lb)" },
        date: { type: 'string', description: 'Date YYYY-MM-DD (default today; cannot be in the future)' },
        time: { type: 'string', description: 'Time of the weigh-in HH:MM 24h. Omit it when the user is weighing in now: today\'s entries get the current time automatically. Give it when they mention one ("this morning at 7").' },
        body_fat: { type: 'number', description: 'Optional body fat percentage (1–80)' },
        note: { type: 'string', description: "Optional short note, e.g. 'after travel'" },
      },
      required: ['weight'],
      write: true,
      preview: async (args = {}, ctx) => {
        const extras = `${args.body_fat != null && args.body_fat !== '' ? ` · ${args.body_fat}% fat` : ''}${args.note ? ` · "${args.note}"` : ''}`;
        try {
          const unit = ctx ? unitOf(ctx) : '';
          const date = typeof args.date === 'string' && DATE_RE.test(args.date) ? args.date : args.date ? null : dates.today();
          const when = date ? dates.label(date) : String(args.date);
          const weight = `${args.weight}${unit ? ' ' + unit : ''}`;
          // One entry per day: logging onto a date that already has a weigh-in updates it, so say so.
          const existing = date && ctx?.db ? (await ctx.db.where(STORE, 'date', date)).map(normalize).filter(Boolean)[0] : null;
          if (existing) return `Update weigh-in ${when} ${fmtW(existing.kg, unit)} → ${weight}${extras}`;
          return `Log weight ${weight}${date === dates.today() ? ' today' : ' on ' + when}${extras}`;
        } catch {
          return `Log weight ${args.weight}${args.date ? ' on ' + args.date : ' today'}${extras}`;
        }
      },
      async run(ctx, args = {}) {
        const unit = unitOf(ctx);
        const w = Number(args.weight);
        if (!Number.isFinite(w) || w <= 0) throw new Error(`weight must be a positive number in ${unit}`);
        const kg = toKg(w, unit);
        if (kg > 700) throw new Error(`weight ${w} ${unit} is not a plausible body weight`);
        const date = actionDate(args.date);
        let bodyFat = null;
        if (args.body_fat !== undefined && args.body_fat !== null && args.body_fat !== '') {
          const bf = Number(args.body_fat);
          if (!Number.isFinite(bf) || bf < 1 || bf > 80) throw new Error('body_fat must be a percentage between 1 and 80');
          bodyFat = round1(bf);
        }
        const note = args.note == null ? '' : String(args.note).trim().slice(0, 300);
        let time = '';
        if (args.time !== undefined && args.time !== null && args.time !== '') {
          if (!isHM(String(args.time))) throw new Error('time must be HH:MM (24h), e.g. 07:15');
          time = String(args.time);
        } else if (date === dates.today()) time = nowHM(); // weighing in now
        const { rec, merged } = await saveEntry(ctx, { date, time, kg: round2(kg), bodyFat, note }, null);
        const saved = normalize(rec) || { ...rec, kg: round2(kg), bodyFat, note };
        return `${merged ? 'Updated' : 'Logged'} ${fmtW(saved.kg, unit)} on ${saved.date}${saved.time ? ' at ' + saved.time : ''}${saved.bodyFat != null ? ` · ${fmt.num(saved.bodyFat, 1)}% fat` : ''}${saved.note ? ` · ${saved.note}` : ''} (id ${saved.id})`;
      },
    },
    {
      name: 'list',
      description: "List recent weigh-ins, newest first, in the user's unit, with ids (use an id with weight_delete). Also returns the latest weight and 7-day average.",
      params: {
        limit: { type: 'integer', description: 'How many entries to return (default 10, max 20)' },
      },
      write: false,
      async run(ctx, args = {}) {
        const unit = unitOf(ctx);
        let limit = args.limit == null || args.limit === '' ? 10 : Number(args.limit);
        if (!Number.isFinite(limit) || limit < 1) throw new Error('limit must be a positive whole number');
        limit = Math.min(20, Math.floor(limit));
        const entries = await loadAll(ctx);
        if (!entries.length) return 'No weigh-ins logged yet.';
        const latest = entries[entries.length - 1];
        const ma = movingAvg(entries); const avg7 = ma[ma.length - 1];
        const goal = goalOf(ctx);
        const head = [
          `Weight (${unit}): ${entries.length} entries, ${entries[0].date} → ${latest.date}.`,
          `Latest ${fmtW(latest.kg, unit)} on ${latest.date}; 7-day avg ${fmtW(avg7.avg, unit)} (${avg7.n} day${avg7.n === 1 ? '' : 's'}).`,
          goal != null ? `Goal ${fmtW(goal, unit)} (${fmtDelta(goal - latest.kg, unit)} to go).` : 'Goal: not set.',
        ].join(' ');
        const shown = entries.slice(-limit).reverse();
        const lines = shown.map((e) => entryLine(e, unit));
        if (entries.length > shown.length) lines.push(`… ${entries.length - shown.length} older entr${entries.length - shown.length === 1 ? 'y' : 'ies'} not shown.`);
        return [head, '', ...lines].join('\n').slice(0, 1500);
      },
    },
    {
      name: 'delete',
      description: 'Delete one weigh-in by id (get ids from weight_list). Use when the user says an entry was a mistake.',
      params: {
        id: { type: 'string', description: 'The weigh-in id, as shown by weight_list' },
      },
      required: ['id'],
      write: true,
      preview: async (args = {}, ctx) => {
        const e = await previewEntry(ctx, args.id);
        if (!e) return `Delete weigh-in ${args.id}`;
        try { return `Delete weigh-in ${entryLabel(e, unitOf(ctx))}`; } catch { return `Delete weigh-in ${args.id}`; }
      },
      async run(ctx, args = {}) {
        const id = args.id == null ? '' : String(args.id).trim();
        if (!id) throw new Error('id is required');
        const rec = await ctx.db.get(STORE, id);
        if (!rec) throw new Error(`No weigh-in with id ${id}`);
        const e = normalize(rec);
        await ctx.db.delete(STORE, id);
        const unit = unitOf(ctx);
        return e ? `Deleted weigh-in ${fmtW(e.kg, unit)} from ${e.date} (id ${id})` : `Deleted weigh-in (id ${id})`;
      },
    },
  ],

  async settings(ctx) {
    let unit = unitOf(ctx);
    const goal = goalOf(ctx), height = heightOf(ctx);
    const f = form([
      { name: 'goal', label: `Goal weight (${unit})`, type: 'number', step: 0.1, min: 1, placeholder: 'none', value: goal != null ? round1(toDisplay(goal, unit)) : '' },
      { name: 'height', label: 'Height (cm)', type: 'number', step: 1, min: 50, max: 272, placeholder: 'optional — enables BMI', value: height ?? '' },
    ]);
    f.el.addEventListener('change', () => {
      unit = unitOf(ctx); // the Preferences form on this screen may have switched kg/lb since we were built
      const v = f.values();
      ctx.settings.set('weight:goal', v.goal != null && v.goal > 0 ? round2(toKg(v.goal, unit)) : null);
      ctx.settings.set('weight:height', v.height != null && v.height > 0 ? Math.round(v.height) : null);
      toast('Weight settings saved');
    });
    // Units switched live on the same Settings screen: relabel the goal field and re-convert its value.
    const goalIn = f.fields.goal.input;
    const goalLabel = goalIn.closest('.field')?.querySelector('.field-label');
    const onUnits = (e) => {
      if (e.detail?.key !== 'units') return;
      if (!f.el.isConnected) { window.removeEventListener('settings:change', onUnits); return; }
      unit = unitOf(ctx);
      if (goalLabel) goalLabel.textContent = `Goal weight (${unit})`;
      const g = goalOf(ctx);
      goalIn.value = g != null ? round1(toDisplay(g, unit)) : '';
    };
    window.addEventListener('settings:change', onUnits);
    return h('div', f.el, h('p.small.muted', { style: { marginTop: '8px' } }, 'The goal shows as a dashed line on the chart; height enables BMI.'));
  },
};
