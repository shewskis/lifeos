// goals.js — Goals: big outcomes with milestones, an optional measurable metric and linked tasks.
import { h, clear, dates, fmt, icon, toast, sheet, confirm, prompt, formSheet, segmented, empty, fab, stat, listItem } from '../ui.js';
import { uid } from '../db.js';

const STORE = 'goals';
const TASKS = 'tasks'; // owned by the tasks module; read here, and written only when the user adds a task for a goal
const STALE_DAYS = 14;
const DAY = 86400000;

const CATEGORIES = [
  { value: 'health', label: 'Health', chip: 'good' },
  { value: 'money', label: 'Money', chip: 'warn' },
  { value: 'career', label: 'Career', chip: 'accent' },
  { value: 'mind', label: 'Mind', chip: '' },
  { value: 'relationships', label: 'People', chip: 'bad' },
  { value: 'other', label: 'Other', chip: '' },
];
const STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
];
const catOf = (v) => CATEGORIES.find((c) => c.value === v) || CATEGORIES[CATEGORIES.length - 1];

// ---------- record helpers ----------
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const trunc = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const tsKey = (ts) => dates.key(new Date(ts));

/** Fill defaults so old/partial records never break the UI. */
function norm(g) {
  const o = { ...(g || {}) };
  o.title = String(o.title ?? '');
  o.why = String(o.why ?? '');
  o.category = CATEGORIES.some((c) => c.value === o.category) ? o.category : 'other';
  o.targetDate = typeof o.targetDate === 'string' ? o.targetDate : '';
  o.status = STATUSES.some((s) => s.value === o.status) ? o.status : 'active';
  o.milestones = Array.isArray(o.milestones)
    ? o.milestones.filter(Boolean).map((m) => ({ id: m.id || uid(), title: String(m.title ?? ''), done: !!m.done, doneAt: m.doneAt ?? null }))
    : [];
  const m = o.metric;
  o.metric = m && typeof m === 'object' && Number.isFinite(Number(m.target))
    ? { name: String(m.name || 'Progress'), start: num(m.start, 0), target: Number(m.target), current: num(m.current, num(m.start, 0)), unit: String(m.unit ?? '') }
    : null;
  o.completedAt = o.completedAt ?? null;
  o.lastProgressAt = o.lastProgressAt ?? o.updatedAt ?? o.createdAt ?? null;
  return o;
}

/** 0..1 — metric-based when a metric exists, otherwise milestone completion. */
function progress(g) {
  if (g.metric) {
    const span = g.metric.target - g.metric.start;
    if (!span) return g.metric.current === g.metric.target ? 1 : 0;
    return clamp01((g.metric.current - g.metric.start) / span);
  }
  const total = g.milestones.length;
  if (!total) return 0;
  return g.milestones.filter((m) => m.done).length / total;
}
const pctOf = (g) => Math.round(progress(g) * 100);
const milestonesDone = (g) => g.milestones.filter((m) => m.done).length;

function deadline(g) {
  if (!g.targetDate) return { text: 'No deadline', cls: 'muted', days: null };
  const n = dates.daysBetween(dates.today(), g.targetDate);
  if (g.status === 'done') return { text: `Due ${dates.label(g.targetDate)}`, cls: 'muted', days: n };
  if (n < 0) return { text: `Overdue by ${-n} day${n === -1 ? '' : 's'}`, cls: 'bad', days: n };
  if (n === 0) return { text: 'Due today', cls: 'warn', days: 0 };
  return { text: `${n} day${n === 1 ? '' : 's'} left`, cls: n <= 7 ? 'warn' : 'muted', days: n };
}

const metricText = (m, digits = 2) => `${fmt.num(m.current, digits)} / ${fmt.num(m.target, digits)}${m.unit ? ' ' + m.unit : ''}`;

function daysSinceProgress(g) {
  const last = g.lastProgressAt || g.createdAt || 0;
  return last ? Math.floor((Date.now() - last) / DAY) : Infinity;
}
const isStale = (g) => g.status === 'active' && daysSinceProgress(g) >= STALE_DAYS;

