// ai.js — AI Coach: chats with Claude about everything the user tracks in LifeOS.
// The whole life report (every module's exportForAI) is prepended to the first user turn.
import { h, clear, dates, fmt, icon, toast, sheet, confirm, segmented, empty, card, resizeImage, copyText, shareText } from '../ui.js';
import { blobToBase64 } from '../db.js';
import { buildLifeReport } from '../report.js';

const STORE = 'aiChats';
const DEFAULT_MODEL = 'claude-opus-5-5';
const MODELS = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best (default)', short: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — faster, cheaper', short: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — cheapest', short: 'Haiku 5.5' },
];
const EFFORTS = ['low', 'medium', 'high'];
const DAYS = [30, 90, 365];
// Chips: plain strings are sent as-is; { prefill } puts a starter into the input so the user finishes the sentence.
const SUGGESTIONS = [
  'Daily brief', { label: 'Add a task…', prefill: 'Add a task: ' }, { label: 'Log weight…', prefill: 'Log my weight: ' },
  { label: 'Add an event…', prefill: 'Add to my calendar: ' }, 'Plan my week', 'Weekly review', 'Where is my money going?',
  'Am I on track with my goals?', 'Patterns in my dreams', 'Fitness & weight trend',
];
const PHYSIQUE_CHIP = 'Physique feedback';
const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk';
const MAX_TOOL_ROUNDS = 6;
const MAX_TOKENS = 32000; // thinking and text share this cap; streaming is already in use, so a large value is safe
/** Writes that cannot be undone are confirmed even when "apply without asking" is on. Modules may set `destructive: true`. */
const isDestructive = (p) => p.entry.action.destructive === true || /^(delete|clear_day)$/.test(p.entry.action.name);

const SYSTEM_BASE = [
  "You are the user's personal life coach and assistant inside their private LifeOS app.",
  'You have their full self-tracked data (weight, progress photos, dreams, notes, tasks, goals, habits, calendar, money, ideas) in <life_report>.',
  'Be concrete and specific — quote their actual numbers, dates and entries. Find patterns across domains (sleep/dreams vs mood, spending vs mood, habits vs weight).',
  'Give 2-4 prioritized, actionable suggestions, not generic advice. Be warm but direct.',
  'Use short headers and bullets. Keep it under ~300 words unless the user asks for a detailed review.',
  'For physique photos give honest, encouraging feedback about visible changes and training focus — never medical diagnoses.',
  'You can also change their data with the tools: add, complete, update or delete tasks, events, habits, weights, notes, dreams, goals, money entries and ideas.',
  'When the user asks you to do something, do it with tools instead of describing how. Use a read tool first when you need an id or are unsure which record they mean; the life report only shows summaries.',
  'Resolve relative dates ("tomorrow", "next Friday", "7pm") yourself from today\'s date in the report. After acting, reply with a one-line summary of what changed; do not repeat the tool output.',
  "Today's date is given in the report. Finish with at most one question.",
].join(' ');
const CONFIRM_ON = 'Write tools are shown to the user for approval in the app before they run, so do not ask for permission in text — just call the tool. If a request is genuinely ambiguous (which task? which day?), ask one short question instead.';
const CONFIRM_OFF = 'Adds and edits run immediately without confirmation, so be careful: only change what was clearly asked for, and when a request is ambiguous (which task? which day?) ask one short question instead of guessing. Deletes are still shown to the user for approval.';
const systemFor = (autoApply) => `${SYSTEM_BASE} ${autoApply ? CONFIRM_OFF : CONFIRM_ON}`;

// ---------- settings ----------
function cfg(settings) {
  const model = settings.get('ai:model') || DEFAULT_MODEL;
  const days = Number(settings.get('ai:days')) || 90;
  const effort = settings.get('ai:effort') || 'medium';
  return {
    apiKey: String(settings.get('ai:apiKey') || '').trim(),
    model: MODELS.some((m) => m.value === model) ? model : DEFAULT_MODEL,
    days: DAYS.includes(days) ? days : 90,
    effort: EFFORTS.includes(effort) ? effort : 'medium',
    includePhotos: !!settings.get('ai:includePhotos', false),
    autoApply: !!settings.get('ai:autoApply', false),
  };
}

