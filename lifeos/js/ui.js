// ui.js — small UI kit shared by every module. No framework; plain DOM.

// ---------- DOM helper ----------
/**
 * h('div.card.big#id', { onclick, style, ... }, child1, child2, ...)
 * children may be strings, numbers, Nodes, arrays, null/false (skipped).
 */
export function h(sel, attrs, ...children) {
  if (attrs && (attrs instanceof Node || typeof attrs !== 'object' || Array.isArray(attrs))) { children.unshift(attrs); attrs = {}; }
  const [tag, ...rest] = sel.split(/(?=[.#])/);
  const el = document.createElement(tag || 'div');
  for (const r of rest) { if (r[0] === '.') el.classList.add(r.slice(1)); else if (r[0] === '#') el.id = r.slice(1); }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class' || k === 'className') el.className += ' ' + v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// ---------- Dates (local time, 'YYYY-MM-DD' keys) ----------
export const dates = {
  pad: (n) => String(n).padStart(2, '0'),
  /** 'YYYY-MM-DD' for a Date (default now), in local time. */
  key(d = new Date()) { return `${d.getFullYear()}-${dates.pad(d.getMonth() + 1)}-${dates.pad(d.getDate())}`; },
  today() { return dates.key(new Date()); },
  /** Parse 'YYYY-MM-DD' to a local Date at midnight. */
  parse(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); },
  addDays(key, n) { const d = dates.parse(key); d.setDate(d.getDate() + n); return dates.key(d); },
  daysBetween(a, b) { return Math.round((dates.parse(b) - dates.parse(a)) / 86400000); },
  /** Human label: Today / Yesterday / Tomorrow / 'Mon 12 Mar' / 'Mon 12 Mar 2025' */
  label(key, { year = 'auto' } = {}) {
    const t = dates.today();
    if (key === t) return 'Today';
    if (key === dates.addDays(t, -1)) return 'Yesterday';
    if (key === dates.addDays(t, 1)) return 'Tomorrow';
    const d = dates.parse(key);
    const opts = { weekday: 'short', day: 'numeric', month: 'short' };
    if (year === true || (year === 'auto' && d.getFullYear() !== new Date().getFullYear())) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  },
  monthLabel(key) { return dates.parse(key).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); },
  time(ts) { return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); },
  /** Start of ISO week (Monday) key */
  weekStart(key) { const d = dates.parse(key); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return dates.key(d); },
  monthStart(key) { return key.slice(0, 7) + '-01'; },
  monthEnd(key) { const d = dates.parse(key); return dates.key(new Date(d.getFullYear(), d.getMonth() + 1, 0)); },
  daysInMonth(key) { const d = dates.parse(key); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); },
  /** Relative "3 days ago" */
  ago(key) { const n = dates.daysBetween(key, dates.today()); if (n === 0) return 'today'; if (n === 1) return 'yesterday'; if (n < 0) return `in ${-n} day${n === -1 ? '' : 's'}`; return `${n} days ago`; },
};

export const fmt = {
  money(n, currency) {
    currency = currency || (window.lifeos?.settings?.get('currency') || 'USD');
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n); }
    catch { return (n < 0 ? '-' : '') + currency + ' ' + Math.abs(n).toFixed(2); }
  },
  num(n, digits = 1) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }); },
  escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
};

