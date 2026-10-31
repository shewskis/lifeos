// app.js — shell: module registry, router, bottom nav, Today dashboard, settings, backup.
import { DB, settings } from './db.js';
import ui, { h, clear, icon, dates, toast, sheet, confirm } from './ui.js';
import { MODULES } from './modules/index.js';
import { buildLifeReport } from './report.js';

const TABS = [
  { id: 'today', label: 'Today', icon: 'home' },
  { id: 'body', label: 'Body', icon: 'body' },
  { id: 'mind', label: 'Mind', icon: 'mind' },
  { id: 'plan', label: 'Plan', icon: 'plan' },
  { id: 'money', label: 'Money', icon: 'money' },
];

const app = {
  db: new DB(),
  settings,
  ui,
  modules: MODULES,
  route: { tab: 'today', module: null, params: {} },
  _cleanup: null,
  _gen: 0, // render generation; a module render that resolves after a newer render() started is discarded

  async init() {
    applyTheme();
    for (const m of MODULES) if (m.stores) this.db.register(m.stores);
    await this.db.open();
    // let modules initialise (migrations, defaults)
    for (const m of MODULES) { try { await m.init?.(this.ctx()); } catch (e) { console.error('init failed', m.id, e); } }
    renderNav();
    window.addEventListener('hashchange', () => this.onHash());
    window.addEventListener('settings:change', (e) => { if (e.detail.key === 'theme') applyTheme(); });
    // In 'auto' mode the CSS follows the OS; keep the theme-color meta (status bar) in sync when the OS switches.
    try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme()); } catch {}
    // Android back button: ui.sheet() pushes a {sheet:true} sentinel history entry per open sheet and its own popstate
    // listener closes the top sheet when Back pops it (same URL, so no hashchange). With no sheet open, Back is a
    // plain history navigation handled by hashchange. A sentinel left over from a reload would only cost a dead press.
    if (history.state?.sheet) { try { history.replaceState(null, '', location.href); } catch {} }
    this.onHash();
    registerSW();
    showInstallHintOnce();
  },

  ctx(extra = {}) {
    return { db: this.db, settings: this.settings, ui, app: this, nav: (hash) => this.go(hash), modules: MODULES, ...extra };
  },

  /** go('body/weight') or go('mind/dreams?date=2025-01-01') or go('today') or go('ai') */
  go(hash) {
    const next = '#/' + hash.replace(/^#?\/?/, '');
    if (history.state?.sheet) {
      // Navigating while a sheet is open: reuse the sheet's sentinel entry for the new route instead of stacking on
      // top of it (that would leave a dead duplicate entry for the next Back press), then close the sheets. The
      // replaceState comes first so the sheets' close() sees no sentinel and does not history.back() over the new route.
      try { history.replaceState(null, '', next); } catch {}
      while (ui.closeTopSheet());
      this.onHash();
      return;
    }
    if (location.hash === next) this.onHash(); // same hash: hashchange would not fire, re-run the route (e.g. a repeated ?add=1 shortcut)
    else location.hash = next;
  },

  onHash() {
    const raw = location.hash.replace(/^#\/?/, '') || 'today';
    const [path, query = ''] = raw.split('?');
    const [tab, moduleId] = path.split('/');
    const qs = new URLSearchParams(query);
    const params = Object.fromEntries(qs);
    if (qs.has('add')) {
      // one-shot param: keep it in route.params for this render but strip it from the URL so a reload or a later
      // Back to this entry does not reopen the add form. replaceState fires no hashchange.
      qs.delete('add');
      const rest = qs.toString();
      try { history.replaceState(history.state, '', location.pathname + location.search + '#/' + path + (rest ? '?' + rest : '')); } catch {}
    }
    this.route = { tab: tab || 'today', module: moduleId || null, params };
    this.render();
  },

  async render() {
    const gen = ++this._gen;
    if (typeof this._cleanup === 'function') { try { this._cleanup(); } catch {} }
    this._cleanup = null;
    const view = document.getElementById('view');
    clear(view);
    window.scrollTo(0, 0);
    document.querySelectorAll('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === this.route.tab));
    const { tab } = this.route;
    if (tab === 'today') return renderToday(view);
    if (tab === 'ai') return renderModuleView(view, MODULES.find((m) => m.id === 'ai'), gen);
    if (tab === 'settings') return renderSettings(view);
    const tabMods = MODULES.filter((m) => m.tab === tab);
    if (!tabMods.length) { this.route.tab = 'today'; return renderToday(view); }
    let mod = tabMods.find((m) => m.id === this.route.module) || tabMods.find((m) => m.id === settings.get('lastModule:' + tab)) || tabMods[0];
    settings.set('lastModule:' + tab, mod.id);
    if (tabMods.length > 1) {
      view.append(h('div.segmented.mb', tabMods.map((m) => h('button.seg', { class: m === mod ? 'active' : '', onclick: () => this.go(`${tab}/${m.id}`) }, m.title))));
    }
    return renderModuleView(view, mod, gen);
  },
};

async function renderModuleView(view, mod, gen) {
  setTopbar(mod.title, mod.subtitle || '', mod.id === 'ai' ? null : () => app.go('ai'));
  const container = h('div.module', { dataset: { module: mod.id } });
  view.append(container);
  try {
    const cleanup = await mod.render(container, app.ctx({ params: app.route.params }));
    if (gen !== app._gen) {
      // the user navigated away while this render was in flight: the new screen already owns app._cleanup,
      // so tear this module down right away instead of overwriting (and leaking) the new screen's cleanup.
      try { cleanup?.(); } catch {}
      return;
    }
    app._cleanup = cleanup;
  } catch (e) {
    console.error(e);
    container.append(ui.empty('Something went wrong', String(e?.message || e)));
  }
}

function setTopbar(title, sub, onAI) {
  const tb = document.getElementById('topbar');
  clear(tb);
  const back = app.route.tab !== 'today' ? h('button.icon-btn', { 'aria-label': 'Home', onclick: () => app.go('today') }, icon('back')) : null;
  if (back) tb.append(back);
  tb.append(h('div.grow', h('h1', title), sub ? h('div.sub', sub) : null));
  if (onAI) tb.append(h('button.icon-btn.accent', { 'aria-label': 'AI coach', onclick: onAI }, icon('ai')));
  tb.append(h('button.icon-btn', { 'aria-label': 'Settings', onclick: () => app.go('settings') }, icon('settings')));
}

function renderNav() {
  const nav = document.getElementById('nav');
  clear(nav);
  for (const t of TABS) nav.append(h('button', { dataset: { tab: t.id }, onclick: () => app.go(t.id) }, icon(t.icon, 24), h('span', t.label)));
}

// ---------- Today dashboard ----------
async function renderToday(view) {
  const name = settings.get('name', '');
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  setTopbar(`${greet}${name ? ', ' + name : ''}`, new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }), () => app.go('ai'));

  // Quick actions from every module
  const quick = h('div.quick-grid');
  for (const m of MODULES) for (const qa of m.quickActions || []) {
    quick.append(h('button.quick', { onclick: async () => { try { await qa.run(app.ctx()); } catch (e) { console.error(e); toast('Could not open: ' + (e.message || e)); } } }, h('span.icon', icon(qa.icon || m.icon || 'plus', 22)), h('span', qa.label)));
  }
  view.append(quick);

  // Install card: shown in a browser tab until the app is installed or the card is dismissed
  const installCard = renderInstallCard();
  if (installCard) view.append(installCard);

  // AI coach card
  const aiMod = MODULES.find((m) => m.id === 'ai');
  if (aiMod) {
    view.append(h('div.card.accent-bg.tappable', { onclick: () => app.go('ai') },
      h('div.row', icon('ai', 28), h('div.grow', h('h3', 'AI Life Coach'), h('div.small.muted', settings.get('ai:apiKey') ? 'Ask for a daily brief, patterns, or a plan' : 'Tap to set up — it reads everything you log here')), icon('chevron'))));
  }

  // Module summary cards
  const summaries = h('div.stack');
  view.append(summaries);
  for (const m of MODULES) {
    if (!m.todayCard) continue;
    const holder = h('div');
    summaries.append(holder);
    const draw = async () => {
      clear(holder);
      try { const c = await m.todayCard(app.ctx()); if (c) holder.append(c); } catch (e) { console.error('todayCard', m.id, e); }
    };
    draw();
    const off = app.db.onChange(null, (store) => { if (m.stores && store in m.stores) draw(); });
    const prev = app._cleanup; app._cleanup = () => { prev?.(); off(); };
  }

  // Module grid
  view.append(h('div.section-title', 'Everything'));
  const grid = h('div.module-grid');
  for (const m of MODULES) if (m.tab) grid.append(h('button.module-tile', { onclick: () => app.go(`${m.tab}/${m.id}`) }, icon(m.icon || 'grid', 26), h('div', h('div.t', m.title), h('div.s', m.subtitle || ''))));
  view.append(grid);
}

