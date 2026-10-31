// finances.js — Money: spending, income & budgets.
import { h, clear, dates, fmt, icon, toast, sheet, confirm, prompt, form, empty, card, listItem, fab, stat, barList, columns } from '../ui.js';

const EXPENSE_CATS = ['Food', 'Groceries', 'Transport', 'Housing', 'Bills', 'Health', 'Fitness', 'Fun', 'Shopping', 'Subscriptions', 'Education', 'Travel', 'Other'];
const INCOME_CATS = ['Salary', 'Freelance', 'Gift', 'Investment', 'Other'];
const OTHER = '__other';

// ---------- small helpers (null-safe for old records) ----------
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const amt = (t) => Math.abs(num(t?.amount));
const isIncome = (t) => t?.type === 'income';
const catOf = (t) => (t?.category && String(t.category).trim()) || 'Other';
const noteOf = (t) => (t?.note == null ? '' : String(t.note));
const dateOf = (t) => (typeof t?.date === 'string' && t.date.length >= 10 ? t.date.slice(0, 10) : '');
const money = (n) => fmt.money(num(n));
const sum = (arr, f = amt) => arr.reduce((s, t) => s + f(t), 0);
const round2 = (n) => Math.round(num(n) * 100) / 100;
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

const ym = (key) => key.slice(0, 7);
const thisMonth = () => ym(dates.today());
function monthRange(m) { const start = m + '-01'; return [start, dates.monthEnd(start)]; }
function shiftMonth(m, n) { const [y, mo] = m.split('-').map(Number); return ym(dates.key(new Date(y, mo - 1 + n, 1))); }
const monthLabel = (m) => dates.monthLabel(m + '-01');
const monthShort = (m) => dates.parse(m + '-01').toLocaleDateString(undefined, { month: 'short' });
const inMonth = (t, m) => ym(dateOf(t)) === m;

function customCats(txs, type) {
  const defaults = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  return uniq(txs.filter((t) => (isIncome(t) ? 'income' : 'expense') === type).map(catOf).filter((c) => !defaults.includes(c))).sort();
}
function catOptions(txs, type) {
  const defaults = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  return [...defaults.map((c) => ({ value: c, label: c })), ...customCats(txs, type).map((c) => ({ value: c, label: c })), { value: OTHER, label: 'Other…' }];
}
function groupBy(arr, keyFn) {
  const map = new Map();
  for (const x of arr) { const k = keyFn(x); if (!map.has(k)) map.set(k, []); map.get(k).push(x); }
  return map;
}
function byCategory(txs) {
  const totals = {};
  for (const t of txs) totals[catOf(t)] = (totals[catOf(t)] || 0) + amt(t);
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}
function sortDesc(txs) {
  return [...txs].sort((a, b) => (dateOf(b) > dateOf(a) ? 1 : dateOf(b) < dateOf(a) ? -1 : num(b.createdAt) - num(a.createdAt)));
}