// ---------- Icons (inline SVG, 24px, currentColor) ----------
const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  body: '<circle cx="12" cy="5" r="2.5"/><path d="M5 10h14M12 10v6l-3 5M12 16l3 5"/>',
  mind: '<path d="M12 3a7 7 0 0 0-7 7c0 2.5 1.2 4 2.5 5.3V19h9v-3.7C17.8 14 19 12.5 19 10a7 7 0 0 0-7-7Z"/><path d="M9.5 22h5"/>',
  plan: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="m8.5 15 2 2 4-4"/>',
  money: '<rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="3"/><path d="M6 10h.01M18 15h.01"/>',
  ai: '<path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v12H4Z"/><circle cx="12" cy="13" r="3.5"/>',
  scale: '<path d="M12 3v3M6 21h12M12 6 5 9l7 3 7-3-7-3Z"/><path d="M5 9c0 3 1.5 5 3.5 5S12 12 12 9M12 9c0 3 1.5 5 3.5 5S19 12 19 9"/>',
  moon: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10Z"/>',
  note: '<path d="M5 3h10l4 4v14H5Z"/><path d="M15 3v4h4M8 12h8M8 16h6"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1.1 2.1h4.8c.1-.9.5-1.6 1.1-2.1A6 6 0 0 0 12 3Z"/>',
  task: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  goal: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  habit: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4M5 13v6h14v-6"/>',
  download: '<path d="M12 3v12M8 11l4 4 4-4M5 19h14"/>',
  upload: '<path d="M12 15V3M8 7l4-4 4 4M5 19h14"/>',
  send: '<path d="m3 11 18-8-8 18-2-8-8-2Z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M15 5l3 3M18 8l2-2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  flame: '<path d="M12 22c4 0 7-3 7-7 0-3-2-5-3-7-1 2-2 3-3 3 0-3-1-6-4-8 0 4-4 6-4 11 0 4 3 8 7 8Z"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  more: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5h10"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4"/><path d="M20 4v7h-7M4 20v-7h7"/>',
  star: '<path d="m12 3 2.8 5.9 6.4.8-4.7 4.5 1.2 6.4L12 17.5l-5.7 3.1 1.2-6.4L2.8 9.7l6.4-.8Z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
  swap: '<path d="M7 16V4M3 8l4-4 4 4M17 8v12M13 16l4 4 4-4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
};
export function icon(name, size = 24) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
  return span;
}

// ---------- Toasts ----------
let toastTimer;
export function toast(msg, { ms, action, onAction } = {}) {
  ms = ms ?? (action ? 5000 : 2200); // action toasts (e.g. Undo) stay long enough to be tapped
  let t = document.getElementById('toast');
  if (!t) { t = h('div#toast.toast'); document.body.appendChild(t); }
  clear(t);
  t.append(h('span', msg));
  // inline: >=44px hit area inside the toast padding and the same high-contrast colour as the message text
  if (action) t.append(h('button.toast-action', { style: { padding: '10px 12px', margin: '-10px -8px -10px 0', minHeight: '44px', color: 'var(--bg)' }, onclick: () => { onAction?.(); t.classList.remove('show'); } }, action));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- Bottom sheet / modal ----------
const sheetStack = []; // entries: { close, fromHistory }
// Android back button: every open sheet pushes a sentinel history entry (same URL, so no hashchange / re-render).
// A back press pops the sentinel -> popstate -> the top sheet closes. A programmatic close pops it via history.back().
let backPending = 0;      // history.back() calls issued here whose popstate has not arrived yet
let popHandling = false;  // true while a popstate is being dispatched; closeTopSheet() is then a no-op
window.addEventListener('popstate', () => {
  popHandling = true; setTimeout(() => { popHandling = false; }, 0);
  if (backPending > 0) { backPending--; return; }
  sheetStack[sheetStack.length - 1]?.fromHistory();
});
/**
 * Opens a bottom sheet. Returns { el, body, close }.
 * opts: { title, content (Node|Node[]), actions: [{label, primary, danger, onClick}], onClose, full }
 */
export function sheet(opts = {}) {
  const backdrop = h('div.sheet-backdrop');
  const el = h('div.sheet', { role: 'dialog', 'aria-modal': 'true' });
  if (opts.full) el.classList.add('full');
  const body = h('div.sheet-body');
  let pushed = false;
  const doClose = (fromHistory) => {
    if (!backdrop.isConnected) return;
    backdrop.classList.remove('show');
    el.classList.remove('show');
    setTimeout(() => backdrop.remove(), 220);
    const i = sheetStack.indexOf(entry); if (i >= 0) sheetStack.splice(i, 1);
    // pop our sentinel unless the back button already did (or the route changed underneath while open)
    if (pushed && !fromHistory && history.state?.sheet) { backPending++; try { history.back(); } catch { backPending--; } }
    opts.onClose?.();
  };
  const close = () => doClose(false);
  const entry = { close, fromHistory: () => doClose(true) };
  const header = h('div.sheet-header',
    h('div.sheet-grip'),
    h('div.sheet-title-row',
      h('h2.sheet-title', opts.title || ''),
      h('button.icon-btn', { 'aria-label': 'Close', onclick: close }, icon('close'))));
  el.append(header, body);
  if (opts.content) append(body, Array.isArray(opts.content) ? opts.content : [opts.content]);
  if (opts.actions?.length) {
    const bar = h('div.sheet-actions');
    for (const a of opts.actions) {
      bar.append(h('button.btn', { class: (a.primary ? 'primary' : '') + (a.danger ? ' danger' : ''), onclick: async () => { const r = await a.onClick?.({ close }); if (r !== false && a.closes !== false) close(); } }, a.label));
    }
    el.append(bar);
  }
  backdrop.append(el);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  try { history.pushState({ sheet: true }, '', location.href); pushed = true; } catch { /* history unavailable: the back button simply won't close the sheet */ }
  requestAnimationFrame(() => { backdrop.classList.add('show'); el.classList.add('show'); });
  sheetStack.push(entry);
  return { el, body, close };
}
/** Closes the top-most sheet. Returns false during popstate dispatch (the sheet is already handled there). */
export function closeTopSheet() { if (popHandling) return false; const s = sheetStack[sheetStack.length - 1]; if (s) { s.close(); return true; } return false; }

export function confirm(message, { title = 'Are you sure?', okLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    sheet({
      title,
      content: h('p.muted', message),
      onClose: () => resolve(false),
      actions: [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: okLabel, primary: true, danger, onClick: () => resolve(true) },
      ],
    });
  });
}

