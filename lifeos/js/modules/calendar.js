// calendar.js — Events & schedule. Month grid + 30-day agenda, recurring events (expanded in memory),
// tasks overlay (read-only from the 'tasks' store), Google Calendar hand-off, .ics import/export.
import { h, clear, dates, fmt, icon, toast, sheet, confirm, form, segmented, empty, card, listItem, fab, pickFile, downloadText } from '../ui.js';

const STORE = 'events';
const HORIZON_DAYS = 730; // open-ended recurring events expand at most 2 years ahead of today
const RECURRENCE = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'yearly', label: 'Every year' },
];
const RECUR_WORD = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' };
const COLORS = [
  { value: '', label: 'Default (blue)' },
  { value: 'green', label: 'Green' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'red', label: 'Red' },
  { value: 'purple', label: 'Purple' },
];
const COLOR_CSS = { '': 'var(--accent)', green: 'var(--good)', yellow: 'var(--warn)', red: 'var(--bad)', purple: 'var(--accent-2)' };

// Module-level view state (survives re-renders within a session).
const state = { view: 'month', month: dates.monthStart(dates.today()), selected: dates.today() };

// ---------- record helpers ----------
function norm(e) {
  e = e || {};
  return {
    ...e,
    date: typeof e.date === 'string' && e.date ? e.date : dates.today(),
    time: typeof e.time === 'string' ? e.time : '',
    endTime: typeof e.endTime === 'string' ? e.endTime : '',
    title: (e.title || '').trim() || 'Untitled',
    notes: e.notes || '',
    location: e.location || '',
    allDay: !!e.allDay,
    color: Object.hasOwn(COLOR_CSS, e.color) ? e.color : '',
    recurrence: RECURRENCE.some((r) => r.value === e.recurrence) ? e.recurrence : 'none',
    recurrenceEnd: typeof e.recurrenceEnd === 'string' ? e.recurrenceEnd : '',
  };
}
/** 'Today · Fri 30 Oct' / 'Mon 2 Nov' */
function dayHeading(k) {
  const lbl = dates.label(k);
  const full = dates.parse(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return ['Today', 'Yesterday', 'Tomorrow'].includes(lbl) ? `${lbl} · ${full}` : lbl;
}
const isHM = (t) => /^\d{2}:\d{2}$/.test(t || '');
const isTimed = (ev) => !ev.allDay && isHM(ev.time);
const colorOf = (ev) => COLOR_CSS[ev.color] || COLOR_CSS[''];
const isRecurring = (ev) => ev.recurrence && ev.recurrence !== 'none';

function fmtTime(t) {
  if (!isHM(t)) return '';
  const [hh, mm] = t.split(':').map(Number);
  return dates.time(new Date(2000, 0, 1, hh, mm).getTime());
}
function timeRange(ev) {
  if (!isTimed(ev)) return 'All day';
  return fmtTime(ev.time) + (isHM(ev.endTime) ? ' – ' + fmtTime(ev.endTime) : '');
}
function addMinutes(hm, mins) {
  const [hh, mm] = hm.split(':').map(Number);
  const total = ((hh * 60 + mm + mins) % 1440 + 1440) % 1440;
  return dates.pad(Math.floor(total / 60)) + ':' + dates.pad(total % 60);
}
function nowHM() { const d = new Date(); return dates.pad(d.getHours()) + ':' + dates.pad(d.getMinutes()); }

/** Date keys on which `ev` occurs within [from, to] (inclusive). Expands recurrence in memory. */
function occurrenceDates(ev, from, to) {
  const start = ev.date;
  if (!start) return [];
  if (!isRecurring(ev)) return start >= from && start <= to ? [start] : [];
  // Open-ended series are expanded up to 2 years past today (never stored), so old yearly events keep showing.
  let end = dates.addDays(dates.today(), HORIZON_DAYS);
  if (ev.recurrenceEnd && ev.recurrenceEnd < end) end = ev.recurrenceEnd;
  if (to < end) end = to;
  if (end < start) return [];
  const out = [];
  if (ev.recurrence === 'daily' || ev.recurrence === 'weekly') {
    const step = ev.recurrence === 'daily' ? 1 : 7;
    let k = start;
    if (from > start) k = dates.addDays(start, Math.ceil(dates.daysBetween(start, from) / step) * step);
    while (k <= end) { out.push(k); k = dates.addDays(k, step); }
  } else {
    const sd = dates.parse(start);
    const mStep = ev.recurrence === 'monthly' ? 1 : 12;
    for (let i = 0; i < 1500; i++) {
      const y = sd.getFullYear(), m = sd.getMonth() + i * mStep;
      const firstOfMonth = dates.key(new Date(y, m, 1));
      if (firstOfMonth > end) break;
      const dim = new Date(y, m + 1, 0).getDate();
      if (sd.getDate() > dim) continue; // e.g. 31st in a 30-day month: skip
      const k = dates.key(new Date(y, m, sd.getDate()));
      if (k > end) break;
      if (k >= from) out.push(k);
    }
  }
  return out;
}

/** Occurrences {ev, date} for all events in [from, to], sorted by date, all-day first then by time. */
function expand(events, from, to) {
  const out = [];
  for (const raw of events) {
    const ev = norm(raw);
    for (const d of occurrenceDates(ev, from, to)) out.push({ ev, date: d });
  }
  out.sort(cmpOcc);
  return out;
}
function cmpOcc(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ta = isTimed(a.ev) ? a.ev.time : '', tb = isTimed(b.ev) ? b.ev.time : '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.ev.title.localeCompare(b.ev.title);
}
function groupByDate(list) {
  const map = new Map();
  for (const it of list) { if (!map.has(it.date)) map.set(it.date, []); map.get(it.date).push(it); }
  return map;
}

/** Open (not done) tasks in [from, to] from the tasks module's store — read-only, tolerant of the store missing. */
async function loadTasks(ctx, from, to) {
  try {
    const rows = await ctx.db.range('tasks', from, to);
    return (rows || []).filter((t) => t && !t.done && typeof t.date === 'string')
      .sort((a, b) => (a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : String(a.title || '').localeCompare(String(b.title || '')));
  } catch { return []; }
}

// ---------- Google Calendar ----------
function gcalUrl(ev, occDate) {
  ev = norm(ev);
  const d = occDate || ev.date;
  const ymd = (k) => k.replace(/-/g, '');
  let when;
  if (!isTimed(ev)) when = `${ymd(d)}/${ymd(dates.addDays(d, 1))}`;
  else {
    const endT = isHM(ev.endTime) ? ev.endTime : addMinutes(ev.time, 60);
    const endD = endT <= ev.time ? dates.addDays(d, 1) : d;
    when = `${ymd(d)}T${ev.time.replace(':', '')}00/${ymd(endD)}T${endT.replace(':', '')}00`;
  }
  const p = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates: when, details: ev.notes, location: ev.location });
  if (isRecurring(ev)) {
    let rule = 'RRULE:FREQ=' + ev.recurrence.toUpperCase();
    if (ev.recurrenceEnd) rule += ';UNTIL=' + ymd(ev.recurrenceEnd) + (isTimed(ev) ? 'T235959' : '');
    p.set('recur', rule);
  }
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

// ---------- iCalendar (.ics) ----------
function icsEscape(s) { return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsUnescape(s) { return String(s ?? '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\'); }
const utf8 = new TextEncoder();
/** RFC 5545 line folding: at most 75 octets per line, split on code points so surrogate pairs stay intact. */
function icsFold(line) {
  const parts = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = ch.charCodeAt(0) < 0x80 ? 1 : utf8.encode(ch).length;
    if (bytes + n > 75) { parts.push(cur); cur = ' ' + ch; bytes = 1 + n; }
    else { cur += ch; bytes += n; }
  }
  parts.push(cur);
  return parts.join('\r\n');
}
function icsStamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

function buildICS(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LifeOS//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:LifeOS'];
  const ymd = (k) => k.replace(/-/g, '');
  for (const raw of events) {
    const ev = norm(raw);
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + (ev.id || Math.random().toString(36).slice(2)) + '@lifeos');
    lines.push('DTSTAMP:' + icsStamp());
    if (isTimed(ev)) {
      const endT = isHM(ev.endTime) ? ev.endTime : addMinutes(ev.time, 60);
      const endD = endT <= ev.time ? dates.addDays(ev.date, 1) : ev.date;
      lines.push(`DTSTART:${ymd(ev.date)}T${ev.time.replace(':', '')}00`);
      lines.push(`DTEND:${ymd(endD)}T${endT.replace(':', '')}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${ymd(ev.date)}`);
      lines.push(`DTEND;VALUE=DATE:${ymd(dates.addDays(ev.date, 1))}`);
    }
    lines.push('SUMMARY:' + icsEscape(ev.title));
    if (ev.location) lines.push('LOCATION:' + icsEscape(ev.location));
    if (ev.notes) lines.push('DESCRIPTION:' + icsEscape(ev.notes));
    if (isRecurring(ev)) {
      let rule = 'RRULE:FREQ=' + ev.recurrence.toUpperCase();
      if (ev.recurrenceEnd) rule += ';UNTIL=' + ymd(ev.recurrenceEnd) + (isTimed(ev) ? 'T235959' : '');
      lines.push(rule);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/** Parse an iCalendar DATE / DATE-TIME value (optionally UTC 'Z') → { date, time, allDay } in local time. */
function parseICSDate(prop) {
  if (!prop) return null;
  const params = (prop.params || '').toUpperCase();
  const v = (prop.val || '').trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.includes('VALUE=DATE') && !v.includes('T')) {
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: '', allDay: true };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/);
  if (!m) return null;
  const [y, mo, d, hh, mm, ss] = [m[1], m[2], m[3], m[4], m[5], m[6] || '00'].map(Number);
  const dt = m[7] === 'Z' ? new Date(Date.UTC(y, mo - 1, d, hh, mm, ss)) : new Date(y, mo - 1, d, hh, mm, ss);
  if (isNaN(dt.getTime())) return null;
  return { date: dates.key(dt), time: dates.pad(dt.getHours()) + ':' + dates.pad(dt.getMinutes()), allDay: false };
}

/** Parse VEVENT blocks out of .ics text → array of event records (without ids). */
function parseICS(text) {
  const unfolded = String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  let skip = 0; // depth inside nested components (VALARM etc.) whose properties must not leak into the event
  for (const line of lines) {
    if (/^BEGIN:VEVENT\s*$/i.test(line)) { cur = {}; skip = 0; continue; }
    if (/^END:VEVENT\s*$/i.test(line)) { if (cur) blocks.push(cur); cur = null; skip = 0; continue; }
    if (!cur) continue;
    if (/^BEGIN:/i.test(line)) { skip++; continue; }
    if (/^END:/i.test(line)) { if (skip > 0) skip--; continue; }
    if (skip > 0) continue;
    const m = line.match(/^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const name = m[1].toUpperCase();
    if (!(name in cur)) cur[name] = { params: m[2] || '', val: m[3] };
  }
  const out = [];
  for (const b of blocks) {
    // A moved/edited single occurrence of a series: the series itself is already imported and we cannot store exceptions.
    if (b['RECURRENCE-ID']) continue;
    const ds = parseICSDate(b.DTSTART);
    if (!ds) continue;
    const de = parseICSDate(b.DTEND);
    const ev = {
      date: ds.date, time: ds.time, endTime: '',
      title: icsUnescape(b.SUMMARY?.val).trim() || 'Untitled',
      notes: icsUnescape(b.DESCRIPTION?.val).trim(),
      location: icsUnescape(b.LOCATION?.val).trim(),
      allDay: ds.allDay, color: '', recurrence: 'none', recurrenceEnd: '',
    };
    if (!ds.allDay && de && !de.allDay && de.time && !(de.date === ds.date && de.time === ds.time)) ev.endTime = de.time;
    if (b.RRULE) {
      const parts = Object.fromEntries(b.RRULE.val.split(';').map((p) => { const i = p.indexOf('='); return i > 0 ? [p.slice(0, i).toUpperCase(), p.slice(i + 1)] : [p.toUpperCase(), '']; }));
      const freq = (parts.FREQ || '').toLowerCase();
      if (RECUR_WORD[freq]) {
        ev.recurrence = freq;
        if (parts.UNTIL) { const u = parseICSDate({ params: '', val: parts.UNTIL }); if (u) ev.recurrenceEnd = u.date; }
        else if (parts.COUNT) { const end = countEnd(ev.date, freq, parseInt(parts.COUNT, 10)); if (end) ev.recurrenceEnd = end; }
      }
    }
    // Multi-day all-day event (DTEND;VALUE=DATE is exclusive): one record per day, capped to keep imports sane.
    if (ds.allDay && de && de.allDay && de.date > dates.addDays(ds.date, 1) && ev.recurrence === 'none') {
      const span = Math.min(dates.daysBetween(ds.date, de.date), 60);
      for (let i = 0; i < span; i++) out.push({ ...ev, date: dates.addDays(ds.date, i) });
      continue;
    }
    out.push(ev);
  }
  return out;
}
/** Date of the n-th occurrence (RRULE COUNT=n) of a series starting on start, used as recurrenceEnd. */
function countEnd(start, freq, n) {
  if (!Number.isFinite(n) || n < 1) return '';
  if (freq === 'daily') return dates.addDays(start, n - 1);
  if (freq === 'weekly') return dates.addDays(start, (n - 1) * 7);
  const sd = dates.parse(start);
  const months = (n - 1) * (freq === 'monthly' ? 1 : 12);
  const last = new Date(sd.getFullYear(), sd.getMonth() + months, 1);
  const dim = new Date(last.getFullYear(), last.getMonth() + 1, 0).getDate();
  return dates.key(new Date(last.getFullYear(), last.getMonth(), Math.min(sd.getDate(), dim)));
}

async function importICS(ctx) {
  const file = await pickFile({ accept: '.ics,text/calendar' });
  if (!file) return;
  let parsed;
  try { parsed = parseICS(await file.text()); } catch (e) { console.error(e); toast('Could not read that file'); return; }
  if (!parsed.length) { toast('No events found in that file'); return; }
  const existing = await ctx.db.all(STORE);
  const seen = new Set(existing.map((e) => dupKey(e)));
  const fresh = [];
  for (const ev of parsed) { const k = dupKey(ev); if (seen.has(k)) continue; seen.add(k); fresh.push(ev); }
  if (!fresh.length) { toast(`All ${parsed.length} events were already in your calendar`); return; }
  await ctx.db.putMany(STORE, fresh);
  const skipped = parsed.length - fresh.length;
  toast(`Imported ${fresh.length} event${fresh.length === 1 ? '' : 's'}` + (skipped ? ` · ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped` : ''));
}
function dupKey(e) { return String(e?.title || '').trim().toLowerCase() + '|' + (e?.date || ''); }

async function exportICS(ctx) {
  const events = await ctx.db.all(STORE, { index: 'date' });
  if (!events.length) { toast('No events to export yet'); return; }
  downloadText('lifeos-calendar.ics', buildICS(events), 'text/calendar');
  toast(`Exported ${events.length} event${events.length === 1 ? '' : 's'}`);
}

// ---------- add / edit sheet ----------
function eventFields() {
  return [
    { name: 'title', label: 'Title', type: 'text', placeholder: 'What is happening?', required: true, autofocus: true },
    { name: 'date', label: 'Date', type: 'date', required: true },
    { name: 'allDay', label: 'All day', type: 'toggle' },
    { name: 'time', label: 'Start time', type: 'time' },
    { name: 'endTime', label: 'End time', type: 'time' },
    { name: 'location', label: 'Location', type: 'text', placeholder: 'Optional' },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, placeholder: 'Optional' },
    { name: 'color', label: 'Color', type: 'select', options: COLORS },
    { name: 'recurrence', label: 'Repeat', type: 'select', options: RECURRENCE },
    { name: 'recurrenceEnd', label: 'Repeat until', type: 'date', hint: 'Leave empty to repeat for up to 2 years' },
  ];
}
function cleanValues(v) {
  const allDay = !!v.allDay;
  const rec = RECURRENCE.some((r) => r.value === v.recurrence) ? v.recurrence : 'none';
  return {
    date: v.date || dates.today(),
    time: allDay ? '' : (isHM(v.time) ? v.time : ''),
    endTime: allDay ? '' : (isHM(v.endTime) ? v.endTime : ''),
    title: (v.title || '').trim(),
    notes: v.notes || '',
    location: (v.location || '').trim(),
    allDay,
    color: Object.hasOwn(COLOR_CSS, v.color) ? v.color : '',
    recurrence: rec,
    recurrenceEnd: rec === 'none' ? '' : (v.recurrenceEnd || ''),
  };
}

/**
 * Add/edit sheet built on ui.form + ui.sheet so the All-day toggle can hide the time fields live.
 * Resolves with cleaned values, or null when cancelled/deleted.
 */
function eventSheet({ title, values, onDelete, occDate }) {
  return new Promise((resolve) => {
    const f = form(eventFields(), values);
    const show = (name, on) => f.fields[name]?.input.closest('.field')?.classList.toggle('hidden', !on);
    const sync = () => { const v = f.values(); show('time', !v.allDay); show('endTime', !v.allDay); show('recurrenceEnd', v.recurrence !== 'none'); };
    f.fields.allDay.input.addEventListener('change', sync);
    f.fields.recurrence.input.addEventListener('change', sync);
    sync();
    const extra = h('div.stack.mt',
      values.recurrence && values.recurrence !== 'none' && values.id ? h('p.small.muted', 'This event repeats. Changes apply to the whole series.') : null,
      h('button.btn.ghost.block', { type: 'button', onclick: () => {
        const v = cleanValues(f.values());
        if (!v.title) { toast('Give the event a title first'); return; }
        window.open(gcalUrl(v, occDate && v.date === values.date ? occDate : v.date), '_blank', 'noopener');
      } }, icon('calendar', 18), 'Open in Google Calendar'));
    const actions = [];
    if (onDelete) actions.push({ label: 'Delete', danger: true, onClick: async () => {
      const ok = await confirm(values.recurrence && values.recurrence !== 'none' ? 'Delete this event and all its repeats? This cannot be undone.' : 'Delete this event? This cannot be undone.');
      if (!ok) return false;
      await onDelete(); resolve(null); return true;
    } });
    actions.push({ label: 'Save', primary: true, onClick: () => { const err = f.validate(); if (err) { toast(err); return false; } resolve(cleanValues(f.values())); } });
    const s = sheet({ title, content: [f.el, extra], actions, onClose: () => resolve(null) });
    f.focus();
    f.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
        e.preventDefault();
        const err = f.validate(); if (err) { toast(err); return; }
        resolve(cleanValues(f.values())); s.close();
      }
    });
  });
}