// ---------- add / edit sheet ----------
async function openTxSheet(ctx, tx = null, preset = {}) {
  const txs = await ctx.db.all('transactions');
  const isEdit = !!tx;
  const init = {
    type: isIncome(tx) ? 'income' : 'expense',
    amount: isEdit ? amt(tx) : '',
    category: isEdit ? catOf(tx) : '',
    note: noteOf(tx),
    date: dateOf(tx) || dates.today(),
    recurring: !!tx?.recurring,
    ...preset,
  };
  const f = form([
    { name: 'type', label: 'Type', type: 'segment', options: [{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }] },
    { name: 'amount', label: 'Amount', type: 'number', placeholder: '0.00', required: true, autofocus: true, min: 0, step: '0.01' },
    { name: 'category', label: 'Category', type: 'select', options: catOptions(txs, init.type) },
    { name: 'custom', label: 'Custom category', type: 'text', placeholder: 'Type a category name' },
    { name: 'note', label: 'Note', type: 'text', placeholder: 'What was it? (optional)' },
    { name: 'date', label: 'Date', type: 'date' },
    { name: 'recurring', label: 'Recurring', type: 'toggle' },
  ], init);
  f.fields.recurring.input.closest('.field').after(h('p.hint', { style: { margin: '-6px 0 0' } }, 'Mark subscriptions so the AI can spot them'));

  const sel = f.fields.category.input;
  const typeSeg = f.fields.type.input;
  const customInput = f.fields.custom.input;
  const customRow = customInput.closest('.field');
  const syncCustom = (focus) => {
    const other = sel.value === OTHER;
    customRow.classList.toggle('hidden', !other);
    if (other && focus) setTimeout(() => customInput.focus(), 50);
  };
  const setOptions = (type, selected) => {
    clear(sel);
    const opts = catOptions(txs, type);
    for (const o of opts) sel.append(h('option', { value: o.value }, o.label));
    if (selected && opts.some((o) => o.value === selected)) sel.value = selected;
    else if (selected) { sel.value = OTHER; customInput.value = selected; }
    else sel.value = opts[0].value;
    syncCustom(false);
  };
  sel.addEventListener('change', () => syncCustom(true));
  typeSeg.addEventListener('change', () => setOptions(typeSeg.value === 'income' ? 'income' : 'expense', null));
  setOptions(init.type, init.category || null);

  const save = async () => {
    const err = f.validate();
    if (err) { toast(err); return false; }
    const v = f.values();
    const amount = Math.abs(num(v.amount));
    if (!(amount > 0)) { toast('Enter an amount greater than 0'); f.fields.amount.input.focus(); return false; }
    const category = v.category === OTHER ? String(v.custom || '').trim() : v.category;
    if (!category) { toast('Enter a category name'); customInput.focus(); return false; }
    const rec = {
      ...(tx || {}),
      type: v.type === 'income' ? 'income' : 'expense',
      amount: round2(amount),
      category,
      note: String(v.note || '').trim(),
      date: v.date || dates.today(),
      recurring: !!v.recurring,
    };
    await ctx.db.put('transactions', rec);
    toast(isEdit ? 'Saved' : rec.type === 'income' ? `Income ${money(rec.amount)} added` : `Expense ${money(rec.amount)} added`);
    return true;
  };

  const actions = [];
  if (isEdit) actions.push({ label: 'Delete', danger: true, onClick: async () => { const ok = await confirm('Delete this transaction?'); if (!ok) return false; await ctx.db.delete('transactions', tx.id); toast('Deleted'); return true; } });
  actions.push({ label: isEdit ? 'Save' : 'Add', primary: true, onClick: save });
  const s = sheet({ title: isEdit ? 'Edit transaction' : init.type === 'income' ? 'New income' : 'New expense', content: f.el, actions });
  f.focus();
  f.el.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); if (await save()) s.close(); }
  });
}

// Fixed-width 2-letter badge ("Fo" for Food, "HI" for Home improvement) so long category names
// never squeeze the note column; the full category name lives in the sub line instead.
function catBadge(cat, income) {
  const words = String(cat).trim().split(/\s+/).filter(Boolean);
  const initials = words.length >= 2 ? words[0][0] + words[1][0] : String(cat).slice(0, 2);
  return h('span.fin-badge', { class: income ? 'in' : '', title: cat, 'aria-label': cat }, initials.toUpperCase());
}

function txRow(ctx, t, { onOpen } = {}) {
  const income = isIncome(t);
  const note = noteOf(t);
  const subParts = [note ? catOf(t) : null, t?.recurring ? 'recurring' : null].filter(Boolean);
  return listItem({
    leading: catBadge(catOf(t), income),
    title: note || catOf(t),
    sub: subParts.length ? subParts.join(' · ') : null,
    right: h('span.amount', { class: income ? 'pos' : 'neg' }, (income ? '+' : '−') + money(amt(t))),
    onClick: () => { onOpen?.(); openTxSheet(ctx, t); },
  });
}

function openCategorySheet(ctx, cat, txs, m, budget) {
  const total = sum(txs);
  const list = h('div.list');
  for (const t of sortDesc(txs)) list.append(txRow(ctx, t, { onOpen: () => s.close() }));
  const s = sheet({
    title: cat,
    content: [
      h('p.muted', `${money(total)}${budget ? ` of ${money(budget)} budget` : ''} · ${txs.length} transaction${txs.length === 1 ? '' : 's'} in ${monthLabel(m)}`),
      txs.length ? list : empty('Nothing here this month', 'Tap + to add an expense in this category', 'money'),
    ],
    actions: [{ label: 'Add expense', primary: true, onClick: () => { openTxSheet(ctx, null, { type: 'expense', category: cat }); } }],
  });
}