export function prompt(message, { title = '', value = '', placeholder = '', okLabel = 'Save', multiline = false } = {}) {
  return new Promise((resolve) => {
    const input = multiline ? h('textarea.input', { rows: 4, placeholder }) : h('input.input', { type: 'text', placeholder });
    input.value = value;
    const s = sheet({
      title, content: [message ? h('p.muted', message) : null, input],
      onClose: () => resolve(null),
      actions: [{ label: 'Cancel', onClick: () => resolve(null) }, { label: okLabel, primary: true, onClick: () => resolve(input.value) }],
    });
    setTimeout(() => input.focus(), 250);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) { resolve(input.value); s.close(); } });
  });
}

// ---------- Forms ----------
/**
 * Build a form from field defs. Returns { el, values(), set(obj), validate(), fields }.
 * field: { name, label, type: 'text'|'number'|'date'|'time'|'textarea'|'select'|'toggle'|'tags'|'segment'|'range'|'hidden',
 *          placeholder, required, options: [{value,label}] | ['a','b'], min, max, step, value, hint, autofocus, rows }
 */
export function form(fields, values = {}) {
  const inputs = {};
  const el = h('form.form', { onsubmit: (e) => e.preventDefault() });
  for (const f of fields) {
    const v = values[f.name] ?? f.value ?? '';
    let input;
    const id = 'f-' + f.name + '-' + Math.random().toString(36).slice(2, 6);
    switch (f.type) {
      case 'textarea': input = h('textarea.input', { id, rows: f.rows || 4, placeholder: f.placeholder || '' }); input.value = v; break;
      case 'select':
        input = h('select.input', { id });
        for (const o of f.options || []) { const opt = typeof o === 'object' ? o : { value: o, label: o }; input.append(h('option', { value: opt.value }, opt.label)); }
        input.value = v; break;
      case 'toggle':
        input = h('input', { id, type: 'checkbox' }); input.checked = !!v; break;
      case 'segment': {
        const wrap = h('div.segmented', { role: 'radiogroup' });
        wrap.value = v;
        for (const o of f.options || []) {
          const opt = typeof o === 'object' ? o : { value: o, label: o };
          const b = h('button.seg', { type: 'button', class: String(opt.value) === String(v) ? 'active' : '', onclick: () => { wrap.value = opt.value; [...wrap.children].forEach((c) => c.classList.toggle('active', c === b)); wrap.dispatchEvent(new Event('change')); } }, opt.label);
          wrap.append(b);
        }
        input = wrap; break;
      }
      case 'tags': {
        input = h('input.input', { id, type: 'text', placeholder: f.placeholder || 'tag1, tag2' });
        input.value = Array.isArray(v) ? v.join(', ') : v;
        break;
      }
      case 'range': {
        input = h('input', { id, type: 'range', min: f.min ?? 1, max: f.max ?? 5, step: f.step ?? 1 }); input.value = v || f.min || 1; break;
      }
      case 'hidden': input = h('input', { type: 'hidden' }); input.value = v; break;
      default:
        input = h('input.input', { id, type: f.type || 'text', placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step, inputmode: f.type === 'number' ? 'decimal' : undefined });
        input.value = v;
    }
    if (f.autofocus) input.autofocus = true;
    inputs[f.name] = { input, def: f };
    if (f.type === 'hidden') { el.append(input); continue; }
    const row = h(f.type === 'segment' ? 'div.field' : 'label.field', { for: f.type === 'segment' ? null : id, class: f.type === 'toggle' ? 'toggle-row' : '' });
    if (f.type === 'toggle') {
      row.append(h('span.field-label', f.label), h('span.switch', input, h('span.knob')));
    } else if (f.type === 'range') {
      const out = h('span.range-value', String(input.value));
      input.addEventListener('input', () => { out.textContent = f.labels?.[input.value] ?? input.value; });
      out.textContent = f.labels?.[input.value] ?? input.value;
      row.append(h('span.field-label', f.label, out), input);
    } else {
      const lab = h('span.field-label', f.label, f.required ? h('span.req', ' *') : null);
      if (f.type === 'segment') { lab.id = id + '-label'; input.setAttribute('aria-labelledby', lab.id); }
      row.append(lab, input);
    }
    if (f.hint) row.append(h('span.hint', f.hint));
    el.append(row);
  }
  const api = {
    el, fields: inputs,
    values() {
      const out = {};
      for (const [name, { input, def }] of Object.entries(inputs)) {
        let val;
        if (def.type === 'toggle') val = input.checked;
        else if (def.type === 'segment') val = input.value;
        else if (def.type === 'number' || def.type === 'range') val = input.value === '' ? null : Number(input.value);
        else if (def.type === 'tags') val = input.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        else val = input.value;
        out[name] = val;
      }
      return out;
    },
    set(obj) { for (const [k, v] of Object.entries(obj)) { const f = inputs[k]; if (!f) continue; if (f.def.type === 'toggle') f.input.checked = !!v; else f.input.value = Array.isArray(v) ? v.join(', ') : v; } },
    /** Returns first error message or null; marks fields. */
    validate() {
      for (const [name, { input, def }] of Object.entries(inputs)) {
        const empty = def.type === 'toggle' ? false : def.type === 'segment' ? input.value === '' : String(input.value ?? '').trim() === '';
        input.classList?.toggle('invalid', !!def.required && empty);
        if (def.required && empty) { input.focus?.(); return `${def.label} is required`; }
      }
      return null;
    },
    focus() { const first = Object.values(inputs).find((x) => x.def.autofocus) || Object.values(inputs)[0]; setTimeout(() => first?.input.focus?.(), 250); },
  };
  return api;
}

