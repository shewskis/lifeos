// notes.js — Daily notes: one journal entry per day with mood & energy. Autosaves as you type.
import { h, clear, dates, fmt, icon, toast, formSheet, listItem, empty, card, stat, lineChart } from '../ui.js';

const STORE = 'notes';
const PLACEHOLDER = 'How was your day? Wins, struggles, gratitude…';
const MOOD = { 1: ['😞', 'Awful'], 2: ['😕', 'Low'], 3: ['😐', 'Okay'], 4: ['🙂', 'Good'], 5: ['😄', 'Great'] };
const ENERGY = { 1: 'Drained', 2: 'Tired', 3: 'Steady', 4: 'Energised', 5: 'Buzzing' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MOOD_COLOR = 'var(--accent)';
const ENERGY_COLOR = 'var(--good)';
const PAGE = 40;

const STYLE = `
.module[data-module="notes"] .notes-emoji { font-size: 22px; line-height: 1; width: 32px; text-align: center; }
.module[data-module="notes"] .notes-saved { display: inline-block; min-height: 18px; opacity: 0; transition: opacity .4s; }
.module[data-module="notes"] .notes-slider.unset input[type="range"] { opacity: .4; }
.module[data-module="notes"] .notes-legend { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--muted); margin: 6px 0 2px; }
.module[data-module="notes"] .notes-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.module[data-module="notes"] .notes-ta { min-height: 170px; }
.module[data-module="notes"] .icon-btn:disabled { opacity: .3; pointer-events: none; }
.module[data-module="notes"] .notes-slider .notes-clear { width: 40px; height: 40px; margin: -8px 0; }
.module[data-module="notes"] .date-nav .notes-date { flex: 1; min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; background: none; border: 0; padding: 4px 8px; border-radius: 12px; color: var(--text); font: inherit; cursor: pointer; transition: background .15s; }
.module[data-module="notes"] .date-nav .notes-date:active { background: var(--card-2); }
.module[data-module="notes"] .date-nav .notes-date[aria-disabled="true"] { cursor: default; }
.module[data-module="notes"] .date-nav .notes-date-label { font-size: 17px; font-weight: 700; line-height: 1.2; }
.module[data-module="notes"] .date-nav .notes-date .small { font-weight: 400; }
`;

// ---------- record helpers (defensive against old/partial records) ----------
function clamp15(v) { const n = Number(v); return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : null; }
function isDateKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function parseTags(v) {
  if (Array.isArray(v)) return v.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,\n#]/).map((s) => s.trim()).filter(Boolean);
  return [];
}
function norm(n) {
  if (!n) return null;
  return { ...n, date: isDateKey(n.date) ? n.date : String(n.date ?? dates.today()), text: String(n.text ?? ''), mood: clamp15(n.mood), energy: clamp15(n.energy), tags: parseTags(n.tags), pinned: !!n.pinned };
}
function hasContent(n) { return !!(n && (n.text.trim() || n.mood != null || n.energy != null || n.tags.length || n.pinned)); }
function snippet(text, n = 80) { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }
function moodEmoji(m) { return MOOD[m]?.[0] || ''; }
function moodText(m) { return m == null ? 'Not set' : `${MOOD[m][0]} ${MOOD[m][1]} · ${m}/5`; }
function energyText(e) { return e == null ? 'Not set' : `⚡ ${ENERGY[e]} · ${e}/5`; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function sortDesc(rows) { return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.updatedAt || 0) - (a.updatedAt || 0))); }
async function allNotes(db) { return sortDesc((await db.all(STORE)).map(norm)); }
/** The single note for a date (if duplicates exist from imports, the most recently updated wins). */
async function noteFor(db, date) {
  const rows = (await db.where(STORE, 'date', date)).map(norm);
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return rows[0] || null;
}
function streakOf(notes) {
  const set = new Set(notes.filter(hasContent).map((n) => n.date));
  let d = dates.today();
  if (!set.has(d)) d = dates.addDays(d, -1);
  let s = 0;
  while (set.has(d)) { s++; d = dates.addDays(d, -1); }
  return s;
}