// ---------- module ----------
export default {
  id: 'finances',
  title: 'Money',
  subtitle: 'Spending, income & budgets',
  icon: 'money',
  tab: 'money',

  stores: {
    transactions: { indexes: ['date', 'category'] },
    budgets: { indexes: ['category'] },
  },

  async render(container, ctx) {
    let month = thisMonth();
    let query = '';
    let allTxs = [];
    let budgets = [];

    container.append(h('style', `
      .fin-days.columns { gap: 3px; }
      .fin-days .col-fill { border-radius: 3px 3px 1px 1px; }
      .fin-cats.bars { gap: 4px; }
      .fin-cats .bar-row { cursor: pointer; padding: 2px 0; min-height: 44px; display: flex; flex-direction: column; justify-content: center; }
      .fin-cats .bar-row:active { opacity: .7; }
      .fin-month { flex: 1; min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: inherit; border-radius: 12px; }
      .fin-month:active { background: var(--card-2); }
      .fin-month h3 { margin: 0; }
      .fin-badge { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; letter-spacing: .02em; background: color-mix(in srgb, var(--expense) 16%, transparent); color: var(--expense); }
      .fin-badge.in { background: color-mix(in srgb, var(--income) 16%, transparent); color: var(--income); }
    `));

    // Month navigation
    const monthTitle = h('button.fin-month', { type: 'button', 'aria-label': 'Jump to current month', onclick: () => { month = thisMonth(); draw(); } });
    const nav = h('div.date-nav',
      h('button.icon-btn', { 'aria-label': 'Previous month', onclick: () => { month = shiftMonth(month, -1); draw(); } }, icon('back')),
      monthTitle,
      h('button.icon-btn', { 'aria-label': 'Next month', onclick: () => { month = shiftMonth(month, 1); draw(); } }, icon('chevron')));

    const summaryHolder = h('div');
    const catHolder = h('div');
    const searchInput = h('input', { type: 'search', placeholder: 'Search notes & categories', 'aria-label': 'Search transactions', oninput: () => { query = searchInput.value.trim(); drawList(); } });
    const searchBar = h('div.search-bar', icon('search', 20), searchInput);
    const listHolder = h('div');
    const trendHolder = h('div');
    container.append(nav, summaryHolder, catHolder, h('div.section-title', 'Transactions'), searchBar, listHolder, trendHolder);
    container.append(fab(() => openTxSheet(ctx), 'Add transaction'));

    const drawSummary = () => {
      clear(summaryHolder);
      const txs = allTxs.filter((t) => inMonth(t, month));
      const income = sum(txs.filter(isIncome));
      const expenses = sum(txs.filter((t) => !isIncome(t)));
      const net = income - expenses;
      const today = dates.today();
      const cur = thisMonth();
      const daysElapsed = month === cur ? Number(today.slice(8, 10)) : month < cur ? dates.daysInMonth(month + '-01') : 0;
      const dailyAvg = daysElapsed ? expenses / daysElapsed : 0;

      const c = card(
        h('div.small.muted', 'Net this month'),
        h('div.big-number', { class: net >= 0 ? 'good' : 'bad' }, (net > 0 ? '+' : '') + money(net)),
        h('div.stats.mt',
          stat('Income', money(income)),
          stat('Expenses', money(expenses)),
          stat('Daily avg', daysElapsed ? money(dailyAvg) : '—', 'spend')));

      if (expenses > 0) {
        const dim = dates.daysInMonth(month + '-01');
        const byDay = {};
        for (const t of txs) if (!isIncome(t)) { const d = Number(dateOf(t).slice(8, 10)); byDay[d] = (byDay[d] || 0) + amt(t); }
        const items = [];
        for (let d = 1; d <= dim; d++) items.push({ label: d === 1 || d % 5 === 0 ? String(d) : '', value: byDay[d] || 0, color: 'var(--expense)' });
        const chart = columns(items, { height: 90, format: money });
        chart.classList.add('fin-days', 'mt');
        c.append(h('div.small.muted.mt', 'Spending per day'), chart);
      } else if (!txs.length) {
        c.append(h('p.small.muted.mt', month === cur ? 'Nothing logged yet this month. Tap + to add an expense or income.' : 'No transactions in this month.'));
      }
      summaryHolder.append(c);
    };

    const drawCategories = () => {
      clear(catHolder);
      const txs = allTxs.filter((t) => inMonth(t, month) && !isIncome(t));
      const budgetMap = {};
      for (const b of budgets) if (b?.category && num(b.monthly) > 0) budgetMap[b.category] = num(b.monthly);
      const totals = Object.fromEntries(byCategory(txs));
      for (const c of Object.keys(budgetMap)) if (!(c in totals)) totals[c] = 0;
      const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
      const c = card(h('div.card-title', h('h3', 'By category'), h('button.btn.sm.ghost', { type: 'button', onclick: () => ctx.nav('settings') }, 'Budgets')));
      if (!rows.length) {
        c.append(h('p.small.muted', 'Your spending by category shows up here. Set monthly budgets in Settings to track them.'));
        catHolder.append(c);
        return;
      }
      const totalBudget = Object.values(budgetMap).reduce((s, v) => s + v, 0);
      const totalSpent = sum(txs.filter((t) => catOf(t) in budgetMap));
      if (totalBudget > 0) {
        const frac = totalSpent / totalBudget;
        c.append(
          h('div.row.between.small', h('span.muted', 'Budgeted categories'), h('span', { class: frac > 1 ? 'bad' : '' }, `${money(totalSpent)} of ${money(totalBudget)}`)),
          h('div.progress.mb', h('div', { style: { width: Math.min(100, frac * 100) + '%', background: frac > 1 ? 'var(--bad)' : frac > 0.85 ? 'var(--warn)' : 'var(--accent)' } })));
      }
      const items = rows.map(([cat, spent]) => {
        const budget = budgetMap[cat];
        return { label: cat, value: spent, color: budget && spent > budget ? 'var(--bad)' : budget ? 'var(--accent)' : 'var(--expense)', budget };
      });
      const bars = barList(items, { format: money });
      bars.classList.add('fin-cats');
      [...bars.children].forEach((row, i) => {
        const it = items[i];
        if (it.budget) {
          const txt = row.querySelector('.bar-head .muted');
          if (txt) { txt.textContent = `${money(it.value)} of ${money(it.budget)}`; if (it.value > it.budget) { txt.classList.remove('muted'); txt.classList.add('bad'); } }
        }
        row.classList.add('tappable');
        row.addEventListener('click', () => openCategorySheet(ctx, it.label, txs.filter((t) => catOf(t) === it.label), month, it.budget));
      });
      c.append(bars);
      catHolder.append(c);
    };

    const drawList = () => {
      clear(listHolder);
      const c = card();
      let txs;
      if (query) {
        const q = query.toLowerCase();
        txs = sortDesc(allTxs.filter((t) => noteOf(t).toLowerCase().includes(q) || catOf(t).toLowerCase().includes(q))).slice(0, 100);
        c.append(h('p.small.muted', `${txs.length} result${txs.length === 1 ? '' : 's'} across all months`));
        if (!txs.length) { c.append(empty('No matches', 'Try a different word', 'search')); listHolder.append(c); return; }
      } else {
        txs = sortDesc(allTxs.filter((t) => inMonth(t, month)));
        if (!allTxs.length) { c.append(empty('No transactions yet', 'Tap + to add your first expense or income', 'money')); listHolder.append(c); return; }
        if (!txs.length) { c.append(empty('Nothing in ' + monthLabel(month), 'Tap + to add, or use the arrows to change month', 'money')); listHolder.append(c); return; }
      }
      const groups = groupBy(txs, dateOf);
      const list = h('div.list');
      for (const [day, rows] of groups) {
        const spent = sum(rows.filter((t) => !isIncome(t)));
        const earned = sum(rows.filter(isIncome));
        list.append(h('div.row.between', { style: { padding: '12px 0 2px' } },
          h('span.pill-date', day ? dates.label(day) : 'No date'),
          h('span.small.muted', [earned ? '+' + money(earned) : null, spent ? '−' + money(spent) : null].filter(Boolean).join('  '))));
        for (const t of rows) list.append(txRow(ctx, t));
      }
      c.append(list);
      listHolder.append(c);
    };

    const drawTrend = () => {
      clear(trendHolder);
      const months = [];
      for (let i = 5; i >= 0; i--) months.push(shiftMonth(month, -i));
      const items = months.map((m) => {
        const txs = allTxs.filter((t) => inMonth(t, m));
        const net = sum(txs.filter(isIncome)) - sum(txs.filter((t) => !isIncome(t)));
        return { label: monthShort(m), value: Math.abs(net), color: net >= 0 ? 'var(--income)' : 'var(--expense)', net };
      });
      const c = card(h('div.card-title', h('h3', '6-month trend'), h('span.small.muted', 'monthly net')));
      if (!items.some((i) => i.value > 0)) c.append(h('p.small.muted', 'Add transactions across a few months to see your trend.'));
      else {
        const chart = columns(items.map((i) => ({ label: i.label, value: i.value, color: i.color })), { height: 110, format: money });
        c.append(chart, h('div.row.between.small.mt', items.map((i) => h('span', { class: i.net >= 0 ? 'good' : 'bad', style: { flex: '1', textAlign: 'center', fontSize: '10px' } }, i.value ? (i.net > 0 ? '+' : '−') + fmt.num(Math.abs(i.net), 0) : ''))));
      }
      trendHolder.append(c);
    };

    const draw = async () => {
      [allTxs, budgets] = await Promise.all([ctx.db.all('transactions'), ctx.db.all('budgets')]);
      clear(monthTitle);
      monthTitle.append(h('h3', monthLabel(month)));
      if (month !== thisMonth()) monthTitle.append(h('div.small.muted', { style: { fontWeight: '500' } }, 'Tap for current month'));
      drawSummary();
      drawCategories();
      drawList();
      drawTrend();
    };

    await draw();
    const off = ctx.db.onChange(null, (store) => { if (store === 'transactions' || store === 'budgets') draw(); });
    if (ctx.params?.add === '1') openTxSheet(ctx, null, { type: 'expense' });
    return off;
  },

  quickActions: [
    { label: 'Expense', icon: 'money', run: (ctx) => openTxSheet(ctx, null, { type: 'expense' }) },
  ],

  async todayCard(ctx) {
    const n = await ctx.db.count('transactions');
    if (!n) return null;
    const today = dates.today();
    const [ms, me] = monthRange(ym(today));
    const [txs, budgets] = await Promise.all([ctx.db.range('transactions', ms, me), ctx.db.all('budgets')]);
    const expenses = txs.filter((t) => !isIncome(t));
    const spentToday = sum(expenses.filter((t) => dateOf(t) === today));
    const spentMonth = sum(expenses);
    const budgetMap = {};
    for (const b of budgets) if (b?.category && num(b.monthly) > 0) budgetMap[b.category] = num(b.monthly);
    const budget = Object.values(budgetMap).reduce((s, v) => s + v, 0);
    const spentBudgeted = sum(expenses.filter((t) => catOf(t) in budgetMap));
    const c = card(
      h('div.card-title', h('h3', 'Money'), h('span.link', 'Open')),
      h('div', `Spent today ${money(spentToday)} · This month ${money(spentMonth)}`));
    if (budget > 0) {
      const frac = spentBudgeted / budget;
      c.append(h('div.progress.mt', h('div', { style: { width: Math.min(100, frac * 100) + '%', background: frac > 1 ? 'var(--bad)' : frac > 0.85 ? 'var(--warn)' : 'var(--accent)' } })));
      c.append(h('div.small.muted', { style: { marginTop: '6px' } }, frac > 1 ? `Budgeted categories: over by ${money(spentBudgeted - budget)}` : `Budgeted categories: ${money(spentBudgeted)} of ${money(budget)}, ${money(budget - spentBudgeted)} left`));
    }
    c.classList.add('tappable');
    c.addEventListener('click', () => ctx.nav('money/finances'));
    return c;
  },

  async settings(ctx) {
    const wrap = h('div');
    const [budgets, txs] = await Promise.all([ctx.db.all('budgets'), ctx.db.all('transactions')]);
    const cats = uniq([...EXPENSE_CATS, ...budgets.map((b) => b?.category), ...txs.filter((t) => !isIncome(t)).map(catOf)]);
    const totalEl = h('strong');
    const rows = h('div.list');
    const inputs = [];
    const updateTotal = () => { totalEl.textContent = money(inputs.reduce((s, i) => s + Math.max(0, num(i.value)), 0)) + ' / month'; };

    const addRow = (cat, existing) => {
      let b = existing || null;
      const inp = h('input.input', { type: 'number', inputmode: 'decimal', min: 0, step: '1', placeholder: 'none', 'aria-label': `Budget for ${cat}`, style: { width: '110px', minHeight: '40px', padding: '8px 10px', textAlign: 'right' } });
      inp.value = b && num(b.monthly) > 0 ? String(num(b.monthly)) : '';
      inputs.push(inp);
      // Serialise the change/clear handlers so a clear tapped mid-save cannot race the pending put.
      let pending = Promise.resolve();
      const queue = (fn) => { pending = pending.then(fn).catch((e) => console.error(e)); return pending; };
      const clearBudget = async () => {
        if (b) { await ctx.db.delete('budgets', b.id); b = null; toast(`Budget for ${cat} cleared`); }
        inp.value = ''; updateTotal();
      };
      inp.addEventListener('change', () => queue(async () => {
        const v = num(inp.value);
        if (inp.value === '' || !(v > 0)) { await clearBudget(); return; }
        b = await ctx.db.put('budgets', { ...(b || {}), category: cat, monthly: round2(v) });
        toast(`${cat}: ${money(b.monthly)} / month`);
        updateTotal();
      }));
      const clearBtn = h('button.icon-btn', { type: 'button', 'aria-label': `Clear budget for ${cat}`, onclick: () => queue(clearBudget) }, icon('close', 18));
      rows.append(h('div.list-item', h('div.li-main', h('div.li-title', cat)), h('div.li-right', inp, clearBtn)));
    };
    for (const cat of cats) addRow(cat, budgets.find((b) => b?.category === cat));
    updateTotal();

    wrap.append(
      h('p.small.muted', 'Monthly budget per category. Leave a field empty for no budget. Changes save as you go.'),
      h('div.row.between.mb', h('span.small.muted', 'Total budget'), totalEl),
      rows,
      h('button.btn.block.mt', { onclick: async () => {
        const name = await prompt('Category name', { title: 'New budget category', placeholder: 'e.g. Pets', okLabel: 'Add' });
        const cat = String(name || '').trim();
        if (!cat) return;
        if (cats.includes(cat)) { toast('That category already has a row'); return; }
        cats.push(cat); addRow(cat, null);
        setTimeout(() => inputs[inputs.length - 1].focus(), 100);
      } }, icon('plus'), 'Add category budget'));
    return wrap;
  },

  async exportForAI(ctx, { since, days } = {}) {
    const all = await ctx.db.all('transactions');
    if (!all.length) return '';
    const budgets = await ctx.db.all('budgets');
    const today = dates.today();
    const from = since || dates.addDays(today, -(days || 90));
    const currency = ctx.settings?.get('currency', 'USD') || 'USD';
    const period = all.filter((t) => dateOf(t) >= from && dateOf(t) <= today);
    const periodDays = Math.max(1, dates.daysBetween(from, today) + 1);
    const lines = [];
    lines.push(`## Money (${currency})`);
    lines.push(`Period ${from} → ${today} (${periodDays} days). ${all.length} transactions total, ${period.length} in period.`);
    const budgetMap = {};
    for (const b of budgets) if (b?.category && num(b.monthly) > 0) budgetMap[b.category] = num(b.monthly);
    const totalBudget = Object.values(budgetMap).reduce((s, v) => s + v, 0);
    if (totalBudget) lines.push(`Total monthly budget: ${money(totalBudget)} across ${Object.keys(budgetMap).length} categories.`);

    // Monthly summary, last 3 months incl. current
    lines.push('', '### Monthly summary (last 3 months)');
    const cur = thisMonth();
    const months = [shiftMonth(cur, -2), shiftMonth(cur, -1), cur];
    let periodIncome = 0, periodExpenses = 0;
    for (const m of months) {
      const txs = all.filter((t) => inMonth(t, m));
      const inc = sum(txs.filter(isIncome)), exp = sum(txs.filter((t) => !isIncome(t)));
      const net = inc - exp;
      const rate = inc > 0 ? Math.round((net / inc) * 100) + '%' : 'n/a';
      lines.push(`- ${m}${m === cur ? ' (month to date)' : ''}: income ${money(inc)}, expenses ${money(exp)}, net ${net >= 0 ? '+' : ''}${money(net)}, savings rate ${rate}`);
    }
    periodIncome = sum(period.filter(isIncome)); periodExpenses = sum(period.filter((t) => !isIncome(t)));
    const periodNet = periodIncome - periodExpenses;
    lines.push(`- Whole period: income ${money(periodIncome)}, expenses ${money(periodExpenses)}, net ${periodNet >= 0 ? '+' : ''}${money(periodNet)}, savings rate ${periodIncome > 0 ? Math.round((periodNet / periodIncome) * 100) + '%' : 'n/a'}`);

    // This month by category with budget variance
    const monthExp = all.filter((t) => inMonth(t, cur) && !isIncome(t));
    const cats = byCategory(monthExp);
    for (const c of Object.keys(budgetMap)) if (!cats.some(([k]) => k === c)) cats.push([c, 0]);
    if (cats.length) {
      lines.push('', `### This month (${cur}) by category`);
      for (const [cat, spent] of cats) {
        const b = budgetMap[cat];
        let v = money(spent);
        if (b) { const diff = spent - b; v += ` of ${money(b)} budget (${diff > 0 ? 'OVER by ' + money(diff) : money(-diff) + ' left'})`; }
        lines.push(`- ${cat}: ${v}`);
      }
    }

    // Recurring items (deduped by note/category, most recent amount)
    const recurring = sortDesc(all.filter((t) => t?.recurring));
    if (recurring.length) {
      const seen = new Map();
      for (const t of recurring) { const k = (noteOf(t) || catOf(t)).toLowerCase(); if (!seen.has(k)) seen.set(k, t); }
      const items = [...seen.values()];
      lines.push('', `### Recurring / subscriptions (${items.length} items, ~${money(sum(items.filter((t) => !isIncome(t))))}/month out${items.some(isIncome) ? `, ${money(sum(items.filter(isIncome)))}/month in` : ''})`);
      for (const t of items.slice(0, 25)) lines.push(`- ${noteOf(t) || catOf(t)} (${catOf(t)}): ${isIncome(t) ? '+' : '-'}${money(amt(t))}, last ${dateOf(t)}`);
    }

    // Top 10 expenses in period
    const top = [...period.filter((t) => !isIncome(t))].sort((a, b) => amt(b) - amt(a)).slice(0, 10);
    if (top.length) {
      lines.push('', '### Top 10 expenses in period');
      for (const t of top) lines.push(`- ${dateOf(t)} ${money(amt(t))} ${catOf(t)}${noteOf(t) ? ': ' + noteOf(t).slice(0, 80) : ''}`);
    }

    // Averages
    lines.push('', '### Averages (period)');
    lines.push(`- Average daily spend: ${money(periodExpenses / periodDays)}`);
    lines.push(`- Average monthly spend: ${money(periodExpenses / Math.max(1, periodDays / 30.44))}`);
    const expDays = new Set(period.filter((t) => !isIncome(t)).map(dateOf)).size;
    lines.push(`- Days with spending: ${expDays} of ${periodDays}; transactions per week: ${fmt.num((period.length / periodDays) * 7, 1)}`);

    // Last 40 transactions
    const recent = sortDesc(all).slice(0, 40);
    lines.push('', `### Last ${recent.length} transactions (date amount Category: note)`);
    for (const t of recent) {
      const n = noteOf(t).replace(/\s+/g, ' ').slice(0, 100);
      lines.push(`${dateOf(t) || '????-??-??'} ${isIncome(t) ? '+' : '-'}${amt(t).toFixed(2)} ${catOf(t)}${n ? ': ' + n : ''}${t?.recurring ? ' [recurring]' : ''}`);
    }
    return lines.join('\n').slice(0, 8000);
  },
};