/**
 * Convenience: open a sheet with a form. Resolves with values or null.
 * opts: { title, fields, values, saveLabel, onDelete }
 */
export function formSheet({ title, fields, values = {}, saveLabel = 'Save', onDelete, extra, extraTop }) {
  return new Promise((resolve) => {
    const f = form(fields, values);
    const actions = [];
    if (onDelete) actions.push({ label: 'Delete', danger: true, onClick: async () => { const ok = await confirm('This cannot be undone.'); if (ok) { await onDelete(); resolve(null); return true; } return false; } });
    actions.push({ label: saveLabel, primary: true, onClick: () => { const err = f.validate(); if (err) { toast(err); return false; } resolve(f.values()); } });
    // extraTop renders above the fields (e.g. a primary action that must be reachable without scrolling), extra below.
    const s = sheet({ title, content: [extraTop || null, f.el, extra || null], actions, onClose: () => resolve(null) });
    f.focus();
    f.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); const err = f.validate(); if (err) { toast(err); return; } resolve(f.values()); s.close(); } });
  });
}

// ---------- Common blocks ----------
export function segmented(options, active, onChange) {
  const wrap = h('div.segmented');
  const render = () => { clear(wrap); for (const o of options) { const opt = typeof o === 'object' ? o : { value: o, label: o }; wrap.append(h('button.seg', { type: 'button', class: opt.value === active ? 'active' : '', onclick: () => { active = opt.value; render(); onChange?.(active); } }, opt.label)); } };
  render();
  wrap.setValue = (v) => { active = v; render(); };
  return wrap;
}

