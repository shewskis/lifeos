// tasks.js — To-dos with due dates, priorities, repeats and goal links.
import { h, clear, dates, fmt, icon, toast, formSheet, confirm, listItem, empty, card, fab, ring, closeTopSheet } from '../ui.js';

const STORE = 'tasks';
const PRIORITIES = [{ value: 'high', label: 'High' }, { value: 'med', label: 'Medium' }, { value: 'low', label: 'Low' }];
const PRIO_ORDER = { high: 0, med: 1, low: 2 };
const REPEATS = [{ value: 'none', label: 'Never' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }];
const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- record helpers ----------
/** Fill defaults so old/partial records never break rendering. */
function norm(t) {
  t = t || {};
  return {
    ...t,
    title: String(t.title ?? '').trim() || 'Untitled task',
    notes: typeof t.notes === 'string' ? t.notes : '',
    date: typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : '',
    time: typeof t.time === 'string' ? t.time : '',
    priority: PRIO_ORDER[t.priority] !== undefined ? t.priority : 'med',
    done: !!t.done,
    doneAt: typeof t.doneAt === 'number' ? t.doneAt : null,
    goalId: t.goalId ? String(t.goalId) : '',
    repeat: REPEATS.some((r) => r.value === t.repeat) ? t.repeat : 'none',
  };
}

function blank(over = {}) {
  return { title: '', notes: '', date: dates.today(), time: '', priority: 'med', done: false, doneAt: null, goalId: '', repeat: 'none', ...over };
}

function sortOpen(a, b) {
  const da = a.date || '9999', db = b.date || '9999';
  if (da !== db) return da < db ? -1 : 1;
  const ta = a.time || '99:99', tb = b.time || '99:99';
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (PRIO_ORDER[a.priority] !== PRIO_ORDER[b.priority]) return PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority];
  return (a.createdAt || 0) - (b.createdAt || 0);
}

async function loadTasks(db) {
  const rows = await db.all(STORE);
  return rows.map(norm);
}

/** Goals are owned by another module; read defensively (store may not exist yet). */
async function loadGoals(db) {
  try {
    const rows = await db.all('goals');
    return rows.filter((g) => g && g.id).map((g) => ({ id: String(g.id), title: String(g.title ?? 'Goal'), active: isGoalActive(g) }));
  } catch { return []; }
}
function isGoalActive(g) {
  if (g.done === true || g.archived === true || g.completed === true) return false;
  if (typeof g.status === 'string' && g.status && g.status !== 'active') return false;
  return true;
}
function goalMap(goals) { const m = {}; for (const g of goals) m[g.id] = g; return m; }

// ---------- quick-add parsing ----------
function nextWeekday(dow) {
  const d = new Date();
  let diff = (dow - d.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return dates.addDays(dates.today(), diff);
}

/** "Gym tomorrow !" → { title:'Gym', date: tomorrow, priority:'high' } */
function parseQuick(raw) {
  const today = dates.today();
  let text = String(raw ?? '').trim();
  const out = { title: '', date: today, time: '', priority: 'med' };
  if (!text) return out;
  if (/^!+/.test(text) || /!+$/.test(text)) { out.priority = 'high'; text = text.replace(/^!+\s*/, '').replace(/\s*!+$/, '').trim(); }
  const keep = [];
  for (const tok of text.split(/\s+/)) {
    if (!tok) continue;
    if (/^!{1,2}$/.test(tok)) { out.priority = 'high'; continue; }
    const w = tok.toLowerCase().replace(/[.,;:!]+$/, '');
    if (w === 'today') { out.date = today; continue; }
    if (w === 'tomorrow' || w === 'tmr' || w === 'tmrw' || w === 'tmw') { out.date = dates.addDays(today, 1); continue; }
    if (Object.prototype.hasOwnProperty.call(WEEKDAYS, w)) { out.date = nextWeekday(WEEKDAYS[w]); continue; }
    const tm = w.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/) || w.match(/^(\d{1,2}):(\d{2})$/);
    if (tm) {
      let hh = Number(tm[1]); const mm = tm[2] ? Number(tm[2]) : 0; const ap = tm[3];
      if (ap === 'pm' && hh < 12) hh += 12;
      if (ap === 'am' && hh === 12) hh = 0;
      if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) { out.time = dates.pad(hh) + ':' + dates.pad(mm); continue; }
    }
    keep.push(tok);
  }
  out.title = keep.join(' ').trim() || text.trim();
  return out;
}

// ---------- repeats ----------
function stepDate(key, repeat) {
  if (repeat === 'daily') return dates.addDays(key, 1);
  if (repeat === 'weekly') return dates.addDays(key, 7);
  if (repeat === 'monthly') {
    const d = dates.parse(key);
    const day = d.getDate();
    const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const last = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
    n.setDate(Math.min(day, last));
    return dates.key(n);
  }
  return key;
}
/** Next occurrence: always at least one period after the due date, and strictly after today
 *  (an overdue daily task rolls to tomorrow; a future task ticked early moves to its next period instead of duplicating). */
function nextOccurrence(dateKey, repeat) {
  const today = dates.today();
  let next = stepDate(dateKey || today, repeat);
  let guard = 0;
  while (next <= today && guard++ < 400) next = stepDate(next, repeat);
  return next;
}

