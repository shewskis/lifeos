// photos.js — daily progress photos: in-app camera with ghost overlay, gallery, compare, timelapse.
import { h, clear, dates, fmt, icon, toast, sheet, confirm, formSheet, form, segmented, empty, card, fab, resizeImage, pickFile } from '../ui.js';

const STORE = 'photos';
const FULL_SIDE = 1280;
const THUMB_SIDE = 320;
const FRAME_MS = 400;
// 44px touch target for the Today-card header link (same pattern as weight.js / tasks.js)
const LINK_STYLE = { padding: '10px 0 10px 12px', minHeight: '44px' };

// ---------- small helpers ----------
function injectStyle() {
  if (document.getElementById('photos-style')) return;
  document.head.append(h('style#photos-style', `
.ph-cam-controls{display:flex;align-items:center;justify-content:space-around;margin-top:4px}
.ph-cam-controls .shutter{margin:0}
.ph-cam-controls .shutter:active{transform:scale(.94)}
.ph-round{width:50px;height:50px;border-radius:50%;background:var(--card-2);color:var(--text);display:inline-flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid var(--border);font-size:10px;font-weight:700;gap:0}
.ph-round.on{background:var(--accent);color:var(--accent-text);border-color:transparent}
.ph-countdown{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:110px;font-weight:800;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.7);pointer-events:none}
.ph-large{width:100%;aspect-ratio:3/4;object-fit:contain;background:#000;border-radius:14px;display:block}
.ph-preview{width:100%;aspect-ratio:3/4;object-fit:cover;background:#000;border-radius:14px;display:block}
.ph-badge{position:absolute;top:6px;right:6px;width:22px;height:22px;border-width:2px}
.ph-today-thumb{width:64px;height:84px;border-radius:10px;object-fit:cover;background:var(--card-2);display:block}
.ph-cap{font-size:12px;color:var(--muted);text-align:center;margin-top:6px}
.sheet .camera-wrap{width:min(100%,calc((92vh - 260px) * .75));max-width:100%;margin:0 auto}
.ph-cmp-label{font-size:12px;font-weight:600;color:var(--text-2)}
`));
}

/** Object-URL pool so every URL we create gets revoked. */
function urlPool() {
  const urls = new Map(); // blob -> url
  return {
    url(blob) {
      if (!(blob instanceof Blob)) return '';
      let u = urls.get(blob);
      if (!u) { u = URL.createObjectURL(blob); urls.set(blob, u); }
      return u;
    },
    revokeAll() { for (const u of urls.values()) { try { URL.revokeObjectURL(u); } catch {} } urls.clear(); },
  };
}

function sortKey(p) { return `${p.date || ''} ${p.time || ''} ${String(p.createdAt || 0).padStart(14, '0')}`; }
function sortAsc(rows) { return [...rows].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)); }
function nowTime() { const d = new Date(); return `${dates.pad(d.getHours())}:${dates.pad(d.getMinutes())}`; }
function imgBlob(p) { return p?.blob instanceof Blob ? p.blob : p?.thumb instanceof Blob ? p.thumb : null; }
function thumbBlob(p) { return p?.thumb instanceof Blob ? p.thumb : p?.blob instanceof Blob ? p.blob : null; }
function shortDate(key) { try { return dates.parse(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return key || ''; } }

function streakDays(rows) {
  const set = new Set(rows.map((p) => p.date).filter(Boolean));
  let d = dates.today();
  if (!set.has(d)) d = dates.addDays(d, -1);
  let n = 0;
  while (set.has(d)) { n++; d = dates.addDays(d, -1); }
  return n;
}
function distinctDays(rows) { return new Set(rows.map((p) => p.date).filter(Boolean)).size; }

function weightLabel(kg, ctx) {
  if (kg === null || kg === undefined || isNaN(Number(kg))) return '';
  const unit = ctx.settings.get('units', 'kg');
  return unit === 'lb' ? `${fmt.num(Number(kg) * 2.20462, 1)} lb` : `${fmt.num(Number(kg), 1)} kg`;
}
function weightDiffLabel(a, b, ctx) {
  if (a == null || b == null || isNaN(Number(a)) || isNaN(Number(b))) return '';
  const unit = ctx.settings.get('units', 'kg');
  let diff = Number(b) - Number(a);
  if (unit === 'lb') diff *= 2.20462;
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
  return `${sign}${fmt.num(Math.abs(diff), 1)} ${unit === 'lb' ? 'lb' : 'kg'}`;
}

function kgOf(r) {
  const v = r?.kg ?? r?.weightKg ?? r?.weight ?? r?.value;
  return v === null || v === undefined || isNaN(Number(v)) ? null : Number(v);
}

/** Read-only peek into the weight module's store for a date. Tolerates the store not existing. */
async function weightForDate(ctx, date) {
  try {
    const rows = await ctx.db.where('weights', 'date', date);
    if (!rows?.length) return null;
    return kgOf(rows.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))[0]);
  } catch { return null; }
}