function sortGoals(list, status) {
  const arr = [...list];
  if (status === 'done') return arr.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  if (status === 'paused') return arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return arr.sort((a, b) => (a.targetDate || '9999-99-99').localeCompare(b.targetDate || '9999-99-99') || (b.createdAt || 0) - (a.createdAt || 0));
}

// ---------- tasks (read-only view of the tasks store) ----------
const hasTasksStore = (db) => { try { return !!db.db?.objectStoreNames?.contains(TASKS); } catch { return false; } };
async function loadTasks(db) {
  if (!hasTasksStore(db)) return [];
  try { return (await db.all(TASKS)).filter(Boolean); } catch { return []; }
}
const openTasksFor = (tasks, goalId) => tasks.filter((t) => t.goalId === goalId && !t.done);

// ---------- persistence ----------
/** Re-read the goal so a mutation starts from the newest record, not the snapshot the sheet was drawn from. */
async function fresh(ctx, g) {
  if (!g?.id) return g;
  try { const raw = await ctx.db.get(STORE, g.id); return raw ? norm(raw) : g; } catch { return g; }
}
const chains = new Map(); // goalId -> pending write; serialises quick successive taps so they compose instead of overwriting
/**
 * Apply `patch` (object, or fn(freshRecord) → patch | null) to the newest copy of the goal, one write at a time per goal.
 * `progressed` stamps lastProgressAt (anything that moves the goal forward). Resolves with the saved record.
 */
function mutateGoal(ctx, g, patch, progressed = true) {
  const key = g?.id || g;
  const run = async () => {
    const cur = await fresh(ctx, g);
    const p = typeof patch === 'function' ? patch(cur) : patch;
    if (!p) return cur;
    return ctx.db.put(STORE, { ...cur, ...p, ...(progressed ? { lastProgressAt: Date.now() } : {}) });
  };
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}
/** Save a static patch on the freshest copy of the record. */
const saveGoal = (ctx, g, patch, progressed = true) => mutateGoal(ctx, g, patch, progressed);

async function markDone(ctx, g) {
  await saveGoal(ctx, g, { status: 'done', completedAt: Date.now() });
  toast('Goal completed', { ms: 5000, action: 'Undo', onAction: () => saveGoal(ctx, g, { status: 'active', completedAt: null }, false) });
}

// ---------- add / edit form ----------
function goalFields(editing) {
  const f = [
    { name: 'title', label: 'Goal', type: 'text', required: true, autofocus: true, placeholder: 'e.g. Run a 10k' },
    { name: 'why', label: 'Why it matters', type: 'textarea', rows: 2, placeholder: 'The reason you will remember on hard days' },
    { name: 'category', label: 'Category', type: 'segment', options: CATEGORIES.map((c) => ({ value: c.value, label: c.label })), value: 'other' },
    { name: 'targetDate', label: 'Target date', type: 'date', hint: 'Optional — leave empty for no deadline' },
    { name: 'metricName', label: 'Measure (optional)', type: 'text', placeholder: 'e.g. Weight, Savings, Books read', hint: 'Track a number instead of ticking milestones. Needs a name and a target; leave all measure fields blank to skip.' },
    { name: 'metricStart', label: 'Start value', type: 'number', step: 'any', placeholder: '0' },
  ];
  if (editing) f.push({ name: 'metricCurrent', label: 'Current value', type: 'number', step: 'any' });
  f.push(
    { name: 'metricTarget', label: 'Target value', type: 'number', step: 'any', placeholder: 'Required when a measure is set' },
    { name: 'metricUnit', label: 'Unit', type: 'text', placeholder: 'kg, EUR, books, km' },
  );
  return f;
}

function toFormValues(g) {
  return {
    title: g.title, why: g.why, category: g.category, targetDate: g.targetDate,
    metricName: g.metric?.name ?? '', metricStart: g.metric?.start ?? '', metricCurrent: g.metric?.current ?? '',
    metricTarget: g.metric?.target ?? '', metricUnit: g.metric?.unit ?? '',
  };
}