// ---------- AI action helpers (text in / text out; reuse the record helpers above) ----------
const ACTION_ROWS = 20;
function argDate(v) {
  if (v == null || v === '') return dates.today();
  if (!isDateKey(v)) throw new Error(`Date must be YYYY-MM-DD, got "${v}"`);
  return v;
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
/** Preview helpers: name a note the way the UI would ('Sat 1 Nov ("Gym then dinner…" · mood 4/5)'). Never throw. */
function previewDate(v) { return isDateKey(v) ? v : dates.today(); }
async function previewNote(ctx, date) {
  try { const n = await noteFor(ctx?.db, date); return hasContent(n) ? n : null; } catch { return null; }
}
function noteLabel(n) {
  const text = snippet(n.text, 40);
  const bits = [text ? `"${text}"` : null, n.mood != null ? `mood ${n.mood}/5` : null, n.energy != null ? `energy ${n.energy}/5` : null, n.tags.length ? '#' + n.tags.slice(0, 3).join(' #') : null, n.pinned ? 'pinned' : null].filter(Boolean);
  return bits.length ? ` (${bits.join(' · ')})` : '';
}
function previewBool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function noteLine(n, textLen = 70) {
  const meta = [n.mood != null ? `mood ${n.mood}` : null, n.energy != null ? `energy ${n.energy}` : null].filter(Boolean).join(', ');
  return `${n.date} (id ${n.id})${meta ? ' ' + meta : ''}${n.tags.length ? ' [' + n.tags.join(', ') + ']' : ''}${n.pinned ? ' ★' : ''}: ${snippet(n.text, textLen) || '(no text)'}`;
}

/** Range slider 1–5 with a "Not set" state and a clear button. */
function slider(label, value, fmtValue, lo, hi, onChange) {
  const wrap = h('div.field.notes-slider');
  const out = h('span.range-value', fmtValue(value));
  const input = h('input', { type: 'range', min: 1, max: 5, step: 1, 'aria-label': label });
  const clearBtn = h('button.icon-btn.notes-clear', { type: 'button', 'aria-label': `Clear ${label}`, onclick: () => { set(null); onChange(null); } }, icon('close', 18));
  const set = (v) => {
    value = v;
    wrap.classList.toggle('unset', v == null);
    out.textContent = fmtValue(v);
    clearBtn.style.visibility = v == null ? 'hidden' : 'visible';
    input.value = v == null ? 3 : v;
  };
  input.addEventListener('input', () => set(Number(input.value)));
  input.addEventListener('change', () => onChange(Number(input.value)));
  wrap.append(
    h('span.field-label', h('span', label), h('span.row', { style: { gap: '4px' } }, out, clearBtn)),
    input,
    h('div.row.between.small.muted', h('span', lo), h('span', hi)));
  set(value);
  return wrap;
}

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
    let selected = isDateKey(ctx.params?.date) ? ctx.params.date : today;
    let query = '';
    let showAll = false;
    let current = null;     // normalised record for the selected day, or null
    let editor = null;      // { ta, tagsInput, mood, energy, pinned, savedEl }
    let lastNotes = [];
    let selfPending = 0;    // db writes made by this screen (avoid re-drawing the editor under the user's fingers)
    let timer = null, flashTimer = null;

    container.append(h('style', STYLE));
    const pinnedHolder = h('div'), navHolder = h('div'), editorHolder = h('div'), chartHolder = h('div');
    const listHolder = h('div');
    const searchInput = h('input', { type: 'search', placeholder: 'Search notes and tags', 'aria-label': 'Search notes' });
    searchInput.addEventListener('input', () => { query = searchInput.value; showAll = false; drawPastList(); });
    const pastHolder = h('div', h('div.section-title', 'Past days'), h('div.search-bar', icon('search', 18), searchInput), listHolder);
    container.append(pinnedHolder, navHolder, editorHolder, chartHolder, pastHolder);

    // ----- saving -----
    function setSaved(msg, sticky) {
      if (!editor) return;
      editor.savedEl.textContent = msg;
      editor.savedEl.style.opacity = '1';
      clearTimeout(flashTimer);
      if (!sticky) flashTimer = setTimeout(() => { if (editor) editor.savedEl.style.opacity = '0'; }, 1800);
    }
    function clearPending() { if (editor && editor.savedEl.textContent === 'Saving…') setSaved(''); }
    async function selfWrite(fn) {
      selfPending++;
      try { return await fn(); }
      catch (e) { selfPending = Math.max(0, selfPending - 1); throw e; }
    }
    // Saves are serialised: a blur-flush and a slider/pin change can fire back-to-back, and two concurrent
    // writes for a brand-new day would both see `current === null` and create duplicate records.
    // The editor values are snapshotted synchronously when save() is called (not when the queued write runs), so a
    // final flush from the render cleanup still persists what was typed even though `editor` is nulled right after.
    let saveChain = Promise.resolve();
    function snapshot() {
      if (!editor) return null;
      return { text: editor.ta.value, mood: editor.mood, energy: editor.energy, tags: parseTags(editor.tagsInput.value), pinned: editor.pinned };
    }
    function save(vals = snapshot(), date = selected) {
      const run = () => doSave(vals, date);
      saveChain = saveChain.then(run, run);
      return saveChain;
    }
    async function doSave(vals, date) {
      clearTimeout(timer); timer = null;
      if (!vals) return;
      const existing = current;
      const emptyNow = !hasContent({ ...vals });
      try {
        if (!existing && emptyNow) { clearPending(); return; }
        if (existing && emptyNow) { await selfWrite(() => db.delete(STORE, existing.id)); current = null; setSaved('Saved'); return; }
        if (existing && existing.text === vals.text && existing.mood === vals.mood && existing.energy === vals.energy && existing.pinned === vals.pinned && existing.tags.join('\u0001') === vals.tags.join('\u0001')) { clearPending(); return; }
        const rec = { ...(existing || {}), date: existing?.date || date, ...vals };
        current = norm(await selfWrite(() => db.put(STORE, rec)));
        setSaved('Saved');
      } catch (e) { console.error(e); toast('Could not save note'); }
    }
    function scheduleSave() { if (!editor) return; clearTimeout(timer); setSaved('Saving…', true); timer = setTimeout(() => save(), 600); }
    // Always waits for any write already in flight too (a blur-triggered save may have cleared `timer` moments earlier).
    async function flush() { if (timer) { clearTimeout(timer); timer = null; save(); } await saveChain; }

    async function select(date) {
      await flush();
      selected = date;
      drawNav();
      await drawEditor();
      drawPastList();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function togglePin(n) {
      try {
        await flush();
        if (n.date === selected && editor) {
          // The row is a stale snapshot; the editor is the source of truth for the selected day. Toggle there and
          // save through the chain so unsaved text is kept and the textarea is not rebuilt under the user's fingers.
          const pinned = !editor.pinned;
          editor.setPinned(pinned);
          await save();
          if ((current?.pinned ?? false) === pinned) toast(pinned ? 'Pinned' : 'Unpinned');
          return;
        }
        const base = n.date === selected && current ? current : n;
        await selfWrite(() => db.put(STORE, { ...base, pinned: !base.pinned }));
        toast(base.pinned ? 'Unpinned' : 'Pinned');
        if (n.date === selected) await drawEditor();
      } catch (e) { console.error(e); toast('Could not update note'); }
    }

    // ----- drawing -----
    function drawNav() {
      clear(navHolder);
      const isToday = selected === today;
      const sub = isToday
        ? dates.parse(selected).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
        : 'Tap for today';
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

    async function drawEditor(focus = false) {
      clear(editorHolder);
      editor = null;
      current = await noteFor(db, selected);
      const n = current || norm({ date: selected });

      const ta = h('textarea.input.notes-ta', { rows: 8, placeholder: PLACEHOLDER });
      ta.value = n.text;
      ta.addEventListener('input', scheduleSave);
      ta.addEventListener('blur', () => { flush(); });

      const savedEl = h('span.small.muted.notes-saved', '');
      const tagsInput = h('input.input', { type: 'text', placeholder: 'Tags — work, family, gym…', autocapitalize: 'off' });
      tagsInput.value = n.tags.join(', ');
      tagsInput.addEventListener('input', scheduleSave);
      tagsInput.addEventListener('change', () => { flush(); });

      const st = { ta, tagsInput, savedEl, mood: n.mood, energy: n.energy, pinned: n.pinned };
      editor = st;

      const pinBtn = h('button.btn.sm', { type: 'button', onclick: () => { st.setPinned(!st.pinned); save(); } });
      const stylePin = () => {
        pinBtn.className = 'btn sm' + (st.pinned ? '' : ' ghost');
        pinBtn.style.color = st.pinned ? 'var(--accent)' : 'var(--muted)';
        pinBtn.replaceChildren(icon('star', 16), st.pinned ? 'Pinned' : 'Pin');
      };
      st.setPinned = (v) => { st.pinned = !!v; stylePin(); };
      stylePin();
      const moreBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'More options', onclick: openEditSheet }, icon('more'));

      const moodEl = slider('Mood', st.mood, moodText, '😞 Awful', '😄 Great', (v) => { st.mood = v; save(); });
      const energyEl = slider('Energy', st.energy, energyText, 'Drained', 'Buzzing', (v) => { st.energy = v; save(); });

      editorHolder.append(card(
        ta,
        h('div.row.between', { style: { marginTop: '8px' } }, savedEl, h('div.row', { style: { gap: '4px' } }, pinBtn, moreBtn)),
        h('div.divider'),
        h('div.form', moodEl, energyEl, h('label.field', h('span.field-label', 'Tags'), tagsInput))));
      if (focus) setTimeout(() => ta.focus(), 120);
    }

    function noteRow(n) {
      let longPressed = false;
      return listItem({
        leading: h('span.notes-emoji', moodEmoji(n.mood) || '📝'),
        title: h('span', dates.label(n.date), n.pinned ? h('span.accent', ' ★') : null),
        sub: snippet(n.text, 80) || (n.tags.length ? n.tags.map((t) => '#' + t).join(' ') : 'No text'),
        right: n.energy != null ? h('span.small.muted', `⚡${n.energy}`) : null,
        onClick: () => { if (longPressed) return; select(n.date); },
        onLongPress: () => { longPressed = true; setTimeout(() => { longPressed = false; }, 700); togglePin(n); },
      });
    }

    function drawPinned(notes) {
      clear(pinnedHolder);
      const pinned = notes.filter((n) => n.pinned);
      if (!pinned.length) return;
      pinnedHolder.append(card(
        h('div.card-title', h('h3', 'Pinned'), h('span.small.muted', 'Long-press a note to unpin')),
        h('div.list', pinned.map(noteRow))));
    }

    function drawChart(notes) {
      clear(chartHolder);
      const from = dates.addDays(today, -29);
      const inRange = notes.filter((n) => n.date >= from && n.date <= today && hasContent(n)).sort((a, b) => (a.date < b.date ? -1 : 1));
      const mp = inRange.filter((n) => n.mood != null).map((n) => ({ x: n.date, y: n.mood }));
      const ep = inRange.filter((n) => n.energy != null).map((n) => ({ x: n.date, y: n.energy }));
      const c = card(h('div.card-title', h('h3', 'Mood & energy'), h('span.small.muted', 'Last 30 days')));
      if (!mp.length && !ep.length) {
        c.append(h('p.small.muted', { style: { margin: 0 } }, 'Set mood and energy on your daily note and your trends will show up here.'));
        chartHolder.append(c);
        return;
      }
      const am = avg(mp.map((p) => p.y)), ae = avg(ep.map((p) => p.y));
      const streak = streakOf(notes);
      c.append(h('div.stats.mb',
        stat('Avg mood', am != null ? `${moodEmoji(Math.round(am))} ${fmt.num(am, 1)}` : '–', mp.length ? `${mp.length} day${mp.length === 1 ? '' : 's'}` : 'not set'),
        stat('Avg energy', ae != null ? `⚡ ${fmt.num(ae, 1)}` : '–', ep.length ? `${ep.length} day${ep.length === 1 ? '' : 's'}` : 'not set'),
        stat('Streak', String(streak), streak === 1 ? 'day in a row' : 'days in a row')));
      c.append(h('div.notes-legend', h('i', { style: { background: MOOD_COLOR } }), 'Mood'), lineChart(mp, { height: 110, color: MOOD_COLOR, yMin: 1, yMax: 5 }));
      c.append(h('div.notes-legend', h('i', { style: { background: ENERGY_COLOR } }), 'Energy'), lineChart(ep, { height: 110, color: ENERGY_COLOR, yMin: 1, yMax: 5 }));
      chartHolder.append(c);
    }

    function drawPastList() {
      clear(listHolder);
      const q = query.trim().toLowerCase();
      let rows = lastNotes.filter((n) => n.date !== selected && hasContent(n));
      if (q) rows = rows.filter((n) => `${n.text} ${n.tags.join(' ')} ${n.date} ${dates.label(n.date)}`.toLowerCase().includes(q));
      if (!rows.length) {
        listHolder.append(q
          ? empty('Nothing matches', 'Try another word, a tag or a date.', 'search')
          : empty('No past notes yet', 'Write about today above — one note per day, saved as you type. Use the arrows to fill in earlier days.', 'note'));
        return;
      }
      const shown = showAll ? rows : rows.slice(0, PAGE);
      const c = card(h('div.list', shown.map(noteRow)));
      if (rows.length > shown.length) c.append(h('button.btn.block.ghost', { type: 'button', onclick: () => { showAll = true; drawPastList(); } }, `Show all ${rows.length}`));
      listHolder.append(c);
    }

    async function drawRest() {
      lastNotes = await allNotes(db);
      drawPinned(lastNotes);
      drawChart(lastNotes);
      drawPastList();
    }

    // ----- edit sheet (move date, edit text/tags, pin, delete) -----
    async function openEditSheet() {
      await flush();
      const n = current || norm({ date: selected });
      const vals = await formSheet({
        title: current ? 'Edit note' : 'Note details',
        fields: [
          { name: 'date', label: 'Date', type: 'date', required: true },
          { name: 'text', label: 'Note', type: 'textarea', rows: 6, placeholder: PLACEHOLDER },
          { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'work, family, gym' },
          { name: 'pinned', label: 'Pinned', type: 'toggle' },
        ],
        values: { date: n.date, text: n.text, tags: n.tags, pinned: n.pinned },
        onDelete: current ? async () => {
          try { await selfWrite(() => db.delete(STORE, current.id)); current = null; toast('Note deleted'); await drawEditor(); }
          catch (e) { console.error(e); toast('Could not delete note'); }
        } : undefined,
      });
      if (!vals) return;
      try {
        let date = isDateKey(vals.date) ? vals.date : selected;
        if (date !== selected) {
          const clash = await noteFor(db, date);
          if (clash) { toast(`There is already a note on ${dates.label(date)}`); date = selected; }
        }
        const rec = { ...n, date, text: String(vals.text ?? ''), tags: parseTags(vals.tags), pinned: !!vals.pinned, mood: editor ? editor.mood : n.mood, energy: editor ? editor.energy : n.energy };
        if (!hasContent(norm(rec))) {
          if (current) { await selfWrite(() => db.delete(STORE, current.id)); current = null; }
          await drawEditor();
          return;
        }
        current = norm(await selfWrite(() => db.put(STORE, rec)));
        if (date !== selected) { selected = date; drawNav(); }
        await drawEditor();
        drawPastList();
        toast('Saved');
      } catch (e) { console.error(e); toast('Could not save note'); }
    }

    // ----- initial draw + live updates -----
    drawNav();
    await drawEditor(ctx.params?.add === '1');
    await drawRest();

    const off = db.onChange(STORE, async () => {
      if (selfPending > 0) { selfPending--; await drawRest(); return; }
      // change from elsewhere (import, another screen): redraw everything
      await drawEditor();
      await drawRest();
    });

    return () => {
      off();
      clearTimeout(flashTimer);
      // save() snapshots the editor synchronously, so the pending burst is persisted even though `editor` is nulled next.
      if (timer) { clearTimeout(timer); timer = null; save().catch(() => {}); }
      editor = null;
    };
  },

  quickActions: [{ label: 'Note', icon: 'note', run: async (ctx) => ctx.nav('mind/notes?add=1') }],

  async todayCard(ctx) {
    const n = await noteFor(ctx.db, dates.today());
    if (!hasContent(n)) {
      return h('div.card.tappable', { onclick: () => ctx.nav('mind/notes?add=1') },
        h('div.row', icon('note', 26), h('div.grow', h('h3', 'Write about today'), h('div.small.muted', 'Journal, mood & energy — takes a minute')), icon('chevron')));
    }
    const chips = [];
    if (n.mood != null) chips.push(h('span.chip.accent', `${moodEmoji(n.mood)} Mood ${n.mood}/5`));
    if (n.energy != null) chips.push(h('span.chip.good', `⚡ Energy ${n.energy}/5`));
    for (const t of n.tags.slice(0, 3)) chips.push(h('span.chip', '#' + t));
    return h('div.card.tappable', { onclick: () => ctx.nav('mind/notes') },
      h('div.card-title', h('h3', 'Daily note'), h('span.link', 'Edit')),
      chips.length ? h('div.chips.mb', chips) : null,
      n.text.trim()
        ? h('p.small', { style: { margin: 0 } }, snippet(n.text, 140))
        : h('p.small.muted', { style: { margin: 0 } }, 'Add a few words about your day'));
  },

  async exportForAI(ctx, { since, days } = {}) {
    const today = dates.today();
    since = isDateKey(since) ? since : dates.addDays(today, -((days || 90) - 1));
    const rows = sortDesc((await ctx.db.range(STORE, since, today)).map(norm)).filter(hasContent);
    if (!rows.length) return '';
    const moods = rows.filter((r) => r.mood != null), energies = rows.filter((r) => r.energy != null);

    const trend = (field) => {
      const last = rows.filter((r) => r.date >= dates.addDays(today, -6) && r[field] != null).map((r) => r[field]);
      const prev = rows.filter((r) => r.date >= dates.addDays(today, -13) && r.date <= dates.addDays(today, -7) && r[field] != null).map((r) => r[field]);
      if (!last.length) return '';
      if (!prev.length) return `; last 7 days avg ${fmt.num(avg(last), 2)}`;
      const d = avg(last) - avg(prev);
      const dir = d > 0.15 ? 'up' : d < -0.15 ? 'down' : 'flat';
      return `; 7-day trend ${dir} (${fmt.num(avg(last), 2)} vs ${fmt.num(avg(prev), 2)} the week before)`;
    };
    const dayLine = (r) => `${r.date} (mood ${r.mood ?? '-'}, energy ${r.energy ?? '-'})${r.text.trim() ? ': ' + snippet(r.text, 100) : ''}`;

    const lines = [`## Daily notes (${since} → ${today})`];
    lines.push(`- ${rows.length} days with notes (${moods.length} with mood, ${energies.length} with energy). Current streak: ${streakOf(rows)} day(s).`);
    if (moods.length) lines.push(`- Avg mood ${fmt.num(avg(moods.map((r) => r.mood)), 2)}/5${trend('mood')}`);
    if (energies.length) lines.push(`- Avg energy ${fmt.num(avg(energies.map((r) => r.energy)), 2)}/5${trend('energy')}`);
    if (moods.length) {
      const byDow = Array.from({ length: 7 }, () => []);
      for (const r of moods) { const d = dates.parse(r.date).getDay(); if (byDow[d]) byDow[d].push(r.mood); }
      const parts = [1, 2, 3, 4, 5, 6, 0].filter((i) => byDow[i].length).map((i) => `${DOW[i]} ${fmt.num(avg(byDow[i]), 1)} (n=${byDow[i].length})`);
      if (parts.length) lines.push('- Avg mood by weekday: ' + parts.join(', '));
      if (moods.length >= 2) {
        const sorted = [...moods].sort((a, b) => (b.mood - a.mood) || ((b.energy ?? 0) - (a.energy ?? 0)));
        lines.push(`- Best day: ${dayLine(sorted[0])}`);
        lines.push(`- Worst day: ${dayLine(sorted[sorted.length - 1])}`);
      }
    }
    const tagCount = {};
    for (const r of rows) for (const t of r.tags) tagCount[t] = (tagCount[t] || 0) + 1;
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (topTags.length) lines.push('- Top tags: ' + topTags.map(([t, c]) => `${t} (${c})`).join(', '));
    const pinned = rows.filter((r) => r.pinned);
    if (pinned.length) lines.push('- Pinned days: ' + pinned.map((r) => r.date).join(', '));

    lines.push('', '### Last 30 notes (newest first)');
    const headerLen = lines.length;
    for (const r of rows.slice(0, 30)) {
      lines.push(`- ${r.date} mood ${r.mood ?? '-'} energy ${r.energy ?? '-'}${r.tags.length ? ' [' + r.tags.join(', ') + ']' : ''}${r.pinned ? ' (pinned)' : ''}: ${snippet(r.text, 300) || '(no text)'}`);
    }
    let truncated = false;
    while (lines.length > headerLen && lines.join('\n').length > 7500) { lines.pop(); truncated = true; }
    if (truncated) lines.push('…(older notes omitted)');
    return lines.join('\n');
  },

  actions: [
    {
      name: 'set_day',
      description: 'Write or update the single daily note for a date (defaults to today). Only the fields you pass change; others are kept. Use append=true to add text to the existing note instead of replacing it. Use clear_day to remove a note.',
      params: {
        date: { type: 'string', description: 'Day of the note, YYYY-MM-DD. Defaults to today.' },
        text: { type: 'string', description: 'Journal text. Replaces the existing text unless append is true. Pass "" to clear the text.' },
        append: { type: 'boolean', description: 'If true, add text as a new paragraph after the existing text and merge tags instead of replacing.' },
        mood: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Mood 1 (awful) to 5 (great).' },
        energy: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Energy 1 (drained) to 5 (buzzing).' },
        tags: { type: 'string', description: 'Comma-separated tags, e.g. "work, gym". Replaces existing tags unless append is true. Pass "" to clear.' },
        pinned: { type: 'boolean', description: 'Pin or unpin the day.' },
      },
      write: true,
      preview: async (a = {}, ctx) => {
        const date = previewDate(a.date);
        const bits = [];
        try {
          const append = previewBool(a.append);
          if (a.text != null) bits.push(a.text === '' ? 'clear the text' : `${append ? 'append' : 'set'} text "${snippet(String(a.text), 50)}"`);
          if (a.mood != null && a.mood !== '') { const m = clamp15(a.mood); bits.push(`mood ${a.mood}/5${m ? ' ' + MOOD[m][0] + ' ' + MOOD[m][1] : ''}`); }
          if (a.energy != null && a.energy !== '') { const e = clamp15(a.energy); bits.push(`energy ${a.energy}/5${e ? ' (' + ENERGY[e] + ')' : ''}`); }
          if (a.tags != null) bits.push(a.tags === '' ? 'clear the tags' : `${append ? 'add' : 'set'} tags ${parseTags(a.tags).map((t) => '#' + t).join(' ') || '(none)'}`);
          if (a.pinned != null && a.pinned !== '') bits.push(previewBool(a.pinned) ? 'pin it' : 'unpin it');
        } catch { /* keep whatever was described so far */ }
        const what = bits.join(', ') || 'no changes';
        const n = await previewNote(ctx, date);
        if (n) return `Update daily note for ${dates.label(date)}${noteLabel(n)}: ${what}`;
        return `Create daily note for ${dates.label(date)}: ${what}`;
      },
      async run(ctx, args = {}) {
        const date = argDate(args.date);
        const mood = argScale(args.mood, 'mood'), energy = argScale(args.energy, 'energy');
        const append = argBool(args.append) === true, pinned = argBool(args.pinned);
        if (args.text != null && typeof args.text !== 'string') throw new Error('text must be a string');
        const hasText = args.text != null;   // '' clears the text (same as emptying the textarea)
        const hasTags = args.tags != null;
        if (!hasText && mood === undefined && energy === undefined && !hasTags && pinned === undefined) throw new Error('Pass at least one of text, mood, energy, tags or pinned');
        const existing = await noteFor(ctx.db, date);
        const base = existing || norm({ date });
        const rec = { ...base, date };
        if (hasText) rec.text = !append ? args.text : !args.text.trim() ? base.text : base.text.trim() ? `${base.text.replace(/\s+$/, '')}\n\n${args.text}` : args.text;
        if (hasTags) {
          const incoming = parseTags(args.tags);
          rec.tags = append ? [...new Set([...base.tags, ...incoming])] : incoming;
        }
        if (mood !== undefined) rec.mood = mood;
        if (energy !== undefined) rec.energy = energy;
        if (pinned !== undefined) rec.pinned = pinned;
        const next = norm(rec);
        if (!hasContent(next)) {
          // Same as the UI: an emptied note is removed rather than stored blank.
          if (existing) { await ctx.db.delete(STORE, existing.id); return `Note for ${date} (id ${existing.id}) is now empty and was removed.`; }
          return `Nothing to save for ${date}: the note would be empty.`;
        }
        const saved = norm(await ctx.db.put(STORE, next));
        return `${existing ? 'Updated' : 'Created'} note for ${saved.date} (id ${saved.id}): mood ${saved.mood ?? '-'}, energy ${saved.energy ?? '-'}, tags [${saved.tags.join(', ')}]${saved.pinned ? ', pinned' : ''}, ${saved.text.length} chars. Text: ${snippet(saved.text, 120) || '(none)'}`;
      },
    },
    {
      name: 'get_day',
      description: 'Read the full daily note for one date (defaults to today): id, text, mood, energy, tags, pinned.',
      params: {
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      },
      write: false,
      async run(ctx, args = {}) {
        const date = argDate(args.date);
        const n = await noteFor(ctx.db, date);
        if (!hasContent(n)) return `No note for ${date} (${dates.label(date)}).`;
        const text = n.text.trim();
        const shown = text.length > 1000 ? text.slice(0, 999).trimEnd() + '…' : text;
        return [
          `Note for ${n.date} (${dates.label(n.date)}), id ${n.id}${n.pinned ? ', pinned' : ''}`,
          `Mood ${n.mood != null ? n.mood + '/5' : 'not set'}, energy ${n.energy != null ? n.energy + '/5' : 'not set'}, tags [${n.tags.join(', ')}]`,
          shown ? `Text (${text.length} chars):\n${shown}` : 'Text: (none)',
        ].join('\n');
      },
    },
    {
      name: 'list',
      description: 'List recent daily notes, newest first, with ids. Filter by a number of days back and/or a search word (matches text, tags and date).',
      params: {
        days: { type: 'integer', description: 'How many days back from today to include (1-365). Default 14.' },
        query: { type: 'string', description: 'Optional search text; case-insensitive match on text, tags or date.' },
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
        let rows = (await allNotes(ctx.db)).filter(hasContent);
        if (pinnedOnly) rows = rows.filter((n) => n.pinned);
        else rows = rows.filter((n) => n.date >= since && n.date <= today);
        if (q) rows = rows.filter((n) => `${n.text} ${n.tags.join(' ')} ${n.date} ${dates.label(n.date)}`.toLowerCase().includes(q));
        const scope = pinnedOnly ? 'pinned notes' : `notes from ${since} to ${today}`;
        if (!rows.length) return `No ${scope}${q ? ` matching "${q}"` : ''}.`;
        const moods = rows.filter((n) => n.mood != null).map((n) => n.mood), energies = rows.filter((n) => n.energy != null).map((n) => n.energy);
        const lines = [`${rows.length} ${scope}${q ? ` matching "${q}"` : ''}. Avg mood ${moods.length ? fmt.num(avg(moods), 1) : '-'}, avg energy ${energies.length ? fmt.num(avg(energies), 1) : '-'}.`];
        for (const n of rows.slice(0, ACTION_ROWS)) lines.push('- ' + noteLine(n, 60));
        if (rows.length > ACTION_ROWS) lines.push(`…${rows.length - ACTION_ROWS} more not shown (narrow with days or query).`);
        return lines.join('\n');
      },
    },
    {
      name: 'clear_day',
      description: 'Delete the daily note for a date entirely (text, mood, energy, tags). Same as Delete in the note editor. Ask the user before calling this.',
      params: {
        date: { type: 'string', description: 'YYYY-MM-DD of the note to delete. Defaults to today.' },
      },
      write: true,
      preview: async (a = {}, ctx) => {
        const date = previewDate(a.date);
        const n = await previewNote(ctx, date);
        if (!n) return `Delete the daily note for ${dates.label(date)}`;
        return `Delete daily note for ${dates.label(date)}${noteLabel(n)}`;
      },
      async run(ctx, args = {}) {
        const date = argDate(args.date);
        const n = await noteFor(ctx.db, date);
        if (!n) throw new Error(`There is no note for ${date}`);
        await ctx.db.delete(STORE, n.id);
        return `Deleted note for ${date} (id ${n.id}).`;
      },
    },
  ],
};