async function openAdd(ctx, date) {
  const v = await eventSheet({ title: 'New event', values: { date: date || dates.today(), allDay: false, recurrence: 'none', color: '' } });
  if (!v) return;
  await ctx.db.put(STORE, v);
  toast('Event added');
}
async function openEdit(ctx, ev, occDate) {
  const fresh = (ev.id && await ctx.db.get(STORE, ev.id).catch(() => null)) || ev;
  const rec = norm(fresh);
  const v = await eventSheet({
    title: 'Edit event', values: rec, occDate,
    onDelete: async () => { await ctx.db.delete(STORE, rec.id); toast('Event deleted'); },
  });
  if (!v) return;
  await ctx.db.put(STORE, { ...fresh, ...v });
  toast('Saved');
}

// ---------- rows ----------
function eventRow(ctx, occ, { showDate = false } = {}) {
  const ev = occ.ev;
  const sub = [showDate ? dates.label(occ.date) : null, timeRange(ev), ev.location || null].filter(Boolean).join(' · ');
  return listItem({
    leading: h('span.priority-dot', { style: { background: colorOf(ev) } }),
    title: ev.title, sub,
    right: isRecurring(ev) ? h('span.muted', { title: 'Repeats ' + RECUR_WORD[ev.recurrence] }, icon('refresh', 16)) : null,
    onClick: () => openEdit(ctx, ev, occ.date),
  });
}
function taskRow(ctx, t) {
  const sub = ['Task', isHM(t.time) ? fmtTime(t.time) : null].filter(Boolean).join(' · ');
  const pr = t.priority === 'high' ? 'p-high' : t.priority === 'med' || t.priority === 'medium' ? 'p-med' : t.priority === 'low' ? 'p-low' : null;
  return listItem({
    leading: h('span.warn', icon('task', 20)),
    title: t.title || 'Untitled task', sub,
    right: pr ? h('span.priority-dot', { class: pr }) : null,
    onClick: () => ctx.nav('plan/tasks'),
  });
}

