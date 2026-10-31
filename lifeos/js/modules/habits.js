// habits.js — daily habits with streaks, a 7-day strip per habit and a month heatmap.
import { h, clear, dates, icon, toast, sheet, confirm, formSheet, empty, card, listItem, fab, stat, ring } from '../ui.js';

const HABITS = 'habits';
const LOGS = 'habitLogs';
const SUGGESTIONS = ['🏋️ Workout', '📖 Read 20 min', '🧘 Meditate', '🚶 10k steps', '🚫 No sugar', '😴 In bed by 23:00', '💧 2L water'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EMOJI_RE = /^(\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}\p{Emoji_Modifier}]*)\s*(.*)$/u;

const CSS = `
.habits .habit-row { flex-wrap: wrap; row-gap: 8px; }
.habits .habit-row:last-child { border-bottom: 0; }
.habit-main { display: flex; align-items: center; gap: 10px; flex: 1 1 100%; min-width: 0; text-align: left; color: inherit; }
.habit-main:active { opacity: .7; }
.habit-emoji { width: 36px; height: 36px; border-radius: 10px; background: var(--card-2); display: inline-flex; align-items: center; justify-content: center; font-size: 20px; flex: 0 0 auto; color: var(--muted); }
.habit-title { font-weight: 600; word-break: break-word; }
.habits .habit-days { flex: 1 1 100%; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; max-width: 420px; }
.habits .habit-cell { width: auto; height: 42px; border-radius: 10px; flex-direction: column; gap: 1px; font-size: 11px; font-weight: 700; line-height: 1; }
.habit-cell .d { font-size: 11px; font-weight: 500; }
.habit-cell.off:not(.done) { opacity: .4; }
.habit-cell:disabled { opacity: .25; }
.habit-cell:active { transform: scale(.92); }
.streak.zero { color: var(--muted); }
.habit-heat .habit-cell { width: auto; height: auto; aspect-ratio: 1; font-size: 12px; font-weight: 600; border-radius: 9px; }
.habit-daypick { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
.habit-daypick .btn.sm { padding: 0; min-height: 42px; font-size: 12px; }
.habit-suggest { justify-content: center; margin-top: 4px; }
.habit-suggest .chip { padding: 10px 14px; font-size: 14px; cursor: pointer; }
.habit-archived-head { width: 100%; display: flex; align-items: center; justify-content: space-between; }
.habit-archived-head .icon { display: inline-flex; transition: transform .15s; }
.habit-archived-head.open .icon { transform: rotate(90deg); }
`;

function ensureStyle() {
  if (document.getElementById('habits-style')) return;
  document.head.append(h('style#habits-style', CSS));
}