// ---------- Settings ----------
async function renderSettings(view) {
  setTopbar('Settings', '', null);
  // Everything goes into a root appended synchronously: render() clears #view on navigation, and the awaits below
  // must not append Settings cards onto whatever screen replaced us.
  const root = h('div.module', { dataset: { module: 'settings' } });
  view.append(root);
  const f = ui.form([
    { name: 'name', label: 'Your name', type: 'text', placeholder: 'How should the app greet you?' },
    { name: 'theme', label: 'Theme', type: 'segment', options: [{ value: 'auto', label: 'Auto' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }] },
    { name: 'units', label: 'Weight unit', type: 'segment', options: [{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }] },
    { name: 'currency', label: 'Currency code', type: 'text', placeholder: 'USD, EUR, GBP…' },
    { name: 'weekStart', label: 'Week starts on', type: 'segment', options: [{ value: 'mon', label: 'Monday' }, { value: 'sun', label: 'Sunday' }] },
  ], { name: settings.get('name', ''), theme: settings.get('theme', 'auto'), units: settings.get('units', 'kg'), currency: settings.get('currency', 'USD'), weekStart: settings.get('weekStart', 'mon') });
  const savePrefs = () => { const v = f.values(); settings.set('name', v.name.trim()); settings.set('theme', v.theme); settings.set('units', v.units); settings.set('currency', (v.currency || 'USD').toUpperCase().trim()); settings.set('weekStart', v.weekStart); };
  // Listen on each field, not on the form: the segment widget dispatches a non-bubbling 'change' on its own element.
  for (const { input } of Object.values(f.fields)) input.addEventListener('change', savePrefs);
  f.el.addEventListener('input', () => { const v = f.values(); settings.set('name', v.name.trim()); settings.set('currency', (v.currency || 'USD').toUpperCase().trim()); });
  root.append(ui.card(h('h3', 'Preferences'), f.el));

  // per-module settings
  for (const m of MODULES) if (m.settings) { const c = ui.card(h('h3', m.title)); try { c.append(await m.settings(app.ctx())); } catch (e) { console.error(e); } root.append(c); }

  // Backup
  const stats = await Promise.all(Object.keys(app.db.schema).map(async (s) => [s, await app.db.count(s)]));
  root.append(ui.card(
    h('h3', 'Backup & data'),
    h('p.muted.small', 'All data is stored only on this device. Export a backup regularly (it includes photos) and keep it somewhere safe like Google Drive.'),
    h('div.chips.mb', stats.map(([s, n]) => h('span.chip', `${s}: ${n}`))),
    h('div.stack',
      h('button.btn.block.primary', { onclick: exportBackup }, icon('download'), 'Export full backup (.json)'),
      h('button.btn.block', { onclick: importBackup }, icon('upload'), 'Import backup'),
      h('button.btn.block', { onclick: exportAIReport }, icon('copy'), 'Copy life report for any AI'),
      h('button.btn.block.danger', { onclick: wipe }, icon('trash'), 'Erase all data'))));

  root.append(ui.card(h('h3', 'Install on your phone'),
    isStandalone()
      ? h('p.small.muted', 'LifeOS is installed and running as an app.')
      : h('div',
          h('p.small.muted.mb', 'Put LifeOS on your home screen: it runs full-screen and works offline like a normal app.'),
          h('button.btn.block.primary', { onclick: installApp }, icon('download'), 'Install LifeOS')),
    h('p.small.muted.mt', `Version ${window.LIFEOS_VERSION || 'dev'}`)));
}