function fromFormValues(v, existing) {
  const name = String(v.metricName || '').trim();
  const unit = String(v.metricUnit || '').trim();
  // Any filled measure field means the user wants a metric; then name + target are both required.
  const hasMetric = !!name || !!unit || v.metricStart != null || v.metricTarget != null || v.metricCurrent != null;
  if (hasMetric && !name) return { error: 'Name the measure (e.g. Weight) or clear all measure fields' };
  if (hasMetric && v.metricTarget == null) return { error: 'Enter a target value for the measure (or clear all measure fields)' };
  const start = v.metricStart ?? 0;
  const metric = hasMetric
    ? { name, start, target: v.metricTarget, current: existing?.metric ? (v.metricCurrent ?? existing.metric.current) : (v.metricCurrent ?? start), unit }
    : null;
  return {
    data: {
      title: String(v.title || '').trim(),
      why: String(v.why || '').trim(),
      category: CATEGORIES.some((c) => c.value === v.category) ? v.category : 'other',
      targetDate: v.targetDate || '',
      metric,
    },
  };
}

/** Opens the add (goal=null) or edit form. Resolves with the saved record, or null. */
async function openGoalForm(ctx, { goal = null, prefill = {} } = {}) {
  const editing = !!goal;
  let values = editing ? toFormValues(goal) : { category: 'other', ...prefill };
  for (;;) {
    const vals = await formSheet({
      title: editing ? 'Edit goal' : 'New goal',
      fields: goalFields(editing),
      values,
      saveLabel: editing ? 'Save' : 'Add goal',
      onDelete: editing ? async () => { await ctx.db.delete(STORE, goal.id); toast('Goal deleted'); } : undefined,
    });
    if (!vals) return null;
    const r = fromFormValues(vals, goal);
    if (r.error) { toast(r.error); values = vals; continue; }
    const now = Date.now();
    let saved;
    if (editing) {
      const metricMoved = JSON.stringify(r.data.metric) !== JSON.stringify(goal.metric);
      saved = await mutateGoal(ctx, goal, (cur) => ({ ...r.data, lastProgressAt: metricMoved ? now : cur.lastProgressAt }), false);
    } else {
      saved = await ctx.db.put(STORE, { ...r.data, status: 'active', milestones: [], completedAt: null, lastProgressAt: now });
    }
    toast(editing ? 'Goal updated' : 'Goal added');
    return saved;
  }
}

const templates = (ctx) => [
  // Every template carries a complete measure (name + start + target) so it saves in one tap.
  { label: `Lose 5 ${ctx.settings.get('units', 'kg')}`, values: { title: `Lose 5 ${ctx.settings.get('units', 'kg')}`, category: 'health', metricName: 'Weight lost', metricStart: 0, metricTarget: 5, metricUnit: ctx.settings.get('units', 'kg') } },
  { label: 'Save 3000', values: { title: 'Save 3000', category: 'money', metricName: 'Saved', metricStart: 0, metricTarget: 3000, metricUnit: ctx.settings.get('currency', 'USD') } },
  { label: 'Read 12 books', values: { title: 'Read 12 books', category: 'mind', metricName: 'Books read', metricStart: 0, metricTarget: 12, metricUnit: 'books' } },
  { label: 'Run a 10k', values: { title: 'Run a 10k', category: 'health', metricName: 'Longest run', metricStart: 0, metricTarget: 10, metricUnit: 'km' } },
];

