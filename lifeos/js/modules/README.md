# LifeOS module contract

Every file in `js/modules/*.js` is an ES module whose **default export** is a plain object:

```js
import { h, dates, fmt, icon, toast, formSheet, confirm, listItem, empty, card, fab, lineChart, segmented, stat } from '../ui.js';

export default {
  id: 'weight',                // unique, used in routes:  #/<tab>/<id>
  title: 'Weight',             // shown in segmented tab + topbar
  subtitle: 'Track your trend',// one short line (Today grid tile)
  icon: 'scale',               // name from ui.js ICONS (see list below)
  tab: 'body',                 // 'body' | 'mind' | 'plan' | 'money'  (ai module has tab: null and is reached via #/ai)

  // IndexedDB stores this module owns. keyPath defaults to 'id'. Every index listed must exist on records
  // you save (use null/'' rather than omitting if you want to index it). 'date' is 'YYYY-MM-DD' local.
  stores: { weights: { indexes: ['date'] } },

  async init(ctx) {},          // optional: seed defaults, migrations. Runs once at startup after DB open.

  // Draw the whole module screen into `container`. `ctx.params` holds the query (e.g. {add:'1'} from app shortcuts —
  // when params.add === '1' open the add form immediately). Return a cleanup function (or nothing) — it runs when the
  // user navigates away; use it to remove db.onChange listeners, stop cameras, etc.
  async render(container, ctx) {},

  // Buttons on the Today screen (keep 1–2 per module). run() usually opens the add form.
  quickActions: [{ label: 'Log weight', icon: 'scale', run: async (ctx) => {} }],

  // A compact card (ui.card) for the Today screen, or null to hide. Re-rendered automatically when one of your stores changes.
  async todayCard(ctx) {},

  // Markdown text for the AI coach and the "copy life report" button. Summarise + include recent entries within
  // opts.since (a 'YYYY-MM-DD'). Be data-dense; the AI reads this. Return '' if the user has no data.
  async exportForAI(ctx, { since, days }) {},

  // Optional: extra controls for the Settings screen. Return a Node.
  async settings(ctx) {},
};
```

## ctx

```
ctx.db        — DB instance (js/db.js): put(store,obj) get(store,id) delete(store,id) all(store,{index,dir,limit})
                range(store, from, to, field='date') where(store, field, value) count(store) onChange(store, fn) → unsubscribe
                put() assigns id/createdAt/updatedAt. All methods return Promises.
ctx.settings  — settings.get(key, default) / set(key, val)   (localStorage, sync). Global keys you may read:
                'units' ('kg'|'lb'), 'currency' ('USD'), 'name', 'weekStart' ('mon'|'sun'). Prefix your own keys with '<id>:'.
ctx.ui        — the ui kit (same as importing from '../ui.js')
ctx.nav(hash) — navigate, e.g. ctx.nav('plan/tasks') or ctx.nav('ai')
ctx.params    — route query params (render only)
ctx.modules   — all modules (for cross-module reads, e.g. the AI module calls every exportForAI)
ctx.app       — the app object; ctx.app.render() forces a full re-render (rarely needed)
```

## UI kit (js/ui.js) — use these, do not hand-roll

- `h(selector, attrs?, ...children)` — `h('div.card', {onclick}, 'text', node, [nodes])`; attrs: `onclick`, `style:{}`, `class`, `dataset`, `html`.
- `clear(el)`, `icon(name, size=24)` → span with inline SVG.
- `dates.today()`, `dates.key(Date)`, `dates.parse(key)`, `dates.addDays(key, n)`, `dates.daysBetween(a,b)`, `dates.label(key)` ("Today"/"Yesterday"/"Mon 12 Mar"), `dates.ago(key)`, `dates.monthLabel`, `dates.weekStart`, `dates.monthStart`, `dates.monthEnd`, `dates.daysInMonth`, `dates.time(ts)`.
- `fmt.money(n)`, `fmt.num(n, digits)`, `fmt.escape(s)`.
- `toast(msg, {action, onAction})`.
- `sheet({title, content, actions:[{label, primary, danger, onClick}], onClose, full})` → `{el, body, close}`.
- `confirm(message, {okLabel})` → Promise<boolean>. `prompt(message, {title, value, multiline})` → Promise<string|null>.
- `form(fields, values)` → `{el, values(), set(), validate(), focus()}` — field types: text, number, date, time, textarea, select, toggle, tags, segment, range, hidden. Fields: `{name,label,type,placeholder,required,options,min,max,step,value,hint,autofocus,rows,labels}`.
- `formSheet({title, fields, values, saveLabel, onDelete, extra, extraTop})` → Promise<values|null>. **The standard way to add/edit a record.** Pass `onDelete` when editing so the sheet shows a Delete button. `extraTop` renders a node above the fields (reachable without scrolling, e.g. a "Complete" action), `extra` below them.
- `segmented(options, active, onChange)` → element with `.setValue(v)`.
- `empty(text, sub, iconName)`, `card(...children)`, `listItem({title, sub, right, leading, onClick, onLongPress, done})`, `fab(onClick)`, `stat(label, value, sub)`.
- Charts: `lineChart(points:[{x:'YYYY-MM-DD'|number, y}], {height, color, goal, yMin, yMax, showDots})`, `barList([{label, value, color}], {format})`, `columns([{label,value,color}], {height, format})`, `ring(frac, {size, color, label})`.
- Media: `resizeImage(file, maxSide, quality)` → Blob, `pickFile({accept, capture})` → File|null, `downloadText(name, text, type)`, `copyText(text)`, `shareText(title, text)`.

CSS classes available (css/app.css): `.card .card-title .list .list-item .li-* .chip(.accent/.good/.bad/.warn) .chips .checkbox(.checked) .btn(.primary/.danger/.ghost/.block/.sm)
.segmented .stats .stat .big-number .section-title .divider .progress .search-bar .date-nav .row(.between/.wrap) .grow .stack .grid-2 .grid-3 .muted .small
.cal-grid .cal-dow .cal-day(.other/.today/.selected) .dots .dot  |  .habit-row .habit-days .habit-cell(.done/.today)  |  .photo-grid .photo-thumb .compare .camera-wrap(.mirror) .ghost .shutter
.chat .msg(.user/.ai) .chat-input-bar .suggestions .typing  |  .amount(.pos/.neg) .priority-dot(.p-high/.p-med/.p-low) .streak .notice(.info) .pill-date`

Icons: home body mind plan money ai plus back close check trash edit settings camera scale moon note bulb task goal calendar habit chevron search share download upload send key info flame arrowUp arrowDown more copy refresh star filter swap eye grid.

## Rules

1. **Mobile first, big touch targets, zero clutter.** The primary action is a `fab()` or a big primary button. Adding an entry must take ≤ 3 taps. Edit by tapping a row (opens `formSheet` with `onDelete`).
2. Re-render your list when your store changes: `const off = ctx.db.onChange('weights', draw); return off;` (return the unsubscribe from `render`).
3. Dates are local `'YYYY-MM-DD'` strings in a `date` field. Default new entries to `dates.today()`.
4. Never `alert()`/`window.confirm()`/`window.prompt()`. Use the ui kit.
5. No external libraries, no build step, no frameworks. Plain ES modules only. Vanilla JS that runs in Chrome for Android.
6. Handle the empty state gracefully with `empty()` and a clear call to action.
7. `exportForAI` must be concise but complete: stats first (counts, averages, trends, streaks), then recent entries as compact lines. Cap long free text at ~300 chars per entry and total output at roughly 6–8k characters.
8. Keep everything in one file per module. Export only the default object (helpers may be module-private).