async function exportBackup() {
  toast('Preparing backup…');
  const data = await app.db.exportAll();
  data.settings = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('lifeos:') && !k.includes('apiKey')) data.settings[k] = localStorage.getItem(k); }
  const json = JSON.stringify(data);
  const name = `lifeos-backup-${dates.today()}.json`;
  if (navigator.canShare) {
    // build the File once: backups with photos are large and each File copies the whole payload
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'LifeOS backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
  }
  ui.downloadText(name, json, 'application/json');
}
async function importBackup() {
  const file = await ui.pickFile({ accept: 'application/json,.json' });
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const mode = await new Promise((res) => sheet({ title: 'Import backup', content: h('p.muted', 'Merge keeps your current entries and adds the backup. Replace erases current data first.'), onClose: () => res(null), actions: [{ label: 'Replace', danger: true, onClick: () => res('replace') }, { label: 'Merge', primary: true, onClick: () => res('merge') }] }));
    if (!mode) return;
    await app.db.importAll(data, { merge: mode === 'merge' });
    for (const [k, v] of Object.entries(data.settings || {})) {
      if (!k.startsWith('lifeos:') || k.includes('apiKey')) continue; // only our own keys; the API key never travels in a backup
      localStorage.setItem(k, v);
    }
    applyTheme(); // settings were written directly, so no settings:change fired
    toast('Backup imported'); app.render();
  } catch (e) { console.error(e); toast('Import failed: ' + e.message); }
}
async function exportAIReport() {
  const text = await buildLifeReport(app.ctx(), { days: 90 });
  await ui.shareText('My life report', text);
}
async function wipe() {
  if (!(await confirm('Erase every entry, photo and setting on this device? Export a backup first.', { okLabel: 'Erase everything' }))) return;
  for (const s of Object.keys(app.db.schema)) await app.db.clear(s);
  Object.keys(localStorage).filter((k) => k.startsWith('lifeos:')).forEach((k) => localStorage.removeItem(k));
  applyTheme(); // theme setting is gone; back to 'auto' without waiting for a reload
  toast('All data erased'); app.go('today');
}