// ---------- milestones ----------
async function addMilestone(ctx, g, title) {
  title = String(title || '').trim();
  if (!title) return false;
  await mutateGoal(ctx, g, (cur) => ({ milestones: [...cur.milestones, { id: uid(), title, done: false, doneAt: null }] }));
  return true;
}
async function toggleMilestone(ctx, g, id) {
  const saved = norm(await mutateGoal(ctx, g, (cur) => ({ milestones: cur.milestones.map((m) => (m.id === id ? { ...m, done: !m.done, doneAt: !m.done ? Date.now() : null } : m)) })));
  const ms = saved.milestones;
  const all = ms.length && ms.every((m) => m.done);
  if (all && !saved.metric && saved.status === 'active') toast('All milestones done!', { ms: 5000, action: 'Mark goal done', onAction: () => markDone(ctx, saved) });
}
async function editMilestone(ctx, g, m) {
  const vals = await formSheet({
    title: 'Edit milestone',
    fields: [{ name: 'title', label: 'Milestone', type: 'text', required: true, autofocus: true }, { name: 'done', label: 'Done', type: 'toggle' }],
    values: { title: m.title, done: m.done },
    onDelete: async () => { await mutateGoal(ctx, g, (cur) => ({ milestones: cur.milestones.filter((x) => x.id !== m.id) })); toast('Milestone removed'); },
  });
  if (!vals) return;
  await mutateGoal(ctx, g, (cur) => ({ milestones: cur.milestones.map((x) => (x.id === m.id ? { ...x, title: vals.title.trim(), done: !!vals.done, doneAt: vals.done ? (x.doneAt || Date.now()) : null } : x)) }));
}

/** Quick numeric entry: number keyboard on Android, old value pre-selected so typing replaces it. Resolves with a finite number or null. */
function promptNumber(message, { title = '', value = '', placeholder = '0', okLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const input = h('input.input', { type: 'number', step: 'any', inputmode: 'decimal', enterkeyhint: 'done', placeholder });
    input.value = value == null ? '' : String(value);
    const submit = () => {
      const raw = String(input.value).trim();
      const n = Number(raw.replace(',', '.'));
      if (raw === '' || !Number.isFinite(n)) { toast('Enter a number'); input.focus(); return false; }
      finish(n);
      return true;
    };
    const s = sheet({
      title, content: [message ? h('p.muted', message) : null, input],
      onClose: () => finish(null),
      actions: [{ label: 'Cancel', onClick: () => finish(null) }, { label: okLabel, primary: true, onClick: () => submit() }],
    });
    input.addEventListener('focus', () => setTimeout(() => { try { input.select(); } catch {} }, 0));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (submit()) s.close(); } });
    setTimeout(() => input.focus(), 250);
  });
}

async function updateMetric(ctx, g) {
  const m = g.metric;
  const n = await promptNumber(`Current ${m.name.toLowerCase()}${m.unit ? ` (${m.unit})` : ''}`, { title: 'Update progress', value: m.current, okLabel: 'Update' });
  if (n == null) return;
  const next = norm(await mutateGoal(ctx, g, (cur) => (cur.metric ? { metric: { ...cur.metric, current: n } } : null)));
  if (next.metric && progress(next) >= 1 && next.status === 'active') toast('Target reached!', { ms: 5000, action: 'Mark done', onAction: () => markDone(ctx, next) });
  else toast('Progress updated');
}

async function addTaskForGoal(ctx, g) {
  if (!hasTasksStore(ctx.db)) { toast('Tasks module is not available'); return; }
  const title = await prompt('', { title: `Task for “${trunc(g.title, 30)}”`, placeholder: 'What is the next small step?', okLabel: 'Add task' });
  if (title == null || !title.trim()) return;
  try {
    await ctx.db.put(TASKS, { title: title.trim(), date: '', time: '', priority: 'med', done: false, doneAt: null, goalId: g.id, repeat: 'none', notes: '' });
    toast('Task added', { action: 'Open tasks', onAction: () => ctx.nav('plan/tasks') });
  } catch (e) { console.error(e); toast('Could not add task'); }
}

