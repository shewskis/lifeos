// ideas.js — Idea inbox: jot a thought in one line, star the good ones, mark them exploring / done / parked.
import { h, clear, dates, icon, toast, formSheet, listItem, empty, card, fab, segmented } from '../ui.js';

const STORE = 'ideas';
const PLACEHOLDER = 'Got an idea? Type it… add #tags';
const STATUS = {
  new: { label: 'New', chip: '' },
  exploring: { label: 'Exploring', chip: 'accent' },
  done: { label: 'Done', chip: 'good' },
  parked: { label: 'Parked', chip: '' },
};
const FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'starred', label: 'Starred' },
  { value: 'parked', label: 'Parked' },
  { value: 'done', label: 'Done' },
];
const PAGE = 50;

const STYLE = `
.module[data-module="ideas"] .idea-star { width: 44px; height: 44px; margin: -10px -4px -10px -8px; color: var(--muted); }
.module[data-module="ideas"] .idea-star.on { color: var(--warn); }
.module[data-module="ideas"] .idea-star.on svg { fill: currentColor; }
.module[data-module="ideas"] .list-item.done .li-sub { text-decoration: none; }
.module[data-module="ideas"] .idea-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; }
.module[data-module="ideas"] .idea-meta .chip { padding: 1px 8px; font-size: 11px; }
.module[data-module="ideas"] .idea-filter { margin-bottom: 12px; }
.module[data-module="ideas"] .idea-count { display: flex; gap: 14px; margin: 2px 0 12px; font-size: 13px; color: var(--muted); }
.module[data-module="ideas"] .idea-count b { color: var(--text); font-weight: 700; }
`;

// ---------- record helpers ----------
function isDateKey(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
/** Arrays (from the form's tags field) and strings go through the same splitter, so "#app #home", "app, home" and
 *  "app home" all store ['app', 'home'] — the same shape the quick-capture bar produces. */
function parseTags(v) {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return uniq(parts.flatMap((s) => String(s ?? '').split(/[,\n#\s]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean));
}
function uniq(arr) { return [...new Set(arr)]; }
function norm(r) {
  if (!r) return null;
  return {
    ...r,
    date: isDateKey(r.date) ? r.date : dates.today(),
    title: String(r.title ?? '').trim(),
    text: String(r.text ?? ''),
    tags: parseTags(r.tags),
    status: STATUS[r.status] ? r.status : 'new',
    starred: !!r.starred,
  };
}
function snippet(text, n = 90) { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }
function isActive(r) { return r.status === 'new' || r.status === 'exploring'; }
/** Newest first: by date, then by creation time. */
function sortDesc(rows) { return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0))); }
async function allIdeas(db) { return sortDesc((await db.all(STORE)).map(norm)); }

/** Quick-capture text → record fields. "#tags" anywhere become tags. Tags trailing the line are removed from the title
 *  ("Sell the bike #money" → "Sell the bike"); a tag inside the sentence keeps its word ("app for #gym buddies" → "app for
 *  gym buddies"). The first line is the title; further lines become the details. */
const TAG_RE = /#([\p{L}\p{N}_-]+)/gu;
const TRAILING_TAGS_RE = /(\s*#[\p{L}\p{N}_-]+)+\s*$/u;
function parseQuick(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const tags = uniq(Array.from(text.matchAll(TAG_RE), (m) => m[1].toLowerCase()));
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return null;
  const stripped = lines[0].replace(TRAILING_TAGS_RE, '').replace(TAG_RE, '$1').replace(/\s{2,}/g, ' ').trim();
  return { title: stripped || lines[0].replace(TAG_RE, '$1').trim(), text: lines.slice(1).join('\n'), tags };
}

function statusChip(status) {
  const s = STATUS[status] || STATUS.new;
  if (status === 'new') return null;
  return h('span.chip', { class: s.chip }, s.label);
}

// ---------- forms ----------
function fields(existing) {
  return [
    { name: 'title', label: 'Idea', type: 'text', required: true, placeholder: 'One line that captures it', autofocus: !existing },
    { name: 'text', label: 'Details', type: 'textarea', rows: 5, placeholder: 'Why it matters, how it could work, first step…' },
    { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'app, business, home' },
    { name: 'status', label: 'Status', type: 'segment', options: Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label })) },
    { name: 'starred', label: 'Starred', type: 'toggle', hint: 'Starred ideas float to the top' },
    { name: 'date', label: 'Captured on', type: 'date' },
  ];
}

