// face.js — daily face photos from three angles (front, left profile, right profile) to see changes over time.
// Store: faces { id, date 'YYYY-MM-DD', time 'HH:MM', angle 'front'|'left'|'right', blob (≤1080px JPEG), thumb (≤320px), note }
// One photo per angle per day: retaking an angle replaces that day's photo for it.
// The camera code is adapted from photos.js (modules may not import each other's internals).
import { h, clear, dates, icon, toast, sheet, confirm, formSheet, segmented, empty, card, fab, resizeImage, pickFile } from '../ui.js';

const STORE = 'faces';
const FULL_SIDE = 1080;
const THUMB_SIDE = 320;
const FRAME_MS = 450;
const LINK_STYLE = { padding: '10px 0 10px 12px', minHeight: '44px' };
const ANGLES = [
  { id: 'front', label: 'Front', short: 'Front', hint: 'Look straight into the lens. Neutral face, chin level, hair off the face.' },
  { id: 'left', label: 'Left side', short: 'Left', hint: 'Turn your head to the right until the camera sees only your left profile.' },
  { id: 'right', label: 'Right side', short: 'Right', hint: 'Turn your head to the left until the camera sees only your right profile.' },
];
const ANGLE_IDS = ANGLES.map((a) => a.id);
const angleOf = (id) => ANGLES.find((a) => a.id === id) || ANGLES[0];

// ---------- styles ----------
function injectStyle() {
  if (document.getElementById('face-style')) return;
  document.head.append(h('style#face-style', `
.fc-controls{display:flex;align-items:center;justify-content:space-around;margin-top:4px}
.fc-controls .shutter{margin:0}
.fc-controls .shutter:active{transform:scale(.94)}
.fc-round{width:50px;height:50px;border-radius:50%;background:var(--card-2);color:var(--text);display:inline-flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid var(--border);font-size:10px;font-weight:700;gap:0}
.fc-round.on{background:var(--accent);color:var(--accent-text);border-color:transparent}
.fc-countdown{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:110px;font-weight:800;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.7);pointer-events:none}
.fc-guide{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.sheet .fc-cam{width:min(100%,calc((92vh - 300px) * .75));max-width:100%;margin:0 auto}
.fc-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.fc-step{min-height:40px;border-radius:10px;border:1px solid var(--border);background:var(--card-2);color:var(--text-2);font:inherit;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer}
.fc-step.cur{border-color:var(--accent);color:var(--text);background:color-mix(in srgb,var(--accent) 18%,var(--card-2))}
.fc-step.done{color:var(--good)}
.fc-hint{font-size:13px;color:var(--text-2);text-align:center;line-height:1.4}
.fc-preview{width:100%;aspect-ratio:3/4;object-fit:cover;background:#000;border-radius:14px;display:block}
.fc-large{width:100%;aspect-ratio:3/4;object-fit:contain;background:#000;border-radius:14px;display:block}
.fc-day{margin-bottom:14px}
.fc-day-head{display:flex;align-items:baseline;justify-content:space-between;margin:0 2px 6px}
.fc-day-head .t{font-weight:700}
.fc-row{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.fc-slot{aspect-ratio:3/4;border-radius:10px;overflow:hidden;background:var(--card-2);position:relative;border:0;padding:0;cursor:pointer;display:block;width:100%}
.fc-slot img{width:100%;height:100%;object-fit:cover;display:block}
.fc-slot .lbl{position:absolute;left:0;right:0;bottom:0;font-size:10px;font-weight:600;padding:3px 6px;background:linear-gradient(transparent,rgba(0,0,0,.7));color:#fff;text-align:left}
.fc-slot.missing{border:1.5px dashed var(--border);background:transparent;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:var(--muted);font-size:11px;font-weight:600}
.fc-blend{position:relative;width:100%;aspect-ratio:3/4;border-radius:14px;overflow:hidden;background:#000}
.fc-blend img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.fc-today-row{display:grid;grid-template-columns:repeat(3,52px);gap:6px}
.fc-today-row .fc-slot{border-radius:8px}
.fc-cmp-label{font-size:12px;font-weight:600;color:var(--text-2)}
`));
}