// ---------- detail sheet ----------
function openDetail(ctx, goalId, registry) {
  if (registry.has(goalId)) return; // a fast double-tap must not stack two sheets for the same goal
  const offs = [];
  const state = { focusMilestone: false, current: null };
  // The milestone input is created once per sheet (not in buildDetail) so a half-typed milestone survives redraws.
  state.msInput = h('input.input', { type: 'text', placeholder: 'Add a milestone…', enterkeyhint: 'done' });
  state.submitMs = async () => {
    const title = state.msInput.value.trim();
    if (!title || !state.current) { state.msInput.focus(); return; }
    state.focusMilestone = true;
    state.msInput.value = ''; // clear before the write so a double-tap on Add cannot add it twice
    let ok = false;
    try { ok = await addMilestone(ctx, state.current, title); } catch (e) { console.error(e); }
    if (!ok) { state.msInput.value = title; state.focusMilestone = false; toast('Could not add milestone'); }
  };
  state.msInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); state.submitMs(); } });
  let seq = 0;
  const s = sheet({ title: '', full: true, onClose: () => { offs.forEach((f) => f()); registry.delete(goalId); } });
  registry.set(goalId, s);
  const redraw = async () => {
    const my = ++seq;
    const raw = await ctx.db.get(STORE, goalId);
    if (my !== seq) return;
    if (!raw) { s.close(); return; }
    const g = norm(raw);
    const tasks = await loadTasks(ctx.db);
    if (my !== seq) return;
    state.current = g;
    const titleEl = s.el.querySelector('.sheet-title'); if (titleEl) titleEl.textContent = g.title;
    clear(s.body);
    s.body.append(...buildDetail(ctx, g, tasks, s, state));
  };
  offs.push(ctx.db.onChange(STORE, redraw), ctx.db.onChange(TASKS, redraw));
  redraw();
}

function barStyle(pct) {
  return pct >= 100 ? { width: '100%', background: 'var(--good)' } : { width: pct + '%' };
}