/** date -> kg for every weigh-in (latest entry wins per date). Read once per load so photos always show the
 *  current weight for their day, not the value cached when the photo was taken. Tolerates the store not existing. */
async function weightMap(ctx) {
  const map = new Map();
  try {
    const rows = await ctx.db.all('weights');
    const seen = new Map(); // date -> updatedAt of the entry currently in `map`
    for (const r of rows || []) {
      const kg = kgOf(r);
      if (kg === null || typeof r.date !== 'string') continue;
      const ts = r.updatedAt || 0;
      if (!seen.has(r.date) || ts >= seen.get(r.date)) { seen.set(r.date, ts); map.set(r.date, kg); }
    }
  } catch {}
  return map;
}

async function savePhoto(ctx, sourceBlob, { date, time, note }) {
  const [blob, thumb] = await Promise.all([resizeImage(sourceBlob, FULL_SIDE, 0.86), resizeImage(sourceBlob, THUMB_SIDE, 0.8)]);
  let d = date || dates.today();
  if (d > dates.today()) d = dates.today(); // never save a photo dated in the future
  const rec = { date: d, time: time || nowTime(), blob, thumb, note: (note || '').trim(), weightKg: await weightForDate(ctx, d) };
  return ctx.db.put(STORE, rec);
}

async function loadAll(ctx) {
  const [rows, weights] = await Promise.all([ctx.db.all(STORE), weightMap(ctx)]);
  // normalise old/partial records so the UI never sees undefined fields
  const ok = rows.filter((p) => p && (p.blob instanceof Blob || p.thumb instanceof Blob)).map((p) => {
    const date = typeof p.date === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.date) ? p.date : dates.key(new Date(p.createdAt || Date.now()));
    // weight is resolved at read time from the weights store (so a weigh-in logged or corrected after the photo
    // shows up everywhere); the snapshot saved with the photo is only a fallback when that day has no weigh-in.
    const snapshot = p.weightKg === null || p.weightKg === undefined || isNaN(Number(p.weightKg)) ? null : Number(p.weightKg);
    return {
      ...p,
      date,
      time: typeof p.time === 'string' ? p.time : '',
      note: typeof p.note === 'string' ? p.note : '',
      weightKg: weights.has(date) ? weights.get(date) : snapshot,
    };
  });
  return sortAsc(ok);
}

// ---------- camera sheet ----------
let activeCameraClose = null;