// ---------- helpers ----------
function urlPool() {
  const urls = new Map();
  return {
    url(blob) { if (!(blob instanceof Blob)) return ''; let u = urls.get(blob); if (!u) { u = URL.createObjectURL(blob); urls.set(blob, u); } return u; },
    revokeAll() { for (const u of urls.values()) { try { URL.revokeObjectURL(u); } catch {} } urls.clear(); },
  };
}
function nowTime() { const d = new Date(); return `${dates.pad(d.getHours())}:${dates.pad(d.getMinutes())}`; }
const imgBlob = (p) => (p?.blob instanceof Blob ? p.blob : p?.thumb instanceof Blob ? p.thumb : null);
const thumbBlob = (p) => (p?.thumb instanceof Blob ? p.thumb : p?.blob instanceof Blob ? p.blob : null);
function shortDate(key) { try { return dates.parse(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(key.slice(0, 4) !== dates.today().slice(0, 4) ? { year: 'numeric' } : {}) }); } catch { return key || ''; } }

async function loadAll(ctx) {
  const rows = await ctx.db.all(STORE);
  return rows
    .filter((p) => p && imgBlob(p) && typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .map((p) => ({ ...p, angle: ANGLE_IDS.includes(p.angle) ? p.angle : 'front', time: typeof p.time === 'string' ? p.time : '', note: typeof p.note === 'string' ? p.note : '' }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '') < (b.time || '') ? -1 : 1));
}
/** [{ date, front, left, right }] newest day first. */
function byDay(photos) {
  const map = new Map();
  for (const p of photos) {
    if (!map.has(p.date)) map.set(p.date, { date: p.date });
    map.get(p.date)[p.angle] = p; // later (by time) wins if old data ever has duplicates
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}
function streakDays(photos) {
  const set = new Set(photos.map((p) => p.date));
  let d = dates.today();
  if (!set.has(d)) d = dates.addDays(d, -1);
  let n = 0;
  while (set.has(d)) { n++; d = dates.addDays(d, -1); }
  return n;
}
const countAngles = (day) => ANGLE_IDS.filter((a) => day?.[a]).length;

/** Save (or replace) the photo for one angle on one day. */
async function saveFace(ctx, sourceBlob, { date, angle, note = '' }) {
  const [blob, thumb] = await Promise.all([resizeImage(sourceBlob, FULL_SIDE, 0.86), resizeImage(sourceBlob, THUMB_SIDE, 0.8)]);
  let d = date || dates.today();
  if (d > dates.today()) d = dates.today();
  const existing = (await ctx.db.where(STORE, 'date', d)).filter((p) => p.angle === angle);
  const keepNote = existing.find((p) => p.note)?.note || '';
  const saved = await ctx.db.put(STORE, { ...(existing[0] || {}), date: d, time: nowTime(), angle, blob, thumb, note: (note || keepNote || '').trim() });
  for (const dup of existing.slice(existing[0] ? 1 : 0)) await ctx.db.delete(STORE, dup.id);
  return saved;
}

/** Thin alignment guide drawn over the camera: face oval + eye line for front, profile oval + ear line for sides. */
function guideSvg(angle) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 300 400');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.classList.add('fc-guide');
  const line = 'stroke="rgba(255,255,255,.6)" stroke-width="2" fill="none" stroke-dasharray="7 6"';
  svg.innerHTML = angle === 'front'
    ? `<ellipse cx="150" cy="185" rx="92" ry="124" ${line}/><line x1="150" y1="50" x2="150" y2="330" ${line} opacity=".45"/><line x1="70" y1="170" x2="230" y2="170" ${line} opacity=".7"/>`
    : `<ellipse cx="150" cy="185" rx="80" ry="124" ${line}/><line x1="150" y1="50" x2="150" y2="330" ${line} opacity=".45"/><line x1="60" y1="170" x2="240" y2="170" ${line} opacity=".7"/><circle cx="${angle === 'left' ? 175 : 125}" cy="190" r="14" ${line} opacity=".7"/>`;
  return svg;
}

// ---------- guided camera: front → left → right ----------
let activeCameraClose = null;

