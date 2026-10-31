# LifeOS — your private life dashboard for Android

One app for the things you want to track every day, with an AI coach that can read all of it and tell you how to improve.

| Tab | Modules |
|---|---|
| **Today** | Quick-add buttons, AI coach, today's summary from every module |
| **Body** | Weight (trend, 7-day average, goal) · Progress photos (in-app camera with ghost overlay of yesterday's pose, compare, timelapse) |
| **Mind** | Dreams (journal, tags, lucid, themes) · Daily notes (mood & energy, autosave) |
| **Plan** | Tasks (quick-add with shortcuts) · Habits (streaks) · Goals (milestones, metrics) · Calendar (events, .ics import/export) |
| **Money** | Transactions, categories, budgets, monthly trend |
| **AI Coach** | Chat with Claude about *your* data: daily brief, weekly review, patterns, physique feedback |

Everything is stored **only on your phone** (IndexedDB). Nothing leaves the device unless you ask the AI coach a question, in which case your data report is sent to Anthropic's API using your own key. Back up from Settings → Export.

---

## 0. How this copy is deployed (already set up)

- **Code:** private GitHub repo <https://github.com/shewskis/lifeos> (this folder is the checkout; the app lives in `lifeos/`).
- **Hosting:** Netlify site **boisterous-sorbet-ad513a** → <https://boisterous-sorbet-ad513a.netlify.app>, linked to that repo. `netlify.toml` publishes `lifeos/` with no build step.
- **Publishing a change:** commit and push to `main`. Netlify builds in about 20 seconds and the installed app shows "Update ready → Reload" on next open.

```bash
git add -A && git commit -m "Describe the change" && git push
```

Before pushing a code change, bump `VERSION` in `lifeos/sw.js` (and `LIFEOS_VERSION` in `lifeos/index.html`) so phones drop the cached files.

**Site protection:** Netlify turned on "team login" protection for this site (`sso_login`). While it is on, only people logged in to your Netlify team can open the URL, so your phone gets a login page. Turn it off once in the dashboard: *Site configuration → Access & security → Site protection → None (public)*. The app itself keeps all data on the device, so a public URL exposes only the code.

Check a deploy or trigger one by hand from this folder (the Netlify CLI is linked to the site):

```bash
npx netlify-cli deploy:list
```

---

## 1. Hosting it yourself elsewhere (reference)

The app is a PWA (Progressive Web App). Any static HTTPS host works; it needs to be served over HTTPS once; after that it installs to the home screen, runs full-screen and works offline.

### Option A — Netlify Drop (easiest)
1. Go to <https://app.netlify.com/drop> (free account).
2. Drag the whole `lifeos` folder onto the page. You get a URL like `https://random-name.netlify.app`.
   Dragging `lifeos.zip` also works, but only a zip whose entries use forward slashes. Build it with `tar -a -c -f lifeos.zip *` from inside the `lifeos` folder (or any zip tool except PowerShell's `Compress-Archive`, which writes backslashes that Netlify unpacks as flat files named `css\app.css`, leaving a blank page).
3. Open that URL in **Chrome on your Android phone** → tap ⋮ → **Install app** (or "Add to Home screen").
4. Done. Open LifeOS from your home screen.

### Option B — GitHub Pages
1. Create a repo, push the contents of `lifeos/` to the `main` branch root.
2. Repo → Settings → Pages → Source: `main` / root. Wait a minute.
3. Open `https://<you>.github.io/<repo>/` on your phone and install as above.

### Option C — Cloudflare Pages / Vercel
Any static host works: upload the folder, no build command, output directory `/`.

> Updating the app later: upload the new files, open the app, and it will toast "Update ready → Reload". If you change files, bump `VERSION` in `sw.js` and `LIFEOS_VERSION` in `index.html`.

### Want a real APK in the Play Store or sideloaded?
Go to <https://www.pwabuilder.com>, paste your hosted URL, click **Package for stores → Android**. It generates a signed APK/AAB (a Trusted Web Activity wrapper) that you can install directly or publish. No code changes needed.

---

## 2. Turn on the AI coach

1. Create an API key at <https://console.anthropic.com> (pay-as-you-go; a typical question costs a few cents; the Haiku model is roughly 20× cheaper than Opus if you want to save).
2. In LifeOS open **AI Coach** (sparkle icon or the card on Today) → paste the key → Save. The key is stored only in the app on your phone.
3. Tap a suggestion chip ("Daily brief", "Weekly review", "Physique feedback"…) or ask anything.

How the AI "sees" your life: on every question the app builds a Markdown **life report** from all modules (stats + recent entries for the last 30/90/365 days, your choice in Settings) and sends it with your question. Turn on **Include progress photos** in Settings to also send your oldest, middle and newest photo for physique feedback. You can preview exactly what the AI receives with **Preview what the AI sees**.

**No API key?** Settings → **Copy life report for any AI** puts the same report on your clipboard / share sheet. Paste it into the Claude app, ChatGPT, Gemini, whatever you like, and ask for advice.

---

## 3. Daily routine the app is designed around

Morning: open app → **Dream** (write while you still remember) → **Log weight** → **Progress photo** (the ghost overlay helps you match yesterday's pose) → check **Today's tasks & habits**.
During the day: **Expense** button as you spend, tick habits and tasks.
Evening: **Note** (how was the day, mood, energy). Weekly: ask the coach for a **Weekly review**.

---

## 4. Calendar access

Android does not allow web apps to read the system calendar. LifeOS has its own calendar plus:
- **Import .ics** — export from Google Calendar (Settings → Import & export → Export) or any calendar app, then import the file.
- **Export .ics** — move your LifeOS events into any calendar app.
- **Open in Google Calendar** button on each event.

If you later want true two-way system calendar sync, the app can be wrapped with Capacitor (native shell) and a calendar plugin. The web code stays the same.

---

## 5. Run it locally on your PC (for testing)

```bash
node tools/serve.js 4173
```
Open <http://localhost:4173>. Chrome DevTools → toggle device toolbar for a phone-sized view.

## 6. Project layout

```
index.html              app shell
manifest.webmanifest    PWA manifest (name, icons, shortcuts)
sw.js                   service worker: offline cache
css/app.css             styles (dark/light, mobile-first)
js/app.js               router, bottom nav, Today, Settings, backup
js/db.js                IndexedDB wrapper + settings
js/ui.js                UI kit: forms, sheets, charts, camera helpers
js/report.js            builds the Markdown life report for the AI
js/modules/*.js         one file per feature (see modules/README.md for the contract)
tools/serve.js          dev server · tools/make-icons.js regenerates icons
```

Adding your own module: copy any module file, change `id/title/tab/stores`, register it in `js/modules/index.js` and in `sw.js`'s SHELL list. The AI coach automatically includes any module that implements `exportForAI`.