// ---------- month view ----------
function weekdayHeader(weekStart) {
  const startDow = weekStart === 'sun' ? 0 : 1;
  const ref = new Date(2023, 0, 1); // a Sunday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(ref); d.setDate(ref.getDate() + ((startDow + i) % 7));
    return h('div.cal-dow', d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2));
  });
}
function gridRange(monthKey, weekStart) {
  const startDow = weekStart === 'sun' ? 0 : 1;
  const first = dates.parse(dates.monthStart(monthKey));
  const offset = (first.getDay() - startDow + 7) % 7;
  const from = dates.addDays(dates.key(first), -offset);
  const end = dates.monthEnd(monthKey);
  let to = dates.addDays(from, 41); // 6 weeks
  if (dates.addDays(from, 34) >= end) to = dates.addDays(from, 34); // 5 weeks is enough
  return { from, to };
}

async function drawMonth(ctx, body, events) {
  const weekStart = ctx.settings.get('weekStart', 'mon');
  const today = dates.today();
  const { from, to } = gridRange(state.month, weekStart);
  const occ = expand(events, from, to);
  const tasks = await loadTasks(ctx, from, to);
  const evBy = groupByDate(occ);
  const taskBy = groupByDate(tasks);

  const setMonth = (m, sel) => { state.month = dates.monthStart(m); if (sel) state.selected = sel; draw(ctx, body, events); };
  const shift = (n) => { const d = dates.parse(state.month); d.setMonth(d.getMonth() + n); setMonth(dates.key(d)); };

  const grid = h('div.cal-grid', weekdayHeader(weekStart));
  for (let k = from; k <= to; k = dates.addDays(k, 1)) {
    const inMonth = k.slice(0, 7) === state.month.slice(0, 7);
    const nEv = (evBy.get(k) || []).length, nT = (taskBy.get(k) || []).length;
    const evDots = Math.min(nEv, nT ? 2 : 3), tDots = Math.min(nT, 3 - evDots);
    const dots = [];
    for (let i = 0; i < evDots; i++) dots.push(h('span.dot'));
    for (let i = 0; i < tDots; i++) dots.push(h('span.dot', { style: { background: 'var(--warn)' } }));
    grid.append(h('button.cal-day', {
      type: 'button',
      class: (inMonth ? '' : 'other') + (k === today ? ' today' : '') + (k === state.selected ? ' selected' : ''),
      'aria-label': dates.label(k, { year: true }) + (nEv ? `, ${nEv} event${nEv === 1 ? '' : 's'}` : '') + (nT ? `, ${nT} task${nT === 1 ? '' : 's'}` : ''),
      onclick: () => { state.selected = k; if (!inMonth) state.month = dates.monthStart(k); draw(ctx, body, events); },
    }, h('span', String(Number(k.slice(8)))), dots.length ? h('div.dots', dots) : null));
  }

  body.append(card(
    h('div.date-nav',
      h('button.icon-btn', { 'aria-label': 'Previous month', onclick: () => shift(-1) }, icon('back')),
      h('button.btn.ghost', {
        type: 'button', 'aria-label': 'Jump to today', title: 'Jump to today',
        style: { flex: '1', minHeight: '40px', padding: '0 8px', fontSize: '17px', fontWeight: '700', color: 'var(--text)', flexDirection: 'column', gap: '0', lineHeight: '1.15' },
        onclick: () => setMonth(today, today),
      }, dates.monthLabel(state.month), state.month !== dates.monthStart(today) ? h('span.small.muted', { style: { fontWeight: '400' } }, 'Tap for today') : null),
      h('button.icon-btn', { 'aria-label': 'Next month', onclick: () => shift(1) }, icon('chevron'))),
    grid));

  // Day agenda for the selected day
  const sel = state.selected;
  const dayEv = evBy.get(sel) || [];
  const dayTasks = taskBy.get(sel) || [];
  const dayCard = card(h('div.card-title',
    h('h3', dayHeading(sel)),
    h('button.btn.sm.primary', { onclick: () => openAdd(ctx, sel) }, '+ Add')));
  if (!dayEv.length && !dayTasks.length) {
    dayCard.append(h('p.muted.small', { style: { textAlign: 'center', padding: '8px 0 4px' } }, 'Nothing planned. Tap + Add to schedule something.'));
  } else {
    const list = h('div.list');
    for (const o of dayEv) list.append(eventRow(ctx, o));
    for (const t of dayTasks) list.append(taskRow(ctx, t));
    dayCard.append(list);
  }
  body.append(dayCard);

  body.append(importExportBlock(ctx));
}