async function openCamera(ctx, { initialFile = null } = {}) {
  injectStyle();
  if (activeCameraClose) { try { activeCameraClose(); } catch {} }
  const pool = urlPool();
  let stream = null;
  let streamReq = 0; // token so a stale getUserMedia result never overwrites a newer stream
  let countdownTimer = null;
  let facing = ctx.settings.get('photos:facing', 'user');
  let timerOn = !!ctx.settings.get('photos:timer', false);
  let closed = false;

  const stopStream = () => { if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch {} } stream = null; } };
  const cancelCountdown = () => { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } countdown.textContent = ''; };

  const latest = (await loadAll(ctx)).slice(-1)[0] || null;

  const video = h('video', { autoplay: true, muted: true, playsinline: true });
  video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
  const ghost = h('img.ghost', { alt: '', style: { display: latest ? '' : 'none' } });
  if (latest) ghost.src = pool.url(imgBlob(latest));
  const countdown = h('div.ph-countdown');
  const camWrap = h('div.camera-wrap', video, ghost, countdown);
  const noticeBox = h('div');
  const ghostCap = h('div.ph-cap', latest ? `Ghost: ${dates.label(latest.date, { year: 'auto' })} — line yourself up with it` : 'First photo — stand where you can repeat this every day');

  const s = sheet({
    title: 'Progress photo',
    full: true,
    onClose: () => { closed = true; cancelCountdown(); stopStream(); pool.revokeAll(); if (activeCameraClose === s.close) activeCameraClose = null; },
  });
  activeCameraClose = s.close;
  const body = s.body;

  // ----- stage 1: live camera -----
  const timerBtn = h('button.ph-round', { 'aria-label': 'Timer', class: timerOn ? 'on' : '', onclick: () => { timerOn = !timerOn; ctx.settings.set('photos:timer', timerOn); timerBtn.classList.toggle('on', timerOn); } }, icon('refresh', 18), h('span', '3s'));
  const swapBtn = h('button.ph-round', { 'aria-label': 'Switch camera', onclick: async () => { facing = facing === 'user' ? 'environment' : 'user'; ctx.settings.set('photos:facing', facing); await startStream(); } }, icon('swap', 20));
  const shutter = h('button.shutter', { 'aria-label': 'Take photo', onclick: () => {
    if (countdownTimer) { cancelCountdown(); return; }
    if (!timerOn) return capture();
    let n = 3; countdown.textContent = String(n);
    countdownTimer = setInterval(() => { n--; if (n <= 0) { cancelCountdown(); capture(); } else countdown.textContent = String(n); }, 1000);
  } });
  const galleryBtn = h('button.btn.block', { onclick: async () => { const f = await pickFile({ accept: 'image/*' }); if (f) showPreview(f, fileDate(f)); } }, icon('upload', 20), 'Choose from gallery');
  const liveStage = h('div.stack', noticeBox, camWrap, ghostCap, h('div.ph-cam-controls', timerBtn, shutter, swapBtn), galleryBtn);

  function fileDate(f) {
    try { const k = dates.key(new Date(f.lastModified)); return k <= dates.today() ? k : dates.today(); } catch { return dates.today(); }
  }

  function showFallback(msg) {
    clear(noticeBox);
    noticeBox.append(h('div.notice', h('div', msg), h('button.btn.primary.block.mt', { onclick: async () => { const f = await pickFile({ accept: 'image/*', capture: 'user' }); if (f) showPreview(f, dates.today()); } }, icon('camera', 20), 'Open phone camera')));
    camWrap.classList.add('hidden'); ghostCap.classList.add('hidden'); shutter.parentElement?.classList.add('hidden');
  }

  function showLive() {
    clear(noticeBox);
    camWrap.classList.remove('hidden'); ghostCap.classList.remove('hidden'); shutter.parentElement?.classList.remove('hidden');
  }

  async function startStream() {
    const myReq = ++streamReq;
    stopStream();
    showLive(); // undo a previous fallback so a retry actually shows the camera
    if (!navigator.mediaDevices?.getUserMedia) { showFallback('In-app camera is not available here (needs HTTPS and a camera). Use your phone camera instead:'); return; }
    swapBtn.disabled = true;
    try {
      const s2 = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1080 }, height: { ideal: 1440 } } });
      if (closed || myReq !== streamReq) { for (const t of s2.getTracks()) { try { t.stop(); } catch {} } return; }
      stopStream();
      stream = s2;
      const actual = stream.getVideoTracks()[0]?.getSettings?.().facingMode || facing;
      camWrap.classList.toggle('mirror', actual !== 'environment');
      video.srcObject = stream;
      try { await video.play(); } catch {}
    } catch (e) {
      if (closed || myReq !== streamReq) return;
      console.warn('getUserMedia failed', e);
      const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      showFallback(denied ? 'Camera permission was denied. Allow it in site settings, or use your phone camera:' : 'Could not start the camera. Use your phone camera instead:');
    } finally {
      if (myReq === streamReq) swapBtn.disabled = false;
    }
  }

  function capture() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { toast('Camera is still starting…'); return; }
    const ratio = 3 / 4;
    let cw = vw, ch = vh;
    if (vw / vh > ratio) cw = Math.round(vh * ratio); else ch = Math.round(vw / ratio);
    const sx = Math.round((vw - cw) / 2), sy = Math.round((vh - ch) / 2);
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    cv.getContext('2d').drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch);
    if (navigator.vibrate) navigator.vibrate(15);
    cv.toBlob((b) => { if (b) showPreview(b, dates.today()); else toast('Capture failed — try again'); }, 'image/jpeg', 0.92);
  }

  // ----- stage 2: preview + save -----
  function showPreview(blob, date) {
    cancelCountdown(); stopStream();
    const preview = h('img.ph-preview', { alt: 'Captured photo' });
    preview.src = pool.url(blob);
    const f = form([
      { name: 'date', label: 'Date', type: 'date', required: true, max: dates.today() },
      { name: 'note', label: 'Note (optional)', type: 'textarea', rows: 2, placeholder: 'How do you feel? Pump, lighting, morning/evening…' },
    ], { date: date || dates.today(), note: '' });
    const saveBtn = h('button.btn.primary.block', { onclick: async () => {
      const err = f.validate(); if (err) { toast(err); return; }
      saveBtn.disabled = true;
      try {
        const v = f.values();
        await savePhoto(ctx, blob, { date: v.date, time: nowTime(), note: v.note });
        toast(v.date === dates.today() ? 'Today\'s photo saved' : 'Photo saved');
        s.close();
      } catch (e) { console.error(e); toast('Could not save: ' + (e.message || e)); saveBtn.disabled = false; }
    } }, icon('check', 20), 'Save photo');
    const retake = h('button.btn.block', { onclick: () => { clear(body); body.append(liveStage); startStream(); } }, icon('camera', 20), 'Retake');
    clear(body);
    body.append(h('div.stack', preview, f.el, saveBtn, retake));
  }

  body.append(liveStage);
  if (initialFile) showPreview(initialFile, fileDate(initialFile));
  else startStream();
  return s;
}