// ---------- actions ----------
/** Delete many ids in ONE readwrite transaction and emit a single db:change (serial db.delete would redraw N times). */
async function deleteMany(db, ids) {
  if (!ids.length) return;
  if (typeof db._tx === 'function' && typeof db._emit === 'function') {
    const st = db._tx(STORE, 'readwrite');
    for (const id of ids) st.delete(id);
    await new Promise((res, rej) => {
      st.transaction.oncomplete = res;
      st.transaction.onerror = () => rej(st.transaction.error);
      st.transaction.onabort = () => rej(st.transaction.error);
    });
    db._emit(STORE);
  } else {
    for (const id of ids) await db.delete(STORE, id); // fallback if the wrapper internals ever change
  }
}

function buzz(ms = 12) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* ignore */ } }

async function toggleDone(ctx, t) {
  t = norm(t);
  const done = !t.done;
  buzz(done ? 15 : 8);
  await ctx.db.put(STORE, { ...t, done, doneAt: done ? Date.now() : null });
  if (done && t.repeat !== 'none') {
    const next = nextOccurrence(t.date, t.repeat);
    const { id, createdAt, updatedAt, ...rest } = t;
    const created = await ctx.db.put(STORE, { ...rest, done: false, doneAt: null, date: next });
    toast(`Done · next ${dates.label(next)}`, {
      action: 'Undo',
      onAction: async () => { await ctx.db.delete(STORE, created.id); await ctx.db.put(STORE, { ...t, done: false, doneAt: null }); },
    });
  } else if (done) {
    toast('Done', { action: 'Undo', onAction: () => ctx.db.put(STORE, { ...t, done: false, doneAt: null }) });
  }
}

async function cyclePriority(ctx, t) {
  const order = ['high', 'med', 'low'];
  const next = order[(order.indexOf(norm(t).priority) + 1) % order.length];
  await ctx.db.put(STORE, { ...norm(t), priority: next });
  toast(`Priority: ${PRIORITIES.find((p) => p.value === next).label}`);
}

/** Add/edit sheet. `existing` = record to edit, or null to add. `preset` = defaults for add. */
async function openSheet(ctx, existing, preset = {}) {
  const goals = await loadGoals(ctx.db);
  const cur = existing ? norm(existing) : blank(preset);
  const goalOpts = [{ value: '', label: 'No goal' }];
  for (const g of goals) if (g.active || g.id === cur.goalId) goalOpts.push({ value: g.id, label: g.title });
  const fields = [
    { name: 'title', label: 'Task', type: 'text', placeholder: 'What needs doing?', required: true, autofocus: true },
    { name: 'date', label: 'Due date', type: 'date', hint: 'Leave empty for "Someday"' },
    { name: 'time', label: 'Time', type: 'time' },
    { name: 'priority', label: 'Priority', type: 'segment', options: PRIORITIES },
    { name: 'repeat', label: 'Repeat', type: 'select', options: REPEATS, hint: 'When you tick it off, the next one is created automatically' },
  ];
  if (goalOpts.length > 1) fields.push({ name: 'goalId', label: 'Linked goal', type: 'select', options: goalOpts });
  fields.push({ name: 'notes', label: 'Notes', type: 'textarea', rows: 3, placeholder: 'Details, links, context…' });
  // Existing task: a Complete button above the form, so finishing a task never requires finding the checkbox.
  const extra = existing ? h('button.btn.block.mb', { type: 'button', class: cur.done ? '' : 'complete', onclick: async () => {
    closeTopSheet(); // resolves the sheet with null; the row redraws from the db:change event
    try { await toggleDone(ctx, cur); } catch (e) { console.error(e); toast('Could not update task'); }
  } }, icon(cur.done ? 'refresh' : 'check', 18), cur.done ? 'Mark as not done' : 'Complete task') : null;
  const vals = await formSheet({
    title: existing ? 'Edit task' : 'New task',
    fields,
    values: cur,
    saveLabel: existing ? 'Save' : 'Add task',
    onDelete: existing ? async () => { await ctx.db.delete(STORE, existing.id); toast('Task deleted'); } : undefined,
    extraTop: extra,
  });
  if (!vals) return null;
  const rec = {
    ...cur,
    title: String(vals.title ?? '').trim(),
    notes: String(vals.notes ?? ''),
    date: vals.date || '',
    time: vals.time || '',
    priority: PRIO_ORDER[vals.priority] !== undefined ? vals.priority : 'med',
    repeat: REPEATS.some((r) => r.value === vals.repeat) ? vals.repeat : 'none',
    goalId: vals.goalId !== undefined ? (vals.goalId || '') : cur.goalId,
  };
  if (!rec.title) { toast('Task needs a title'); return null; }
  const saved = await ctx.db.put(STORE, rec);
  if (!existing) toast(rec.date ? `Added for ${dates.label(rec.date)}` : 'Added to Someday');
  return saved;
}

async function quickAdd(ctx, text) {
  const p = parseQuick(text);
  if (!p.title) return false;
  await ctx.db.put(STORE, blank({ title: p.title, date: p.date, time: p.time, priority: p.priority }));
  buzz(8);
  toast(`Added for ${dates.label(p.date)}${p.priority === 'high' ? ' · high priority' : ''}`);
  return true;
}