async function openCamera(ctx, { angle: startAngle } = {}) {
  injectStyle();
  if (activeCameraClose) { try { activeCameraClose(); } catch {} }
  const pool = urlPool();
  const today = dates.today();
  let stream = null, streamReq = 0, countdownTimer = null, closed = false;
  let facing = ctx.settings.get('face:facing', 'user');
  let timerOn = !!ctx.settings.get('face:timer', false);
  let ghostOn = ctx.settings.get('face:ghost', true) !== false;

  const all = await loadAll(ctx);
  const todayDay = byDay(all.filter((p) => p.date === today))[0] || { date: today };
  const doneToday = new Set(ANGLE_IDS.filter((a) => todayDay[a]));
  let idx = startAngle ? ANGLE_IDS.indexOf(startAngle) : ANGLE_IDS.findIndex((a) => !doneToday.has(a));
  if (idx < 0) idx = 0;

  /** Ghost for an angle: the most recent photo of that angle from before today (else today's own). */
  const ghostFor = (angle) => {
    const list = all.filter((p) => p.angle === angle);
    return list.filter((p) => p.date < today).slice(-1)[0] || list.slice(-1)[0] || null;
  };

  const video = h('video', { autoplay: true, muted: true, playsinline: true });
  video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
  const ghost = h('img.ghost', { alt: '' });
  const countdown = h('div.fc-countdown');
  const guideHolder = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
  const camWrap = h('div.camera-wrap.fc-cam', video, ghost, guideHolder, countdown);
  const noticeBox = h('div');
  const steps = h('div.fc-steps');
  const hint = h('div.fc-hint');
  const ghostCap = h('div.small.muted', { style: { textAlign: 'center' } });

  const s = sheet({
    title: 'Face photos',
    full: true,
    onClose: () => { closed = true; cancelCountdown(); stopStream(); pool.revokeAll(); if (activeCameraClose === s.close) activeCameraClose = null; },
  });
  activeCameraClose = s.close;
  const body = s.body;

  const stopStream = () => { if (stream) { for (const t of stream.getTracks()) { try { t.stop(); } catch {} } stream = null; } };
  function cancelCountdown() { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } countdown.textContent = ''; }

  const timerBtn = h('button.fc-round', { type: 'button', 'aria-label': '3 second timer', class: timerOn ? 'on' : '', onclick: () => { timerOn = !timerOn; ctx.settings.set('face:timer', timerOn); timerBtn.classList.toggle('on', timerOn); } }, icon('refresh', 18), h('span', '3s'));
  const ghostBtn = h('button.fc-round', { type: 'button', 'aria-label': 'Ghost overlay of your last photo', class: ghostOn ? 'on' : '', onclick: () => { ghostOn = !ghostOn; ctx.settings.set('face:ghost', ghostOn); ghostBtn.classList.toggle('on', ghostOn); paintStep(); } }, icon('eye', 18), h('span', 'Ghost'));
  const swapBtn = h('button.fc-round', { type: 'button', 'aria-label': 'Switch camera', onclick: async () => { facing = facing === 'user' ? 'environment' : 'user'; ctx.settings.set('face:facing', facing); await startStream(); } }, icon('swap', 20));
  const shutter = h('button.shutter', { type: 'button', 'aria-label': 'Take photo', onclick: () => {
    if (countdownTimer) { cancelCountdown(); return; }
    if (!timerOn) return capture();
    let n = 3; countdown.textContent = String(n);
    countdownTimer = setInterval(() => { n--; if (n <= 0) { cancelCountdown(); capture(); } else countdown.textContent = String(n); }, 1000);
  } });
  const galleryBtn = h('button.btn.block', { type: 'button', onclick: async () => { const f = await pickFile({ accept: 'image/*' }); if (f) showPreview(f); } }, icon('upload', 20), 'Choose from gallery');
  const skipBtn = h('button.btn.block.ghost', { type: 'button', onclick: () => next() });
  const controls = h('div.fc-controls', timerBtn, shutter, ghostBtn, swapBtn);
  const liveStage = h('div.stack', steps, hint, noticeBox, camWrap, ghostCap, controls, galleryBtn, skipBtn);

  function paintSteps() {
    clear(steps);
    ANGLES.forEach((a, i) => steps.append(h('button.fc-step', {
      type: 'button', class: (i === idx ? 'cur' : '') + (doneToday.has(a.id) ? ' done' : ''),
      'aria-label': `${a.label}${doneToday.has(a.id) ? ', done today' : ''}`,
      onclick: () => { idx = i; showLive(); },
    }, doneToday.has(a.id) ? icon('check', 14) : null, a.short)));
  }
  function paintStep() {
    const a = ANGLES[idx];
    s.el.querySelector('.sheet-title')?.replaceChildren(document.createTextNode(`Face photos · ${a.label}`));
    hint.textContent = a.hint;
    clear(guideHolder); guideHolder.append(guideSvg(a.id));
    const g = ghostFor(a.id);
    ghost.style.display = g && ghostOn ? '' : 'none';
    if (g) ghost.src = pool.url(imgBlob(g));
    ghostCap.textContent = g ? (ghostOn ? `Ghost: your ${a.label.toLowerCase()} from ${dates.label(g.date)} — line up with it` : 'Ghost hidden') : `First ${a.label.toLowerCase()} photo — use a spot and light you can repeat`;
    const remaining = ANGLE_IDS.filter((x, i) => i > idx && !doneToday.has(x));
    skipBtn.textContent = remaining.length ? `Skip ${a.label.toLowerCase()} for now` : 'Done for now';
    paintSteps();
  }

  function showFallback(msg) {
    clear(noticeBox);
    noticeBox.append(h('div.notice', h('div', msg), h('button.btn.primary.block.mt', { type: 'button', onclick: async () => { const f = await pickFile({ accept: 'image/*', capture: 'user' }); if (f) showPreview(f); } }, icon('camera', 20), 'Open phone camera')));
    camWrap.classList.add('hidden'); ghostCap.classList.add('hidden'); controls.classList.add('hidden');
  }
  function showLive() {
    clear(body); body.append(liveStage);
    clear(noticeBox); camWrap.classList.remove('hidden'); ghostCap.classList.remove('hidden'); controls.classList.remove('hidden');
    paintStep();
    resumeVideo();
  }
  /** Removing the <video> from the page (to show the preview) pauses it, so coming back to the camera has to play it
   *  again, or the next angle shows a frozen frame. A stream whose track ended (camera taken by another app, phone
   *  locked) is reopened instead. */
  function resumeVideo() {
    const live = stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
    if (!live) { startStream(); return; }
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play().catch(() => startStream());
  }

  async function startStream() {
    const myReq = ++streamReq;
    stopStream();
    if (!navigator.mediaDevices?.getUserMedia) { showFallback('In-app camera is not available here (needs HTTPS and a camera). Use your phone camera instead:'); return; }
    swapBtn.disabled = true;
    try {
      const s2 = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1080 }, height: { ideal: 1440 } } });
      if (closed || myReq !== streamReq) { for (const t of s2.getTracks()) { try { t.stop(); } catch {} } return; }
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
    } finally { if (myReq === streamReq) swapBtn.disabled = false; }
  }

  function capture() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { toast('Camera is still starting…'); return; }
    if (video.paused) { resumeVideo(); toast('Camera was paused — try again'); return; } // never save a stale frame
    const ratio = 3 / 4;
    let cw = vw, ch = vh;
    if (vw / vh > ratio) cw = Math.round(vh * ratio); else ch = Math.round(vw / ratio);
    const sx = Math.round((vw - cw) / 2), sy = Math.round((vh - ch) / 2);
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    cv.getContext('2d').drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch);
    if (navigator.vibrate) navigator.vibrate(15);
    cv.toBlob((b) => { if (b) showPreview(b); else toast('Capture failed — try again'); }, 'image/jpeg', 0.92);
  }

  function showPreview(blob) {
    cancelCountdown();
    const a = ANGLES[idx];
    const preview = h('img.fc-preview', { alt: `${a.label} photo` });
    preview.src = pool.url(blob);
    const isLast = ANGLE_IDS.every((x, i) => i <= idx || doneToday.has(x));
    const saveBtn = h('button.btn.primary.block', { type: 'button', onclick: async () => {
      saveBtn.disabled = true;
      try {
        await saveFace(ctx, blob, { date: today, angle: a.id });
        doneToday.add(a.id);
        if (navigator.vibrate) navigator.vibrate(10);
        next(true);
      } catch (e) { console.error(e); toast('Could not save: ' + (e.message || e)); saveBtn.disabled = false; }
    } }, icon('check', 20), isLast ? `Save ${a.label.toLowerCase()}` : `Save & next`);
    const retake = h('button.btn.block', { type: 'button', onclick: () => showLive() }, icon('camera', 20), 'Retake');
    clear(body);
    body.append(h('div.stack', steps, preview, saveBtn, retake));
    paintSteps();
  }

  /** Go to the next angle still missing today, or finish. */
  function next(justSaved = false) {
    const after = ANGLE_IDS.findIndex((x, i) => i > idx && !doneToday.has(x));
    const any = after >= 0 ? after : ANGLE_IDS.findIndex((x) => !doneToday.has(x));
    if (any < 0 || (!justSaved && after < 0)) {
      if (doneToday.size === ANGLE_IDS.length) toast('All 3 face photos saved for today');
      else if (justSaved) toast('Saved');
      s.close();
      return;
    }
    if (justSaved) toast(`${ANGLES[idx].label} saved`);
    idx = any;
    showLive();
  }

  showLive();
  return s;
}