// ---------- viewer sheet ----------
function openViewer(ctx, photos, startIndex) {
  injectStyle();
  const pool = urlPool();
  let i = Math.max(0, Math.min(startIndex, photos.length - 1));
  const s = sheet({ title: 'Photo', full: true, onClose: () => pool.revokeAll() });
  const body = s.body;

  const draw = () => {
    const p = photos[i];
    if (!p) { s.close(); return; }
    clear(body);
    const img = h('img.ph-large', { alt: 'Progress photo' });
    img.src = pool.url(imgBlob(p));
    const w = weightLabel(p.weightKg, ctx);
    const meta = h('div.row.wrap',
      h('span.chip.accent', dates.label(p.date, { year: 'auto' })),
      p.time ? h('span.chip', p.time) : null,
      w ? h('span.chip.good', icon('scale', 14), w) : null,
      h('span.chip', `#${i + 1} of ${photos.length}`));
    const note = p.note ? h('p', p.note) : h('p.muted.small', 'No note');
    const nav = h('div.row',
      h('button.btn.grow', { disabled: i === 0, onclick: () => { i--; draw(); } }, icon('back', 20), 'Older'),
      h('button.btn.grow', { disabled: i === photos.length - 1, onclick: () => { i++; draw(); } }, 'Newer', icon('chevron', 20)));
    const editBtn = h('button.btn.block', { onclick: () => editPhoto(ctx, p, { onDeleted: () => s.close(), onSaved: (rec) => { photos[i] = rec; draw(); } }) }, icon('edit', 20), 'Edit date / note');
    const delBtn = h('button.btn.block.danger', { onclick: async () => {
      if (!(await confirm('Delete this photo? This cannot be undone.'))) return;
      await ctx.db.delete(STORE, p.id); toast('Photo deleted');
      photos.splice(i, 1); if (!photos.length) { s.close(); return; } if (i >= photos.length) i = photos.length - 1; draw();
    } }, icon('trash', 20), 'Delete');
    body.append(h('div.stack', img, meta, note, nav, editBtn, delBtn));
  };
  draw();
  return s;
}

async function editPhoto(ctx, p, { onDeleted, onSaved } = {}) {
  const v = await formSheet({
    title: 'Edit photo',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true, max: dates.today() },
      { name: 'time', label: 'Time', type: 'time' },
      { name: 'note', label: 'Note', type: 'textarea', rows: 3, placeholder: 'Optional note' },
    ],
    values: { date: p.date || dates.today(), time: p.time || '', note: p.note || '' },
    onDelete: async () => { await ctx.db.delete(STORE, p.id); toast('Photo deleted'); onDeleted?.(); },
  });
  if (!v) return;
  let date = v.date || p.date || dates.today();
  if (date > dates.today()) date = dates.today();
  const rec = { ...p, date, time: v.time || p.time || '', note: (v.note || '').trim() };
  if (date !== p.date || rec.weightKg == null) rec.weightKg = await weightForDate(ctx, date);
  const saved = await ctx.db.put(STORE, rec);
  toast('Saved');
  onSaved?.(saved);
}

// ---------- AI actions (read-only) ----------
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ACTION_ROWS = 20;

function actionDate(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new Error(`${name} must be a date in YYYY-MM-DD format`);
  return v;
}

/** One compact text line per photo for the model: id, date, time, weight, note. Never includes image data. */
function photoLine(p, ctx, { noteChars = 120 } = {}) {
  const w = weightLabel(p.weightKg, ctx);
  const note = (p.note || '').replace(/\s+/g, ' ').trim();
  return `${p.id} | ${p.date}${p.time ? ' ' + p.time : ''}${w ? ' | ' + w : ''}${note ? ' | ' + (note.length > noteChars ? note.slice(0, noteChars) + '…' : note) : ''}`;
}