// ---------- row rendering ----------
function checkbox(ctx, t) {
  // 44px hit area (README rule 1) around the 26px visual circle; negative margin keeps the row layout unchanged.
  return h('button', {
    style: { width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '-9px', flex: '0 0 auto' },
    'aria-label': t.done ? 'Mark not done' : 'Mark done',
    'aria-pressed': String(!!t.done),
    onclick: (e) => { e.stopPropagation(); toggleDone(ctx, t).catch((err) => { console.error(err); toast('Could not update task'); }); },
  }, h('span.checkbox', { class: t.done ? 'checked' : '' }, icon('check')));
}

function subLine(t, goals, { showDate = true } = {}) {
  const today = dates.today();
  const parts = [h('span.priority-dot', { class: 'p-' + t.priority, title: t.priority })];
  if (showDate && t.date) {
    const overdue = !t.done && t.date < today;
    const late = overdue ? dates.daysBetween(t.date, today) : 0;
    parts.push(h('span', { class: overdue ? 'bad' : '' }, dates.label(t.date) + (t.time ? ' · ' + t.time : '') + (overdue ? ` · ${late}d late` : '')));
  } else if (showDate && t.time) parts.push(h('span', t.time));
  else if (showDate && !t.date) parts.push(h('span', 'Someday'));
  if (t.repeat !== 'none') parts.push(h('span', icon('refresh', 12), ' ', REPEATS.find((r) => r.value === t.repeat).label));
  if (t.done && t.doneAt) parts.push(h('span', 'done ' + dates.ago(dates.key(new Date(t.doneAt)))));
  const g = t.goalId ? goals[t.goalId] : null;
  if (g) parts.push(h('span.chip.accent', icon('goal', 12), g.title));
  if (t.notes) parts.push(h('span.muted', icon('note', 12)));
  return h('div.row.wrap', { style: { gap: '6px', rowGap: '2px' } }, parts);
}

/** Explicit "Complete" / "Undo" button on the right of every row (the circle on the left still works too). */
function completeButton(ctx, t) {
  return h('button.btn.sm', {
    type: 'button',
    class: t.done ? 'ghost' : 'complete',
    'aria-label': t.done ? 'Mark not done' : 'Complete task',
    onclick: (e) => { e.stopPropagation(); toggleDone(ctx, t).catch((err) => { console.error(err); toast('Could not update task'); }); },
  }, icon(t.done ? 'refresh' : 'check', 16), t.done ? 'Undo' : 'Complete');
}

function taskRow(ctx, t, goals, opts = {}) {
  let lpAt = 0;
  return listItem({
    leading: checkbox(ctx, t),
    title: t.title,
    sub: subLine(t, goals, opts),
    right: completeButton(ctx, t),
    done: t.done,
    onClick: () => { if (Date.now() - lpAt < 700) return; openSheet(ctx, t).catch(console.error); },
    onLongPress: () => { lpAt = Date.now(); if (!t.done) cyclePriority(ctx, t).catch(console.error); },
  });
}

// ---------- AI assistant action helpers (module-private; see README "Actions") ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const LIST_FILTERS = ['open', 'today', 'overdue', 'upcoming', 'someday', 'done', 'all'];
const LIST_LIMIT = 20;

function reqString(v, name) {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`${name} is required`);
  return s;
}
/** undefined → undefined (leave as is); '' / 'none' / 'someday' → '' (no due date); 'today'/'tomorrow'; else strict YYYY-MM-DD. */
function parseDateArg(v, name = 'date') {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === 'none' || s === 'someday' || s === 'null') return '';
  if (s === 'today') return dates.today();
  if (s === 'tomorrow') return dates.addDays(dates.today(), 1);
  if (!DATE_RE.test(s) || Number.isNaN(dates.parse(s).getTime()) || dates.key(dates.parse(s)) !== s) throw new Error(`${name} must be a valid YYYY-MM-DD date (got "${v}")`);
  return s;
}
function parseTimeArg(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (s === '' || s.toLowerCase() === 'none') return '';
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`time must be HH:MM (got "${v}")`);
  const t = dates.pad(Number(m[1])) + ':' + m[2];
  if (!TIME_RE.test(t)) throw new Error(`time must be HH:MM in 24h (got "${v}")`);
  return t;
}
function parsePriorityArg(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  const alias = { medium: 'med', normal: 'med', mid: 'med', h: 'high', m: 'med', l: 'low' };
  const p = alias[s] || s;
  if (PRIO_ORDER[p] === undefined) throw new Error(`priority must be one of high, med, low (got "${v}")`);
  return p;
}
function parseRepeatArg(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  const r = s === 'never' ? 'none' : s;
  if (!REPEATS.some((x) => x.value === r)) throw new Error(`repeat must be one of none, daily, weekly, monthly (got "${v}")`);
  return r;
}
/** Resolve goal_id (id or exact title) against the goals store. '' / 'none' clears the link. */
async function parseGoalArg(ctx, v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (s === '' || s.toLowerCase() === 'none') return '';
  const goals = await loadGoals(ctx.db);
  const g = goals.find((x) => x.id === s) || goals.find((x) => x.title.toLowerCase() === s.toLowerCase());
  if (!g) throw new Error(`No goal with id or title "${s}"`);
  return g.id;
}
/** Load one task by id (exact key, then a string-compare scan). Throws when missing. */
async function findTask(ctx, id) {
  const key = reqString(id, 'id');
  let rec = null;
  try { rec = await ctx.db.get(STORE, key); } catch { rec = null; }
  if (!rec) {
    const all = await ctx.db.all(STORE);
    rec = all.find((t) => String(t.id) === key) || null;
  }
  if (!rec) throw new Error(`No task with id "${key}". Use tasks_list to find the right id.`);
  return norm(rec);
}
/** One compact line for the model: id, title, date/time, priority, repeat, goal, status. */
function taskLine(t, goals, today = dates.today()) {
  const bits = [`[${t.id}] ${t.title.slice(0, 80)}`];
  if (t.date) {
    let d = t.date + (t.time ? ' ' + t.time : '');
    if (!t.done && t.date < today) d += ` (${dates.daysBetween(t.date, today)}d overdue)`;
    bits.push(d);
  } else bits.push('someday');
  bits.push(t.priority);
  if (t.repeat !== 'none') bits.push(t.repeat);
  if (t.goalId) bits.push('goal: ' + (goals[t.goalId]?.title || t.goalId));
  if (t.done) bits.push('DONE' + (t.doneAt ? ' ' + dates.key(new Date(t.doneAt)) : ''));
  if (t.notes) bits.push('notes: ' + t.notes.replace(/\s+/g, ' ').slice(0, 60));
  return '- ' + bits.join(' · ');
}
function describeTask(t, goals) {
  return `"${t.title}" (id ${t.id})${t.date ? ' due ' + t.date + (t.time ? ' ' + t.time : '') : ' (someday, no due date)'}, ${t.priority} priority${t.repeat !== 'none' ? ', repeats ' + t.repeat : ''}${t.goalId && goals?.[t.goalId] ? ', goal "' + goals[t.goalId].title + '"' : ''}`;
}
function clampText(s, max = 1500) { return s.length > max ? s.slice(0, max - 1) + '…' : s; }