export function empty(text, sub, iconName = 'info') {
  return h('div.empty', icon(iconName, 40), h('p', text), sub ? h('p.muted', sub) : null);
}

export function card(...children) { return h('div.card', ...children); }

export function listItem({ title, sub, right, leading, onClick, onLongPress, done }) {
  const el = h('div.list-item', { class: (onClick ? 'tappable' : '') + (done ? ' done' : ''), onclick: onClick });
  if (leading) el.append(h('div.li-leading', leading));
  el.append(h('div.li-main', h('div.li-title', title), sub ? h('div.li-sub', sub) : null));
  if (right) el.append(h('div.li-right', right));
  if (onLongPress) longPress(el, onLongPress);
  return el;
}

export function longPress(el, fn, ms = 500) {
  let t; const start = (e) => { t = setTimeout(() => { fn(e); if (navigator.vibrate) navigator.vibrate(10); }, ms); }; const stop = () => clearTimeout(t);
  el.addEventListener('touchstart', start, { passive: true }); el.addEventListener('touchend', stop); el.addEventListener('touchmove', stop); el.addEventListener('touchcancel', stop);
  el.addEventListener('mousedown', start); el.addEventListener('mouseup', stop); el.addEventListener('mouseleave', stop);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); });
}

export function fab(onClick, label = 'Add') {
  return h('button.fab', { 'aria-label': label, onclick: onClick }, icon('plus', 28));
}

export function stat(label, value, sub) {
  return h('div.stat', h('div.stat-value', value), h('div.stat-label', label), sub ? h('div.stat-sub', sub) : null);
}

// ---------- Charts (SVG, no deps) ----------
/**
 * Line chart. points: [{x: number|string(date key), y: number}], opts: {height, color, unit, goal, smooth, showDots, yMin, yMax, formatX}
 */
export function lineChart(points, opts = {}) {
  const W = 320, H = opts.height || 160, padL = 36, padR = 10, padT = 10, padB = 24;
  const wrap = h('div.chart');
  if (!points || points.length === 0) { wrap.append(h('div.chart-empty', 'No data yet')); return wrap; }
  const xs = points.map((p, i) => typeof p.x === 'number' ? p.x : dates.parse(p.x).getTime());
  const ys = points.map((p) => p.y);
  let xMin = Math.min(...xs), xMax = Math.max(...xs); if (xMin === xMax) { xMin -= 86400000; xMax += 86400000; }
  let yMin = opts.yMin ?? Math.min(...ys, opts.goal ?? Infinity), yMax = opts.yMax ?? Math.max(...ys, opts.goal ?? -Infinity);
  const flatY = yMax === yMin;
  // NB: weight.js overlayRawPoints() mirrors this y padding; keep them in sync
  const span = (yMax - yMin) || 1; yMin -= span * 0.1; yMax += span * 0.1;
  const sx = (x) => padL + ((x - xMin) / (xMax - xMin)) * (W - padL - padR);
  const sy = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * (H - padT - padB);
  const color = opts.color || 'var(--accent)';
  let d = '';
  const pts = xs.map((x, i) => [sx(x), sy(ys[i])]);
  if (opts.smooth !== false && pts.length > 2) {
    d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; const cx = (x0 + x1) / 2; d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`; }
  } else d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ');
  const area = d + ` L${pts[pts.length - 1][0]},${H - padB} L${pts[0][0]},${H - padB} Z`;
  const gridLines = [];
  const ticks = flatY ? 2 : 4; // flat series: 3 ticks (y-0.1, y, y+0.1) stay distinct after rounding
  let prevLabel = null;
  for (let i = 0; i <= ticks; i++) {
    const y = yMin + ((yMax - yMin) * i) / ticks; const yy = sy(y); const label = fmt.num(y, 1);
    gridLines.push(`<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" class="grid"/>` + (label === prevLabel ? '' : `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" class="tick">${label}</text>`));
    prevLabel = label;
  }
  const fx = opts.formatX || ((t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
  const xTicks = [xMin, (xMin + xMax) / 2, xMax];
  const xText = xTicks.map(fx);
  const xLabels = xText[0] === xText[2]
    ? `<text x="${sx(xTicks[1])}" y="${H - 6}" text-anchor="middle" class="tick">${xText[1]}</text>` // single day: one centred label
    : xText.map((s, i) => (i === 1 && (s === xText[0] || s === xText[2])) ? '' : `<text x="${sx(xTicks[i])}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" class="tick">${s}</text>`).join('');
  const goal = opts.goal != null ? `<line x1="${padL}" x2="${W - padR}" y1="${sy(opts.goal)}" y2="${sy(opts.goal)}" class="goal"/>` : '';
  const dots = (opts.showDots ?? pts.length <= 60) ? pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${color}"/>`).join('') : '';
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="line-chart"><defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>${gridLines.join('')}${goal}<path d="${area}" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}${xLabels}</svg>`;
  return wrap;
}

/** Horizontal bars. items: [{label, value, color}] */
export function barList(items, { total, format } = {}) {
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const wrap = h('div.bars');
  for (const it of items) {
    const pct = Math.round((Math.abs(it.value) / max) * 100);
    wrap.append(h('div.bar-row',
      h('div.bar-head', h('span', it.label), h('span.muted', format ? format(it.value) : fmt.num(it.value))),
      h('div.bar-track', h('div.bar-fill', { style: { width: pct + '%', background: it.color || 'var(--accent)' } }))));
  }
  return wrap;
}

/** Simple column chart. items: [{label, value, color}] */
export function columns(items, { height = 120, format } = {}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  const wrap = h('div.columns', { style: { height: height + 'px' } });
  for (const it of items) {
    const pct = Math.max(2, Math.round((it.value / max) * 100));
    wrap.append(h('div.col', { title: `${it.label}: ${format ? format(it.value) : it.value}` }, h('div.col-fill', { style: { height: pct + '%', background: it.color || 'var(--accent)' } }), h('div.col-label', it.label)));
  }
  return wrap;
}

/** Progress ring (0..1) */
export function ring(frac, { size = 56, stroke = 6, color = 'var(--accent)', label } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const wrap = h('div.ring', { style: { width: size + 'px', height: size + 'px' } });
  wrap.innerHTML = `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="var(--border)" stroke-width="${stroke}" fill="none"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="${stroke}" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.max(0, Math.min(1, frac)))}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  if (label != null) wrap.append(h('div.ring-label', label));
  return wrap;
}