// ---------- theme / sw / install ----------
function applyTheme() {
  const t = settings.get('theme', 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0d12';
}
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Update ready', { ms: 6000, action: 'Reload', onAction: () => location.reload() }); });
    });
  }).catch((e) => console.warn('SW failed', e));
}
let deferredInstall = null;
let installHintDue = false; // the 4 s settle timer has elapsed
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; maybeShowInstallHint(); });
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  settings.set('installCardDismissed', true);
  document.querySelectorAll('.install-card').forEach((c) => c.remove());
  toast('Installed — open LifeOS from your home screen');
});
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }

/** Today-screen card with an Install button; null once installed or dismissed. */
function renderInstallCard() {
  if (isStandalone() || settings.get('installCardDismissed')) return null;
  const card = h('div.card.install-card',
    h('div.row', icon('download', 28),
      h('div.grow', h('h3', 'Install on your phone'), h('div.small.muted', 'Home-screen icon, full screen, works offline')),
      h('button.icon-btn', { 'aria-label': 'Dismiss', onclick: () => { settings.set('installCardDismissed', true); card.remove(); } }, icon('close'))),
    h('button.btn.block.primary.mt', { onclick: installApp }, icon('download'), 'Install LifeOS'));
  return card;
}

/** Native install prompt when the browser offers one; otherwise step-by-step instructions for this browser. */
async function installApp() {
  if (isStandalone()) { toast('LifeOS is already installed'); return; }
  if (deferredInstall) {
    const ev = deferredInstall; deferredInstall = null; // a captured prompt can be shown only once
    try { ev.prompt(); const { outcome } = await ev.userChoice; if (outcome === 'accepted') return; } catch {}
  }
  showInstallHelp();
}
function showInstallHelp() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua);
  const samsung = /SamsungBrowser/.test(ua);
  const firefox = /Firefox/.test(ua);
  const android = /Android/.test(ua);
  let browser, steps;
  if (ios) { browser = 'Safari on iPhone'; steps = ['Tap the Share button (square with an arrow) at the bottom.', 'Scroll down and tap "Add to Home Screen".', 'Tap Add. LifeOS appears on your home screen.']; }
  else if (samsung) { browser = 'Samsung Internet'; steps = ['Tap the menu (☰) at the bottom right.', 'Tap "Add page to", then "Home screen".', 'Confirm. LifeOS appears on your home screen.']; }
  else if (firefox) { browser = 'Firefox'; steps = ['Tap the menu (⋮).', 'Tap "Install" or "Add to Home screen".', 'Confirm.']; }
  else if (android) { browser = 'Chrome on Android'; steps = ['Tap the menu (⋮) at the top right.', 'Tap "Install app" (on some phones it says "Add to Home screen").', 'Tap Install. LifeOS appears on your home screen and in your app list.']; }
  else { browser = 'Chrome on a computer'; steps = ['Click the install icon at the right end of the address bar (a screen with a down arrow).', 'Or open the menu (⋮), then "Cast, save and share", then "Install page as app".']; }
  sheet({
    title: 'Install LifeOS',
    content: h('div',
      h('p.muted', `In ${browser}:`),
      h('ol.install-steps', steps.map((s) => h('li', s))),
      h('p.small.muted.mt', 'Already installed? Open LifeOS from your home screen instead of the browser tab.')),
    actions: [{ label: 'Got it', primary: true }],
  });
}
function showInstallHintOnce() {
  if (settings.get('installHintShown') || isStandalone()) return;
  setTimeout(() => { installHintDue = true; maybeShowInstallHint(); }, 4000);
}
// Chrome fires beforeinstallprompt only after the manifest and service worker are ready, which can be after the timer;
// show the hint when both have happened, and mark it as shown only when it was actually shown.
function maybeShowInstallHint() {
  if (!installHintDue || !deferredInstall || settings.get('installHintShown')) return;
  if (isStandalone()) return;
  settings.set('installHintShown', true);
  toast('Install LifeOS on your home screen', { ms: 8000, action: 'Install', onAction: installApp });
}

window.lifeos = app;
app.init().catch((e) => { console.error(e); document.getElementById('view').append(ui.empty('Failed to start', String(e?.message || e))); });
