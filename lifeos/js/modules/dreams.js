// dreams.js — Morning dream journal: log dreams fast, tag them, spot recurring themes.
import { h, clear, dates, fmt, icon, toast, formSheet, empty, card, listItem, fab, stat } from '../ui.js';

const STORE = 'dreams';
const MOOD_LABELS = { 1: 'Awful', 2: 'Bad', 3: 'Okay', 4: 'Good', 5: 'Amazing' };
const VIVID_LABELS = { 1: 'Faint', 2: 'Hazy', 3: 'Clear', 4: 'Vivid', 5: 'Hyper-real' };
const SLEEP_LABELS = { 1: 'Terrible', 2: 'Poor', 3: 'Okay', 4: 'Good', 5: 'Great' };
const MOOD_EMOJI = { 1: '\u{1F616}', 2: '\u{1F615}', 3: '\u{1F610}', 4: '\u{1F642}', 5: '\u{1F604}' };
const ELLIPSIS = '…', DASH = '—';
// Rating sliders run 0-5: position 0 means "not rated" and is stored as null, so an untouched slider never saves as 3.
const UNRATED = 'Not rated';
function withUnrated(labels) { return { 0: UNRATED, ...labels }; }
// ui range inputs fall back to min||1 for falsy values, so pass the string '0' (truthy) to park the slider on "not rated".
function toFormRating(v) { return v == null ? '0' : v; }

const STOPWORDS = new Set(('that this with were there then they them their have from what when which would could about into some ' +
  'like just very really been being also than more most other only over after before because where while these those through ' +
  'again around back down your mine ours will shall should might must does doing done said says going went come came know knew ' +
  'think thought felt feel feeling something someone anything everything nothing else even much many each every both such here ' +
  'away still though although until since upon onto cannot didn wasn weren doesn couldn wouldn shouldn isn aren hadn hasn ' +
  'having make made making take took taking give gave getting gets want wanted need needed tried trying seem seemed seems look ' +
  'looked looking started start starting ended ending turn turned kind sort thing things part place time times first next last ' +
  'later another somewhere somehow suddenly maybe almost quite rather little actually dream dreams dreamed dreamt dreaming ' +
  'remember remembered woke wake waking asleep sleep night morning yeah okay well once never always sometimes whole ' +
  'across along among behind below beside between beyond during except inside outside toward towards under underneath ' +
  'within without yourself myself himself herself itself themselves ourselves whom whose whatever whoever wherever anyway ' +
  'ought able above against').split(/\s+/));