// ---------- viewer: one day, all angles ----------
function openViewer(ctx, days, dayIndex, angle) {
  injectStyle();
  const pool = urlPool();
  let i = Math.max(0, Math.min(dayIndex, days.length - 1));
  let ang = angle;
  const s = sheet({ title: 'Face photos', full: true, onClose: () => pool.revokeAll() });
  // When moving between days, land on an angle that exists; an angle the user picked explicitly is shown even if missing.
  let picked = false;
  const draw = () => {
    const day = days[i];
    if (!day) { s.close(); return; }
    if (!day[ang] && !picked) ang = ANGLE_IDS.find((a) => day[a]) || 'front';
    picked = false;
    const p = day[ang];
    clear(s.body);
    const seg = segmented(ANGLES.map((a) => ({ value: a.id, label: day[a.id] ? a.short : `${a.short} –` })), ang, (v) => { ang = v; picked = true; draw(); });
    const img = p ? h('img.fc-large', { alt: `${angleOf(ang).label} photo` }) : null;
    if (img) img.src = pool.url(imgBlob(p));
    const nav = h('div.row',
      h('button.btn.grow', { type: 'button', disabled: i >= days.length - 1, onclick: () => { i++; draw(); } }, icon('back', 20), 'Older'),
      h('button.btn.grow', { type: 'button', disabled: i === 0, onclick: () => { i--; draw(); } }, 'Newer', icon('chevron', 20)));
    const isToday = day.date === dates.today();
    s.body.append(h('div.stack',
      seg,
      img || h('div.fc-slot.missing', { style: { aspectRatio: '3/4' } }, icon('camera', 28), 'No photo for this angle'),
      h('div.row.wrap', h('span.chip.accent', dates.label(day.date, { year: 'auto' })), p?.time ? h('span.chip', p.time) : null, h('span.chip', `${countAngles(day)}/3 angles`)),
      p?.note ? h('p', { style: { margin: '0' } }, p.note) : null,
      nav,
      isToday ? h('button.btn.block', { type: 'button', onclick: () => { s.close(); openCamera(ctx, { angle: ang }); } }, icon('camera', 20), p ? `Retake ${angleOf(ang).label.toLowerCase()}` : `Take ${angleOf(ang).label.toLowerCase()}`) : null,
      p ? h('button.btn.block', { type: 'button', onclick: () => editNote(ctx, p, (rec) => { day[ang] = rec; draw(); }) }, icon('edit', 20), p.note ? 'Edit note' : 'Add note') : null,
      p ? h('button.btn.block.danger', { type: 'button', onclick: async () => {
        if (!(await confirm(`Delete the ${angleOf(ang).label.toLowerCase()} photo from ${dates.label(day.date)}? This cannot be undone.`))) return;
        await ctx.db.delete(STORE, p.id);
        toast('Photo deleted');
        delete day[ang];
        if (!countAngles(day)) { days.splice(i, 1); if (!days.length) { s.close(); return; } i = Math.min(i, days.length - 1); }
        draw();
      } }, icon('trash', 20), 'Delete this photo') : null));
  };
  draw();
  return s;
}