// ---------- schedule / date helpers ----------
function scheduleOf(hb) {
  const s = hb?.schedule;
  if (Array.isArray(s)) {
    const d = [...new Set(s.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
    return d.length && d.length < 7 ? d : 'daily';
  }
  return 'daily';
}
function isDue(hb, key) {
  const s = scheduleOf(hb);
  return s === 'daily' || s.includes(dates.parse(key).getDay());
}
function weekOrder(ctx) {
  return (ctx?.settings?.get?.('weekStart', 'mon') || 'mon') === 'sun' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
}
function dowDate(dow) { return new Date(2024, 0, 7 + dow); } // 2024-01-07 is a Sunday
function dowNarrow(dow) { return dowDate(dow).toLocaleDateString(undefined, { weekday: 'narrow' }); }
function dowShort(dow) { return dowDate(dow).toLocaleDateString(undefined, { weekday: 'short' }); }
function scheduleLabel(hb, ctx) {
  const s = scheduleOf(hb);
  if (s === 'daily') return 'Every day';
  const j = s.join(',');
  if (j === '1,2,3,4,5') return 'Weekdays';
  if (j === '0,6') return 'Weekends';
  return weekOrder(ctx).filter((d) => s.includes(d)).map(dowShort).join(', ');
}
function createdKey(hb) {
  return hb?.createdAt ? dates.key(new Date(hb.createdAt)) : null;
}
function displayTitle(hb) { return (hb.emoji ? hb.emoji + ' ' : '') + (hb.title || 'Untitled'); }

function normalize(hb) {
  return {
    ...hb,
    title: (hb?.title || 'Untitled'),
    emoji: hb?.emoji || '',
    color: hb?.color || '',
    archived: !!hb?.archived,
    order: Number.isFinite(Number(hb?.order)) ? Number(hb.order) : 0,
    schedule: scheduleOf(hb),
  };
}
function byOrder(a, b) { return (a.order - b.order) || ((a.createdAt || 0) - (b.createdAt || 0)); }

// ---------- stats ----------
/** Consecutive scheduled days completed, ending today (or yesterday if today is due but not yet done). */
function currentStreak(hb, done, today) {
  let key = today;
  if (isDue(hb, today) && !done.has(today)) key = dates.addDays(today, -1);
  let n = 0;
  for (let i = 0; i < 3700; i++) {
    if (isDue(hb, key)) { if (done.has(key)) n++; else break; }
    key = dates.addDays(key, -1);
  }
  return n;
}
function bestStreak(hb, done, today) {
  if (!done.size) return 0;
  let key = [...done].sort()[0];
  let best = 0, cur = 0;
  for (let i = 0; i < 3700 && key <= today; i++) {
    if (isDue(hb, key)) {
      if (done.has(key)) { cur++; if (cur > best) best = cur; }
      else if (key !== today) cur = 0; // an undone today does not break the run
    }
    key = dates.addDays(key, 1);
  }
  return best;
}
/** Completion over the last `days` days. Today counts as due only once done; days before the habit existed are skipped. */
function completion(hb, done, days, today) {
  const ck = createdKey(hb);
  let due = 0, n = 0;
  for (let i = 0; i < days; i++) {
    const key = dates.addDays(today, -i);
    if (!isDue(hb, key)) continue;
    const d = done.has(key);
    if (!d && i === 0) continue;
    if (!d && ck && key < ck) continue;
    due++; if (d) n++;
  }
  return { due, done: n, pct: due ? Math.round((n / due) * 100) : null };
}
function pctLabel(c) { return c.pct == null ? '–' : c.pct + '%'; }
function mostMissedWeekday(hb, done, today) {
  const ck = createdKey(hb);
  const miss = [0, 0, 0, 0, 0, 0, 0];
  let any = false;
  for (let i = 1; i <= 30; i++) {
    const key = dates.addDays(today, -i);
    if (ck && key < ck) break;
    if (!isDue(hb, key) || done.has(key)) continue;
    miss[dates.parse(key).getDay()]++; any = true;
  }
  if (!any) return null;
  let b = 0;
  for (let d = 1; d < 7; d++) if (miss[d] > miss[b]) b = d;
  return `${DOW_SHORT[b]} (${miss[b]}x)`;
}

// ---------- data ----------
async function load(db) {
  const habits = (await db.all(HABITS)).filter(Boolean).map(normalize).sort(byOrder);
  const logs = await db.all(LOGS);
  const done = new Map();
  for (const l of logs) {
    if (!l || !l.habitId || !l.date) continue;
    if (!done.has(l.habitId)) done.set(l.habitId, new Set());
    done.get(l.habitId).add(l.date);
  }
  return { habits, logs, setFor: (id) => done.get(id) || new Set() };
}
/** Runs `fn` at most once at a time; calls made while it is running collapse into a single trailing run. */
function coalesce(fn) {
  let running = false, again = false;
  return async () => {
    if (running) { again = true; return; }
    running = true;
    try { do { again = false; await fn(); } while (again); }
    finally { running = false; }
  };
}
const pendingToggles = new Set(); // `habitId|date` keys with a toggle in flight (ignores double-taps)
async function toggleLog(db, habitId, key) {
  if (key > dates.today()) return;
  const k = `${habitId}|${key}`;
  if (pendingToggles.has(k)) return;
  pendingToggles.add(k);
  try {
    const existing = (await db.where(LOGS, 'habitId', habitId)).filter((l) => l && l.date === key);
    if (existing.length) { for (const l of existing) await db.delete(LOGS, l.id); return false; }
    await db.put(LOGS, { habitId, date: key });
    try { navigator.vibrate?.(8); } catch {}
    return true;
  } finally { pendingToggles.delete(k); }
}
/** Deletes every log of a habit in one readwrite transaction (one change event), falling back to per-row deletes. */
async function deleteLogsFor(db, habitId) {
  const logs = (await db.where(LOGS, 'habitId', habitId)).filter((l) => l && l.id != null);
  if (!logs.length) return;
  const raw = db.db;
  if (raw && typeof raw.transaction === 'function' && typeof db._emit === 'function') {
    const tx = raw.transaction(LOGS, 'readwrite');
    const st = tx.objectStore(LOGS);
    for (const l of logs) st.delete(l.id);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    db._emit(LOGS);
    return;
  }
  for (const l of logs) await db.delete(LOGS, l.id);
}
async function deleteHabit(ctx, id) {
  await deleteLogsFor(ctx.db, id);
  await ctx.db.delete(HABITS, id);
  toast('Habit deleted');
}
async function setArchived(ctx, id, archived) {
  const hb = await ctx.db.get(HABITS, id);
  if (!hb) return;
  await ctx.db.put(HABITS, { ...hb, archived });
  toast(archived ? 'Habit archived' : 'Habit restored');
}

// ---------- forms ----------
/** Opens the add/edit form. Resolves with {title, emoji, schedule} or null. */
async function habitForm(ctx, { values = {}, isEdit = false, onDelete } = {}) {
  const sched = scheduleOf(values);
  const picked = new Set(sched === 'daily' ? [1, 2, 3, 4, 5] : sched);
  const pick = h('div.habit-daypick');
  const pickWrap = h('div.field', h('span.field-label', 'Which days'), pick, h('span.hint', 'Tap the days this habit is due'));
  const renderPick = () => {
    clear(pick);
    for (const d of weekOrder(ctx)) {
      pick.append(h('button.btn.sm', { type: 'button', class: picked.has(d) ? 'primary' : '', onclick: () => { if (picked.has(d)) picked.delete(d); else picked.add(d); renderPick(); } }, dowShort(d)));
    }
  };
  renderPick();
  pickWrap.classList.toggle('hidden', sched === 'daily');

  const p = formSheet({
    title: isEdit ? 'Edit habit' : 'New habit',
    fields: [
      { name: 'title', label: 'Habit', type: 'text', required: true, autofocus: !isEdit, placeholder: 'e.g. Read 20 min' },
      { name: 'emoji', label: 'Emoji', type: 'text', placeholder: 'Optional, e.g. 📖' },
      { name: 'schedule', label: 'Repeat', type: 'segment', options: [{ value: 'daily', label: 'Daily' }, { value: 'days', label: 'Specific days' }] },
    ],
    values: { title: values.title || '', emoji: values.emoji || '', schedule: sched === 'daily' ? 'daily' : 'days' },
    saveLabel: isEdit ? 'Save' : 'Add habit',
    onDelete,
    extra: pickWrap,
  });
  // the sheet is mounted synchronously; wire the segment to the day picker
  const seg = pickWrap.parentElement?.querySelector('.segmented');
  seg?.addEventListener('change', () => pickWrap.classList.toggle('hidden', seg.value !== 'days'));

  const v = await p;
  if (!v) return null;
  let title = String(v.title || '').trim();
  let emoji = String(v.emoji || '').trim();
  if (!emoji) { const m = title.match(EMOJI_RE); if (m && m[2]) { emoji = m[1]; title = m[2].trim(); } }
  if (!title) { toast('Habit needs a name'); return null; }
  let schedule = 'daily';
  if (v.schedule === 'days') {
    if (picked.size === 0) toast('No days picked — saved as daily');
    else if (picked.size < 7) schedule = [...picked].sort((a, b) => a - b);
  }
  return { title, emoji, schedule };
}
async function openAdd(ctx, prefill = {}) {
  const v = await habitForm(ctx, { values: { ...prefill, schedule: 'daily' } });
  if (!v) return;
  const all = await ctx.db.all(HABITS);
  const order = all.reduce((m, x) => Math.max(m, Number(x?.order) || 0), 0) + 1;
  await ctx.db.put(HABITS, { title: v.title, emoji: v.emoji, schedule: v.schedule, color: '', archived: false, order });
  toast('Habit added');
}
async function openEdit(ctx, id) {
  const hb = await ctx.db.get(HABITS, id);
  if (!hb) return;
  const v = await habitForm(ctx, { values: hb, isEdit: true, onDelete: () => deleteHabit(ctx, id) });
  if (!v) return;
  await ctx.db.put(HABITS, { ...normalize(hb), title: v.title, emoji: v.emoji, schedule: v.schedule });
  toast('Habit saved');
}

// ---------- detail sheet ----------
async function openDetail(ctx, id) {
  const today = dates.today();
  let monthKey = dates.monthStart(today);
  let hb = await ctx.db.get(HABITS, id);
  if (!hb) return;
  hb = normalize(hb);
  const holder = h('div');
  let s = null;

  const heatmap = (done) => {
    const order = weekOrder(ctx);
    const grid = h('div.cal-grid.habit-heat');
    for (const d of order) grid.append(h('div.cal-dow', dowNarrow(d)));
    const first = dates.parse(monthKey);
    const n = dates.daysInMonth(monthKey);
    const offset = order.indexOf(first.getDay());
    for (let i = 0; i < offset; i++) grid.append(h('div'));
    let due = 0, hit = 0;
    for (let d = 1; d <= n; d++) {
      const key = monthKey.slice(0, 8) + dates.pad(d);
      const future = key > today, isDue_ = isDue(hb, key), isDone = done.has(key);
      if (!future && isDue_ && (isDone || key !== today)) { due++; if (isDone) hit++; }
      grid.append(h('button.habit-cell', {
        type: 'button', disabled: future,
        class: (isDone ? 'done ' : '') + (key === today ? 'today ' : '') + (isDue_ ? '' : 'off'),
        'aria-label': `${dates.label(key)}${isDone ? ' — done' : ''}`,
        onclick: () => toggleLog(ctx.db, id, key),
      }, String(d)));
    }
    const atCurrent = monthKey >= dates.monthStart(today);
    const nav = h('div.date-nav',
      h('button.icon-btn', { type: 'button', 'aria-label': 'Previous month', onclick: () => { const d = dates.parse(monthKey); monthKey = dates.key(new Date(d.getFullYear(), d.getMonth() - 1, 1)); draw(); } }, icon('back')),
      h('h3', dates.monthLabel(monthKey)),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Next month', disabled: atCurrent, style: { opacity: atCurrent ? '.3' : '1' }, onclick: () => { const d = dates.parse(monthKey); monthKey = dates.key(new Date(d.getFullYear(), d.getMonth() + 1, 1)); draw(); } }, icon('chevron')));
    return h('div', nav, grid, h('div.small.muted.mt', due ? `${hit} of ${due} scheduled days this month · tap a day to fix it` : 'Tap a day to mark it done'));
  };

  let drawId = 0;
  const draw = coalesce(async () => {
    const t = ++drawId;
    const fresh = await ctx.db.get(HABITS, id);
    if (!fresh) { s?.close(); return; }
    hb = normalize(fresh);
    const done = new Set((await ctx.db.where(LOGS, 'habitId', id)).map((l) => l?.date).filter(Boolean));
    if (t !== drawId) return;
    const c30 = completion(hb, done, 30, today);
    const c7 = completion(hb, done, 7, today);
    clear(holder);
    holder.append(
      h('div.small.muted.mb', scheduleLabel(hb, ctx) + (hb.archived ? ' · Archived' : '')),
      h('div.stats.mb',
        stat('Streak', h('span.streak', icon('flame', 18), String(currentStreak(hb, done, today))), 'days'),
        stat('Best', String(bestStreak(hb, done, today)), 'days'),
        stat('30 days', pctLabel(c30), `${c30.done}/${c30.due} · 7d ${pctLabel(c7)}`)),
      heatmap(done));
    const titleEl = s?.el.querySelector('.sheet-title');
    if (titleEl) titleEl.textContent = displayTitle(hb);
  });

  const off1 = ctx.db.onChange(LOGS, draw);
  const off2 = ctx.db.onChange(HABITS, draw);
  s = sheet({
    title: displayTitle(hb),
    content: holder,
    onClose: () => { off1(); off2(); },
    actions: [
      { label: 'Delete', danger: true, onClick: async () => { const ok = await confirm(`Delete "${hb.title}" and all its check-ins?`); if (!ok) return false; await deleteHabit(ctx, id); } },
      { label: hb.archived ? 'Restore' : 'Archive', onClick: () => setArchived(ctx, id, !hb.archived) },
      { label: 'Edit', primary: true, onClick: () => { openEdit(ctx, id); return false; } },
    ],
  });
  await draw();
}

// ---------- module ----------
export default {
  id: 'habits',
  title: 'Habits',
  subtitle: 'Daily streaks',
  icon: 'habit',
  tab: 'plan',

  stores: {
    habits: { indexes: ['order'] },
    habitLogs: { indexes: ['date', 'habitId'] },
  },

  async render(container, ctx) {
    ensureStyle();
    container.classList.add('habits');
    const body = h('div');
    container.append(body);
    let archivedOpen = false;
    let drawId = 0;

    const draw = coalesce(async () => {
      const t = ++drawId;
      const today = dates.today();
      const data = await load(ctx.db);
      if (t !== drawId) return;
      clear(body);
      const active = data.habits.filter((x) => !x.archived);
      const archived = data.habits.filter((x) => x.archived);

      if (!data.habits.length) {
        body.append(
          empty('No habits yet', 'Pick one to start, or tap + to create your own', 'habit'),
          h('div.chips.habit-suggest', SUGGESTIONS.map((sug) => h('button.chip.accent', { type: 'button', onclick: () => {
            const m = sug.match(EMOJI_RE);
            openAdd(ctx, m && m[2] ? { emoji: m[1], title: m[2].trim() } : { title: sug });
          } }, sug))));
        return;
      }

      // header: today's ring + best streak
      const due = active.filter((hb) => isDue(hb, today));
      const doneToday = due.filter((hb) => data.setFor(hb.id).has(today)).length;
      let wDue = 0, wDone = 0;
      for (const hb of active) { const c = completion(hb, data.setFor(hb.id), 7, today); wDue += c.due; wDone += c.done; }
      const best = active.reduce((m, hb) => Math.max(m, bestStreak(hb, data.setFor(hb.id), today)), 0);
      const allDone = due.length > 0 && doneToday === due.length;
      body.append(card(h('div.row',
        ring(due.length ? doneToday / due.length : 0, { size: 64, stroke: 7, color: allDone ? 'var(--good)' : 'var(--accent)', label: due.length ? `${doneToday}/${due.length}` : '–' }),
        h('div.grow',
          h('h3', !due.length ? 'Nothing due today' : allDone ? 'All done today 🎉' : `${doneToday} of ${due.length} done today`),
          h('div.small.muted', wDue ? `${Math.round((wDone / wDue) * 100)}% this week · ${active.length} habit${active.length === 1 ? '' : 's'}` : `${active.length} habit${active.length === 1 ? '' : 's'}`)),
        h('span.chip.warn', icon('flame', 14), `Best streak ${best}`))));

      // habit rows
      if (!active.length) body.append(empty('All habits archived', 'Tap + to add a new one, or restore one below', 'habit'));
      else body.append(card(h('div.list', active.map((hb) => habitRow(hb, data, today)))));

      // archived (collapsed)
      if (archived.length) {
        const head = h('button.section-title.habit-archived-head', { type: 'button', class: archivedOpen ? 'open' : '', onclick: () => { archivedOpen = !archivedOpen; draw(); } },
          h('span', `Archived (${archived.length})`), icon('chevron', 18));
        body.append(head);
        if (archivedOpen) {
          body.append(card(h('div.list', archived.map((hb) => listItem({
            title: hb.title,
            sub: scheduleLabel(hb, ctx),
            leading: h('span.habit-emoji', hb.emoji || icon('habit', 18)),
            right: h('button.btn.sm', { type: 'button', onclick: (e) => { e.stopPropagation(); setArchived(ctx, hb.id, false); } }, 'Restore'),
            onClick: () => openDetail(ctx, hb.id),
          })))));
        }
      }
    });

    const habitRow = (hb, data, today) => {
      const done = data.setFor(hb.id);
      const n = currentStreak(hb, done, today);
      const main = h('button.habit-main', { type: 'button', onclick: () => openDetail(ctx, hb.id) },
        h('span.habit-emoji', hb.emoji || icon('habit', 18)),
        h('span.grow', h('div.habit-title', hb.title), h('div.small.muted', scheduleLabel(hb, ctx))),
        h('span.streak', { class: n ? '' : 'zero' }, icon('flame', 16), String(n)));
      const days = h('div.habit-days');
      for (let i = 6; i >= 0; i--) {
        const key = dates.addDays(today, -i);
        const isDue_ = isDue(hb, key), isDone = done.has(key);
        days.append(h('button.habit-cell', {
          type: 'button',
          class: (isDone ? 'done ' : '') + (key === today ? 'today ' : '') + (isDue_ ? '' : 'off'),
          'aria-label': `${hb.title}: ${dates.label(key)}${isDone ? ' — done' : ''}`,
          onclick: () => toggleLog(ctx.db, hb.id, key),
        }, h('span', dowNarrow(dates.parse(key).getDay())), h('span.d', String(dates.parse(key).getDate()))));
      }
      return h('div.habit-row', main, days);
    };

    container.append(fab(() => openAdd(ctx), 'Add habit'));
    await draw();
    const off1 = ctx.db.onChange(HABITS, draw);
    const off2 = ctx.db.onChange(LOGS, draw);
    if (ctx.params?.add === '1') openAdd(ctx);
    return () => { off1(); off2(); };
  },

  quickActions: [],

  async todayCard(ctx) {
    const today = dates.today();
    const data = await load(ctx.db);
    const active = data.habits.filter((x) => !x.archived);
    if (!active.length) return null;
    const due = active.filter((hb) => isDue(hb, today));
    const doneN = due.filter((hb) => data.setFor(hb.id).has(today)).length;
    const allDone = due.length > 0 && doneN === due.length;
    const c = card(h('div.card-title',
      h('h3.tappable', { onclick: () => ctx.nav('plan/habits') }, 'Habits'),
      h('div.row', h('span.small.muted', due.length ? `${doneN}/${due.length}` : ''),
        ring(due.length ? doneN / due.length : 0, { size: 30, stroke: 4, color: allDone ? 'var(--good)' : 'var(--accent)' }))));
    if (!due.length) { c.append(h('p.muted.small', 'Nothing scheduled today')); return c; }
    c.append(h('div.list', due.map((hb) => {
      const done = data.setFor(hb.id);
      const isDone = done.has(today);
      const n = currentStreak(hb, done, today);
      return listItem({
        title: displayTitle(hb),
        sub: n ? h('span.streak', icon('flame', 12), `${n} day${n === 1 ? '' : 's'}`) : null,
        leading: h('span.checkbox', { class: isDone ? 'checked' : '' }, icon('check')),
        done: isDone,
        onClick: () => toggleLog(ctx.db, hb.id, today),
      });
    })));
    return c;
  },

  async exportForAI(ctx) {
    const today = dates.today();
    const data = await load(ctx.db);
    if (!data.habits.length) return '';
    const active = data.habits.filter((x) => !x.archived);
    const archived = data.habits.filter((x) => x.archived);
    const lines = ['## Habits', `${active.length} active habit${active.length === 1 ? '' : 's'}${archived.length ? `, ${archived.length} archived` : ''}.`, ''];
    for (const hb of active) {
      const done = data.setFor(hb.id);
      const c7 = completion(hb, done, 7, today), c30 = completion(hb, done, 30, today);
      const missed = mostMissedWeekday(hb, done, today);
      const todayState = done.has(today) ? 'done today' : isDue(hb, today) ? 'not yet today' : 'not due today';
      lines.push(`- ${displayTitle(hb)} — ${scheduleLabel(hb, ctx)}; 7d ${pctLabel(c7)} (${c7.done}/${c7.due}), 30d ${pctLabel(c30)} (${c30.done}/${c30.due}); streak ${currentStreak(hb, done, today)}, best ${bestStreak(hb, done, today)}${missed ? `; most missed: ${missed}` : ''}; ${todayState}`);
    }
    const parts = [];
    for (let i = 13; i >= 0; i--) {
      const key = dates.addDays(today, -i);
      const due = active.filter((hb) => isDue(hb, key));
      const d = due.filter((hb) => data.setFor(hb.id).has(key)).length;
      parts.push(`${key.slice(5)} ${d}/${due.length}`);
    }
    lines.push('', 'Daily completion, last 14 days (done/due, oldest first): ' + parts.join(', '));
    if (archived.length) lines.push('', 'Archived: ' + archived.map(displayTitle).join(', '));
    return lines.join('\n');
  },

  // ---------- AI assistant actions ----------
  actions: [
    {
      name: 'add',
      description: 'Create a new habit. schedule: "daily" (default), "weekdays", "weekends", or comma-separated weekday names like "mon,wed,fri". A leading emoji in the title is split off automatically.',
      params: {
        title: { type: 'string', description: 'Habit name, e.g. "Read 20 min"' },
        emoji: { type: 'string', description: 'Optional single emoji shown next to the habit' },
        schedule: { type: 'string', description: 'When it is due: "daily", "weekdays", "weekends", or weekday names e.g. "mon,wed,fri"' },
      },
      required: ['title'],
      write: true,
      preview: (args) => `Add habit "${String(args.title || '').trim()}" (${previewSchedule(args.schedule)})`,
      async run(ctx, args) {
        let title = String(args.title || '').trim();
        let emoji = String(args.emoji || '').trim();
        if (!emoji) { const m = title.match(EMOJI_RE); if (m && m[2]) { emoji = m[1]; title = m[2].trim(); } }
        if (!title) throw new Error('Habit needs a title');
        const schedule = parseScheduleArg(args.schedule);
        const dupe = (await ctx.db.all(HABITS)).filter(Boolean).find((x) => !x.archived && String(x.title || '').trim().toLowerCase() === title.toLowerCase());
        if (dupe) throw new Error(`A habit called "${dupe.title}" already exists (id ${dupe.id})`);
        const rec = await createHabit(ctx, { title, emoji, schedule });
        return `Added habit "${displayTitle(rec)}" (id ${rec.id}), ${scheduleLabel(rec, ctx)}`;
      },
    },
    {
      name: 'list',
      description: 'List habits with id, schedule, today status, current streak and 7-day completion. Call this before changing a habit to get its id.',
      params: {
        include_archived: { type: 'boolean', description: 'Also list archived habits (default false)' },
      },
      write: false,
      async run(ctx, args) {
        const today = dates.today();
        const data = await load(ctx.db);
        const rows = data.habits.filter((x) => args?.include_archived || !x.archived);
        if (!rows.length) return data.habits.length ? 'No active habits (all archived). Pass include_archived=true to see them.' : 'No habits yet.';
        const MAX = 20;
        const lines = rows.slice(0, MAX).map((hb) => {
          const done = data.setFor(hb.id);
          const c7 = completion(hb, done, 7, today);
          const state = done.has(today) ? 'done today' : isDue(hb, today) ? 'NOT yet today' : 'not due today';
          return `- ${displayTitle(hb)} [id ${hb.id}] — ${scheduleLabel(hb, ctx)}; ${state}; streak ${currentStreak(hb, done, today)}; 7d ${pctLabel(c7)} (${c7.done}/${c7.due})${hb.archived ? '; ARCHIVED' : ''}`;
        });
        if (rows.length > MAX) lines.push(`… ${rows.length - MAX} more not shown`);
        return `${rows.length} habit${rows.length === 1 ? '' : 's'} (today ${today}):\n` + lines.join('\n');
      },
    },
    {
      name: 'set_done',
      description: 'Mark a habit done (or undo it) for a date. Default date is today; future dates are not allowed. Idempotent: setting a state that already holds changes nothing.',
      params: {
        habit_id: { type: 'string', description: 'Habit id from habits_list (an exact habit title also works)' },
        date: { type: 'string', description: 'Date YYYY-MM-DD (default today)' },
        done: { type: 'boolean', description: 'true = mark done (default), false = mark not done' },
      },
      required: ['habit_id'],
      write: true,
      preview: async (args, ctx) => `${args.done === false ? 'Un-mark' : 'Mark'} habit ${await previewHabit(ctx, args.habit_id)} ${args.done === false ? 'not done' : 'done'} for ${previewDate(args.date)}`,
      async run(ctx, args) {
        const hb = await findHabit(ctx, args.habit_id);
        const key = parseDateArg(args.date);
        if (key > dates.today()) throw new Error(`Cannot log ${key}: it is in the future`);
        const want = args.done !== false;
        const has = (await ctx.db.where(LOGS, 'habitId', hb.id)).some((l) => l && l.date === key);
        if (has === want) return `"${displayTitle(hb)}" (id ${hb.id}) was already ${want ? 'done' : 'not done'} on ${key}`;
        const res = await toggleLog(ctx.db, hb.id, key);
        if (res === undefined) throw new Error('Another change to this habit is in progress; try again');
        const done = new Set((await ctx.db.where(LOGS, 'habitId', hb.id)).map((l) => l?.date).filter(Boolean));
        const dueNote = isDue(hb, key) ? '' : ' (not a scheduled day)';
        return `${want ? 'Marked' : 'Un-marked'} "${displayTitle(hb)}" (id ${hb.id}) ${want ? 'done' : 'not done'} for ${key}${dueNote}. Streak now ${currentStreak(hb, done, dates.today())}.`;
      },
    },
    {
      name: 'archive',
      description: 'Archive a habit (hides it from the daily list, keeps its history) or restore an archived one.',
      params: {
        habit_id: { type: 'string', description: 'Habit id from habits_list (an exact habit title also works)' },
        archived: { type: 'boolean', description: 'true = archive (default), false = restore' },
      },
      required: ['habit_id'],
      write: true,
      preview: async (args, ctx) => `${args.archived === false ? 'Restore' : 'Archive'} habit ${await previewHabit(ctx, args.habit_id)}${args.archived === false ? ' (back to the daily list)' : ' (hidden from the daily list, history kept)'}`,
      async run(ctx, args) {
        const hb = await findHabit(ctx, args.habit_id);
        const want = args.archived !== false;
        if (hb.archived === want) return `"${displayTitle(hb)}" (id ${hb.id}) is already ${want ? 'archived' : 'active'}`;
        await setArchived(ctx, hb.id, want);
        return `${want ? 'Archived' : 'Restored'} "${displayTitle(hb)}" (id ${hb.id})`;
      },
    },
    {
      name: 'delete',
      description: 'Permanently delete a habit and all its check-ins. Prefer archive unless the user clearly wants it gone.',
      params: {
        habit_id: { type: 'string', description: 'Habit id from habits_list (an exact habit title also works)' },
      },
      required: ['habit_id'],
      write: true,
      preview: async (args, ctx) => `Delete habit ${await previewHabit(ctx, args.habit_id)} and all its check-ins`,
      async run(ctx, args) {
        const hb = await findHabit(ctx, args.habit_id);
        const n = (await ctx.db.where(LOGS, 'habitId', hb.id)).filter(Boolean).length;
        await deleteHabit(ctx, hb.id);
        return `Deleted "${displayTitle(hb)}" (id ${hb.id}) and ${n} check-in${n === 1 ? '' : 's'}`;
      },
    },
  ],
};

// ---------- action helpers (private) ----------
/** Preview helper: '"📖 Read 20 min"' for a known habit (by id or exact title), else 'habit <ref>' text. Never throws. */
async function previewHabit(ctx, ref) {
  const q = String(ref ?? '').trim();
  try {
    const hb = await findHabit(ctx, q);
    return `"${displayTitle(hb)}"`;
  } catch {
    return q || '(none)';
  }
}
/** Preview helper: 'Today' / 'Yesterday' / 'Mon 12 Mar' for a valid YYYY-MM-DD (default today); raw text otherwise. Never throws. */
function previewDate(raw) {
  try {
    const key = parseDateArg(raw);
    return dates.label(key);
  } catch {
    return String(raw);
  }
}
/** Preview helper: 'every day' / 'weekdays' / 'weekends' / 'Mon, Wed, Fri'; echoes the raw text when it cannot be parsed. Never throws. */
function previewSchedule(raw) {
  try {
    const s = parseScheduleArg(raw);
    if (s === 'daily') return 'every day';
    const label = scheduleLabel({ schedule: s });
    return label === 'Weekdays' || label === 'Weekends' ? label.toLowerCase() : label;
  } catch {
    return String(raw ?? '').trim() || 'every day';
  }
}
const DOW_NAMES = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
/** "daily" | "weekdays" | "weekends" | "mon,wed,fri" → 'daily' or sorted [0..6] (same shape scheduleOf() produces). */
function parseScheduleArg(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'daily' || s === 'every day' || s === 'everyday') return 'daily';
  if (s === 'weekdays') return [1, 2, 3, 4, 5];
  if (s === 'weekends') return [0, 6];
  const days = new Set();
  for (const part of s.split(/[\s,;/]+/).filter(Boolean)) {
    const d = DOW_NAMES[part] ?? (/^[0-6]$/.test(part) ? Number(part) : undefined);
    if (d === undefined) throw new Error(`Unknown weekday "${part}" in schedule; use names like mon,tue,wed or "daily"/"weekdays"/"weekends"`);
    days.add(d);
  }
  return scheduleOf({ schedule: [...days] });
}
/** Validates 'YYYY-MM-DD' (defaults to today). */
function parseDateArg(raw) {
  if (raw == null || String(raw).trim() === '') return dates.today();
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || dates.key(dates.parse(s)) !== s) throw new Error(`Invalid date "${s}"; use YYYY-MM-DD`);
  return s;
}
/** Resolves a habit by id, falling back to a unique case-insensitive title match. Throws when not found. */
async function findHabit(ctx, ref) {
  const q = String(ref ?? '').trim();
  if (!q) throw new Error('habit_id is required');
  const byId = await ctx.db.get(HABITS, q);
  if (byId) return normalize(byId);
  const all = (await ctx.db.all(HABITS)).filter(Boolean);
  const hits = all.filter((x) => String(x.id) === q || String(x.title || '').trim().toLowerCase() === q.toLowerCase());
  if (hits.length === 1) return normalize(hits[0]);
  if (hits.length > 1) throw new Error(`Several habits are called "${q}"; use the id from habits_list: ${hits.map((x) => x.id).join(', ')}`);
  throw new Error(`No habit with id or title "${q}". Call habits_list to see ids.`);
}
/** Same record shape and ordering as openAdd(), without the form. */
async function createHabit(ctx, { title, emoji, schedule }) {
  const all = await ctx.db.all(HABITS);
  const order = all.reduce((m, x) => Math.max(m, Number(x?.order) || 0), 0) + 1;
  const rec = await ctx.db.put(HABITS, { title, emoji: emoji || '', schedule, color: '', archived: false, order });
  toast('Habit added');
  return normalize(rec);
}