async function openSheet(ctx, existing) {
  const { db } = ctx;
  const cur = existing ? norm(existing) : norm({ date: dates.today(), status: 'new' });
  const vals = await formSheet({
    title: existing ? 'Edit idea' : 'New idea',
    fields: fields(existing),
    values: { title: cur.title, text: cur.text, tags: cur.tags, status: cur.status, starred: cur.starred, date: cur.date },
    saveLabel: existing ? 'Save' : 'Add idea',
    onDelete: existing ? async () => {
      try { await db.delete(STORE, existing.id); toast('Idea deleted'); }
      catch (e) { console.error(e); toast('Could not delete idea'); }
    } : undefined,
  });
  if (!vals) return null;
  const title = String(vals.title ?? '').trim();
  if (!title) { toast('Write the idea first'); return null; }
  try {
    const rec = norm({ ...(existing || {}), ...vals, title, date: isDateKey(vals.date) ? vals.date : cur.date });
    const saved = await db.put(STORE, rec);
    toast(existing ? 'Saved' : 'Idea captured');
    return saved;
  } catch (e) { console.error(e); toast('Could not save idea'); return null; }
}

async function setStatus(ctx, idea, status) {
  try { await ctx.db.put(STORE, { ...idea, status }); toast(`Marked ${STATUS[status].label.toLowerCase()}`); }
  catch (e) { console.error(e); toast('Could not update idea'); }
}
async function toggleStar(ctx, idea) {
  try { await ctx.db.put(STORE, { ...idea, starred: !idea.starred }); }
  catch (e) { console.error(e); toast('Could not update idea'); }
}