async function editNote(ctx, p, onSaved) {
  const v = await formSheet({ title: 'Note', fields: [{ name: 'note', label: 'Note', type: 'textarea', rows: 3, placeholder: 'Sleep, skin, puffiness, lighting…', autofocus: true }], values: { note: p.note || '' } });
  if (!v) return;
  const saved = await ctx.db.put(STORE, { ...p, note: String(v.note || '').trim() });
  toast('Saved');
  onSaved?.(saved);
}

// ---------- AI action helpers ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function actionDate(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new Error(`${name} must be a date in YYYY-MM-DD format`);
  return v;
}

// ---------- module ----------
export default {
  id: 'face',
  title: 'Face',
  subtitle: 'Daily front & side photos',
  icon: 'face',
  tab: 'body',
  stores: { faces: { indexes: ['date'] } },

  async render(container, ctx) {
    injectStyle();
    const pool = urlPool();
    let view = ctx.settings.get('face:view', 'days');
    if (!['days', 'compare', 'timelapse'].includes(view)) view = 'days';
    let cmpAngle = ctx.settings.get('face:cmpAngle', 'front');
    let cmpMode = ctx.settings.get('face:cmpMode', 'side');
    let cmpA = null, cmpB = null; // photo ids; null = first / latest for the angle
    let tlIndex = -1;
    let showDays = 20;
    let photos = [], days = [];
    let playTimer = null;
    const stopPlay = () => { if (playTimer) { clearInterval(playTimer); playTimer = null; } };

    const header = h('div');
    const seg = segmented([{ value: 'days', label: 'Days' }, { value: 'compare', label: 'Compare' }, { value: 'timelapse', label: 'Timelapse' }], view, (v) => { view = v; ctx.settings.set('face:view', v); stopPlay(); drawView(); });
    const content = h('div.mt');
    container.append(header, seg, content, fab(() => openCamera(ctx), 'Take face photos'));

    const slot = (p, angle, onClick, { label = true } = {}) => {
      if (!p) return h('button.fc-slot.missing', { type: 'button', 'aria-label': `${angleOf(angle).label}: no photo`, onclick: onClick }, icon('plus', 18), angleOf(angle).short);
      const img = h('img', { alt: `${angleOf(angle).label}`, loading: 'lazy' });
      img.src = pool.url(thumbBlob(p));
      return h('button.fc-slot', { type: 'button', 'aria-label': `${angleOf(angle).label} photo`, onclick: onClick }, img, label ? h('span.lbl', angleOf(angle).short) : null);
    };

    const drawHeader = () => {
      clear(header);
      const streak = streakDays(photos);
      const todayDay = days.find((d) => d.date === dates.today());
      const n = countAngles(todayDay);
      header.append(h('div.row.wrap.mb',
        h('span.chip', { class: streak > 0 ? 'warn' : '' }, icon('flame', 14), streak > 0 ? `${streak} day streak` : 'No streak yet'),
        h('span.chip', `${days.length} day${days.length === 1 ? '' : 's'}`),
        n === 3 ? h('span.chip.good', icon('check', 14), 'Today done') : h('span.chip', `Today ${n}/3`)));
    };

    const drawView = () => {
      clear(content); pool.revokeAll();
      if (!photos.length) {
        content.append(
          empty('No face photos yet', 'Every day: one photo from the front, one of your left side and one of your right side. Same spot, same light — the guide and ghost help you line up.', 'face'),
          h('button.btn.primary.block', { type: 'button', onclick: () => openCamera(ctx) }, icon('camera', 20), 'Take today\'s face photos'));
        return;
      }
      if (view === 'compare') return drawCompare();
      if (view === 'timelapse') return drawTimelapse();
      drawDays();
    };

    const drawDays = () => {
      const today = dates.today();
      const todayDay = days.find((d) => d.date === today);
      const n = countAngles(todayDay);
      if (n < 3) content.append(h('button.btn.primary.block.mb', { type: 'button', onclick: () => openCamera(ctx) }, icon('camera', 20), n ? `Finish today's photos (${n}/3)` : 'Take today\'s face photos'));
      const list = todayDay ? days : [{ date: today }, ...days];
      for (const day of list.slice(0, showDays)) {
        const di = days.indexOf(day);
        const open = (angle) => (di < 0 || !day[angle]) && day.date === today ? openCamera(ctx, { angle }) : di >= 0 ? openViewer(ctx, [...days], di, angle) : null;
        content.append(h('div.fc-day',
          h('div.fc-day-head', h('span.t', dates.label(day.date)), h('span.small.muted', `${countAngles(day)}/3${day.front?.note || day.left?.note || day.right?.note ? ' · note' : ''}`)),
          h('div.fc-row', ANGLE_IDS.map((a) => (day[a] || day.date === today ? slot(day[a], a, () => open(a)) : h('div.fc-slot.missing', { 'aria-label': `${angleOf(a).label}: no photo` }, '—'))))));
      }
      if (list.length > showDays) content.append(h('button.btn.block.ghost', { type: 'button', onclick: () => { showDays += 30; drawView(); } }, `Show older days (${list.length - showDays} more)`));
    };

    const anglePicker = (cur, onPick) => segmented(ANGLES.map((a) => ({ value: a.id, label: a.short })), cur, onPick);

    const drawCompare = () => {
      const list = photos.filter((p) => p.angle === cmpAngle);
      content.append(h('div.mb', anglePicker(cmpAngle, (v) => { cmpAngle = v; cmpA = null; cmpB = null; ctx.settings.set('face:cmpAngle', v); drawView(); })));
      if (list.length < 2) { content.append(empty(`Need two ${angleOf(cmpAngle).label.toLowerCase()} photos to compare`, 'Take another one tomorrow and come back.', 'face')); return; }
      const a = list.find((p) => p.id === cmpA) || list[0];
      const b = list.find((p) => p.id === cmpB) || list[list.length - 1];
      const sel = (cur, caption, onPick) => {
        const el = h('select.input', { 'aria-label': `${caption} photo`, onchange: () => { onPick(el.value); drawView(); } });
        for (const p of list) el.append(h('option', { value: p.id }, shortDate(p.date)));
        el.value = cur.id;
        return h('label.field', { style: { gap: '4px' } }, h('span.fc-cmp-label', caption), el);
      };
      content.append(h('div.compare.mb', sel(a, 'Before', (id) => { cmpA = id; }), sel(b, 'After', (id) => { cmpB = id; })));
      content.append(h('div.mb', segmented([{ value: 'side', label: 'Side by side' }, { value: 'blend', label: 'Blend' }], cmpMode, (v) => { cmpMode = v; ctx.settings.set('face:cmpMode', v); drawView(); })));
      if (cmpMode === 'blend') {
        const under = h('img', { alt: 'Before' }), over = h('img', { alt: 'After' });
        under.src = pool.url(imgBlob(a)); over.src = pool.url(imgBlob(b));
        const range = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Blend between before and after' });
        range.value = '50'; over.style.opacity = '.5';
        range.addEventListener('input', () => { over.style.opacity = String(Number(range.value) / 100); });
        content.append(h('div.fc-blend', under, over), h('div.row.between.small.muted.mt', h('span', shortDate(a.date)), h('span', 'Slide to fade'), h('span', shortDate(b.date))), range);
      } else {
        const side = (p) => { const img = h('img', { alt: dates.label(p.date) }); img.src = pool.url(imgBlob(p)); return h('div.stack', { style: { gap: '6px' } }, img, h('div.small.muted', { style: { textAlign: 'center' } }, dates.label(p.date, { year: 'auto' }))); };
        content.append(h('div.compare', side(a), side(b)));
      }
      const apart = Math.abs(dates.daysBetween(a.date, b.date));
      content.append(
        h('div.row.wrap.mt', { style: { justifyContent: 'center' } }, h('span.chip', `${apart} day${apart === 1 ? '' : 's'} apart`)),
        h('button.btn.block.ghost.mt', { type: 'button', onclick: () => { cmpA = null; cmpB = null; drawView(); } }, icon('refresh', 18), 'First vs latest'));
    };

    const drawTimelapse = () => {
      const list = photos.filter((p) => p.angle === cmpAngle);
      content.append(h('div.mb', anglePicker(cmpAngle, (v) => { cmpAngle = v; tlIndex = -1; stopPlay(); ctx.settings.set('face:cmpAngle', v); drawView(); })));
      if (!list.length) { content.append(empty(`No ${angleOf(cmpAngle).label.toLowerCase()} photos yet`, '', 'face')); return; }
      if (tlIndex < 0 || tlIndex >= list.length) tlIndex = list.length - 1;
      const img = h('img.fc-large', { alt: 'Timelapse frame' });
      const label = h('div.row.wrap', { style: { justifyContent: 'center' } });
      const slider = h('input', { type: 'range', min: 0, max: list.length - 1, step: 1, 'aria-label': 'Scrub photos' });
      const show = (k) => {
        tlIndex = Math.max(0, Math.min(k, list.length - 1));
        const p = list[tlIndex];
        img.src = pool.url(imgBlob(p));
        slider.value = String(tlIndex);
        clear(label);
        label.append(h('span.chip.accent', dates.label(p.date, { year: 'auto' })), h('span.chip', `${tlIndex + 1} / ${list.length}`));
      };
      slider.addEventListener('input', () => { stopPlay(); setPlay(); show(Number(slider.value)); });
      const playBtn = h('button.btn.primary.block', { type: 'button', onclick: () => {
        if (playTimer) { stopPlay(); setPlay(); return; }
        if (tlIndex >= list.length - 1) show(0);
        playTimer = setInterval(() => { if (tlIndex >= list.length - 1) { stopPlay(); setPlay(); return; } show(tlIndex + 1); }, FRAME_MS);
        setPlay();
      } });
      const setPlay = () => { clear(playBtn); playBtn.append(icon(playTimer ? 'close' : 'chevron', 20), playTimer ? 'Pause' : 'Play'); };
      setPlay();
      for (const p of list) pool.url(imgBlob(p));
      show(tlIndex);
      content.append(h('div.stack', img, label, slider, playBtn));
    };

    const load = async () => {
      try { photos = await loadAll(ctx); } catch (e) { console.error(e); photos = []; }
      days = byDay(photos);
      stopPlay();
      drawHeader();
      drawView();
    };
    await load();
    const off = ctx.db.onChange(STORE, load);
    if (ctx.params?.add === '1') openCamera(ctx);
    return () => {
      off(); stopPlay(); pool.revokeAll();
      if (activeCameraClose) { try { activeCameraClose(); } catch {} activeCameraClose = null; }
    };
  },

  quickActions: [], // the Today card has its own button; a 9th quick tile would break the 4-column grid

  async todayCard(ctx) {
    injectStyle();
    const photos = await loadAll(ctx);
    const today = dates.today();
    const day = byDay(photos.filter((p) => p.date === today))[0] || { date: today };
    const n = countAngles(day);
    const streak = streakDays(photos);
    const title = h('div.card-title', h('h3', 'Face photos'), h('button.link', { style: LINK_STYLE, onclick: (e) => { e.stopPropagation(); ctx.nav('body/face'); } }, 'Open'));
    if (!photos.length) {
      return card(title,
        h('p.small.muted', 'Front and both sides, once a day, to see how your face changes.'),
        h('button.btn.primary.block', { type: 'button', onclick: () => openCamera(ctx) }, icon('camera', 20), 'Take today\'s face photos'));
    }
    const urls = [];
    const mini = ANGLE_IDS.map((a) => {
      if (!day[a]) return h('div.fc-slot.missing', { style: { cursor: 'default' } }, angleOf(a).short);
      const u = URL.createObjectURL(thumbBlob(day[a])); urls.push(u);
      const img = h('img', { alt: angleOf(a).label }); img.onload = () => URL.revokeObjectURL(u); img.onerror = () => URL.revokeObjectURL(u); img.src = u;
      return h('div.fc-slot', { style: { cursor: 'default' } }, img);
    });
    return card(title,
      h('div.row', { style: { gap: '12px', alignItems: 'center' } }, h('div.fc-today-row', mini),
        h('div.grow',
          h('strong', n === 3 ? 'Done today' : `${n}/3 today`),
          streak > 1 ? h('div.streak.small', icon('flame', 14), `${streak} day streak`) : h('div.small.muted', 'Same spot, same light'))),
      n < 3 ? h('button.btn.primary.block.mt', { type: 'button', onclick: () => openCamera(ctx) }, icon('camera', 20), n ? `Finish today (${n}/3)` : 'Take today\'s face photos') : null);
  },

  async exportForAI(ctx, { since, days } = {}) {
    const photos = await loadAll(ctx);
    if (!photos.length) return '';
    const today = dates.today();
    const sinceKey = since || dates.addDays(today, -(days || 90));
    const allDays = byDay(photos);
    const inRange = allDays.filter((d) => d.date >= sinceKey);
    const periodDays = Math.max(1, dates.daysBetween(sinceKey, today) + 1);
    const full = inRange.filter((d) => countAngles(d) === 3).length;
    const lines = ['## Face photos (front, left side, right side)'];
    lines.push(`- ${allDays.length} days with face photos (first ${allDays[allDays.length - 1].date}, latest ${allDays[0].date}). Current streak: ${streakDays(photos)} day(s).`);
    lines.push(`- Since ${sinceKey}: ${inRange.length}/${periodDays} days (${Math.round((inRange.length / periodDays) * 100)}% adherence), ${full} with all 3 angles.`);
    lines.push('- Per angle: ' + ANGLES.map((a) => `${a.short} ${photos.filter((p) => p.angle === a.id).length}`).join(', '));
    const noted = photos.filter((p) => p.note && p.date >= sinceKey).reverse().slice(0, 30);
    if (noted.length) { lines.push('- Notes:'); for (const p of noted) lines.push(`  - ${p.date} ${angleOf(p.angle).short}: ${p.note.replace(/\s+/g, ' ').slice(0, 300)}`); }
    lines.push('- (Image data is not included in this report.)');
    return lines.join('\n').slice(0, 6000);
  },

  // Read-only: face photos are taken in the app's camera.
  actions: [
    {
      name: 'list',
      description: 'List days with face photos (newest first): which angles were taken (front / left / right), photo ids and notes. Never returns image data. Photos are taken in the app (Body > Face), not by the assistant.',
      params: {
        from_date: { type: 'string', description: 'Only days on or after this date, YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Only days on or before this date, YYYY-MM-DD' },
        limit: { type: 'integer', description: 'Max days (1-20, default 14)' },
      },
      write: false,
      async run(ctx, args = {}) {
        const from = actionDate(args.from_date, 'from_date'), to = actionDate(args.to_date, 'to_date');
        let limit = args.limit == null || args.limit === '' ? 14 : Number(args.limit);
        if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a whole number from 1 to 20');
        limit = Math.min(20, limit);
        const photos = await loadAll(ctx);
        if (!photos.length) return 'No face photos yet. They are taken in the app (Body > Face).';
        let list = byDay(photos);
        if (from) list = list.filter((d) => d.date >= from);
        if (to) list = list.filter((d) => d.date <= to);
        if (!list.length) return 'No face photos in that range.';
        const lines = [`${list.length} day(s) with face photos. Format: date: angle(id) …`];
        for (const d of list.slice(0, limit)) {
          const parts = ANGLE_IDS.map((a) => (d[a] ? `${a}(${d[a].id})${d[a].note ? ' "' + d[a].note.replace(/\s+/g, ' ').slice(0, 60) + '"' : ''}` : `${a}: missing`));
          lines.push(`- ${d.date}: ${parts.join(', ')}`);
        }
        if (list.length > limit) lines.push(`… ${list.length - limit} older day(s) not shown.`);
        return lines.join('\n').slice(0, 1500);
      },
    },
  ],
};