function importExportBlock(ctx) {
  return h('div.stack',
    h('div.row',
      h('button.btn.sm.grow', { onclick: () => importICS(ctx) }, icon('upload', 16), 'Import .ics'),
      h('button.btn.sm.grow', { onclick: () => exportICS(ctx) }, icon('download', 16), 'Export .ics')),
    h('div.notice.info.small', 'Android does not let web apps read the system calendar. Export your Google Calendar as .ics (Settings → Import & export) and import it here, or add events to Google Calendar with the button inside each event. Google downloads a .zip — unzip it and pick the .ics inside.'));
}

// ---------- agenda view ----------
async function drawAgenda(ctx, body, events) {
  const today = dates.today();
  const to = dates.addDays(today, 29);
  const occ = expand(events, today, to);
  const tasks = await loadTasks(ctx, today, to);
  const evBy = groupByDate(occ), taskBy = groupByDate(tasks);
  const days = [...new Set([...evBy.keys(), ...taskBy.keys()])].sort();
  if (!days.length) {
    body.append(empty('Nothing in the next 30 days', 'Tap + to add an event, or import an .ics file below.', 'calendar'));
    body.append(importExportBlock(ctx));
    return;
  }
  const nEv = occ.length, nT = tasks.length;
  body.append(h('p.small.muted', `${nEv} event${nEv === 1 ? '' : 's'}${nT ? ` · ${nT} open task${nT === 1 ? '' : 's'}` : ''} in the next 30 days`));
  for (const d of days) {
    body.append(h('div.section-title', dayHeading(d)));
    const list = h('div.list');
    for (const o of evBy.get(d) || []) list.append(eventRow(ctx, o));
    for (const t of taskBy.get(d) || []) list.append(taskRow(ctx, t));
    body.append(card(list));
  }
  body.append(h('div.mt'), importExportBlock(ctx));
}