// ---------- module ----------
export default {
  id: 'photos',
  title: 'Progress photos',
  subtitle: 'Daily physique photo',
  icon: 'camera',
  tab: 'body',
  stores: { photos: { indexes: ['date'] } },

  async render(container, ctx) {
    injectStyle();
    const pool = urlPool();
    let view = ctx.settings.get('photos:view', 'gallery');
    let photos = [];
    let playTimer = null;
    let cmpA = null, cmpB = null; // photo ids for compare; null = "first" / "latest" (keeps tracking new photos)
    let tlIndex = -1;
    const stopPlay = () => { if (playTimer) { clearInterval(playTimer); playTimer = null; } };

    const header = h('div');
    const seg = segmented([{ value: 'gallery', label: 'Gallery' }, { value: 'compare', label: 'Compare' }, { value: 'timelapse', label: 'Timelapse' }], view, (v) => { view = v; ctx.settings.set('photos:view', v); stopPlay(); drawView(); });
    const content = h('div.mt');
    container.append(header, seg, content, fab(() => openCamera(ctx), 'Take progress photo'));

    const drawHeader = () => {
      clear(header);
      const streak = streakDays(photos);
      const days = distinctDays(photos);
      const todayHas = photos.some((p) => p.date === dates.today());
      header.append(h('div.row.wrap.mb',
        h('span.chip', { class: streak > 0 ? 'warn' : '' }, icon('flame', 14), streak > 0 ? `${streak} day streak` : 'No streak yet'),
        h('span.chip', icon('camera', 14), `${photos.length} photo${photos.length === 1 ? '' : 's'}`),
        days ? h('span.chip', `Day ${days}`) : null,
        todayHas ? h('span.chip.good', icon('check', 14), 'Today done') : null));
    };

    const drawView = () => {
      clear(content); pool.revokeAll();
      if (!photos.length) {
        content.append(
          empty('No progress photos yet', 'Same spot, same light, same pose every day. The ghost overlay helps you match yesterday\'s frame.', 'camera'),
          h('button.btn.primary.block', { onclick: () => openCamera(ctx) }, icon('camera', 20), 'Take today\'s photo'));
        return;
      }
      if (view === 'compare') return drawCompare();
      if (view === 'timelapse') return drawTimelapse();
      drawGallery();
    };

    const drawGallery = () => {
      const todayHas = photos.some((p) => p.date === dates.today());
      if (!todayHas) content.append(h('button.btn.primary.block.mb', { onclick: () => openCamera(ctx) }, icon('camera', 20), 'Take today\'s photo'));
      const desc = [...photos].reverse();
      const groups = new Map();
      for (const p of desc) { const k = (p.date || '').slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
      for (const [month, list] of groups) {
        content.append(h('div.section-title', month ? dates.monthLabel(month + '-01') : 'Undated'), h('div.small.muted.mb', `${list.length} photo${list.length === 1 ? '' : 's'}`));
        const grid = h('div.photo-grid');
        for (const p of list) {
          const img = h('img', { alt: dates.label(p.date), loading: 'lazy' });
          img.src = pool.url(thumbBlob(p));
          const w = weightLabel(p.weightKg, ctx);
          const tile = h('div.photo-thumb.tappable', { onclick: () => openViewer(ctx, [...photos], photos.indexOf(p)) }, img,
            p.date === dates.today() ? h('span.checkbox.checked.ph-badge', icon('check', 12)) : null,
            h('div.date', shortDate(p.date) + (w ? ` · ${w}` : '')));
          grid.append(tile);
        }
        content.append(grid);
      }
    };

    const optionLabel = (p) => {
      const sameDay = photos.filter((x) => x.date === p.date).length > 1;
      const w = weightLabel(p.weightKg, ctx);
      // compact: "12 Mar" (+ year only when it differs from this year) so the distinguishing part fits a half-width select
      let d = shortDate(p.date);
      if ((p.date || '').slice(0, 4) !== dates.today().slice(0, 4)) d += ` ${(p.date || '').slice(0, 4)}`;
      return d + (sameDay && p.time ? ` ${p.time}` : '') + (w ? ` · ${w}` : '');
    };

    const drawCompare = () => {
      if (photos.length < 2) { content.append(empty('Need at least two photos to compare', 'Take tomorrow\'s photo and come back.', 'camera')); return; }
      // cmpA/cmpB stay null until the user picks explicitly, so the defaults keep tracking first / latest after new photos
      const a = photos.find((p) => p.id === cmpA) || photos[0];
      const b = photos.find((p) => p.id === cmpB) || photos[photos.length - 1];
      const sel = (cur, caption, onPick) => {
        const el = h('select.input', { 'aria-label': `${caption} photo`, onchange: () => { onPick(el.value); drawView(); } });
        for (const p of photos) el.append(h('option', { value: p.id }, optionLabel(p)));
        el.value = cur.id;
        return h('label.field', { style: { gap: '4px' } }, h('span.ph-cmp-label', caption), el);
      };
      const side = (p) => {
        const img = h('img', { alt: dates.label(p.date), onclick: () => openViewer(ctx, [...photos], photos.indexOf(p)) });
        img.src = pool.url(imgBlob(p));
        const w = weightLabel(p.weightKg, ctx);
        return h('div.stack', { style: { gap: '6px' } }, img, h('div.small.muted', { style: { textAlign: 'center' } }, dates.label(p.date, { year: 'auto' }) + (w ? ` · ${w}` : '')));
      };
      const daysApart = Math.abs(dates.daysBetween(a.date, b.date));
      const diff = weightDiffLabel(a.weightKg, b.weightKg, ctx);
      content.append(
        h('div.compare.mb', sel(a, 'Before', (id) => { cmpA = id; }), sel(b, 'After', (id) => { cmpB = id; })),
        h('div.compare', side(a), side(b)),
        h('div.row.wrap.mt', { style: { justifyContent: 'center' } },
          h('span.chip', `${daysApart} day${daysApart === 1 ? '' : 's'} apart`),
          diff ? h('span.chip.accent', icon('scale', 14), diff) : h('span.chip', 'No weight on both days')),
        h('button.btn.block.ghost.mt', { onclick: () => { cmpA = null; cmpB = null; drawView(); } }, icon('refresh', 18), 'First vs latest'));
    };

    const drawTimelapse = () => {
      if (tlIndex < 0 || tlIndex >= photos.length) tlIndex = photos.length - 1;
      const img = h('img.ph-large', { alt: 'Timelapse frame' });
      const label = h('div.row.wrap', { style: { justifyContent: 'center' } });
      const slider = h('input', { type: 'range', min: 0, max: photos.length - 1, step: 1, 'aria-label': 'Scrub photos' });
      slider.value = String(tlIndex);
      const show = (idx) => {
        tlIndex = Math.max(0, Math.min(idx, photos.length - 1));
        const p = photos[tlIndex];
        img.src = pool.url(imgBlob(p));
        slider.value = String(tlIndex);
        clear(label);
        const w = weightLabel(p.weightKg, ctx);
        label.append(h('span.chip.accent', dates.label(p.date, { year: 'auto' })), w ? h('span.chip.good', w) : null, h('span.chip', `${tlIndex + 1} / ${photos.length}`));
      };
      slider.addEventListener('input', () => { stopPlay(); setPlayLabel(); show(Number(slider.value)); });
      const playBtn = h('button.btn.primary.block', { onclick: () => {
        if (playTimer) { stopPlay(); setPlayLabel(); return; }
        if (tlIndex >= photos.length - 1) show(0);
        playTimer = setInterval(() => { if (tlIndex >= photos.length - 1) { stopPlay(); setPlayLabel(); return; } show(tlIndex + 1); }, FRAME_MS);
        setPlayLabel();
      } });
      const setPlayLabel = () => { clear(playBtn); playBtn.append(icon(playTimer ? 'close' : 'chevron', 20), playTimer ? 'Pause' : 'Play'); };
      setPlayLabel();
      // warm the URLs so playback does not stutter on first pass
      for (const p of photos) pool.url(imgBlob(p));
      show(tlIndex);
      content.append(h('div.stack', img, label, slider, playBtn, h('div.ph-cap', `${photos.length} frames · ${FRAME_MS} ms each`)));
    };

    const load = async () => {
      try { photos = await loadAll(ctx); } catch (e) { console.error(e); photos = []; }
      stopPlay();
      drawHeader();
      drawView();
    };
    await load();
    const off = ctx.db.onChange(STORE, load);
    const offWeights = ctx.db.onChange('weights', load); // weight chips are joined at read time, so re-draw on weigh-ins too
    if (ctx.params?.add === '1') openCamera(ctx);

    return () => {
      off(); offWeights(); stopPlay(); pool.revokeAll();
      if (activeCameraClose) { try { activeCameraClose(); } catch {} activeCameraClose = null; }
    };
  },

  quickActions: [{ label: 'Progress photo', icon: 'camera', run: async (ctx) => { await openCamera(ctx); } }],

  async todayCard(ctx) {
    injectStyle();
    const photos = await loadAll(ctx);
    const today = dates.today();
    const todays = photos.filter((p) => p.date === today);
    const days = distinctDays(photos);
    const streak = streakDays(photos);
    const title = h('div.card-title', h('h3', 'Progress photo'), h('button.link', { style: LINK_STYLE, onclick: (e) => { e.stopPropagation(); ctx.nav('body/photos'); } }, 'Open'));
    if (todays.length) {
      const p = todays[todays.length - 1];
      const img = h('img.ph-today-thumb', { alt: 'Today\'s photo' });
      const url = URL.createObjectURL(thumbBlob(p));
      img.onload = () => URL.revokeObjectURL(url); img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
      const w = weightLabel(p.weightKg, ctx);
      return card({ class: 'tappable', onclick: () => ctx.nav('body/photos') }, title,
        h('div.row', img, h('div.grow',
          h('div.row', h('span.checkbox.checked', icon('check')), h('strong', `Day ${days}`)),
          h('div.small.muted', `Today's photo is in${w ? ' · ' + w : ''}`),
          streak > 1 ? h('div.streak.small.mt', icon('flame', 14), `${streak} day streak`) : null)));
    }
    return card(title,
      h('p.small.muted', photos.length ? `Day ${days + 1} — keep the streak${streak ? ` (${streak} so far)` : ''}. Same spot, same light.` : 'Start your visual log: one photo a day, same spot, same pose.'),
      h('button.btn.primary.block', { onclick: () => openCamera(ctx) }, icon('camera', 20), 'Take today\'s photo'));
  },

  async exportForAI(ctx, { since, days } = {}) {
    const photos = await loadAll(ctx);
    if (!photos.length) return '';
    const today = dates.today();
    const first = photos[0], latest = photos[photos.length - 1];
    const streak = streakDays(photos);
    const sinceKey = since || dates.addDays(today, -(days || 90));
    const inRange = photos.filter((p) => p.date >= sinceKey);
    const periodDays = Math.max(1, dates.daysBetween(sinceKey, today) + 1);
    const daysWith = distinctDays(inRange);
    const lines = [];
    lines.push('## Progress photos');
    lines.push(`- Total: ${photos.length} photos on ${distinctDays(photos)} days (first ${first.date}, latest ${latest.date}, ${dates.ago(latest.date)}). Current streak: ${streak} day${streak === 1 ? '' : 's'}.`);
    lines.push(`- Since ${sinceKey}: ${inRange.length} photos on ${daysWith}/${periodDays} days (${Math.round((daysWith / periodDays) * 100)}% adherence).`);
    const withW = photos.filter((p) => p.weightKg != null);
    if (withW.length >= 2) lines.push(`- Weight on photo days: ${fmt.num(withW[0].weightKg, 1)} kg (${withW[0].date}) → ${fmt.num(withW[withW.length - 1].weightKg, 1)} kg (${withW[withW.length - 1].date}).`);
    // photos per week
    const weeks = new Map();
    for (const p of inRange) { const w = dates.weekStart(p.date); weeks.set(w, (weeks.get(w) || 0) + 1); }
    if (weeks.size) lines.push('- Photos per week (week starting): ' + [...weeks.entries()].sort().map(([w, n]) => `${w}: ${n}`).join(', '));
    // notes
    const noted = inRange.filter((p) => (p.note || '').trim()).reverse().slice(0, 40);
    if (noted.length) {
      lines.push('- Notes:');
      for (const p of noted) lines.push(`  - ${p.date}: ${String(p.note).trim().slice(0, 300).replace(/\s+/g, ' ')}`);
    }
    lines.push('- (Image data is not included here; the AI module attaches selected photos itself.)');
    return lines.join('\n').slice(0, 8000);
  },

  // Read-only: photos must be taken in the UI (camera / gallery), so there are no write actions.
  actions: [
    {
      name: 'list',
      description: 'List progress photos (newest first) with id, date, time, weight on that day and note. Never returns image data. Use from_date/to_date (YYYY-MM-DD) to narrow; omit both for the most recent photos.',
      params: {
        from_date: { type: 'string', description: 'Only photos on or after this date, YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Only photos on or before this date, YYYY-MM-DD' },
        with_note_only: { type: 'boolean', description: 'true = only photos that have a note' },
        limit: { type: 'integer', description: 'Max rows to return (1-20, default 20)' },
      },
      write: false,
      async run(ctx, args = {}) {
        const from = actionDate(args.from_date, 'from_date');
        const to = actionDate(args.to_date, 'to_date');
        if (from && to && from > to) throw new Error('from_date must not be after to_date');
        let limit = args.limit === undefined || args.limit === null ? ACTION_ROWS : Number(args.limit);
        if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a whole number from 1 to ' + ACTION_ROWS);
        limit = Math.min(limit, ACTION_ROWS);
        const photos = await loadAll(ctx);
        if (!photos.length) return 'No progress photos yet. Photos are taken in the app (Body > Progress photos).';
        let rows = photos;
        if (from) rows = rows.filter((p) => p.date >= from);
        if (to) rows = rows.filter((p) => p.date <= to);
        if (args.with_note_only) rows = rows.filter((p) => (p.note || '').trim());
        if (!rows.length) return `No photos match${from ? ' from ' + from : ''}${to ? ' to ' + to : ''}${args.with_note_only ? ' with a note' : ''} (${photos.length} photos total).`;
        const shown = [...rows].reverse().slice(0, limit);
        const lines = [`${rows.length} photo${rows.length === 1 ? '' : 's'}${from || to ? ' in range' : ''} (${photos.length} total). Format: id | date time | weight | note`];
        for (const p of shown) lines.push(photoLine(p, ctx));
        if (rows.length > shown.length) lines.push(`… ${rows.length - shown.length} older not shown; narrow with from_date/to_date.`);
        return lines.join('\n').slice(0, 1500);
      },
    },
    {
      name: 'get',
      description: 'Get one progress photo by id: date, time, weight on that day and the full note. Never returns image data.',
      params: {
        id: { type: 'string', description: 'Photo id (from photos_list)' },
      },
      required: ['id'],
      write: false,
      async run(ctx, args = {}) {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) throw new Error('id is required');
        const photos = await loadAll(ctx);
        const i = photos.findIndex((p) => p.id === id);
        if (i < 0) throw new Error(`No photo with id ${id}`);
        const p = photos[i];
        const w = weightLabel(p.weightKg, ctx);
        const sameDay = photos.filter((x) => x.date === p.date).length;
        const lines = [
          `Photo ${p.id} — ${p.date}${p.time ? ' ' + p.time : ''} (${dates.label(p.date)}${dates.daysBetween(p.date, dates.today()) > 1 ? ', ' + dates.ago(p.date) : ''}), #${i + 1} of ${photos.length}${sameDay > 1 ? ', ' + sameDay + ' photos that day' : ''}.`,
          `Weight that day: ${w || 'not logged'}.`,
          `Note: ${(p.note || '').trim() ? String(p.note).trim().slice(0, 600) : '(none)'}`,
        ];
        return lines.join('\n').slice(0, 1500);
      },
    },
    {
      name: 'summary',
      description: 'Summary of the progress-photo habit: total photos, days covered, current streak, adherence since a date, first/latest photo (with ids) and weight change between them. Read-only.',
      params: {
        since: { type: 'string', description: 'Start of the adherence window, YYYY-MM-DD (default: 30 days ago)' },
      },
      write: false,
      async run(ctx, args = {}) {
        const today = dates.today();
        const since = actionDate(args.since, 'since') || dates.addDays(today, -30);
        if (since > today) throw new Error('since must not be in the future');
        const photos = await loadAll(ctx);
        if (!photos.length) return 'No progress photos yet. Photos are taken in the app (Body > Progress photos).';
        const first = photos[0], latest = photos[photos.length - 1];
        const inRange = photos.filter((p) => p.date >= since);
        const periodDays = dates.daysBetween(since, today) + 1;
        const daysWith = distinctDays(inRange);
        const streak = streakDays(photos);
        const lines = [
          `Total: ${photos.length} photos on ${distinctDays(photos)} days. Current streak: ${streak} day${streak === 1 ? '' : 's'}. Today's photo: ${photos.some((p) => p.date === today) ? 'done' : 'not yet'}.`,
          `Since ${since}: ${inRange.length} photos on ${daysWith}/${periodDays} days (${Math.round((daysWith / periodDays) * 100)}% adherence).`,
          `First: ${photoLine(first, ctx, { noteChars: 60 })}`,
          `Latest: ${photoLine(latest, ctx, { noteChars: 60 })} (${dates.ago(latest.date)})`,
        ];
        const withW = photos.filter((p) => p.weightKg != null);
        if (withW.length >= 2) {
          const a = withW[0], b = withW[withW.length - 1];
          lines.push(`Weight on photo days: ${weightLabel(a.weightKg, ctx)} (${a.date}) → ${weightLabel(b.weightKg, ctx)} (${b.date}), ${weightDiffLabel(a.weightKg, b.weightKg, ctx)} over ${dates.daysBetween(a.date, b.date)} days.`);
        }
        return lines.join('\n').slice(0, 1500);
      },
    },
  ],
};