// ---------- the module ----------
export default {
  id: 'ideas',
  title: 'Ideas',
  subtitle: 'Catch sparks before they fade',
  icon: 'bulb',
  tab: 'mind',
  stores: { ideas: { indexes: ['date', 'status'] } },

  async render(container, ctx) {
    const { db } = ctx;
    let filter = ctx.settings.get('ideas:filter', 'active');
    if (!FILTERS.some((f) => f.value === filter)) filter = 'active';
    let query = '';
    let showAll = false;
    let ideas = [];

    container.append(h('style', STYLE));

    // quick-capture bar: kept out of draw() so typing is never interrupted by re-renders
    const input = h('input', { type: 'text', placeholder: PLACEHOLDER, enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'sentences', 'aria-label': 'New idea' });
    const submit = async () => {
      const raw = input.value;
      const parsed = parseQuick(raw);
      if (!parsed) { input.focus(); return; }
      input.value = ''; // cleared synchronously so a second Enter / "+" tap during the write cannot capture the same text twice
      try {
        await db.put(STORE, norm({ ...parsed, date: dates.today(), status: 'new', starred: false }));
        input.focus();
        if (filter !== 'active') { filter = 'active'; ctx.settings.set('ideas:filter', filter); seg.setValue(filter); }
        toast('Idea captured');
      } catch (e) {
        console.error(e);
        if (!input.value) input.value = raw; // give the text back unless something new was typed meanwhile
        toast('Could not save idea');
      }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const bar = h('div.search-bar', icon('bulb', 20), input, h('button.icon-btn.accent', { type: 'button', 'aria-label': 'Add idea', onclick: submit }, icon('plus', 26)));

    const seg = segmented(FILTERS, filter, (v) => { filter = v; showAll = false; ctx.settings.set('ideas:filter', v); draw(); });
    seg.classList.add('idea-filter');
    const countEl = h('div.idea-count');
    const searchInput = h('input', { type: 'search', placeholder: 'Search ideas and tags', 'aria-label': 'Search ideas' });
    searchInput.addEventListener('input', () => { query = searchInput.value; showAll = false; draw(); });
    // The search bar lives outside listHolder: draw() clears that holder on every keystroke, and detaching the focused
    // input would blur it and close the phone keyboard after each character.
    const search = h('div.search-bar.hidden', icon('search', 18), searchInput);
    const listHolder = h('div');
    container.append(bar, seg, countEl, search, listHolder, fab(() => openSheet(ctx, null).catch(console.error), 'New idea'));

    // Shared across rows: a long-press re-renders every row under the finger, so a per-row flag would never see the click.
    let lastLongPressAt = 0;
    function row(r) {
      const star = h('button.icon-btn.idea-star', {
        type: 'button', class: r.starred ? 'on' : '', 'aria-label': r.starred ? 'Unstar' : 'Star',
        onclick: (e) => { e.stopPropagation(); toggleStar(ctx, r); },
      }, icon('star', 20));
      const meta = [];
      const chip = statusChip(r.status);
      if (chip) meta.push(chip);
      for (const t of r.tags.slice(0, 4)) meta.push(h('span.chip', '#' + t));
      meta.push(h('span.small.muted', dates.ago(r.date)));
      const details = snippet(r.text, 90);
      return listItem({
        leading: star,
        title: r.title || 'Untitled idea',
        sub: h('div', details ? h('div', details) : null, h('div.idea-meta', meta)),
        right: isActive(r)
          ? h('button.icon-btn', { type: 'button', 'aria-label': 'Mark done', onclick: (e) => { e.stopPropagation(); setStatus(ctx, r, 'done'); } }, icon('check', 20))
          : h('button.icon-btn', { type: 'button', 'aria-label': 'Reopen', onclick: (e) => { e.stopPropagation(); setStatus(ctx, r, 'new'); } }, icon('refresh', 18)),
        done: r.status === 'done',
        onClick: () => { if (Date.now() - lastLongPressAt < 700) return; openSheet(ctx, r).catch(console.error); },
        onLongPress: () => { lastLongPressAt = Date.now(); toggleStar(ctx, r); },
      });
    }

    function visible() {
      const q = query.trim().toLowerCase();
      let rows = ideas;
      if (filter === 'active') rows = rows.filter(isActive);
      else if (filter === 'starred') rows = rows.filter((r) => r.starred);
      else rows = rows.filter((r) => r.status === filter);
      if (q) rows = rows.filter((r) => `${r.title} ${r.text} ${r.tags.join(' ')} ${STATUS[r.status].label}`.toLowerCase().includes(q));
      // starred first within the filter, then newest
      return [...rows].sort((a, b) => (b.starred - a.starred) || (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
    }

    function drawCount() {
      clear(countEl);
      const active = ideas.filter(isActive).length, starred = ideas.filter((r) => r.starred).length, done = ideas.filter((r) => r.status === 'done').length;
      if (!ideas.length) return;
      countEl.append(h('span', h('b', String(active)), ' active'), h('span', h('b', String(starred)), ' starred'), h('span', h('b', String(done)), ' done'));
    }

    function draw() {
      drawCount();
      clear(listHolder);
      const rows = visible();
      const q = query.trim();
      search.classList.toggle('hidden', !ideas.length);
      if (!rows.length) {
        if (!ideas.length) listHolder.append(empty('No ideas yet', 'Type one in the box above and press Enter. Add #tags to group them. Star the ones worth chasing.', 'bulb'));
        else if (q) listHolder.append(empty('Nothing matches', 'Try another word or a tag.', 'search'));
        else if (filter === 'active') listHolder.append(empty('Inbox empty', 'Every idea is done or parked. Nice. Capture the next one above.', 'check'));
        else if (filter === 'starred') listHolder.append(empty('No starred ideas', 'Tap the star on an idea to keep it on top.', 'star'));
        else if (filter === 'parked') listHolder.append(empty('Nothing parked', 'Park ideas you are not ready for yet; they wait here.', 'bulb'));
        else listHolder.append(empty('Nothing done yet', 'Mark an idea done with the ✓ on its row.', 'check'));
        return;
      }
      const shown = showAll ? rows : rows.slice(0, PAGE);
      const c = card(h('div.list', shown.map(row)));
      if (rows.length > shown.length) c.append(h('button.btn.block.ghost', { type: 'button', onclick: () => { showAll = true; draw(); } }, `Show all ${rows.length}`));
      listHolder.append(c);
      if (filter === 'active' && rows.length) listHolder.append(h('p.small.muted', { style: { textAlign: 'center', margin: '10px 0 0' } }, 'Tap an idea to add details or park it · long-press to star'));
    }

    async function load() { ideas = await allIdeas(db); draw(); }
    await load();
    if (ctx.params?.add === '1') setTimeout(() => input.focus(), 150);

    return db.onChange(STORE, load);
  },

  quickActions: [{ label: 'Idea', icon: 'bulb', run: async (ctx) => ctx.nav('mind/ideas?add=1') }],

  async todayCard(ctx) {
    const rows = await allIdeas(ctx.db);
    const active = rows.filter(isActive);
    if (!rows.length) {
      return h('div.card.tappable', { onclick: () => ctx.nav('mind/ideas?add=1') },
        h('div.row', icon('bulb', 26), h('div.grow', h('h3', 'Got an idea?'), h('div.small.muted', 'Write it down before it fades')), icon('chevron')));
    }
    const starred = active.filter((r) => r.starred);
    const pick = starred[0] || active[0];
    return h('div.card.tappable', { onclick: () => ctx.nav('mind/ideas') },
      h('div.card-title', h('h3', 'Ideas'), h('span.link', 'Open')),
      h('div.chips.mb',
        h('span.chip.accent', `${active.length} active`),
        starred.length ? h('span.chip.warn', `★ ${starred.length}`) : null,
        h('span.chip', `${rows.length} total`)),
      pick
        ? h('p.small', { style: { margin: 0 } }, h('span.muted', starred.length ? 'Starred: ' : 'Latest: '), snippet(pick.title, 90))
        : h('p.small.muted', { style: { margin: 0 } }, 'Inbox is clear. Capture the next one.'));
  },

  async exportForAI(ctx, { since, days } = {}) {
    const today = dates.today();
    since = isDateKey(since) ? since : dates.addDays(today, -((days || 90) - 1));
    const all = await allIdeas(ctx.db);
    if (!all.length) return '';
    const recent = all.filter((r) => r.date >= since);
    const by = (s) => all.filter((r) => r.status === s).length;
    const lines = [`## Ideas (${all.length} total, ${recent.length} captured since ${since})`];
    lines.push(`- Status: ${by('new')} new, ${by('exploring')} exploring, ${by('done')} done, ${by('parked')} parked. Starred: ${all.filter((r) => r.starred).length}.`);
    const tagCount = {};
    for (const r of all) for (const t of r.tags) tagCount[t] = (tagCount[t] || 0) + 1;
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (topTags.length) lines.push('- Top tags: ' + topTags.map(([t, c]) => `${t} (${c})`).join(', '));
    // "untouched" = not edited, starred or re-statused (updatedAt), not merely captured long ago
    const touched = (r) => (r.updatedAt ? dates.key(new Date(r.updatedAt)) : r.date);
    const stale = all.filter((r) => isActive(r) && dates.daysBetween(touched(r), today) >= 30);
    if (stale.length) lines.push(`- ${stale.length} active idea(s) untouched for 30+ days — candidates to start, park or drop.`);

    const headerLen = lines.length; // everything after this may be trimmed by the size cap (starred lines go last)
    const line = (r) => `- [${STATUS[r.status].label}${r.starred ? ', ★' : ''}] ${r.date} ${snippet(r.title, 150)}${r.tags.length ? ' [' + r.tags.join(', ') + ']' : ''}${r.text.trim() ? ' — ' + snippet(r.text, 200) : ''}`;
    const starred = all.filter((r) => r.starred && isActive(r));
    if (starred.length) { lines.push('', '### Starred (most important to the user)'); for (const r of starred.slice(0, 10)) lines.push(line(r)); }
    const active = all.filter((r) => isActive(r) && !r.starred);
    if (active.length) { lines.push('', '### Active ideas (newest first)'); for (const r of active.slice(0, 40)) lines.push(line(r)); }
    const parked = all.filter((r) => r.status === 'parked');
    if (parked.length) { lines.push('', '### Parked'); for (const r of parked.slice(0, 15)) lines.push(line(r)); }
    const done = all.filter((r) => r.status === 'done');
    if (done.length) { lines.push('', '### Done'); for (const r of done.slice(0, 10)) lines.push(line(r)); }
    let truncated = false;
    while (lines.length > headerLen && lines.join('\n').length > 7000) { lines.pop(); truncated = true; }
    if (truncated) lines.push('…(older ideas omitted)');
    return lines.join('\n');
  },
};