// --- preview helpers: name records the way the UI does; never throw (a failed lookup falls back to the raw id) ---
/** findTask for previews: null instead of an error when the id is missing/unknown or ctx is unavailable. */
async function peekTask(ctx, id) {
  try { return await findTask(ctx, id); } catch { return null; }
}
/** 'YYYY-MM-DD' → how the UI shows it ("today", "tomorrow", "Sat 1 Nov"); anything else is returned as given. */
function dateWord(key) {
  try {
    const s = String(key ?? '').trim();
    if (!DATE_RE.test(s)) return s;
    const l = dates.label(s);
    return /^(Today|Tomorrow|Yesterday)$/.test(l) ? l.toLowerCase() : l;
  } catch { return String(key ?? ''); }
}
/** A date argument in words: ''/none/someday → 'someday', today/tomorrow as given, a key → UI label. */
function dateArgWord(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '' || s === 'none' || s === 'someday' || s === 'null') return 'someday';
  if (s === 'today' || s === 'tomorrow') return s;
  return dateWord(String(v).trim());
}
/** '"Call the dentist" (due Sat 1 Nov 14:00)' / '"Tidy garage" (someday)' — the task as the confirmation card names it. */
function taskName(t) {
  return `"${t.title}"${t.date ? ` (due ${dateWord(t.date)}${t.time ? ' ' + t.time : ''})` : ' (someday)'}`;
}
/** Goal arg → its title when it resolves, otherwise the given text. */
async function goalWord(ctx, v) {
  const s = String(v ?? '').trim();
  try {
    const goals = await loadGoals(ctx.db);
    const g = goals.find((x) => x.id === s) || goals.find((x) => x.title.toLowerCase() === s.toLowerCase());
    return g ? g.title : s;
  } catch { return s; }
}