function buildDetail(ctx, g, tasks, s, state) {
  const cat = catOf(g.category);
  const dl = deadline(g);
  const pct = pctOf(g);
  const open = openTasksFor(tasks, g.id);
  const nodes = [];

  // header chips
  nodes.push(h('div.row.wrap', { style: { marginBottom: '10px' } },
    h('span.chip', { class: cat.chip }, cat.label),
    g.status === 'paused' ? h('span.chip.warn', 'Paused') : null,
    g.status === 'done' ? h('span.chip.good', `Completed${g.completedAt ? ' ' + dates.label(tsKey(g.completedAt)) : ''}`) : null,
    isStale(g) ? h('span.chip.bad', `No progress for ${daysSinceProgress(g)} days`) : null,
    h('span.small.grow', { class: dl.cls, style: { textAlign: 'right' } }, dl.text)));
  if (g.why) nodes.push(h('p.muted', { style: { whiteSpace: 'pre-wrap' } }, g.why));

  // progress
  nodes.push(h('div.row.between', { style: { marginBottom: '6px' } },
    h('span', { style: { fontWeight: 700, fontSize: '20px' } }, `${pct}%`),
    h('span.small.muted', g.metric ? metricText(g.metric) : `${milestonesDone(g)}/${g.milestones.length} milestones`)));
  nodes.push(h('div.progress', h('div', { style: barStyle(pct) })));

  // metric
  if (g.metric) {
    const m = g.metric;
    nodes.push(h('div.section-title', m.name));
    nodes.push(h('div.stats.mb',
      stat('Start', fmt.num(m.start, 2), m.unit || null),
      stat('Current', fmt.num(m.current, 2), m.unit || null),
      stat('Target', fmt.num(m.target, 2), m.unit || null)));
    nodes.push(h('button.btn.block.primary', { onclick: () => updateMetric(ctx, g) }, icon('refresh', 20), 'Update current value'));
  }

  // milestones
  nodes.push(h('div.section-title', `Milestones ${milestonesDone(g)}/${g.milestones.length}`));
  if (!g.milestones.length) nodes.push(h('p.small.muted', g.metric ? 'Optional: add steps on the way to the target.' : 'Break it down: add the first concrete step below. Tap a milestone to tick it off.'));
  const list = h('div.list');
  for (const m of g.milestones) {
    list.append(listItem({
      title: m.title,
      sub: m.done && m.doneAt ? `Done ${dates.label(tsKey(m.doneAt))}` : null,
      done: m.done,
      leading: h('span.checkbox', { class: m.done ? 'checked' : '' }, icon('check')),
      right: h('button.icon-btn', { 'aria-label': 'Edit milestone', onclick: (e) => { e.stopPropagation(); editMilestone(ctx, g, m); } }, icon('edit', 20)),
      onClick: () => toggleMilestone(ctx, g, m.id),
    }));
  }
  nodes.push(list);
  // Re-attach the sheet's persistent milestone input (see openDetail) so its text is kept across redraws.
  nodes.push(h('div.row', { style: { marginTop: '8px' } }, h('div.grow', state.msInput), h('button.btn', { onclick: state.submitMs }, icon('plus', 20), 'Add')));
  if (state.focusMilestone) { state.focusMilestone = false; setTimeout(() => state.msInput.focus(), 50); }

  // tasks
  nodes.push(h('div.section-title', `Open tasks · ${open.length}`));
  if (open.length) {
    const tl = h('div.list');
    for (const t of open.slice(0, 5)) {
      tl.append(listItem({
        title: String(t.title || 'Untitled task'),
        sub: t.date ? dates.label(t.date) : null,
        leading: h('span.priority-dot', { class: t.priority === 'high' ? 'p-high' : t.priority === 'low' ? 'p-low' : 'p-med' }),
        right: icon('chevron', 18),
        onClick: () => { s.close(); ctx.nav('plan/tasks'); },
      }));
    }
    if (open.length > 5) tl.append(h('p.small.muted', { style: { padding: '8px 0 0' } }, `+${open.length - 5} more in Tasks`));
    nodes.push(tl);
  } else nodes.push(h('p.small.muted', 'No open tasks linked to this goal yet.'));
  nodes.push(h('button.btn.block', { onclick: () => addTaskForGoal(ctx, g) }, icon('task', 20), 'Add task for this goal'));

  // actions
  nodes.push(h('div.divider'));
  const isDone = g.status === 'done';
  nodes.push(h('div.grid-2',
    h('button.btn', { onclick: () => openGoalForm(ctx, { goal: g }) }, icon('edit', 20), 'Edit'),
    isDone
      ? h('button.btn', { onclick: () => saveGoal(ctx, g, { status: 'active', completedAt: null }) }, icon('refresh', 20), 'Reopen')
      : h('button.btn', { onclick: () => saveGoal(ctx, g, { status: g.status === 'paused' ? 'active' : 'paused' }) }, icon(g.status === 'paused' ? 'arrowUp' : 'moon', 20), g.status === 'paused' ? 'Resume' : 'Pause'),
    isDone
      ? h('span')
      : h('button.btn.primary', { onclick: async () => { await markDone(ctx, g); s.close(); } }, icon('check', 20), 'Mark done'),
    h('button.btn.danger', {
      onclick: async () => {
        if (!(await confirm(`Delete “${trunc(g.title, 40)}” and its milestones? Linked tasks stay in Tasks.`))) return;
        await ctx.db.delete(STORE, g.id);
        s.close();
        toast('Goal deleted');
      },
    }, icon('trash', 20), 'Delete')));
  nodes.push(h('div', { style: { height: '12px' } }));
  return nodes;
}

// ---------- list screen ----------
function goalCard(ctx, g, tasks, registry) {
  const cat = catOf(g.category);
  const dl = deadline(g);
  const pct = pctOf(g);
  const open = openTasksFor(tasks, g.id).length;
  return h('div.card.tappable', { onclick: () => openDetail(ctx, g.id, registry) },
    h('div.row.between', { style: { marginBottom: '8px' } },
      h('div.row', { style: { gap: '6px' } }, h('span.chip', { class: cat.chip }, cat.label), isStale(g) ? h('span.chip.bad', 'Stale') : null),
      h('span.small', { class: dl.cls }, dl.text)),
    h('h3', { style: { marginBottom: g.why ? '2px' : '10px' } }, g.title),
    g.why ? h('p.muted.small', { style: { marginBottom: '10px' } }, trunc(g.why, 140)) : null,
    h('div.progress', h('div', { style: barStyle(pct) })),
    // .wrap: when both strings do not fit on one line the second drops to its own row instead of both wrapping mid-text.
    h('div.row.between.wrap.small.muted', { style: { marginTop: '6px', rowGap: '2px' } },
      h('span', `${pct}%${g.metric ? ' · ' + metricText(g.metric, 1) : ''}`),
      h('span', `${milestonesDone(g)}/${g.milestones.length} milestones · ${open} open task${open === 1 ? '' : 's'}`)));
}