// ---------- actions → tools ----------
/** Every module's `actions` become Claude tools named '<moduleId>_<action>'. Returns { tools, byName }. */
function buildTools(ctx) {
  const tools = [], byName = new Map();
  for (const m of ctx.modules || []) {
    for (const a of m.actions || []) {
      if (!a?.name || typeof a.run !== 'function') continue;
      const name = `${m.id}_${a.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
      if (byName.has(name)) { console.warn('duplicate action', name); continue; }
      byName.set(name, { module: m, action: a });
      tools.push({ name, description: String(a.description || `${a.name} in ${m.title}`), input_schema: { type: 'object', properties: a.params || {}, required: Array.isArray(a.required) ? a.required : [] } });
    }
  }
  return { tools, byName };
}
/** Human line for a write action. preview(args, ctx) may be async (e.g. look up a record's title by id). */
async function previewOf(ctx, entry, args) {
  const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
  try { const p = await entry.action.preview?.(args, ctx); if (p) return oneLine(p); } catch (e) { console.warn('preview failed', entry.module.id, entry.action.name, e); }
  const vals = Object.entries(args || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
  return oneLine(`${entry.module.title}: ${entry.action.name.replace(/_/g, ' ')}${vals ? ' — ' + vals : ''}`);
}
/** Change log ('actions' record, one preview per line) → plain-text list. Not markdown: previews quote user titles that may contain _ * ` or #. */
const logEl = (text) => h('ul.ai-log', String(text ?? '').split('\n').filter(Boolean).map((l) => h('li', l)));
async function runAction(ctx, entry, args) {
  const out = await entry.action.run(ctx, args || {});
  const text = out == null ? 'Done' : typeof out === 'string' ? out : JSON.stringify(out);
  return text.length > 4000 ? text.slice(0, 4000) + '…' : text;
}

/**
 * Confirmation card for write actions. Resolves with a Set of the tool_use ids the user approved (empty = skipped all),
 * or null when the request was stopped. The card is replaced by the caller once the results are in.
 */
function confirmActions(chat, items, signal) {
  return new Promise((resolve) => {
    const boxes = new Map();
    const anyDanger = items.some((it) => it.destructive);
    const applyLabel = h('span', 'Apply');
    const applyBtn = h('button.btn.primary.grow', { type: 'button', onclick: () => finish(new Set(items.filter((it) => boxes.get(it.id).checked).map((it) => it.id))) }, icon('check', 18), applyLabel);
    if (anyDanger) applyBtn.classList.add('danger');
    const relabel = () => {
      const n = items.filter((it) => boxes.get(it.id).checked).length;
      applyBtn.disabled = n === 0;
      applyLabel.textContent = n === items.length ? (anyDanger ? 'Apply (includes delete)' : 'Apply') : `Apply ${n} of ${items.length}`;
    };
    const rows = items.map((it) => {
      const cb = h('input', { type: 'checkbox', onchange: relabel }); cb.checked = true; boxes.set(it.id, cb);
      return h('label.ai-action-row', { class: it.destructive ? 'danger' : '' }, cb,
        h('span.grow', it.preview, it.destructive ? h('span.small.muted', ' · permanent') : null));
    });
    relabel();
    let done = false;
    const finish = (val) => { if (done) return; done = true; signal?.removeEventListener('abort', onAbort); card.remove(); resolve(val); };
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort);
    const card = h('div.msg.ai.ai-confirm',
      h('div.ai-confirm-title', icon('edit', 18), items.length === 1 ? 'The assistant wants to make this change' : `The assistant wants to make ${items.length} changes`),
      h('div.stack', rows),
      h('div.row', { style: { gap: '8px', marginTop: '10px' } },
        applyBtn,
        h('button.btn.grow', { type: 'button', onclick: () => finish(new Set()) }, 'Skip')));
    chat.append(card);
    scrollBottom({ force: true, smooth: false }); // jump, don't animate content under a finger
  });
}
const modelShort = (id) => MODELS.find((m) => m.value === id)?.short || id;

// ---------- minimal safe markdown ----------
function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
}
function md(src) {
  const lines = fmt.escape(src || '').split('\n');
  let html = '', list = null, para = [];
  const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); html += '<div class="divider"></div>'; continue; }
    if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) { flushPara(); closeList(); const lvl = Math.min(3, m[1].length); html += `<h${lvl}>${inline(m[2])}</h${lvl}>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>'; } html += `<li>${inline(m[1])}</li>`; continue; }
    closeList(); para.push(line.trim());
  }
  flushPara(); closeList();
  return html;
}

// ---------- helpers ----------
let sdkPromise = null;
function loadSDK() {
  if (window.__ANTHROPIC_SDK_OVERRIDE) return Promise.resolve(window.__ANTHROPIC_SDK_OVERRIDE); // test hook: a fake client class
  if (!sdkPromise) {
    sdkPromise = import(/* webpackIgnore: true */ SDK_URL).then((m) => m.default || m.Anthropic).catch((e) => { sdkPromise = null; throw Object.assign(new Error('Could not load the AI library (needs internet)'), { isImportError: true, cause: e }); });
  }
  return sdkPromise;
}

async function photoCount(ctx) {
  try { if (!ctx.db.schema?.photos) return 0; return await ctx.db.count('photos'); } catch { return 0; }
}

/** Oldest, middle and newest progress photo as API content blocks. */
async function photoBlocks(ctx) {
  const blocks = [];
  try {
    if (!ctx.db.schema?.photos) return blocks;
    const all = (await ctx.db.all('photos', { index: 'date' })).filter((p) => p && (p.blob instanceof Blob || p.image instanceof Blob));
    if (!all.length) return blocks;
    const idx = [...new Set([0, Math.floor((all.length - 1) / 2), all.length - 1])];
    for (const i of idx) {
      const p = all[i];
      const blob = p.blob instanceof Blob ? p.blob : p.image;
      try {
        const small = await resizeImage(blob, 800, 0.8);
        const data = await blobToBase64(small);
        const when = p.date ? dates.label(p.date, { year: true }) + ` (${p.date})` : 'unknown date';
        blocks.push({ type: 'text', text: `Progress photo from ${when}` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
      } catch (e) { console.warn('photo skipped', e); }
    }
  } catch (e) { console.warn('photos unavailable', e); }
  return blocks;
}

/** history: chronological [{role,text}] ending with the new user message. */
function buildMessages(history, report, imageBlocks) {
  const recent = history
    .map((m) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', text: String(m?.text ?? '').trim() }))
    .filter((m) => m.text)
    .slice(-20);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  const merged = [];
  for (const m of recent) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.text += '\n\n' + m.text; else merged.push({ ...m });
  }
  if (!merged.length || merged[merged.length - 1].role !== 'user') return null;
  return merged.map((m, i) => i === 0
    ? { role: 'user', content: [{ type: 'text', text: '<life_report>\n' + report + '\n</life_report>', cache_control: { type: 'ephemeral' } }, ...imageBlocks, { type: 'text', text: m.text }] }
    : { role: m.role, content: m.text });
}

/** Drop the per-second "Generated …" stamp so the cached <life_report> prefix is byte-stable between sends. */
function stableReport(report) {
  return String(report || '').replace(/^Generated [^\n]*?\. (?=Covers )/m, '');
}

function describeError(e) {
  if (!e) return 'Something went wrong';
  if (e.isImportError) return e.message;
  const s = e.status ?? e.response?.status;
  if (s === 401 || s === 403) return 'Invalid API key — check Settings';
  if (s === 429) return 'Rate limited — wait a minute';
  if (s === 400) return 'Request rejected: ' + (e.error?.error?.message || e.message || 'bad request');
  if (s === 529 || s === 503) return 'The AI is overloaded — try again in a moment';
  if (e.name === 'APIConnectionError' || /Failed to fetch|NetworkError|Load failed|network/i.test(e.message || '') || navigator.onLine === false) return 'No connection';
  return e.message || 'Something went wrong';
}
const isAbort = (e) => e && (e.name === 'AbortError' || e.name === 'APIUserAbortError' || /abort/i.test(e.message || ''));

let scrollRaf = 0, scrollForce = false, scrollSmooth = true;
/** Scroll to the bottom at most once per frame; coalesced calls keep the strongest flags (any force wins, any non-smooth wins).
 *  Without force, only when the user is already near the bottom. */
function scrollBottom({ force = false, smooth = true } = {}) {
  scrollForce = scrollForce || force;
  scrollSmooth = scrollSmooth && smooth;
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const doForce = scrollForce, doSmooth = scrollSmooth;
    scrollForce = false; scrollSmooth = true;
    const el = document.documentElement;
    const gap = el.scrollHeight - window.scrollY - window.innerHeight;
    if (!doForce && gap > 160) return;
    window.scrollTo({ top: el.scrollHeight, behavior: doSmooth ? 'smooth' : 'auto' });
  });
}

function moduleStyle() {
  return h('style', `
    .ai-dock{position:fixed;left:0;right:0;bottom:calc(var(--nav-h) + var(--safe-b));z-index:24;background:var(--bg-elev);border-top:1px solid var(--border)}
    .ai-dock .suggestions{padding:8px 12px 0}
    .ai-dock .chat-input-bar{position:static;border-top:0;background:transparent}
    .ai-dock .chat-input-bar textarea{overflow-y:auto}
    .ai-dock .chat-input-bar .icon-btn:disabled{opacity:.4;pointer-events:none}
    .ai-dock .suggestions .chip{min-height:42px}
    .ai-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:4px 0 10px}
    .ai-head .btns{display:flex;gap:6px}
    .ai-keyrow{display:flex;gap:8px;align-items:stretch}
    .ai-keyrow .input{flex:1;min-width:0}
    .ai-keyrow .icon-btn{width:48px;height:48px;border-radius:12px;background:var(--card-2);border:1px solid var(--border)}
    .ai-setup li{margin-bottom:4px}
    .ai-setup ul{padding-left:20px;margin:0 0 8px}
    .ai-confirm{align-self:stretch;max-width:100%;border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
    .ai-confirm-title{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:8px;color:var(--accent)}
    .ai-action-row{display:flex;align-items:flex-start;gap:10px;min-height:44px;padding:10px 0;border-top:1px solid var(--border);font-size:14px;line-height:1.4;cursor:pointer}
    .ai-action-row input{width:24px;height:24px;margin:-2px 0 0;accent-color:var(--accent);flex:0 0 auto}
    .ai-action-row.danger .grow{color:var(--bad)}
    .ai-action-row.danger input{accent-color:var(--bad)}
    .ai-actions{align-self:stretch;max-width:100%;background:var(--card-2);font-size:13px}
    .ai-actions .ai-log{margin:0;padding-left:18px;display:grid;gap:4px}
    @media (min-width:720px){.ai-dock{max-width:640px;margin:0 auto}}
  `);
}

// ---------- screens ----------
function renderSetup(container, ctx, params) {
  const c = cfg(ctx.settings);
  const keyInput = h('input.input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const eye = h('button.icon-btn', { type: 'button', 'aria-label': 'Show key', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, icon('eye', 20));
  const save = () => {
    const k = keyInput.value.trim();
    if (!k) { toast('Paste your API key first'); keyInput.focus(); return; }
    ctx.settings.set('ai:apiKey', k); // settings:change → remount() in render()
    toast('Key saved — ask away');
  };
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

  container.append(
    card(
      h('div.row', { style: { marginBottom: '8px' } }, h('span.accent', icon('ai', 28)), h('h3', { style: { margin: 0 } }, 'Your personal life coach')),
      h('p.muted', 'The coach reads your weight, photos, dreams, notes, tasks, goals, habits, calendar, money and ideas — then gives concrete, personal suggestions. It can also make changes for you: "add a task for tomorrow", "log 82.4 kg", "park the podcast idea". Every change is shown for your OK first.'),
      h('div.ai-setup',
        h('h4', { style: { marginTop: '12px' } }, 'Privacy'),
        h('ul.small.muted',
          h('li', 'Your key and all your data stay on this phone.'),
          h('li', "Data is sent only to Anthropic's API, and only when you ask a question."),
          h('li', `You choose how much history goes along (currently the last ${c.days} days).`)),
        h('h4', 'How to get a key'),
        h('ul.small.muted',
          h('li', 'Go to console.anthropic.com → API keys → Create key.'),
          h('li', 'Pay-as-you-go: a typical question costs a few cents.'),
          h('li', 'Paste the key below. You can change it any time in Settings.'))),
      h('div.ai-keyrow.mt', keyInput, eye),
      h('button.btn.primary.block.mt', { onclick: save }, icon('key', 20), 'Save key & start')),
    card(
      h('h3', 'No key?'),
      h('p.muted.small', 'Copy your life report and paste it into any AI app (ChatGPT, Gemini, Claude.ai…). Same data, same questions.'),
      h('div.stack',
        h('button.btn.block', { onclick: async () => { toast('Building your report…'); try { await shareText('My life report', await buildLifeReport(ctx, { days: c.days })); } catch (e) { toast('Could not build report: ' + (e?.message || e)); } } }, icon('share', 20), 'Copy your life report'),
        h('button.btn.ghost.block', { onclick: () => previewReport(ctx, c.days) }, icon('eye', 20), 'Preview what the AI sees'))));

  if (params?.add === '1') setTimeout(() => keyInput.focus(), 300);
}

async function previewReport(ctx, days) {
  const body = h('div', h('p.muted', 'Building report…'));
  const s = sheet({ title: `What the AI sees (last ${days} days)`, full: true, content: body });
  try {
    const report = await buildLifeReport(ctx, { days });
    clear(body);
    body.append(
      h('p.small.muted', `${fmt.num(report.length, 0)} characters. This Markdown is sent as context with every question.`),
      h('div.row.mb',
        h('button.btn.sm', { onclick: () => copyText(report) }, icon('copy', 16), 'Copy'),
        h('button.btn.sm', { onclick: () => shareText('My life report', report) }, icon('share', 16), 'Share')),
      h('pre.code', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, report));
  } catch (e) { clear(body); body.append(empty('Could not build the report', String(e?.message || e))); }
  return s;
}

async function renderChat(container, ctx, state, params, alive = () => true) {
  const c = cfg(ctx.settings);
  const hasPhotos = (await photoCount(ctx)) > 0;
  if (!alive()) return; // a newer remount took over while we were waiting

  // header row
  const refreshBtn = h('button.btn.sm', { onclick: async () => { toast('Refreshing data…'); try { const r = await buildLifeReport(ctx, { days: c.days }); toast(`Data refreshed — ${fmt.num(r.length, 0)} characters ready`, { action: 'Preview', onAction: () => previewReport(ctx, c.days) }); } catch (e) { toast('Refresh failed: ' + (e?.message || e)); } } }, icon('refresh', 16), 'Refresh data');
  const clearBtn = h('button.btn.sm', { onclick: async () => { if (state.busy) return; if (!(await confirm('Delete the whole conversation with your coach? Your tracked data is not affected.', { okLabel: 'Clear chat' }))) return; await ctx.db.clear(STORE); toast('Chat cleared'); } }, icon('trash', 16), 'Clear chat');
  const head = h('div.ai-head',
    h('div.small.muted', `Context: last ${c.days} days · ${modelShort(c.model)} · ${c.effort} effort`),
    h('div.btns', refreshBtn, clearBtn));
  const chat = h('div.chat');
  container.append(head, chat);

  // dock: suggestions + input
  const ta = h('textarea.input', { rows: 1, placeholder: 'Ask your coach…', 'aria-label': 'Message' });
  const sendBtn = h('button.icon-btn', { 'aria-label': 'Send', onclick: () => send(ta.value) }, icon('send', 22));
  const stopBtn = h('button.btn.sm.danger', { style: { display: 'none', minHeight: '46px' }, onclick: () => { state.ctl?.abort(); state.stream?.abort?.(); } }, 'Stop');
  const chips = h('div.suggestions');
  const chipList = hasPhotos ? [...SUGGESTIONS, PHYSIQUE_CHIP] : SUGGESTIONS;
  for (const s of chipList) {
    const label = typeof s === 'string' ? s : s.label;
    const onclick = typeof s === 'string'
      ? () => send(label, { physique: label === PHYSIQUE_CHIP })
      : () => { if (state.busy) return; ta.value = s.prefill; autoGrow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); };
    chips.append(h('button.chip.accent', { type: 'button', onclick }, label));
  }
  const dock = h('div.ai-dock', chips, h('div.chat-input-bar', ta, stopBtn, sendBtn));
  container.append(dock);
  const fitDock = () => { container.style.paddingBottom = (dock.offsetHeight + 8) + 'px'; };
  const autoGrow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, Math.max(46, ta.scrollHeight)) + 'px'; fitDock(); };
  ta.addEventListener('input', autoGrow);
  const desktop = window.matchMedia('(pointer: fine)').matches && !('ontouchstart' in window);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && desktop && !e.isComposing) { e.preventDefault(); send(ta.value); } });
  requestAnimationFrame(fitDock);

  const setBusy = (busy) => {
    state.busy = busy;
    sendBtn.disabled = busy;
    refreshBtn.disabled = busy;
    clearBtn.disabled = busy;
    stopBtn.style.display = busy ? '' : 'none';
    chips.querySelectorAll('button').forEach((b) => { b.disabled = busy; b.style.opacity = busy ? '.5' : ''; });
  };

  // history
  const bubble = (m) => m.role === 'user'
    ? h('div.msg.user', String(m.text ?? ''))
    : m.kind === 'actions'
      ? h('div.msg.ai.ai-actions', logEl(m.text))
      : h('div.msg.ai', { html: md(String(m.text ?? '')) });
  const draw = async () => {
    if (state.busy) return; // live bubbles are on screen; redraw when the reply is saved
    let rows = [];
    try { rows = await ctx.db.all(STORE, { index: 'ts' }); } catch (e) { console.error(e); }
    if (state.busy) return; // a send() started during the read owns the chat now; its finally will redraw
    clear(chat); // clear only after the read, so the chat is never emptied while a send can slip in
    rows = rows.filter((r) => r && r.text != null).slice(-50);
    if (!rows.length) {
      chat.append(empty('Ask your coach anything', 'Tap a suggestion below or type a question. It reads everything you log in LifeOS and answers with your real numbers.', 'ai'));
      return;
    }
    let lastDate = null;
    for (const r of rows) {
      if (r.date && r.date !== lastDate) { chat.append(h('div.pill-date', { style: { textAlign: 'center' } }, dates.label(r.date))); lastDate = r.date; }
      chat.append(bubble(r));
    }
    scrollBottom({ force: true });
  };
  await draw();
  if (!alive()) return;
  state.off = ctx.db.onChange(STORE, draw);

  // ---- sending ----
  async function send(text, { physique = false } = {}) {
    text = String(text || '').trim();
    if (!text || state.busy) return;
    const current = cfg(ctx.settings);
    if (!current.apiKey) { toast('Add your API key first'); return; }
    setBusy(true);
    ta.value = ''; autoGrow();
    chat.querySelector('.empty')?.remove();
    chat.querySelectorAll('.ai-notice').forEach((n) => n.remove());

    const userBubble = h('div.msg.user', text);
    const aiBubble = h('div.msg.ai.typing');
    chat.append(userBubble, aiBubble);
    scrollBottom({ force: true });

    let acc = '';   // text streamed in the current round
    let base = '';  // text of the finished rounds (hoisted so the abort path can save it too)
    let aborted = false;
    let notice = null; // error / refusal notice; re-appended after draw() clears the chat
    // Human lines about what was done. Persisted after every round (same record re-put), so changes that already ran
    // leave a trace even if the follow-up request fails or the user presses Stop.
    const log = [];
    let logRec = null;
    const saveLog = async () => {
      if (!log.length) return;
      try { logRec = await ctx.db.put(STORE, { ...(logRec || { date: dates.today(), role: 'assistant', kind: 'actions', ts: Date.now() }), text: log.join('\n') }); }
      catch (e) { console.warn('could not save the change log', e); }
    };
    state.stream = null;
    // Stop works before the SDK stream exists too: the controller covers the report build, SDK import and photo encoding.
    const ctl = new AbortController();
    state.ctl = ctl;
    const checkAbort = () => { if (ctl.signal.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' }); };
    try {
      // db.put returns the saved copy (with id) — the passed object is not mutated.
      const userRec = await ctx.db.put(STORE, { date: dates.today(), role: 'user', text, ts: Date.now() });
      checkAbort();

      const [rawReport, Anthropic] = await Promise.all([buildLifeReport(ctx, { days: current.days }), loadSDK()]);
      checkAbort();
      const report = stableReport(rawReport);
      const images = (current.includePhotos || physique) ? await photoBlocks(ctx) : [];
      checkAbort();
      let history = [];
      try { history = await ctx.db.all(STORE, { index: 'ts' }); } catch { history = [userRec]; }
      checkAbort();
      const messages = buildMessages(history, report, images);
      if (!messages) throw new Error('Could not build the conversation');

      const client = new Anthropic({ apiKey: current.apiKey, dangerouslyAllowBrowser: true });
      const { tools, byName } = buildTools(ctx);
      const system = systemFor(current.autoApply);
      // Text from every round streams into one bubble.
      const attach = (stream) => {
        state.stream = stream;
        stream.on('text', (delta) => { acc += delta; aiBubble.classList.remove('typing'); aiBubble.style.display = ''; aiBubble.innerHTML = md(base + acc); scrollBottom({ smooth: false }); });
      };
      const reqOpts = { signal: ctl.signal };
      // After a mid-output server-side fallback, the blocks before the last `fallback` marker are a discarded partial:
      // keep its text, drop its thinking/tool_use (they are neither run nor echoed). The non-beta endpoint has no
      // `fallback` block type, so the markers are stripped when the beta path is abandoned.
      const echoable = (content) => { const i = content.map((b) => b.type).lastIndexOf('fallback'); return i < 0 ? content : content.filter((b, k) => k > i || b.type === 'text' || b.type === 'fallback'); };
      const stripFallback = (msgs) => msgs.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => b.type !== 'fallback') } : m));
      const start = (beta, msgs) => beta
        ? client.beta.messages.stream({ model: current.model, max_tokens: MAX_TOKENS, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: current.effort }, system, tools, messages: msgs }, reqOpts)
        : client.messages.stream({ model: current.model, max_tokens: MAX_TOKENS, output_config: { effort: current.effort }, system, tools, messages: stripFallback(msgs) }, reqOpts);
      let useBeta = true;
      const ask = async (msgs) => {
        acc = '';
        attach(start(useBeta, msgs));
        try {
          return await state.stream.finalMessage();
        } catch (e) {
          if (e?.status === 400 && useBeta && !isAbort(e)) {
            useBeta = false; acc = ''; aiBubble.classList.add('typing'); aiBubble.innerHTML = md(base);
            attach(start(false, msgs));
            return await state.stream.finalMessage();
          }
          throw e;
        }
      };

      // ---- tool loop: the model may call module actions; writes are confirmed by the user first ----
      let convo = messages;
      let final = await ask(convo);
      for (let round = 0; round < MAX_TOOL_ROUNDS && final?.stop_reason === 'tool_use'; round++) {
        const kept = echoable(final.content || []);
        const uses = kept.filter((b) => b.type === 'tool_use');
        if (!uses.length) break;
        base += acc + (acc.trim() ? '\n\n' : '');
        acc = ''; // folded into base — otherwise an abort before the next ask() would save this round twice
        aiBubble.innerHTML = md(base);
        const planned = uses.map((u) => ({ id: u.id, name: u.name, input: u.input || {}, entry: byName.get(u.name), preview: '' }));
        const writes = planned.filter((p) => p.entry?.action.write);
        for (const p of writes) { p.preview = await previewOf(ctx, p.entry, p.input); checkAbort(); }
        // "Apply without asking" skips the card for adds and edits only; anything irreversible is always confirmed.
        const toConfirm = current.autoApply ? writes.filter(isDestructive) : writes;
        const approved = new Set(writes.filter((p) => !toConfirm.includes(p)).map((p) => p.id));
        if (toConfirm.length) {
          // Waiting on the user, not the model: no blinking dots above the card, and Stop reads as Cancel.
          aiBubble.classList.remove('typing');
          if (!base.trim()) aiBubble.style.display = 'none';
          stopBtn.textContent = 'Cancel';
          let picked = null;
          try { picked = await confirmActions(chat, toConfirm.map((p) => ({ id: p.id, preview: p.preview, destructive: isDestructive(p) })), ctl.signal); }
          finally { stopBtn.textContent = 'Stop'; aiBubble.style.display = ''; }
          checkAbort();
          for (const id of picked || []) approved.add(id);
        }
        const results = [];
        for (const p of planned) {
          checkAbort();
          let content, isError = false;
          if (!p.entry) { content = `Unknown tool ${p.name}`; isError = true; }
          else if (p.entry.action.write && !approved.has(p.id)) { content = 'The user declined this change. Do not retry it; ask if they want something else.'; log.push('✗ Skipped: ' + p.preview); }
          else {
            try { content = await runAction(ctx, p.entry, p.input); if (p.entry.action.write) log.push('✓ ' + p.preview); }
            catch (e) { console.error('action failed', p.name, e); content = `Error: ${e?.message || e}`; isError = true; if (p.entry.action.write) log.push('⚠ Failed: ' + p.preview + ' — ' + (e?.message || e)); }
          }
          results.push({ type: 'tool_result', tool_use_id: p.id, content, is_error: isError || undefined });
        }
        if (log.length) {
          const seen = aiBubble.previousElementSibling?.classList?.contains('ai-actions-live') ? aiBubble.previousElementSibling : null;
          const liveLog = seen || h('div.msg.ai.ai-actions.ai-actions-live');
          liveLog.replaceChildren(logEl(log.join('\n')));
          if (!seen) chat.insertBefore(liveLog, aiBubble);
          await saveLog();
        }
        aiBubble.classList.add('typing');
        convo = [...convo, { role: 'assistant', content: kept }, { role: 'user', content: results }];
        final = await ask(convo);
      }

      // Round cap hit while the model still wanted tools: those calls were never run — say so instead of saving
      // "Adding those now…" as if it happened.
      const leftover = final?.stop_reason === 'tool_use' ? echoable(final.content || []).filter((b) => b.type === 'tool_use') : [];
      if (leftover.length) log.push(`⚠ Stopped after ${MAX_TOOL_ROUNDS} rounds of changes; ${leftover.length} proposed call${leftover.length === 1 ? '' : 's'} not applied. Ask again to continue.`);
      const refused = final?.stop_reason === 'refusal';      // mid-stream refusal: the API says to discard the partial
      const truncated = final?.stop_reason === 'max_tokens'; // thinking + text hit the cap; any tool_use in it is incomplete and was not run
      const roundText = refused ? '' : ((final?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || acc);
      const answer = (base + roundText).trim();
      aiBubble.classList.remove('typing');
      aiBubble.style.display = '';
      aiBubble.innerHTML = md(answer);
      if (refused) { notice = h('div.small.muted.ai-notice', { style: { textAlign: 'center' } }, 'The model declined to answer this one.'); chat.append(notice); }
      else if (truncated) {
        const dropped = (final.content || []).some((b) => b.type === 'tool_use');
        notice = h('div.small.muted.ai-notice', { style: { textAlign: 'center' } }, dropped
          ? 'The answer was cut off before the assistant could finish its changes — nothing from that step was applied. Try again or lower the effort in Settings.'
          : 'The answer was cut off (too long). Try again or lower the effort in Settings.');
        chat.append(notice);
      }
      await saveLog();
      if (answer) await ctx.db.put(STORE, { date: dates.today(), role: 'assistant', text: truncated ? answer + '\n\n_(cut off)_' : answer, ts: Date.now() });
      else if (!refused && !truncated) aiBubble.remove();
    } catch (e) {
      aborted = isAbort(e);
      aiBubble.classList.remove('typing');
      aiBubble.style.display = '';
      await saveLog(); // changes that already ran must leave a trace even when the next round was stopped or failed
      if (aborted) {
        const partial = (base + acc).trim();
        if (partial) { aiBubble.innerHTML = md(partial); try { await ctx.db.put(STORE, { date: dates.today(), role: 'assistant', text: partial, ts: Date.now() }); } catch {} }
        else aiBubble.remove();
        if (alive()) toast('Stopped'); // the screen may have been torn down (navigation / remount): nothing to announce there
      } else {
        console.error(e);
        aiBubble.remove();
        const msg = describeError(e);
        notice = h('div.notice.ai-notice', { style: { alignSelf: 'stretch' } }, msg, (e?.status === 401 || e?.status === 403) ? h('button.btn.sm', { style: { marginLeft: '8px' }, onclick: () => ctx.nav('settings') }, 'Open Settings') : null);
        if (alive()) { chat.append(notice); toast(msg); }
      }
    } finally {
      state.stream = null;
      state.ctl = null;
      stopBtn.textContent = 'Stop';
      setBusy(false);
      if (alive()) {
        await draw(); // clears the chat and redraws DB rows…
        if (notice) { chat.append(notice); scrollBottom({ force: true }); } // …so put the notice back afterwards
      }
    }
  }

  if (params?.add === '1') setTimeout(() => ta.focus(), 300);
  if (params?.q) { const q = String(params.q); setTimeout(() => send(q), 200); }
}

// ---------- module ----------
export default {
  id: 'ai',
  title: 'AI Coach',
  subtitle: 'Reads everything, gives tips, makes changes',
  icon: 'ai',
  tab: null,
  stores: { [STORE]: { indexes: ['date', 'ts'] } },
  quickActions: [], // the Today screen already has the AI Coach card; a 9th quick tile would break the 4-column grid
  todayCard: null,

  async render(container, ctx) {
    const state = { busy: false, stream: null, ctl: null, off: null };
    const style = moduleStyle();
    container.append(style);
    let disposed = false;
    let gen = 0; // bumped on every remount so a superseded async renderChat bails out instead of double-mounting
    const remount = async () => {
      if (disposed) return;
      const my = ++gen;
      const alive = () => !disposed && my === gen;
      state.off?.(); state.off = null;
      clear(container);
      container.style.paddingBottom = '';
      container.append(style);
      const c = cfg(ctx.settings);
      if (!c.apiKey) renderSetup(container, ctx, ctx.params);
      else await renderChat(container, ctx, state, ctx.params, alive);
    };
    await remount();
    const onSettings = (e) => { if (e.detail?.key === 'ai:apiKey' && !state.busy) remount(); };
    window.addEventListener('settings:change', onSettings);
    return () => {
      disposed = true;
      window.removeEventListener('settings:change', onSettings);
      state.off?.();
      try { state.ctl?.abort(); state.stream?.abort?.(); } catch {}
      container.style.paddingBottom = '';
    };
  },

  async settings(ctx) {
    const c = cfg(ctx.settings);
    const wrap = h('div.stack');

    // API key
    const keyInput = h('input.input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
    keyInput.value = c.apiKey;
    const eye = h('button.icon-btn', { type: 'button', 'aria-label': 'Show key', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, icon('eye', 20));
    const status = h('div.small.muted', c.apiKey ? `Key saved (…${c.apiKey.slice(-4)})` : 'No key yet — get one at console.anthropic.com');
    wrap.append(
      h('div.field', h('span.field-label', 'Anthropic API key'),
        h('div.ai-keyrow', keyInput, eye),
        status,
        h('div.row.mt',
          h('button.btn.sm.primary', { onclick: () => { const k = keyInput.value.trim(); if (!k) { toast('Paste a key first'); return; } ctx.settings.set('ai:apiKey', k); status.textContent = `Key saved (…${k.slice(-4)})`; toast('API key saved'); } }, 'Save'),
          h('button.btn.sm.danger', { onclick: async () => { if (!(await confirm('Remove the API key from this phone? Your chat history stays.', { okLabel: 'Remove key' }))) return; ctx.settings.set('ai:apiKey', ''); keyInput.value = ''; status.textContent = 'No key yet'; toast('Key removed'); } }, 'Remove'))));

    // model
    const sel = h('select.input');
    for (const m of MODELS) sel.append(h('option', { value: m.value }, m.label));
    sel.value = c.model;
    sel.addEventListener('change', () => { ctx.settings.set('ai:model', sel.value); toast('Model: ' + modelShort(sel.value)); });
    wrap.append(h('label.field', h('span.field-label', 'Model'), sel));

    // effort
    wrap.append(h('div.field', h('span.field-label', 'Effort (thinking depth)'),
      segmented(EFFORTS.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) })), c.effort, (v) => ctx.settings.set('ai:effort', v)),
      h('span.hint', 'Higher = more thorough and a bit slower/pricier.')));

    // days
    wrap.append(h('div.field', h('span.field-label', 'History sent with each question'),
      segmented(DAYS.map((d) => ({ value: d, label: d === 365 ? '1 year' : d + ' days' })), c.days, (v) => ctx.settings.set('ai:days', Number(v))),
      h('span.hint', 'More days = more context, more tokens.')));

    // photos toggle
    const tog = h('input', { type: 'checkbox' });
    tog.checked = c.includePhotos;
    tog.addEventListener('change', () => { ctx.settings.set('ai:includePhotos', tog.checked); toast(tog.checked ? 'Photos included in every question' : 'Photos only when you ask for physique feedback'); });
    wrap.append(h('label.field.toggle-row', h('span.field-label', 'Include progress photos (3 per question)'), h('span.switch', tog, h('span.knob'))));

    // apply changes without confirmation
    const auto = h('input', { type: 'checkbox' });
    auto.checked = c.autoApply;
    auto.addEventListener('change', () => { ctx.settings.set('ai:autoApply', auto.checked); toast(auto.checked ? 'Changes apply immediately' : 'Changes wait for your OK'); });
    wrap.append(h('label.field.toggle-row', h('span.field-label', 'Apply changes without asking'), h('span.switch', auto, h('span.knob'))),
      h('span.hint', 'Off: every add, edit or delete the assistant proposes is listed for your OK first. On: adds and edits happen immediately (a log stays in the chat); deletes still ask, because they cannot be undone.'));

    // clear chat
    wrap.append(h('button.btn.block', { onclick: async () => { if (!(await confirm('Delete the whole conversation with your coach?', { okLabel: 'Clear history' }))) return; await ctx.db.clear(STORE); toast('Chat history cleared'); } }, icon('trash', 18), 'Clear chat history'));
    return wrap;
  },
};