// ---------- Images ----------
/** Resize an image File/Blob to maxSide px, return JPEG Blob. */
export function resizeImage(file, maxSide = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), hgt = Math.round(img.height * scale);
      const cv = document.createElement('canvas'); cv.width = w; cv.height = hgt;
      cv.getContext('2d').drawImage(img, 0, 0, w, hgt);
      URL.revokeObjectURL(url);
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

/** Opens the device file picker/camera; resolves with File or null. accept e.g. 'image/*', capture 'user'|'environment' */
export function pickFile({ accept = '*/*', capture } = {}) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    if (capture) inp.setAttribute('capture', capture);
    let settled = false, fallbackTimer;
    const finish = (file) => {
      if (settled) return; settled = true;
      clearTimeout(fallbackTimer); window.removeEventListener('focus', onFocus);
      resolve(file); inp.remove();
    };
    // Fallback for browsers without the 'cancel' event: the picker was dismissed if no file arrived a few seconds
    // after the window regained focus (Android delivers 'change' asynchronously after the picker/camera returns).
    const onFocus = () => { fallbackTimer = setTimeout(() => { if (!inp.files?.length) finish(null); }, 3000); };
    inp.addEventListener('change', () => finish(inp.files?.[0] || null));
    inp.addEventListener('cancel', () => finish(null)); // Chrome 113+: fired when the picker is dismissed
    document.body.appendChild(inp);
    inp.click();
    setTimeout(() => { if (!settled) window.addEventListener('focus', onFocus, { once: true }); }, 0);
  });
}

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); return true; }
  catch { toast('Copy failed — long-press the text to copy'); return false; }
}

export async function shareText(title, text) {
  if (navigator.share) { try { await navigator.share({ title, text }); return true; } catch { return false; } }
  return copyText(text);
}

export const ui = { h, clear, dates, fmt, icon, toast, sheet, closeTopSheet, confirm, prompt, form, formSheet, segmented, empty, card, listItem, longPress, fab, stat, lineChart, barList, columns, ring, resizeImage, pickFile, downloadText, copyText, shareText };
export default ui;