function emptyFor(ctx, filter, total) {
  if (total === 0) {
    return h('div',
      empty('No goals yet', 'A goal is a big outcome you can break into milestones or measure with a number. Tap + or start from a template.', 'goal'),
      h('div.chips', { style: { justifyContent: 'center' } },
        templates(ctx).map((t) => h('button.chip.accent', { style: { padding: '9px 14px', fontSize: '13px' }, onclick: () => openGoalForm(ctx, { prefill: t.values }) }, t.label))));
  }
  if (filter === 'active') return empty('No active goals', 'Resume a paused goal or tap + to add a new one.', 'goal');
  if (filter === 'paused') return empty('Nothing paused', 'Goals you pause will wait here until you resume them.', 'moon');
  return empty('No completed goals yet', 'Mark a goal done and it lands here.', 'check');
}

export default {
  id: 'goals',
  title: 'Goals',
  subtitle: 'Big outcomes & milestones',
  icon: 'goal',
  tab: 'plan',
  stores: { goals: { indexes: ['status'] } },

  async render(container, ctx) {
    let filter = ctx.settings.get('goals:filter', 'active');
    if (!STATUSES.some((s) => s.value === filter)) filter = 'active';
    const openSheets = new Map(); // goalId -> detail sheet
    const head = h('div.mb');
    const listEl = h('div');
    // The category segment has 6 options, too wide for a 343px sheet: wrap it into two rows of three so every
    // option (and the active one) stays visible, instead of a hidden-scrollbar horizontal scroll.
    const style = h('style', '.sheet .form .segmented{flex-wrap:wrap}.sheet .form .segmented .seg{flex:1 1 30%}');
    container.append(style, head, listEl, fab(() => openGoalForm(ctx), 'Add goal'));

    let seq = 0;
    const draw = async () => {
      const my = ++seq;
      const [raw, tasks] = await Promise.all([ctx.db.all(STORE), loadTasks(ctx.db)]);
      if (my !== seq) return;
      const all = raw.map(norm);
      const counts = { active: 0, paused: 0, done: 0 };
      for (const g of all) counts[g.status]++;
      clear(head);
      head.append(segmented(
        STATUSES.map((st) => ({ value: st.value, label: counts[st.value] ? `${st.label} · ${counts[st.value]}` : st.label })),
        filter,
        (v) => { filter = v; ctx.settings.set('goals:filter', v); draw(); }));
      const rows = sortGoals(all.filter((g) => g.status === filter), filter);
      clear(listEl);
      if (!rows.length) { listEl.append(emptyFor(ctx, filter, all.length)); return; }
      if (filter === 'active') {
        const stale = rows.filter(isStale).length;
        if (stale) listEl.append(h('div.notice.mb', `${stale} goal${stale === 1 ? '' : 's'} had no progress for ${STALE_DAYS}+ days. Tap one and move something.`));
      }
      for (const g of rows) listEl.append(goalCard(ctx, g, tasks, openSheets));
    };
    await draw();
    const offs = [ctx.db.onChange(STORE, draw), ctx.db.onChange(TASKS, draw)];
    if (ctx.params?.add === '1') openGoalForm(ctx);
    return () => { offs.forEach((f) => f()); for (const s of [...openSheets.values()]) { try { s.close(); } catch {} } };
  },

  quickActions: [],

  async todayCard(ctx) {
    const active = (await ctx.db.all(STORE)).map(norm).filter((g) => g.status === 'active');
    if (!active.length) return null;
    const top = sortGoals(active, 'active').slice(0, 3);
    return h('div.card.tappable', { onclick: () => ctx.nav('plan/goals') },
      h('div.card-title', h('h3', 'Goals'), h('span.link', `${active.length} active`)),
      h('div.stack', { style: { gap: '10px' } }, top.map((g) => {
        const pct = pctOf(g); const dl = deadline(g);
        return h('div',
          h('div.row.between.small', { style: { marginBottom: '4px' } },
            h('span.grow.ellipsis', { style: { fontWeight: 600 } }, g.title),
            h('span', { class: dl.cls, style: { flex: '0 0 auto' } }, `${pct}% · ${dl.text}`)),
          h('div.progress', h('div', { style: barStyle(pct) })));
      })));
  },

  async exportForAI(ctx, { since, days } = {}) {
    const all = (await ctx.db.all(STORE)).map(norm);
    if (!all.length) return '';
    const tasks = await loadTasks(ctx.db);
    const from = since || dates.addDays(dates.today(), -(days || 30));
    const active = sortGoals(all.filter((g) => g.status === 'active'), 'active');
    const paused = sortGoals(all.filter((g) => g.status === 'paused'), 'paused');
    const done = sortGoals(all.filter((g) => g.status === 'done'), 'done');
    const recentDone = done.filter((g) => g.completedAt && tsKey(g.completedAt) >= from);
    const stale = active.filter(isStale);
    const openLinked = tasks.filter((t) => t.goalId && !t.done && all.some((g) => g.id === t.goalId)).length;

    const line = (g) => {
      const parts = [`**${trunc(g.title, 80)}** [${g.category}]`, `${pctOf(g)}%`];
      const dl = deadline(g);
      parts.push(dl.text + (g.targetDate ? ` (${g.targetDate})` : ''));
      if (g.milestones.length) {
        const next = g.milestones.find((m) => !m.done);
        parts.push(`milestones ${milestonesDone(g)}/${g.milestones.length}${next ? `, next: "${trunc(next.title, 80)}"` : ''}`);
      }
      if (g.metric) parts.push(`${g.metric.name}: ${fmt.num(g.metric.current, 2)}${g.metric.unit ? ' ' + g.metric.unit : ''} (start ${fmt.num(g.metric.start, 2)}, target ${fmt.num(g.metric.target, 2)})`);
      const open = openTasksFor(tasks, g.id).length;
      parts.push(`${open} open task${open === 1 ? '' : 's'}`);
      if (isStale(g)) parts.push(`STALE: no progress for ${daysSinceProgress(g)} days`);
      let out = '- ' + parts.join(' · ');
      if (g.why) out += `\n  why: ${trunc(g.why, 300)}`;
      return out;
    };

    const L = [];
    L.push('## Goals');
    L.push(`Active: ${active.length} · Paused: ${paused.length} · Done: ${done.length} (${recentDone.length} completed since ${from}) · Open linked tasks: ${openLinked}${stale.length ? ` · Stale (no progress ${STALE_DAYS}+ days): ${stale.length}` : ''}`);
    if (active.length) { L.push('', '### Active goals'); active.forEach((g) => L.push(line(g))); }
    if (paused.length) { L.push('', '### Paused'); paused.forEach((g) => L.push(line(g))); }
    if (recentDone.length) {
      L.push('', '### Recently completed');
      recentDone.forEach((g) => L.push(`- **${trunc(g.title, 80)}** [${g.category}] — done ${tsKey(g.completedAt)}${g.targetDate ? ` (target was ${g.targetDate})` : ''}${g.metric ? ` · ${g.metric.name} ${fmt.num(g.metric.current, 2)}${g.metric.unit ? ' ' + g.metric.unit : ''}` : ''}`));
    }
    let text = L.join('\n');
    if (text.length > 7500) text = text.slice(0, 7490) + '\n…';
    return text;
  },
};