// ---------- record helpers (guard old / imported records) ----------
function rating(v) { const n = Number(v); return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : null; }
function norm(r) {
  r = r || {};
  return {
    ...r,
    date: typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : dates.today(),
    title: typeof r.title === 'string' ? r.title : '',
    text: typeof r.text === 'string' ? r.text : '',
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [],
    mood: rating(r.mood), vividness: rating(r.vividness), sleepQuality: rating(r.sleepQuality),
    lucid: !!r.lucid,
  };
}
function cleanTags(tags) {
  const seen = new Set(), out = [];
  for (const t of tags || []) { const k = String(t).trim().toLowerCase().replace(/^#/, ''); if (k && !seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}
function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function snippet(d, n = 60) { const t = oneLine(d.text); return t.length > n ? t.slice(0, n).trimEnd() + ELLIPSIS : t; }
function displayTitle(d) { return oneLine(d.title) || snippet(d, 60) || 'Untitled dream'; }
function avg(arr) { const xs = arr.filter((x) => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function sortDesc(rows) { return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0))); }
async function loadAll(ctx) { return sortDesc((await ctx.db.all(STORE)).map(norm)); }

/** Consecutive days with at least one dream, ending today or (if today is not logged yet) yesterday. */
function streakOf(rows) {
  const set = new Set(rows.map((d) => d.date));
  let day = dates.today();
  if (!set.has(day)) { day = dates.addDays(day, -1); if (!set.has(day)) return 0; }
  let n = 0;
  while (set.has(day)) { n++; day = dates.addDays(day, -1); }
  return n;
}
function tagCounts(rows) {
  const m = new Map();
  for (const d of rows) for (const t of d.tags) { const k = t.toLowerCase(); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function wordCounts(rows) {
  const m = new Map();
  for (const d of rows) {
    const words = (d.title + ' ' + d.text).toLowerCase().match(/\p{L}+/gu) || [];
    for (const w of words) { if (w.length < 4 || STOPWORDS.has(w)) continue; m.set(w, (m.get(w) || 0) + 1); }
  }
  return [...m.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---------- add / edit ----------
function fields() {
  return [
    { name: 'date', label: 'Date', type: 'date', required: true },
    { name: 'title', label: 'Title', type: 'text', placeholder: 'A short name for the dream (optional)' },
    { name: 'text', label: 'The dream', type: 'textarea', rows: 7, autofocus: true, required: true, placeholder: 'What happened? Who was there? How did it feel?' },
    { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'flying, work, family', hint: 'Comma separated. Tags make recurring themes easy to spot.' },
    { name: 'mood', label: 'Mood in the dream', type: 'range', min: 0, max: 5, labels: withUnrated(MOOD_LABELS), hint: 'Optional. Leave at the far left to skip.' },
    { name: 'vividness', label: 'Vividness', type: 'range', min: 0, max: 5, labels: withUnrated(VIVID_LABELS) },
    { name: 'lucid', label: 'Lucid dream (knew I was dreaming)', type: 'toggle' },
    { name: 'sleepQuality', label: 'Sleep quality', type: 'range', min: 0, max: 5, labels: withUnrated(SLEEP_LABELS) },
  ];
}
function toFormValues(d) {
  return { date: d.date, title: d.title, text: d.text, tags: d.tags, mood: toFormRating(d.mood), vividness: toFormRating(d.vividness), lucid: d.lucid, sleepQuality: toFormRating(d.sleepQuality) };
}
function toRecord(v, base) {
  return {
    ...(base || {}),
    date: v.date || dates.today(),
    title: oneLine(v.title),
    text: String(v.text || '').trim(),
    tags: cleanTags(v.tags),
    mood: rating(v.mood),
    vividness: rating(v.vividness),
    lucid: !!v.lucid,
    sleepQuality: rating(v.sleepQuality),
  };
}
async function openAdd(ctx, preset = {}) {
  const v = await formSheet({ title: 'New dream', fields: fields(), values: toFormValues(norm({ date: dates.today(), ...preset })), saveLabel: 'Save dream' });
  if (!v) return null;
  const rec = await ctx.db.put(STORE, toRecord(v));
  toast('Dream saved');
  return rec;
}
async function openEdit(ctx, d) {
  const v = await formSheet({
    title: 'Edit dream', fields: fields(), values: toFormValues(d), saveLabel: 'Save',
    onDelete: async () => { await ctx.db.delete(STORE, d.id); toast('Dream deleted'); },
  });
  if (!v) return;
  await ctx.db.put(STORE, toRecord(v, d));
  toast('Dream saved');
}

// ---------- pieces ----------
function moodEl(d, size = 22) {
  return h('span', { style: { fontSize: size + 'px', lineHeight: '1', width: '30px', textAlign: 'center', display: 'inline-block' }, title: d.mood ? 'Mood: ' + MOOD_LABELS[d.mood] : 'Mood not rated' },
    d.mood ? MOOD_EMOJI[d.mood] : h('span.muted', '•'));
}
function tagChips(tags, max = 4) {
  const shown = tags.slice(0, max);
  return [shown.map((t) => h('span.chip', '#' + t)), tags.length > max ? h('span.chip', '+' + (tags.length - max)) : null];
}
function row(ctx, d) {
  const hasTitle = !!oneLine(d.title);
  const sub = h('div',
    hasTitle && d.text ? h('div.ellipsis', snippet(d, 80)) : null,
    h('div.row.wrap', { style: { gap: '6px', marginTop: '4px' } }, h('span.pill-date', dates.label(d.date)), tagChips(d.tags)));
  return listItem({
    leading: moodEl(d),
    title: displayTitle(d),
    sub,
    right: d.lucid ? h('span.accent', { title: 'Lucid dream', 'aria-label': 'Lucid' }, icon('moon', 20)) : null,
    onClick: () => openEdit(ctx, d),
  });
}

export default {
  id: 'dreams',
  title: 'Dreams',
  subtitle: 'Morning dream journal',
  icon: 'moon',
  tab: 'mind',
  stores: { dreams: { indexes: ['date'] } },

  async render(container, ctx) {
    let rows = [];
    let query = '';
    let tagFilter = null;

    const statsHolder = h('div');
    const listHolder = h('div');
    const input = h('input', { type: 'search', placeholder: 'Search dreams, tags' + ELLIPSIS, 'aria-label': 'Search dreams', autocomplete: 'off',
      oninput: () => { query = input.value; drawList(); } });
    const search = h('div.search-bar', h('span.muted', { style: { display: 'flex' } }, icon('search', 20)), input);
    container.append(statsHolder, search, listHolder, fab(() => openAdd(ctx), 'Add dream'));

    const resetFilters = () => { query = ''; input.value = ''; tagFilter = null; drawStats(); drawList(); };

    const drawStats = () => {
      clear(statsHolder);
      if (!rows.length) return;
      const month = dates.today().slice(0, 7);
      const thisMonth = rows.filter((d) => d.date.startsWith(month)).length;
      const lucidPct = Math.round((rows.filter((d) => d.lucid).length / rows.length) * 100);
      const sleep = avg(rows.map((d) => d.sleepQuality));
      const streak = streakOf(rows);
      const top = tagCounts(rows).slice(0, 5);
      statsHolder.append(card(
        h('div.stats', { style: { gridTemplateColumns: 'repeat(2, 1fr)' } },
          stat('This month', String(thisMonth), thisMonth === 1 ? 'dream logged' : 'dreams logged'),
          stat('Lucid', lucidPct + '%', `of ${rows.length} dream${rows.length === 1 ? '' : 's'}`),
          stat('Sleep quality', sleep == null ? '–' : fmt.num(sleep, 1), sleep == null ? 'not rated yet' : 'average out of 5'),
          stat('Streak', String(streak), streak === 1 ? 'day in a row' : 'days in a row')),
        top.length ? h('div.chips.mt', { style: { gap: '8px' } }, top.map(([t, n]) => h('button.chip', {
          type: 'button', class: tagFilter === t ? 'accent' : '', 'aria-pressed': tagFilter === t ? 'true' : 'false',
          style: { minHeight: '36px', padding: '0 12px', fontSize: '13px' },
          onclick: () => { tagFilter = tagFilter === t ? null : t; drawStats(); drawList(); },
        }, '#' + t, h('span.muted', String(n))))) : null));
    };

    const drawList = () => {
      clear(listHolder);
      if (!rows.length) {
        listHolder.append(empty('No dreams yet', 'Tap + right after you wake up and jot down what you remember. Even a fragment counts.', 'moon'));
        return;
      }
      const q = query.trim().toLowerCase();
      const filtered = rows.filter((d) =>
        (!tagFilter || d.tags.some((t) => t.toLowerCase() === tagFilter)) &&
        (!q || d.title.toLowerCase().includes(q) || d.text.toLowerCase().includes(q) || d.tags.some((t) => t.toLowerCase().includes(q))));
      if (tagFilter || q) {
        listHolder.append(h('div.row.between', { style: { marginTop: '8px' } },
          h('span.small.muted', `${filtered.length} of ${rows.length} dream${rows.length === 1 ? '' : 's'}${tagFilter ? ' tagged #' + tagFilter : ''}`),
          h('button.btn.sm.ghost', { type: 'button', onclick: resetFilters }, 'Clear')));
      }
      if (!filtered.length) { listHolder.append(empty('No matching dreams', 'Try another word or clear the filter.', 'search')); return; }
      let curMonth = null, list = null;
      for (const d of filtered) {
        const m = d.date.slice(0, 7);
        if (m !== curMonth) {
          curMonth = m;
          listHolder.append(h('div.section-title', dates.monthLabel(d.date)));
          list = h('div.list');
          listHolder.append(card(list));
        }
        list.append(row(ctx, d));
      }
    };

    const load = async () => { rows = await loadAll(ctx); drawStats(); drawList(); };
    await load();
    const off = ctx.db.onChange(STORE, load);
    if (ctx.params?.add === '1') openAdd(ctx);
    return off;
  },

  quickActions: [{ label: 'Dream', icon: 'moon', run: (ctx) => openAdd(ctx) }],

  async todayCard(ctx) {
    const todays = sortDesc((await ctx.db.where(STORE, 'date', dates.today())).map(norm));
    if (!todays.length) {
      return h('div.card.tappable', { onclick: () => openAdd(ctx), role: 'button' },
        h('div.row', h('span.accent', { style: { display: 'flex' } }, icon('moon', 26)),
          h('div.grow', h('h3', { style: { marginBottom: '2px' } }, "Record this morning's dream"), h('div.small.muted', 'Dreams fade within minutes. Tap to jot it down.')),
          icon('chevron')));
    }
    const d = todays[0];
    const hasTitle = !!oneLine(d.title);
    return h('div.card.tappable', { onclick: () => ctx.nav('mind/dreams'), role: 'button' },
      h('div.card-title', h('h3', "Today's dream"), h('span.link', todays.length > 1 ? `${todays.length} dreams` : d.lucid ? 'Lucid' : (d.mood ? MOOD_LABELS[d.mood] : ''))),
      h('div.row', moodEl(d, 26),
        h('div.grow',
          h('div', { style: { fontWeight: 600 } }, displayTitle(d)),
          hasTitle && d.text ? h('div.small.muted', snippet(d, 120)) : null,
          d.tags.length ? h('div.chips', { style: { marginTop: '6px' } }, tagChips(d.tags, 5)) : null),
        d.lucid ? h('span.accent', icon('moon', 20)) : null));
  },

  async exportForAI(ctx, { since, days } = {}) {
    const all = (await ctx.db.all(STORE)).map(norm);
    if (!all.length) return '';
    const from = since || dates.addDays(dates.today(), -(days || 90));
    const rows = sortDesc(all.filter((d) => d.date >= from));
    const out = [];
    out.push(`## Dreams (dream journal, since ${from})`);
    if (!rows.length) { out.push(`No dreams logged in this period (${all.length} total ever, last on ${sortDesc(all.slice())[0].date}).`); return out.join('\n'); }
    const lucid = rows.filter((d) => d.lucid).length;
    const f = (x) => (x == null ? 'n/a' : fmt.num(x, 1) + '/5');
    out.push(`- Dreams logged: ${rows.length} (${all.length} total ever); lucid: ${lucid} (${Math.round((lucid / rows.length) * 100)}%)`);
    out.push(`- Averages: mood ${f(avg(rows.map((d) => d.mood)))}, vividness ${f(avg(rows.map((d) => d.vividness)))}, sleep quality ${f(avg(rows.map((d) => d.sleepQuality)))}`);
    out.push(`- Current logging streak: ${streakOf(all)} day(s); days with a dream in period: ${new Set(rows.map((d) => d.date)).size}`);
    const themes = wordCounts(rows).slice(0, 15);
    const tags = tagCounts(rows).slice(0, 10);
    if (themes.length) out.push(`- Recurring words: ${themes.map(([w, n]) => `${w} (${n})`).join(', ')}`);
    if (tags.length) out.push(`- Top tags: ${tags.map(([t, n]) => `#${t} (${n})`).join(', ')}`);
    out.push('', 'Recent dreams (newest first):');
    for (const d of rows.slice(0, 20)) {
      const text = oneLine(d.text);
      const body = text.length > 300 ? text.slice(0, 300).trimEnd() + ELLIPSIS : text;
      const title = oneLine(d.title);
      out.push(`${d.date}${d.lucid ? ' [lucid]' : ''}${d.mood ? ` (mood ${d.mood}/5)` : ''} ${title ? title + ' ' + DASH + ' ' : ''}${body || '(no text)'}${d.tags.length ? '  #' + d.tags.join(' #') : ''}`);
    }
    return out.join('\n');
  },
};
