// notes.js — Daily notes: as many journal notes per day as you like, each with an optional mood, energy, tags and pin.
// Store: notes { id, date 'YYYY-MM-DD', time 'HH:MM' ('' on notes from before v1.5), text, mood 1-5|null, energy 1-5|null,
//                tags [], pinned, createdAt, updatedAt }
// Before v1.5 there was exactly one note per day; those records are simply the first note of their day.
import { h, clear, dates, fmt, icon, toast, formSheet, listItem, empty, card, stat, lineChart } from '../ui.js';

const STORE = 'notes';
const PLACEHOLDER = 'What is on your mind? Wins, struggles, gratitude…';
const MOOD = { 1: ['😞', 'Awful'], 2: ['😕', 'Low'], 3: ['😐', 'Okay'], 4: ['🙂', 'Good'], 5: ['😄', 'Great'] };
const ENERGY = { 1: 'Drained', 2: 'Tired', 3: 'Steady', 4: 'Energised', 5: 'Buzzing' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MOOD_COLOR = 'var(--accent)';
const ENERGY_COLOR = 'var(--good)';
const PAGE = 40;
const DRAFT_KEY = 'lifeos:notes:draft:'; // + date; plain localStorage so typing does not fire settings:change events

const STYLE = `
.module[data-module="notes"] .notes-emoji { font-size: 22px; line-height: 1; width: 32px; text-align: center; }
.module[data-module="notes"] .notes-ta { min-height: 110px; }
.module[data-module="notes"] .icon-btn:disabled { opacity: .3; pointer-events: none; }
.module[data-module="notes"] .date-nav .notes-date { flex: 1; min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; background: none; border: 0; padding: 4px 8px; border-radius: 12px; color: var(--text); font: inherit; cursor: pointer; transition: background .15s; }
.module[data-module="notes"] .date-nav .notes-date:active { background: var(--card-2); }
.module[data-module="notes"] .date-nav .notes-date[aria-disabled="true"] { cursor: default; }
.module[data-module="notes"] .date-nav .notes-date-label { font-size: 17px; font-weight: 700; line-height: 1.2; }
.module[data-module="notes"] .date-nav .notes-date .small { font-weight: 400; }
.module[data-module="notes"] .notes-pick { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.module[data-module="notes"] .notes-pick .lbl { font-size: 12px; font-weight: 600; color: var(--muted); width: 48px; flex: 0 0 auto; }
.module[data-module="notes"] .notes-pick .opts { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; flex: 1; }
.module[data-module="notes"] .notes-pick button { min-height: 40px; border-radius: 10px; background: var(--card-2); border: 1px solid var(--border); color: var(--text-2); font: inherit; font-size: 18px; cursor: pointer; }
.module[data-module="notes"] .notes-pick.energy button { font-size: 13px; font-weight: 700; }
.module[data-module="notes"] .notes-pick button.on { background: color-mix(in srgb, var(--accent) 22%, var(--card-2)); border-color: var(--accent); color: var(--text); }
.module[data-module="notes"] .notes-pick.energy button.on { background: color-mix(in srgb, var(--good) 22%, var(--card-2)); border-color: var(--good); }
.module[data-module="notes"] .notes-compose-foot { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
.module[data-module="notes"] .notes-compose-foot .input { flex: 1; min-width: 0; }
.module[data-module="notes"] .note-entry .li-title { font-weight: 400; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
.module[data-module="notes"] .note-entry .li-sub { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; }
.module[data-module="notes"] .note-entry .li-sub .chip { padding: 1px 8px; font-size: 11px; }
.module[data-module="notes"] .notes-legend { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--muted); margin: 6px 0 2px; }
.module[data-module="notes"] .notes-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
`;

// ---------- record helpers (defensive against old/partial records) ----------
function clamp15(v) { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : null; }
function isDateKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dates.key(dates.parse(s)) === s; }
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isHM = (t) => typeof t === 'string' && HM_RE.test(t);
function nowHM() { const d = new Date(); return dates.pad(d.getHours()) + ':' + dates.pad(d.getMinutes()); }
function timeLabel(t) {
  if (!isHM(t)) return '';
  const [hh, mm] = t.split(':').map(Number);
  return new Date(2000, 0, 1, hh, mm).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function parseTags(v) {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return [...new Set(parts.flatMap((s) => String(s ?? '').split(/[,\n#]+/)).map((s) => s.trim()).filter(Boolean))];
}
function norm(n) {
  if (!n) return null;
  return {
    ...n,
    date: isDateKey(n.date) ? n.date : String(n.date ?? dates.today()),
    time: isHM(n.time) ? n.time : '',
    text: String(n.text ?? ''),
    mood: clamp15(n.mood), energy: clamp15(n.energy),
    tags: parseTags(n.tags), pinned: !!n.pinned,
  };
}
function hasContent(n) { return !!(n && (n.text.trim() || n.mood != null || n.energy != null || n.tags.length)); }
function snippet(text, n = 80) { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }
function moodEmoji(m) { return MOOD[m]?.[0] || ''; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
/** Within a day: by time (untimed old notes first), then by when they were written. */
function byTime(a, b) { return (a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : (a.createdAt || 0) - (b.createdAt || 0); }
/** Newest day first, and newest note first within a day. */
function newestFirst(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : -byTime(a, b); }
async function allNotes(db) { return (await db.all(STORE)).map(norm).filter(hasContent).sort(newestFirst); }
async function notesOn(db, date) { return (await db.where(STORE, 'date', date)).map(norm).filter(hasContent).sort(byTime); }

/** Per-day summary: { date, notes[], mood (avg|null), energy (avg|null), tags[] } newest day first. */
function byDay(notes) {
  const map = new Map();
  for (const n of notes) { if (!map.has(n.date)) map.set(n.date, []); map.get(n.date).push(n); }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, list]) => {
    const ms = list.filter((n) => n.mood != null).map((n) => n.mood), es = list.filter((n) => n.energy != null).map((n) => n.energy);
    return { date, notes: list.sort(byTime), mood: avg(ms), energy: avg(es), tags: [...new Set(list.flatMap((n) => n.tags))] };
  });
}
function streakOf(notes) {
  const set = new Set(notes.map((n) => n.date));
  let d = dates.today();
  if (!set.has(d)) d = dates.addDays(d, -1);
  let s = 0;
  while (set.has(d)) { s++; d = dates.addDays(d, -1); }
  return s;
}

// ---------- drafts (the composer keeps unsaved text per day, so nothing typed is lost when you leave) ----------
function readDraft(date) { try { return JSON.parse(localStorage.getItem(DRAFT_KEY + date) || 'null'); } catch { return null; } }
function writeDraft(date, d) {
  try {
    if (!d || (!d.text?.trim() && d.mood == null && d.energy == null && !d.tags?.trim())) localStorage.removeItem(DRAFT_KEY + date);
    else localStorage.setItem(DRAFT_KEY + date, JSON.stringify(d));
  } catch { /* storage full or blocked: the composer still works, the draft just is not kept */ }
}

// ---------- edit sheet ----------
const MOOD_OPTS = [{ value: '', label: '–' }, ...[1, 2, 3, 4, 5].map((m) => ({ value: m, label: MOOD[m][0] }))];
const ENERGY_OPTS = [{ value: '', label: '–' }, ...[1, 2, 3, 4, 5].map((e) => ({ value: e, label: String(e) }))];
async function editNote(ctx, note) {
  const n = norm(note);
  const vals = await formSheet({
    title: 'Edit note',
    fields: [
      { name: 'text', label: 'Note', type: 'textarea', rows: 6, placeholder: PLACEHOLDER, autofocus: true },
      { name: 'mood', label: 'Mood', type: 'segment', options: MOOD_OPTS },
      { name: 'energy', label: 'Energy', type: 'segment', options: ENERGY_OPTS },
      { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'work, family, gym' },
      { name: 'pinned', label: 'Pinned', type: 'toggle' },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'time', label: 'Time', type: 'time' },
    ],
    values: { text: n.text, mood: n.mood ?? '', energy: n.energy ?? '', tags: n.tags, pinned: n.pinned, date: n.date, time: n.time },
    onDelete: async () => {
      try {
        await ctx.db.delete(STORE, n.id);
        toast('Note deleted', { action: 'Undo', onAction: () => ctx.db.put(STORE, note) });
      } catch (e) { console.error(e); toast('Could not delete note'); }
    },
  });
  if (!vals) return;
  const rec = norm({
    ...note, text: String(vals.text ?? ''), mood: clamp15(vals.mood), energy: clamp15(vals.energy), tags: parseTags(vals.tags),
    pinned: !!vals.pinned, date: isDateKey(vals.date) ? vals.date : n.date, time: isHM(String(vals.time || '').slice(0, 5)) ? String(vals.time).slice(0, 5) : '',
  });
  try {
    if (!hasContent(rec)) { await ctx.db.delete(STORE, n.id); toast('Empty note removed'); return; }
    await ctx.db.put(STORE, rec);
    toast('Saved');
  } catch (e) { console.error(e); toast('Could not save note'); }
}

// ---------- AI action helpers ----------
const ACTION_ROWS = 20;
function argDate(v) {
  if (v == null || v === '') return dates.today();
  if (!isDateKey(v)) throw new Error(`Date must be a real date YYYY-MM-DD, got "${v}"`);
  return v;
}
function argTime(v) {
  if (v == null || v === '') return undefined;
  if (!isHM(String(v))) throw new Error('time must be HH:MM (24h), e.g. 21:30');
  return String(v);
}
function argScale(v, label) {
  if (v == null || v === '') return undefined;
  const n = clamp15(v);
  if (n == null || Number(v) !== n) throw new Error(`${label} must be a whole number from 1 to 5`);
  return n;
}
function argBool(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  throw new Error('Expected true or false');
}
async function requireNote(ctx, id) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key) throw new Error('id is required (get it from notes_list or notes_get_day)');
  const rec = await ctx.db.get(STORE, key).catch(() => null);
  if (!rec) throw new Error(`No note with id "${key}". Use notes_list or notes_get_day to find it.`);
  return norm(rec);
}
function noteLine(n, textLen = 70) {
  const meta = [n.mood != null ? `mood ${n.mood}` : null, n.energy != null ? `energy ${n.energy}` : null].filter(Boolean).join(', ');
  return `${n.date}${n.time ? ' ' + n.time : ''} (id ${n.id})${meta ? ' ' + meta : ''}${n.tags.length ? ' [' + n.tags.join(', ') + ']' : ''}${n.pinned ? ' ★' : ''}: ${snippet(n.text, textLen) || '(no text)'}`;
}
/** How the confirmation card names a note: '"Gym then dinner…" (Today 9:30 PM · mood 4/5)'. */
function noteLabel(n) {
  const text = snippet(n.text, 40);
  const when = dates.label(n.date) + (n.time ? ' ' + timeLabel(n.time) : '');
  const bits = [when, n.mood != null ? `mood ${n.mood}/5` : null, n.pinned ? 'pinned' : null].filter(Boolean);
  return `${text ? `"${text}" ` : ''}(${bits.join(' · ')})`;
}
async function previewNoteById(ctx, id) { try { const r = await ctx?.db?.get(STORE, String(id || '').trim()); return r ? norm(r) : null; } catch { return null; } }
function previewBool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function describeFields(a) {
  const bits = [];
  try {
    if (a.text != null) bits.push(a.text === '' ? 'clear the text' : `${previewBool(a.append) ? 'append' : 'text'} "${snippet(String(a.text), 50)}"`);
    if (a.mood != null && a.mood !== '') { const m = clamp15(a.mood); bits.push(`mood ${a.mood}/5${m ? ' ' + MOOD[m][0] : ''}`); }
    if (a.energy != null && a.energy !== '') { const e = clamp15(a.energy); bits.push(`energy ${a.energy}/5${e ? ' (' + ENERGY[e] + ')' : ''}`); }
    if (a.tags != null) bits.push(a.tags === '' ? 'clear the tags' : `tags ${parseTags(a.tags).map((t) => '#' + t).join(' ')}`);
    if (a.pinned != null && a.pinned !== '') bits.push(previewBool(a.pinned) ? 'pin it' : 'unpin it');
    if (a.date) bits.push(`date ${isDateKey(a.date) ? dates.label(a.date) : a.date}`);
    if (a.time) bits.push(`time ${timeLabel(a.time) || a.time}`);
  } catch { /* keep what was described */ }
  return bits;
}

// ---------- module ----------
export default {
  id: 'notes',
  title: 'Daily notes',
  subtitle: 'Journal, mood & energy',
  icon: 'note',
  tab: 'mind',
  stores: { notes: { indexes: ['date'] } },

  async render(container, ctx) {
    const { db } = ctx;
    const today = dates.today();
    let selected = isDateKey(ctx.params?.date) && ctx.params.date <= today ? ctx.params.date : today;
    let query = '';
    let showAll = false;
    let all = [];
    let draftTimer = null;

    container.append(h('style', STYLE));
    const navHolder = h('div'), composeHolder = h('div'), dayHolder = h('div'), pinnedHolder = h('div'), chartHolder = h('div'), listHolder = h('div');
    const searchInput = h('input', { type: 'search', placeholder: 'Search notes and tags', 'aria-label': 'Search notes' });
    searchInput.addEventListener('input', () => { query = searchInput.value; showAll = false; drawPast(); });
    const pastHolder = h('div', h('div.section-title', 'Past days'), h('div.search-bar', icon('search', 18), searchInput), listHolder);
    container.append(navHolder, composeHolder, dayHolder, pinnedHolder, chartHolder, pastHolder);

    // ----- composer: writes a NEW note for the selected day -----
    let comp = null; // { date, ta, tags, mood, energy, refresh, reset }
    const flushDraft = () => {
      clearTimeout(draftTimer); draftTimer = null;
      if (comp) writeDraft(comp.date, { text: comp.ta.value, mood: comp.mood, energy: comp.energy, tags: comp.tags.value });
    };
    const scheduleDraft = () => { clearTimeout(draftTimer); draftTimer = setTimeout(flushDraft, 400); comp?.refresh(); };

    function picker(kind, labels, get, set) {
      const wrap = h('div.notes-pick', { class: kind }, h('span.lbl', kind === 'mood' ? 'Mood' : 'Energy'));
      const opts = h('div.opts');
      const btns = [1, 2, 3, 4, 5].map((v) => h('button', {
        type: 'button', 'aria-label': `${kind} ${v} of 5, ${labels(v)[1]}`, 'aria-pressed': 'false',
        onclick: () => { set(get() === v ? null : v); paint(); scheduleDraft(); },
      }, labels(v)[0]));
      const paint = () => btns.forEach((b, i) => { const on = get() === i + 1; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      opts.append(...btns); wrap.append(opts); paint();
      wrap.paint = paint;
      return wrap;
    }

    function drawComposer(focus = false) {
      if (comp) flushDraft();
      clear(composeHolder);
      const date = selected;
      const d = readDraft(date) || {};
      const ta = h('textarea.input.notes-ta', { rows: 4, placeholder: PLACEHOLDER, 'aria-label': 'New note' });
      ta.value = d.text || '';
      const tags = h('input.input', { type: 'text', placeholder: 'Tags — work, gym…', autocapitalize: 'off', 'aria-label': 'Tags' });
      tags.value = d.tags || '';
      const st = { date, ta, tags, mood: clamp15(d.mood), energy: clamp15(d.energy) };
      const moodPick = picker('mood', (v) => MOOD[v], () => st.mood, (v) => { st.mood = v; });
      const energyPick = picker('energy', (v) => [String(v), ENERGY[v]], () => st.energy, (v) => { st.energy = v; });
      const saveBtn = h('button.btn.primary', { type: 'button', onclick: () => saveNew() }, icon('plus', 18), 'Add note');
      st.refresh = () => { saveBtn.disabled = !(ta.value.trim() || st.mood != null || st.energy != null); };
      st.reset = () => { ta.value = ''; tags.value = ''; st.mood = null; st.energy = null; moodPick.paint(); energyPick.paint(); st.refresh(); writeDraft(date, null); };
      ta.addEventListener('input', scheduleDraft);
      tags.addEventListener('input', scheduleDraft);
      ta.addEventListener('blur', flushDraft);
      // Ctrl/Cmd+Enter saves on a keyboard; on a phone the button is right there.
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNew(); } });
      comp = st;
      composeHolder.append(card(
        h('div.card-title', h('h3', date === today ? 'New note' : `New note for ${dates.label(date)}`),
          date === today ? h('span.small.muted', timeLabel(nowHM())) : null),
        ta, moodPick, energyPick,
        h('div.notes-compose-foot', tags, saveBtn)));
      st.refresh();
      if (focus) setTimeout(() => ta.focus(), 120);
    }

    let saving = false;
    async function saveNew() {
      if (!comp || saving) return;
      const st = comp;
      const rec = norm({ date: st.date, time: st.date === today ? nowHM() : '', text: st.ta.value.trim(), mood: st.mood, energy: st.energy, tags: parseTags(st.tags.value), pinned: false });
      if (!hasContent(rec)) { toast('Write something or pick a mood first'); st.ta.focus(); return; }
      saving = true;
      try {
        await db.put(STORE, rec);
        st.reset();
        toast('Note added');
      } catch (e) { console.error(e); toast('Could not save note'); }
      finally { saving = false; }
    }

    // ----- date navigation -----
    function select(date) {
      flushDraft();
      selected = date;
      drawNav();
      drawComposer();
      drawDay();
      drawPast();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function drawNav() {
      clear(navHolder);
      const isToday = selected === today;
      const sub = isToday ? dates.parse(selected).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Tap for today';
      navHolder.append(h('div.date-nav',
        h('button.icon-btn', { type: 'button', 'aria-label': 'Previous day', onclick: () => select(dates.addDays(selected, -1)) }, icon('back')),
        h('button.notes-date', {
          type: 'button',
          'aria-label': isToday ? null : `${dates.label(selected)} — jump to today`,
          'aria-disabled': isToday ? 'true' : null,
          onclick: () => { if (!isToday) select(today); },
        }, h('span.notes-date-label', dates.label(selected)), h('span.small.muted', sub)),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Next day', disabled: selected >= today, onclick: () => select(dates.addDays(selected, 1)) }, icon('chevron'))));
    }

    // ----- rows -----
    function noteRow(n, { showDate = false } = {}) {
      let pressedAt = 0;
      const chips = [];
      const when = [showDate ? dates.label(n.date) : null, n.time ? timeLabel(n.time) : null].filter(Boolean).join(' · ');
      if (when) chips.push(h('span.small.muted', when));
      if (n.energy != null) chips.push(h('span.chip.good', `⚡ ${n.energy}`));
      for (const t of n.tags.slice(0, 4)) chips.push(h('span.chip', '#' + t));
      if (n.pinned) chips.push(h('span.chip.accent', '★ Pinned'));
      const el = listItem({
        leading: h('span.notes-emoji', moodEmoji(n.mood) || '📝'),
        title: n.text.trim() || (n.mood != null ? `Feeling ${MOOD[n.mood][1].toLowerCase()}` : 'Check-in'),
        sub: chips.length ? chips : null,
        onClick: () => { if (Date.now() - pressedAt < 700) return; editNote(ctx, n).catch(console.error); },
        onLongPress: async () => {
          pressedAt = Date.now();
          try { await db.put(STORE, { ...n, pinned: !n.pinned }); toast(n.pinned ? 'Unpinned' : 'Pinned'); } catch (e) { console.error(e); toast('Could not update note'); }
        },
      });
      el.classList.add('note-entry');
      return el;
    }

    function drawDay() {
      clear(dayHolder);
      const list = all.filter((n) => n.date === selected).sort(byTime);
      if (!list.length) return;
      const ms = list.filter((n) => n.mood != null).map((n) => n.mood);
      dayHolder.append(card(
        h('div.card-title', h('h3', `${selected === today ? 'Today' : dates.label(selected)} · ${list.length} note${list.length === 1 ? '' : 's'}`),
          ms.length ? h('span.chip.accent', `${moodEmoji(Math.round(avg(ms)))} ${fmt.num(avg(ms), 1)}`) : null),
        h('div.list', list.map((n) => noteRow(n))),
        h('div.small.muted', { style: { textAlign: 'center', marginTop: '6px' } }, 'Tap a note to edit · hold to pin')));
    }

    function drawPinned() {
      clear(pinnedHolder);
      const pinned = all.filter((n) => n.pinned);
      if (!pinned.length) return;
      pinnedHolder.append(card(h('div.card-title', h('h3', 'Pinned'), h('span.small.muted', 'Hold a note to unpin')), h('div.list', pinned.map((n) => noteRow(n, { showDate: true })))));
    }

    function drawChart() {
      clear(chartHolder);
      const from = dates.addDays(today, -29);
      const days = byDay(all.filter((n) => n.date >= from && n.date <= today)).reverse();
      const mp = days.filter((d) => d.mood != null).map((d) => ({ x: d.date, y: d.mood }));
      const ep = days.filter((d) => d.energy != null).map((d) => ({ x: d.date, y: d.energy }));
      const c = card(h('div.card-title', h('h3', 'Mood & energy'), h('span.small.muted', 'Daily average · 30 days')));
      if (!mp.length && !ep.length) {
        c.append(h('p.small.muted', { style: { margin: 0 } }, 'Tap a mood or energy level when you add a note and your trends show up here.'));
        chartHolder.append(c);
        return;
      }
      const am = avg(mp.map((p) => p.y)), ae = avg(ep.map((p) => p.y));
      const streak = streakOf(all);
      c.append(h('div.stats.mb',
        stat('Avg mood', am != null ? `${moodEmoji(Math.round(am))} ${fmt.num(am, 1)}` : '–', mp.length ? `${mp.length} day${mp.length === 1 ? '' : 's'}` : 'not set'),
        stat('Avg energy', ae != null ? `⚡ ${fmt.num(ae, 1)}` : '–', ep.length ? `${ep.length} day${ep.length === 1 ? '' : 's'}` : 'not set'),
        stat('Streak', String(streak), streak === 1 ? 'day in a row' : 'days in a row')));
      c.append(h('div.notes-legend', h('i', { style: { background: MOOD_COLOR } }), 'Mood'), lineChart(mp, { height: 110, color: MOOD_COLOR, yMin: 1, yMax: 5 }));
      c.append(h('div.notes-legend', h('i', { style: { background: ENERGY_COLOR } }), 'Energy'), lineChart(ep, { height: 110, color: ENERGY_COLOR, yMin: 1, yMax: 5 }));
      chartHolder.append(c);
    }

    function drawPast() {
      clear(listHolder);
      const q = query.trim().toLowerCase();
      if (q) {
        // Searching: show the matching notes themselves.
        const hits = all.filter((n) => `${n.text} ${n.tags.join(' ')} ${n.date} ${dates.label(n.date)}`.toLowerCase().includes(q));
        if (!hits.length) { listHolder.append(empty('Nothing matches', 'Try another word, a tag or a date.', 'search')); return; }
        const shown = showAll ? hits : hits.slice(0, PAGE);
        const c = card(h('div.list', shown.map((n) => noteRow(n, { showDate: true }))));
        if (hits.length > shown.length) c.append(h('button.btn.block.ghost', { type: 'button', onclick: () => { showAll = true; drawPast(); } }, `Show all ${hits.length}`));
        listHolder.append(c);
        return;
      }
      const days = byDay(all.filter((n) => n.date !== selected));
      if (!days.length) {
        listHolder.append(empty('No past notes yet', 'Write as many notes a day as you like. Use the arrows to add notes to earlier days.', 'note'));
        return;
      }
      const shown = showAll ? days : days.slice(0, PAGE);
      const c = card(h('div.list', shown.map((d) => listItem({
        leading: h('span.notes-emoji', d.mood != null ? moodEmoji(Math.round(d.mood)) : '📝'),
        title: h('span', dates.label(d.date), h('span.small.muted', `  ${d.notes.length} note${d.notes.length === 1 ? '' : 's'}`)),
        sub: snippet(d.notes.map((n) => n.text.trim()).filter(Boolean).join(' · '), 90) || (d.tags.length ? d.tags.map((t) => '#' + t).join(' ') : 'Mood check-in'),
        right: icon('chevron', 18),
        onClick: () => select(d.date),
      }))));
      if (days.length > shown.length) c.append(h('button.btn.block.ghost', { type: 'button', onclick: () => { showAll = true; drawPast(); } }, `Show all ${days.length} days`));
      listHolder.append(c);
    }

    async function load() {
      all = await allNotes(db);
      drawDay(); drawPinned(); drawChart(); drawPast();
    }

    drawNav();
    drawComposer(ctx.params?.add === '1');
    await load();
    const off = db.onChange(STORE, load);

    return () => { off(); flushDraft(); comp = null; };
  },

  quickActions: [{ label: 'Note', icon: 'note', run: async (ctx) => ctx.nav('mind/notes?add=1') }],

  async todayCard(ctx) {
    const list = await notesOn(ctx.db, dates.today());
    if (!list.length) {
      return h('div.card.tappable', { onclick: () => ctx.nav('mind/notes?add=1') },
        h('div.row', icon('note', 26), h('div.grow', h('h3', 'Write a note'), h('div.small.muted', 'Journal, mood & energy — as many as you like')), icon('chevron')));
    }
    const ms = list.filter((n) => n.mood != null).map((n) => n.mood), es = list.filter((n) => n.energy != null).map((n) => n.energy);
    const latest = list[list.length - 1];
    const chips = [h('span.chip', `${list.length} note${list.length === 1 ? '' : 's'} today`)];
    if (ms.length) chips.push(h('span.chip.accent', `${moodEmoji(Math.round(avg(ms)))} Mood ${fmt.num(avg(ms), 1)}`));
    if (es.length) chips.push(h('span.chip.good', `⚡ Energy ${fmt.num(avg(es), 1)}`));
    return h('div.card.tappable', { onclick: () => ctx.nav('mind/notes?add=1') },
      h('div.card-title', h('h3', 'Daily notes'), h('span.link', '+ Note')),
      h('div.chips.mb', chips),
      latest.text.trim()
        ? h('p.small', { style: { margin: 0 } }, latest.time ? h('span.muted', timeLabel(latest.time) + ' · ') : null, snippet(latest.text, 140))
        : h('p.small.muted', { style: { margin: 0 } }, 'Add a few words about your day'));
  },

  async exportForAI(ctx, { since, days } = {}) {
    const today = dates.today();
    since = isDateKey(since) ? since : dates.addDays(today, -((days || 90) - 1));
    const notes = (await ctx.db.range(STORE, since, today)).map(norm).filter(hasContent).sort(newestFirst);
    if (!notes.length) return '';
    const dayRows = byDay(notes);
    const moods = dayRows.filter((d) => d.mood != null), energies = dayRows.filter((d) => d.energy != null);

    const trend = (field) => {
      const last = dayRows.filter((d) => d.date >= dates.addDays(today, -6) && d[field] != null).map((d) => d[field]);
      const prev = dayRows.filter((d) => d.date >= dates.addDays(today, -13) && d.date <= dates.addDays(today, -7) && d[field] != null).map((d) => d[field]);
      if (!last.length) return '';
      if (!prev.length) return `; last 7 days avg ${fmt.num(avg(last), 2)}`;
      const dlt = avg(last) - avg(prev);
      const dir = dlt > 0.15 ? 'up' : dlt < -0.15 ? 'down' : 'flat';
      return `; 7-day trend ${dir} (${fmt.num(avg(last), 2)} vs ${fmt.num(avg(prev), 2)} the week before)`;
    };
    const dayLine = (d) => `${d.date} (mood ${d.mood != null ? fmt.num(d.mood, 1) : '-'}, energy ${d.energy != null ? fmt.num(d.energy, 1) : '-'}, ${d.notes.length} note${d.notes.length === 1 ? '' : 's'})${d.notes.some((n) => n.text.trim()) ? ': ' + snippet(d.notes.map((n) => n.text).join(' / '), 100) : ''}`;

    const lines = [`## Daily notes (${since} → ${today})`];
    lines.push(`- ${notes.length} notes on ${dayRows.length} days (several notes a day are allowed; mood/energy are per note, daily figures are averages). Current streak: ${streakOf(notes)} day(s).`);
    if (moods.length) lines.push(`- Avg daily mood ${fmt.num(avg(moods.map((d) => d.mood)), 2)}/5${trend('mood')}`);
    if (energies.length) lines.push(`- Avg daily energy ${fmt.num(avg(energies.map((d) => d.energy)), 2)}/5${trend('energy')}`);
    if (moods.length) {
      const byDow = Array.from({ length: 7 }, () => []);
      for (const d of moods) byDow[dates.parse(d.date).getDay()].push(d.mood);
      const parts = [1, 2, 3, 4, 5, 6, 0].filter((i) => byDow[i].length).map((i) => `${DOW[i]} ${fmt.num(avg(byDow[i]), 1)} (n=${byDow[i].length})`);
      if (parts.length) lines.push('- Avg mood by weekday: ' + parts.join(', '));
      if (moods.length >= 2) {
        const sorted = [...moods].sort((a, b) => (b.mood - a.mood) || ((b.energy ?? 0) - (a.energy ?? 0)));
        lines.push(`- Best day: ${dayLine(sorted[0])}`);
        lines.push(`- Worst day: ${dayLine(sorted[sorted.length - 1])}`);
      }
      const timedMood = notes.filter((n) => n.time && n.mood != null);
      if (timedMood.length >= 6) {
        const part = (n) => { const hh = Number(n.time.slice(0, 2)); return hh < 12 ? 'morning' : hh < 18 ? 'afternoon' : 'evening'; };
        const g = { morning: [], afternoon: [], evening: [] };
        for (const n of timedMood) g[part(n)].push(n.mood);
        const parts2 = Object.entries(g).filter(([, v]) => v.length).map(([k, v]) => `${k} ${fmt.num(avg(v), 1)} (n=${v.length})`);
        lines.push('- Mood by time of day: ' + parts2.join(', '));
      }
    }
    const tagCount = {};
    for (const n of notes) for (const t of n.tags) tagCount[t] = (tagCount[t] || 0) + 1;
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (topTags.length) lines.push('- Top tags: ' + topTags.map(([t, c]) => `${t} (${c})`).join(', '));
    const pinned = notes.filter((n) => n.pinned);
    if (pinned.length) lines.push('- Pinned notes: ' + pinned.slice(0, 10).map((n) => `${n.date}${n.time ? ' ' + n.time : ''} "${snippet(n.text, 60)}"`).join('; '));

    lines.push('', '### Recent notes (newest first)');
    const headerLen = lines.length;
    for (const n of notes.slice(0, 40)) {
      lines.push(`- ${n.date}${n.time ? ' ' + n.time : ''} mood ${n.mood ?? '-'} energy ${n.energy ?? '-'}${n.tags.length ? ' [' + n.tags.join(', ') + ']' : ''}${n.pinned ? ' (pinned)' : ''}: ${snippet(n.text, 300) || '(no text)'}`);
    }
    let truncated = false;
    while (lines.length > headerLen && lines.join('\n').length > 7500) { lines.pop(); truncated = true; }
    if (truncated) lines.push('…(older notes omitted)');
    return lines.join('\n');
  },

  actions: [
    {
      name: 'add',
      description: 'Add a new journal note. A day can have any number of notes, so use this for every new thought, check-in or entry — do not overwrite earlier notes. Date defaults to today; today\'s notes get the current time automatically. Give text and/or a mood/energy check-in.',
      params: {
        text: { type: 'string', description: 'The note text.' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        time: { type: 'string', description: 'HH:MM 24h. Omit for "now" on today; give it when the user names a time.' },
        mood: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Mood right now, 1 (awful) to 5 (great).' },
        energy: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Energy right now, 1 (drained) to 5 (buzzing).' },
        tags: { type: 'string', description: 'Comma-separated tags, e.g. "work, gym".' },
        pinned: { type: 'boolean', description: 'Pin the note.' },
      },
      write: true,
      preview: (a = {}) => {
        const date = isDateKey(a.date) ? a.date : dates.today();
        const bits = describeFields({ ...a, date: undefined, time: undefined, append: undefined });
        return `Add note for ${dates.label(date)}${a.time ? ' at ' + (timeLabel(a.time) || a.time) : ''}: ${bits.join(', ') || '(empty)'}`;
      },
      async run(ctx, args = {}) {
        const date = argDate(args.date);
        const time = argTime(args.time) ?? (date === dates.today() ? nowHM() : '');
        const mood = argScale(args.mood, 'mood'), energy = argScale(args.energy, 'energy');
        if (args.text != null && typeof args.text !== 'string') throw new Error('text must be a string');
        const rec = norm({ date, time, text: String(args.text ?? '').trim().slice(0, 5000), mood: mood ?? null, energy: energy ?? null, tags: parseTags(args.tags ?? ''), pinned: argBool(args.pinned) === true });
        if (!hasContent(rec)) throw new Error('Nothing to save: give text, mood or energy');
        const saved = norm(await ctx.db.put(STORE, rec));
        return `Added note (id ${saved.id}) for ${saved.date}${saved.time ? ' ' + saved.time : ''}: mood ${saved.mood ?? '-'}, energy ${saved.energy ?? '-'}, tags [${saved.tags.join(', ')}]. Text: ${snippet(saved.text, 120) || '(none)'}`;
      },
    },
    {
      name: 'get_day',
      description: 'Read all notes of one date (defaults to today) in time order, with ids, full text, mood, energy, tags and pin, plus the day\'s average mood/energy.',
      params: { date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } },
      write: false,
      async run(ctx, args = {}) {
        const date = argDate(args.date);
        const list = await notesOn(ctx.db, date);
        if (!list.length) return `No notes on ${date} (${dates.label(date)}).`;
        const d = byDay(list)[0];
        const out = [`${list.length} note${list.length === 1 ? '' : 's'} on ${date} (${dates.label(date)}). Day avg mood ${d.mood != null ? fmt.num(d.mood, 1) : '-'}, energy ${d.energy != null ? fmt.num(d.energy, 1) : '-'}.`];
        let budget = 1400;
        for (const n of list) {
          const text = n.text.trim();
          const shown = text.length > 400 ? text.slice(0, 399).trimEnd() + '…' : text;
          const line = `- id ${n.id}${n.time ? ' at ' + n.time : ''}${n.mood != null ? ` mood ${n.mood}` : ''}${n.energy != null ? ` energy ${n.energy}` : ''}${n.tags.length ? ' [' + n.tags.join(', ') + ']' : ''}${n.pinned ? ' ★' : ''}: ${shown || '(no text)'}`;
          if ((budget -= line.length) < 0) { out.push('…more notes not shown'); break; }
          out.push(line);
        }
        return out.join('\n');
      },
    },
    {
      name: 'list',
      description: 'List recent notes, newest first, with ids. Filter by days back and/or a search word (matches text, tags and date).',
      params: {
        days: { type: 'integer', description: 'How many days back from today (1-365). Default 14.' },
        query: { type: 'string', description: 'Optional search text; case-insensitive.' },
        pinned_only: { type: 'boolean', description: 'If true, only pinned notes (ignores days).' },
      },
      write: false,
      async run(ctx, args = {}) {
        const today = dates.today();
        let days = 14;
        if (args.days != null && args.days !== '') {
          days = Number(args.days);
          if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be a whole number from 1 to 365');
        }
        const pinnedOnly = argBool(args.pinned_only) === true;
        const q = String(args.query ?? '').trim().toLowerCase();
        const since = dates.addDays(today, -(days - 1));
        let rows = await allNotes(ctx.db);
        if (pinnedOnly) rows = rows.filter((n) => n.pinned);
        else rows = rows.filter((n) => n.date >= since && n.date <= today);
        if (q) rows = rows.filter((n) => `${n.text} ${n.tags.join(' ')} ${n.date} ${dates.label(n.date)}`.toLowerCase().includes(q));
        const scope = pinnedOnly ? 'pinned notes' : `notes from ${since} to ${today}`;
        if (!rows.length) return `No ${scope}${q ? ` matching "${q}"` : ''}.`;
        const lines = [`${rows.length} ${scope}${q ? ` matching "${q}"` : ''}:`];
        for (const n of rows.slice(0, ACTION_ROWS)) lines.push('- ' + noteLine(n, 60));
        if (rows.length > ACTION_ROWS) lines.push(`…${rows.length - ACTION_ROWS} more not shown (narrow with days or query).`);
        return lines.join('\n');
      },
    },
    {
      name: 'update',
      description: 'Change one existing note by id (from list or get_day). Only the fields you pass change. append=true adds text as a new paragraph and merges tags instead of replacing. To write something new, prefer notes_add.',
      params: {
        id: { type: 'string', description: 'Note id.' },
        text: { type: 'string', description: 'New text (replaces unless append). "" clears it.' },
        append: { type: 'boolean', description: 'Append text / merge tags instead of replacing.' },
        mood: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Mood 1-5.' },
        energy: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Energy 1-5.' },
        tags: { type: 'string', description: 'Comma-separated tags. "" clears them.' },
        pinned: { type: 'boolean', description: 'Pin or unpin.' },
        date: { type: 'string', description: 'Move to another date, YYYY-MM-DD.' },
        time: { type: 'string', description: 'New time HH:MM.' },
      },
      required: ['id'],
      write: true,
      preview: async (a = {}, ctx) => {
        const n = await previewNoteById(ctx, a.id);
        const bits = describeFields(a);
        return `Update note ${n ? noteLabel(n) : a.id}: ${bits.join(', ') || 'no changes'}`;
      },
      async run(ctx, args = {}) {
        const base = await requireNote(ctx, args.id);
        const append = argBool(args.append) === true;
        const mood = argScale(args.mood, 'mood'), energy = argScale(args.energy, 'energy'), pinned = argBool(args.pinned);
        const time = args.time === '' ? '' : argTime(args.time);
        const date = args.date == null || args.date === '' ? undefined : argDate(args.date);
        if (args.text != null && typeof args.text !== 'string') throw new Error('text must be a string');
        const rec = { ...base };
        let changed = false;
        if (args.text != null) { rec.text = !append ? args.text : !args.text.trim() ? base.text : base.text.trim() ? `${base.text.replace(/\s+$/, '')}\n\n${args.text}` : args.text; changed = true; }
        if (args.tags != null) { const inc = parseTags(args.tags); rec.tags = append ? [...new Set([...base.tags, ...inc])] : inc; changed = true; }
        if (mood !== undefined) { rec.mood = mood; changed = true; }
        if (energy !== undefined) { rec.energy = energy; changed = true; }
        if (pinned !== undefined) { rec.pinned = pinned; changed = true; }
        if (date !== undefined) { rec.date = date; changed = true; }
        if (time !== undefined) { rec.time = time; changed = true; }
        if (!changed) throw new Error('Nothing to update: pass at least one field');
        const next = norm(rec);
        if (!hasContent(next)) { await ctx.db.delete(STORE, base.id); return `Note ${base.id} became empty and was removed.`; }
        const saved = norm(await ctx.db.put(STORE, next));
        return `Updated note ${saved.id}: ${noteLine(saved, 100)}`;
      },
    },
    {
      name: 'delete',
      description: 'Delete one note by id. Other notes of that day stay.',
      params: { id: { type: 'string', description: 'Note id.' } },
      required: ['id'],
      write: true,
      preview: async (a = {}, ctx) => {
        const n = await previewNoteById(ctx, a.id);
        return `Delete note ${n ? noteLabel(n) : a.id}`;
      },
      async run(ctx, args = {}) {
        const n = await requireNote(ctx, args.id);
        await ctx.db.delete(STORE, n.id);
        return `Deleted note ${n.id} from ${n.date}${n.time ? ' ' + n.time : ''}.`;
      },
    },
  ],
};
