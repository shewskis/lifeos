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
};