// ---------- main draw ----------
let drawToken = 0;
async function draw(ctx, body, events) {
  const token = ++drawToken;
  if (!events) events = await ctx.db.all(STORE, { index: 'date' });
  if (token !== drawToken) return;
  const frag = h('div');
  if (state.view === 'agenda') await drawAgenda(ctx, frag, events); else await drawMonth(ctx, frag, events);
  if (token !== drawToken) return;
  clear(body);
  while (frag.firstChild) body.append(frag.firstChild);
}

// ---------- module ----------
export default {
  id: 'calendar',
  title: 'Calendar',
  subtitle: 'Events & schedule',
  icon: 'calendar',
  tab: 'plan',
  stores: { events: { indexes: ['date'] } },

  async render(container, ctx) {
    state.view = ctx.settings.get('calendar:view', 'month') === 'agenda' ? 'agenda' : 'month';
    if (ctx.params?.date && /^\d{4}-\d{2}-\d{2}$/.test(ctx.params.date)) { state.selected = ctx.params.date; state.month = dates.monthStart(ctx.params.date); state.view = 'month'; }
    else if (Math.abs(dates.daysBetween(dates.today(), state.selected)) > 60) { state.selected = dates.today(); state.month = dates.monthStart(dates.today()); }

    const body = h('div');
    const seg = segmented([{ value: 'month', label: 'Month' }, { value: 'agenda', label: 'Agenda' }], state.view, (v) => {
      state.view = v; ctx.settings.set('calendar:view', v); draw(ctx, body);
    });
    container.append(h('div.mb', seg), body, fab(() => openAdd(ctx, state.view === 'month' ? state.selected : dates.today()), 'Add event'));

    await draw(ctx, body);
    if (ctx.params?.add === '1') openAdd(ctx, state.view === 'month' ? state.selected : dates.today());

    const offEvents = ctx.db.onChange(STORE, () => draw(ctx, body));
    const offTasks = ctx.db.onChange('tasks', () => draw(ctx, body));
    return () => { offEvents(); offTasks(); drawToken++; };
  },

  quickActions: [{ label: 'Event', icon: 'calendar', run: (ctx) => openAdd(ctx, dates.today()) }],

  async todayCard(ctx) {
    const today = dates.today(), tomorrow = dates.addDays(today, 1);
    const events = await ctx.db.all(STORE);
    if (!events.length) return null;
    const now = nowHM();
    const occ = expand(events, today, tomorrow).filter((o) => o.date !== today || !isTimed(o.ev) || (isHM(o.ev.endTime) ? o.ev.endTime : addMinutes(o.ev.time, 30)) >= now);
    if (!occ.length) return null;
    const list = h('div.list');
    for (const o of occ.slice(0, 5)) {
      const ev = o.ev;
      list.append(listItem({
        leading: h('span.priority-dot', { style: { background: colorOf(ev) } }),
        title: ev.title,
        sub: [o.date === today ? 'Today' : 'Tomorrow', timeRange(ev), ev.location || null].filter(Boolean).join(' · '),
        onClick: () => ctx.nav('plan/calendar?date=' + o.date),
      }));
    }
    return card(
      h('div.card-title', h('h3', 'Next up'), h('span.link', { onclick: () => ctx.nav('plan/calendar') }, occ.length > 5 ? `+${occ.length - 5} more` : 'Calendar')),
      list);
  },

  async exportForAI(ctx) {
    const all = await ctx.db.all(STORE);
    if (!all.length) return '';
    const today = dates.today();
    const to = dates.addDays(today, 13);
    const occ = expand(all, today, to);
    const byDay = groupByDate(occ);
    const lines = [`## Calendar (${all.length} events stored; ${occ.length} in the next 14 days, ${today} → ${to})`];

    const week1 = occ.filter((o) => dates.daysBetween(today, o.date) < 7).length;
    const week2 = occ.length - week1;
    lines.push(`- Events per week: this week ${week1}, next week ${week2}; busy days ${byDay.size}/14, free days ${14 - byDay.size}`);
    const busiest = [...byDay.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3).filter(([, v]) => v.length >= 2);
    if (busiest.length) lines.push('- Busiest days: ' + busiest.map(([d, v]) => `${d} (${dates.parse(d).toLocaleDateString(undefined, { weekday: 'short' })}, ${v.length} events)`).join(', '));

    const recurring = all.map(norm).filter((e) => isRecurring(e) && (!e.recurrenceEnd || e.recurrenceEnd >= today));
    if (recurring.length) {
      lines.push(`- Recurring commitments (${recurring.length}): ` + recurring.slice(0, 15).map((e) => `${e.title} ${RECUR_WORD[e.recurrence]}${isTimed(e) ? ' ' + e.time : ''}${e.recurrenceEnd ? ' until ' + e.recurrenceEnd : ''}`).join('; '));
    }

    if (occ.length) {
      lines.push('', 'Upcoming (YYYY-MM-DD HH:MM Title @ location):');
      for (const o of occ.slice(0, 80)) {
        const ev = o.ev;
        let line = `${o.date} ${isTimed(ev) ? ev.time : 'all-day'} ${ev.title}`;
        if (isHM(ev.endTime) && isTimed(ev)) line += `–${ev.endTime}`;
        if (ev.location) line += ` @ ${ev.location}`;
        if (isRecurring(ev)) line += ` (${RECUR_WORD[ev.recurrence]})`;
        if (ev.notes) line += ` — ${ev.notes.replace(/\s+/g, ' ').slice(0, 120)}`;
        lines.push(line);
      }
      if (occ.length > 80) lines.push(`… and ${fmt.num(occ.length - 80, 0)} more`);
    } else lines.push('', 'No events scheduled in the next 14 days.');
    return lines.join('\n');
  },
};