// ---------- the module ----------
export default {
  id: 'tasks',
  title: 'Tasks',
  subtitle: 'To-dos with due dates',
  icon: 'task',
  tab: 'plan',
  stores: { tasks: { indexes: ['date'] } },

  async render(container, ctx) {
    let showCompleted = false;

    // quick-add bar (kept out of draw() so typing is never interrupted by re-renders)
    const input = h('input', { type: 'text', placeholder: 'Add a task… try "Gym tomorrow !"', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'sentences' });
    const submit = async () => {
      const text = input.value;
      if (!text.trim()) { input.focus(); return; }
      try { if (await quickAdd(ctx, text)) { input.value = ''; input.focus(); } }
      catch (e) { console.error(e); toast('Could not add task'); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const bar = h('div.search-bar', icon('task', 20), input, h('button.icon-btn.accent', { 'aria-label': 'Add task', onclick: submit }, icon('plus', 26)));
    const listHolder = h('div');
    container.append(bar, listHolder, fab(() => openSheet(ctx, null).catch(console.error), 'New task'));

    const section = (label, tasks, goals, { color = '', showDate = true } = {}) => {
      if (!tasks.length) return [];
      return [
        // inline colour: .section-title is declared after .bad in app.css with equal specificity, so a class would lose
        h('div.section-title', { style: color ? { color } : null }, `${label} · ${tasks.length}`),
        card(h('div.list', tasks.map((t) => taskRow(ctx, t, goals, { showDate })))),
      ];
    };

    const draw = async () => {
      const [all, goalList] = await Promise.all([loadTasks(ctx.db), loadGoals(ctx.db)]);
      const goals = goalMap(goalList);
      const frag = document.createDocumentFragment();
      const today = dates.today(); // recomputed per draw so sections stay correct if the app is left open past midnight
      const tmr = dates.addDays(today, 1);
      const open = all.filter((t) => !t.done).sort(sortOpen);
      const done = all.filter((t) => t.done).sort((a, b) => (b.doneAt || b.updatedAt || 0) - (a.doneAt || a.updatedAt || 0));

      if (!all.length) {
        frag.append(empty('No tasks yet', 'Type one above and press Enter. Shortcuts: "!" = high priority, "tomorrow" or a weekday name sets the date, "7pm" sets a time.', 'task'));
      } else if (!open.length) {
        frag.append(empty('All clear', 'Nothing left to do. Add your next task above.', 'check'));
      }

      frag.append(
        ...section('Overdue', open.filter((t) => t.date && t.date < today), goals, { color: 'var(--bad)' }),
        ...section('Today', open.filter((t) => t.date === today), goals),
        ...section('Tomorrow', open.filter((t) => t.date === tmr), goals),
        ...section('Upcoming', open.filter((t) => t.date && t.date > tmr), goals),
        ...section('Someday', open.filter((t) => !t.date), goals),
      );

      if (done.length) {
        const chev = icon('chevron', 16);
        chev.style.display = 'inline-flex'; chev.style.transition = 'transform .15s'; chev.style.transform = showCompleted ? 'rotate(90deg)' : 'none';
        frag.append(h('button.section-title.tappable', {
          type: 'button',
          'aria-expanded': String(showCompleted),
          style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', minHeight: '44px', width: '100%', textAlign: 'left', margin: '10px 0 0' },
          onclick: () => { showCompleted = !showCompleted; draw().catch(console.error); },
        }, `Completed · ${done.length}`, chev));
        if (showCompleted) {
          const recent = done.slice(0, 20);
          frag.append(card(
            h('div.list', recent.map((t) => taskRow(ctx, t, goals))),
            done.length > 20 ? h('p.small.muted.mt', `Showing the last 20 of ${done.length}`) : null,
            h('button.btn.sm.ghost.danger.mt', {
              onclick: async () => {
                if (!(await confirm(`Delete all ${done.length} completed tasks?`, { okLabel: 'Delete all' }))) return;
                await deleteMany(ctx.db, done.map((t) => t.id));
                toast('Completed tasks deleted');
              },
            }, icon('trash', 16), 'Clear completed'),
          ));
        }
      }
      clear(listHolder);
      listHolder.append(frag);
    };

    await draw();
    const offTasks = ctx.db.onChange(STORE, () => draw().catch(console.error));
    const offGoals = ctx.db.onChange('goals', () => draw().catch(console.error));

    if (ctx.params?.add === '1') {
      const preset = {};
      if (ctx.params.date && /^\d{4}-\d{2}-\d{2}$/.test(ctx.params.date)) preset.date = ctx.params.date;
      if (ctx.params.goal) preset.goalId = String(ctx.params.goal);
      setTimeout(() => openSheet(ctx, null, preset).catch(console.error), 50);
    }

    return () => { offTasks(); offGoals(); };
  },

  quickActions: [
    { label: 'Task', icon: 'task', run: async (ctx) => { await openSheet(ctx, null); } },
  ],

  async todayCard(ctx) {
    const today = dates.today();
    const [all, goalList] = await Promise.all([loadTasks(ctx.db), loadGoals(ctx.db)]);
    const goals = goalMap(goalList);
    const due = all.filter((t) => t.date && t.date <= today);
    const open = due.filter((t) => !t.done).sort(sortOpen);
    const doneToday = all.filter((t) => t.done && t.doneAt && dates.key(new Date(t.doneAt)) === today);
    const total = open.length + doneToday.length;
    const frac = total ? doneToday.length / total : 0;
    const head = h('div.card-title', h('h3', 'Tasks'), h('button.link', { style: { padding: '10px 0 10px 12px', minHeight: '44px' }, onclick: () => ctx.nav('plan/tasks') }, 'See all'));
    if (!total) {
      return card(head, h('div.row',
        ring(0, { size: 48, label: '0' }),
        h('div.grow', h('div', 'No tasks due today'),
          h('button.btn.ghost.sm', { style: { paddingLeft: 0 }, onclick: () => openSheet(ctx, null).catch(console.error) }, icon('plus', 16), 'Add a task'))));
    }
    const overdueN = open.filter((t) => t.date < today).length;
    const summary = open.length
      ? `${open.length} to do${overdueN ? ` · ${overdueN} overdue` : ''}`
      : 'All done for today';
    const body = [head, h('div.row.mb',
      ring(frac, { size: 52, color: frac >= 1 ? 'var(--good)' : 'var(--accent)', label: `${doneToday.length}/${total}` }),
      h('div.grow', h('div', { class: open.length ? '' : 'good' }, summary), h('div.small.muted', `${fmt.num(frac * 100, 0)}% complete`)))];
    if (open.length) {
      body.push(h('div.list', open.slice(0, 5).map((t) => taskRow(ctx, t, goals, { showDate: t.date !== today }))));
      if (open.length > 5) body.push(h('button.btn.ghost.sm.block.mt', { onclick: () => ctx.nav('plan/tasks') }, `+${open.length - 5} more`));
    }
    return card(...body);
  },

  async exportForAI(ctx, { since, days = 30 } = {}) {
    const all = await loadTasks(ctx.db);
    if (!all.length) return '';
    const today = dates.today();
    const goals = goalMap(await loadGoals(ctx.db));
    const open = all.filter((t) => !t.done).sort(sortOpen);
    const done = all.filter((t) => t.done);
    const lines = ['## Tasks'];
    const byP = { high: 0, med: 0, low: 0 };
    for (const t of open) byP[t.priority]++;
    lines.push(`Open: ${open.length} (high ${byP.high}, med ${byP.med}, low ${byP.low}) · completed all-time: ${done.length} · total: ${all.length}`);

    const fmtTask = (t) => `- ${t.title.slice(0, 120)}${t.date ? ` (${t.date}${t.time ? ' ' + t.time : ''})` : ''} [${t.priority}]${t.repeat !== 'none' ? ` [${t.repeat}]` : ''}${t.goalId && goals[t.goalId] ? ` → ${goals[t.goalId].title}` : ''}${t.notes ? ' — ' + t.notes.replace(/\s+/g, ' ').slice(0, 120) : ''}`;

    const overdue = open.filter((t) => t.date && t.date < today);
    lines.push(`\nOverdue: ${overdue.length}`);
    for (const t of overdue.slice(0, 15)) lines.push(fmtTask(t) + ` ${dates.daysBetween(t.date, today)}d late`);
    const dueToday = open.filter((t) => t.date === today);
    lines.push(`\nDue today: ${dueToday.length}`);
    for (const t of dueToday.slice(0, 15)) lines.push(fmtTask(t));
    const weekEnd = dates.addDays(today, 7);
    const thisWeek = open.filter((t) => t.date && t.date > today && t.date <= weekEnd);
    lines.push(`\nDue in the next 7 days: ${thisWeek.length}`);
    for (const t of thisWeek.slice(0, 15)) lines.push(fmtTask(t));
    const someday = open.filter((t) => !t.date);
    if (someday.length) { lines.push(`\nSomeday (no date): ${someday.length}`); for (const t of someday.slice(0, 8)) lines.push(fmtTask(t)); }

    const rate = (n) => {
      const from = dates.addDays(today, -(n - 1));
      const dueIn = all.filter((t) => t.date && t.date >= from && t.date <= today);
      const doneIn = dueIn.filter((t) => t.done).length;
      const completedIn = done.filter((t) => t.doneAt && dates.key(new Date(t.doneAt)) >= from).length;
      return `${n}d: ${completedIn} completed; of ${dueIn.length} due, ${doneIn} done (${dueIn.length ? fmt.num((doneIn / dueIn.length) * 100, 0) : 0}%)`;
    };
    lines.push('\nCompletion rate — ' + rate(7) + ' · ' + rate(30));

    const dow = [0, 0, 0, 0, 0, 0, 0];
    const from30 = dates.addDays(today, -29);
    for (const t of done) if (t.doneAt && dates.key(new Date(t.doneAt)) >= from30) dow[new Date(t.doneAt).getDay()]++;
    const best = dow.reduce((bi, v, i) => (v > dow[bi] ? i : bi), 0);
    lines.push(`Completions by weekday (30d): ${DOW_NAMES.map((d, i) => `${d} ${dow[i]}`).join(', ')}${dow[best] ? ` · most productive: ${DOW_NAMES[best]}` : ''}`);

    const recent = done.filter((t) => t.doneAt).sort((a, b) => b.doneAt - a.doneAt).slice(0, 10);
    if (recent.length) {
      lines.push('\nRecently completed:');
      for (const t of recent) {
        const dk = dates.key(new Date(t.doneAt));
        lines.push(`- ${t.title.slice(0, 100)} (done ${dk}${t.date && t.date !== dk ? `, was due ${t.date}` : ''})`);
      }
    }

    const perGoal = {};
    for (const t of all) if (t.goalId) { const k = t.goalId; perGoal[k] = perGoal[k] || { open: 0, done: 0 }; perGoal[k][t.done ? 'done' : 'open']++; }
    const gk = Object.keys(perGoal);
    if (gk.length) {
      lines.push('\nTasks per goal:');
      for (const k of gk) lines.push(`- ${goals[k]?.title || 'Unknown goal'}: ${perGoal[k].open} open, ${perGoal[k].done} done`);
    }

    if (since) {
      const sinceCreated = all.filter((t) => t.createdAt && dates.key(new Date(t.createdAt)) >= since).length;
      const sinceDone = done.filter((t) => t.doneAt && dates.key(new Date(t.doneAt)) >= since).length;
      lines.push(`\nSince ${since}: ${sinceCreated} created, ${sinceDone} completed`);
    }

    let out = lines.join('\n');
    if (out.length > 7500) out = out.slice(0, 7500) + '\n…';
    return out;
  },

  // ---------- AI assistant actions (see README "Actions") ----------
  actions: [
    {
      name: 'add',
      description: 'Add a task. date defaults to today; pass "none" for no due date (Someday). Dates YYYY-MM-DD, time HH:MM (24h). Optional repeat (daily/weekly/monthly) and goal_id (a goal id or its exact title).',
      params: {
        title: { type: 'string', description: 'Short task title' },
        date: { type: 'string', description: 'Due date YYYY-MM-DD (default today); "none" for no due date' },
        time: { type: 'string', description: 'Time HH:MM 24h, optional' },
        priority: { type: 'string', enum: ['high', 'med', 'low'], description: 'Priority (default med)' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'], description: 'Repeat; the next occurrence is created when the task is completed (default none)' },
        notes: { type: 'string', description: 'Details / context, optional' },
        goal_id: { type: 'string', description: 'Link to a goal by id (or exact title), optional' },
      },
      required: ['title'],
      write: true,
      preview: (a) => {
        const d = a.date === undefined || a.date === null ? 'today' : dateArgWord(a.date); // run() defaults an omitted date to today
        const when = d === 'someday' ? ' (someday)' : ` due ${d}`;
        return `Add task "${a.title}"${when}${a.time ? ' at ' + a.time : ''}${a.priority && a.priority !== 'med' ? ` · ${a.priority} priority` : ''}${a.repeat && a.repeat !== 'none' ? ` · repeats ${a.repeat}` : ''}`;
      },
      async run(ctx, args = {}) {
        const title = reqString(args.title, 'title').slice(0, 200);
        const date = parseDateArg(args.date);
        const time = parseTimeArg(args.time);
        const priority = parsePriorityArg(args.priority);
        const repeat = parseRepeatArg(args.repeat);
        const goalId = await parseGoalArg(ctx, args.goal_id);
        const over = { title, notes: typeof args.notes === 'string' ? args.notes.slice(0, 2000) : '' };
        if (date !== undefined) over.date = date;
        if (time !== undefined) over.time = time;
        if (priority !== undefined) over.priority = priority;
        if (repeat !== undefined) over.repeat = repeat;
        if (goalId !== undefined) over.goalId = goalId;
        const saved = norm(await ctx.db.put(STORE, blank(over)));
        const goals = goalMap(await loadGoals(ctx.db));
        return `Added task ${describeTask(saved, goals)}.`;
      },
    },
    {
      name: 'list',
      description: 'List tasks with their ids. filter: open (default: everything not done), today, overdue, upcoming (due after today), someday (no date), done, all. Optionally narrow with from/to dates (YYYY-MM-DD, inclusive) and/or a search word in title/notes.',
      params: {
        filter: { type: 'string', enum: ['open', 'today', 'overdue', 'upcoming', 'someday', 'done', 'all'], description: 'Which tasks (default open)' },
        from: { type: 'string', description: 'Only tasks due on/after this YYYY-MM-DD, optional' },
        to: { type: 'string', description: 'Only tasks due on/before this YYYY-MM-DD, optional' },
        search: { type: 'string', description: 'Case-insensitive text to match in title or notes, optional' },
        limit: { type: 'number', description: 'Max rows to return (default 20, max 50)' },
      },
      write: false,
      async run(ctx, args = {}) {
        const today = dates.today();
        const filter = String(args.filter ?? 'open').trim().toLowerCase() || 'open';
        if (!LIST_FILTERS.includes(filter)) throw new Error(`Unknown filter "${args.filter}"; use one of ${LIST_FILTERS.join(', ')}`);
        const from = parseDateArg(args.from, 'from');
        const to = parseDateArg(args.to, 'to');
        if (from && to && from > to) throw new Error('from must be on or before to');
        const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit)) || LIST_LIMIT));
        const q = String(args.search ?? '').trim().toLowerCase();
        const [all, goalList] = await Promise.all([loadTasks(ctx.db), loadGoals(ctx.db)]);
        const goals = goalMap(goalList);
        let rows = all;
        if (filter === 'open') rows = rows.filter((t) => !t.done);
        else if (filter === 'today') rows = rows.filter((t) => !t.done && t.date === today);
        else if (filter === 'overdue') rows = rows.filter((t) => !t.done && t.date && t.date < today);
        else if (filter === 'upcoming') rows = rows.filter((t) => !t.done && t.date && t.date > today);
        else if (filter === 'someday') rows = rows.filter((t) => !t.done && !t.date);
        else if (filter === 'done') rows = rows.filter((t) => t.done);
        if (from) rows = rows.filter((t) => t.date && t.date >= from);
        if (to) rows = rows.filter((t) => t.date && t.date <= to);
        if (q) rows = rows.filter((t) => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
        rows = filter === 'done'
          ? rows.sort((a, b) => (b.doneAt || b.updatedAt || 0) - (a.doneAt || a.updatedAt || 0))
          : rows.sort((a, b) => (a.done === b.done ? sortOpen(a, b) : a.done ? 1 : -1));
        const scope = `filter ${filter}${from || to ? `, due ${from || '…'}..${to || '…'}` : ''}${q ? `, search "${q}"` : ''}`;
        const total = rows.length;
        if (!total) return `No tasks match (${scope}). Today is ${today}.`;
        const shown = rows.slice(0, limit);
        const lines = [`${total} task${total === 1 ? '' : 's'} (${scope}; today ${today}):`, ...shown.map((t) => taskLine(t, goals, today))];
        if (total > shown.length) lines.push(`… ${total - shown.length} more not shown (raise limit or narrow the filter).`);
        return clampText(lines.join('\n'));
      },
    },
    {
      name: 'complete',
      description: 'Mark a task done by id (a repeating task automatically gets its next occurrence created). Set undo=true to mark a done task as not done again.',
      params: {
        id: { type: 'string', description: 'Task id from tasks_list' },
        undo: { type: 'boolean', description: 'true = mark as NOT done instead (default false)' },
      },
      required: ['id'],
      write: true,
      preview: async (a, ctx) => {
        const undo = a.undo === true || String(a.undo).toLowerCase() === 'true';
        const t = await peekTask(ctx, a.id);
        if (!t) return undo ? `Mark task ${a.id} as not done` : `Complete task ${a.id}`;
        if (undo) return `Mark task ${taskName(t)} as not done${t.done ? '' : ' (it is already open)'}`;
        return `Complete task ${taskName(t)}${t.done ? ' (it is already done)' : t.repeat !== 'none' ? ` · the next ${t.repeat} one is created` : ''}`;
      },
      async run(ctx, args = {}) {
        const t = await findTask(ctx, args.id);
        const wantDone = !(args.undo === true || String(args.undo).toLowerCase() === 'true');
        if (t.done === wantDone) return `Task "${t.title}" (id ${t.id}) is already ${wantDone ? 'done' : 'open'}; nothing changed.`;
        const before = new Set((await ctx.db.all(STORE)).map((r) => String(r.id)));
        await toggleDone(ctx, t);
        if (wantDone && t.repeat !== 'none') {
          const created = (await loadTasks(ctx.db)).filter((r) => !before.has(String(r.id)));
          const nxt = created[0];
          return `Completed "${t.title}" (id ${t.id}).${nxt ? ` Next ${t.repeat} occurrence created: id ${nxt.id} due ${nxt.date}.` : ''}`;
        }
        return wantDone
          ? `Completed "${t.title}" (id ${t.id}) on ${dates.today()}.`
          : `Reopened "${t.title}" (id ${t.id})${t.date ? ', due ' + t.date : ''}.`;
      },
    },
    {
      name: 'update',
      description: 'Edit a task by id. Only the fields you pass change. date "none" removes the due date (Someday); time "none" clears the time; goal_id "none" unlinks the goal.',
      params: {
        id: { type: 'string', description: 'Task id from tasks_list' },
        title: { type: 'string', description: 'New title' },
        date: { type: 'string', description: 'New due date YYYY-MM-DD, or "none" for no due date' },
        time: { type: 'string', description: 'New time HH:MM 24h, or "none" to clear' },
        priority: { type: 'string', enum: ['high', 'med', 'low'], description: 'New priority' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'], description: 'New repeat' },
        notes: { type: 'string', description: 'New notes (replaces the existing notes)' },
        goal_id: { type: 'string', description: 'Goal id (or exact title) to link, or "none" to unlink' },
      },
      required: ['id'],
      write: true,
      preview: async (a, ctx) => {
        const t = await peekTask(ctx, a.id);
        const ch = [];
        if (a.title !== undefined) ch.push(`title → "${a.title}"`);
        if (a.date !== undefined) ch.push(`due → ${dateArgWord(a.date)}`);
        if (a.time !== undefined) { const tm = String(a.time ?? '').trim(); ch.push(tm === '' || tm.toLowerCase() === 'none' ? 'time → none' : `time → ${tm}`); }
        if (a.priority !== undefined && a.priority !== null && String(a.priority).trim() !== '') ch.push(`priority → ${String(a.priority).trim()}`); // run() ignores ''
        if (a.repeat !== undefined) { const r = String(a.repeat ?? '').trim().toLowerCase(); if (r) ch.push(r === 'none' || r === 'never' ? 'repeat → never' : `repeat → ${r}`); } // run() ignores ''
        if (a.notes !== undefined) ch.push('notes');
        if (a.goal_id !== undefined) {
          const g = String(a.goal_id ?? '').trim();
          ch.push(g === '' || g.toLowerCase() === 'none' ? 'goal → none' : `goal → "${await goalWord(ctx, g)}"`);
        }
        return `Update task ${t ? taskName(t) : a.id}${ch.length ? ': ' + ch.join(', ') : ' (no changes)'}`;
      },
      async run(ctx, args = {}) {
        const t = await findTask(ctx, args.id);
        const changes = {};
        if (args.title !== undefined) changes.title = reqString(args.title, 'title').slice(0, 200);
        const date = parseDateArg(args.date); if (date !== undefined) changes.date = date;
        const time = parseTimeArg(args.time); if (time !== undefined) changes.time = time;
        const priority = parsePriorityArg(args.priority); if (priority !== undefined) changes.priority = priority;
        const repeat = parseRepeatArg(args.repeat); if (repeat !== undefined) changes.repeat = repeat;
        if (args.notes !== undefined) changes.notes = String(args.notes ?? '').slice(0, 2000);
        const goalId = await parseGoalArg(ctx, args.goal_id); if (goalId !== undefined) changes.goalId = goalId;
        if (!Object.keys(changes).length) throw new Error('Nothing to update: pass at least one of title, date, time, priority, repeat, notes, goal_id');
        const saved = norm(await ctx.db.put(STORE, { ...t, ...changes }));
        const goals = goalMap(await loadGoals(ctx.db));
        return `Updated ${Object.keys(changes).join(', ')}: ${describeTask(saved, goals)}${saved.done ? ' (done)' : ''}.`;
      },
    },
    {
      name: 'delete',
      description: 'Permanently delete a task by id. Prefer tasks_complete unless the user clearly wants the task removed.',
      params: {
        id: { type: 'string', description: 'Task id from tasks_list' },
      },
      required: ['id'],
      write: true,
      preview: async (a, ctx) => { const t = await peekTask(ctx, a.id); return `Delete task ${t ? taskName(t) : a.id}`; },
      async run(ctx, args = {}) {
        const t = await findTask(ctx, args.id);
        await ctx.db.delete(STORE, t.id);
        return `Deleted task "${t.title}" (id ${t.id})${t.date ? ', was due ' + t.date : ''}.`;
      },
    },
  ],
};
