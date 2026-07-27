# Perigee

A SpaceX launch, Starlink and Starship tracker that lives on your iPhone home
screen and keeps its own data up to date. No App Store, no Apple Developer
account, no server. Everything below runs on GitHub's free tier.

## How it stays current

Two independent layers, so a failure in one never blanks the app:

| Layer | Source | Refreshes |
| --- | --- | --- |
| Launches, countdown, boosters | Launch Library 2, called from the phone | Every time you open the app |
| Pad weather | Open-Meteo, called from the phone | Every time you open the app |
| Starlink + Starshield census, launch cadence | `scripts/scrape.mjs` via GitHub Actions | Daily, committed to this repo |
| Starship program, crew rosters, news | Hand-curated in `src/PerigeeApp.jsx` | When you edit it |

The daily job scrapes Jonathan McDowell's constellation tables at
planet4589.org. That has to happen on a server, not in the browser: the site
sends no CORS headers, so a phone can't read it directly. The job writes
`public/data/perigee-data.json`; the app reads that file from
`raw.githubusercontent.com` at startup and overlays it on the values compiled
into the bundle. New data therefore goes live **without a rebuild**.

If the fetch fails — offline, aeroplane mode, GitHub down — the app silently
keeps its built-in snapshot and labels it accordingly on the Overview tab.

## Setup

### 1. Create the repo

Make a new **public** repo called `perigee` (public matters: GitHub Actions
minutes are free and unlimited on public repos, and `raw.githubusercontent.com`
serves public files without a token).

```bash
cd perigee
git init -b main
git add .
git commit -m "Perigee"
git remote add origin https://github.com/YOUR_USERNAME/perigee.git
git push -u origin main
```

### 2. Point the app at your repo

In `src/liveData.js`, change one line:

```js
const GITHUB_USER = "YOUR_GITHUB_USERNAME";
```

Until you do, the app just reads its bundled copy of the data — it works, it
simply won't pick up the daily refreshes.

### 3. Turn on Pages

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Push anything (or run the **Deploy to Pages** workflow by hand) and your app
appears at `https://YOUR_USERNAME.github.io/perigee/`.

### 4. Turn on the data refresh

Go to the **Actions** tab, pick **Refresh data**, and hit **Run workflow** to
prove it works. After that it runs itself at 06:15 UTC daily.

If the push step fails, check **Settings → Actions → General → Workflow
permissions** is set to *Read and write permissions*.

### 5. Put it on your home screen

On your iPhone, open the Pages URL **in Safari** (this does not work from
Chrome), then **Share → Add to Home Screen**.

You get the Perigee icon on your springboard, and it opens full-screen with no
browser chrome, because of the `apple-mobile-web-app-capable` tag in
`index.html`.

## Local development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build into dist/
npm run scrape   # run the scraper once, writes public/data/perigee-data.json
node scripts/scrape.test.mjs   # verify the parser against known-good values
```

## Keeping it alive

**GitHub pauses scheduled workflows after 60 days without repo activity.** It
emails you first. Either push a commit occasionally or open the Actions tab and
re-enable it. If that annoys you, move the cron to a Cloudflare Worker, which
has no such rule.

## What the scraper does and doesn't cover

Covered automatically, with a self-check: the Starlink census (including the
broadband / direct-to-cell split and the per-generation breakdown), the
Starshield census, per-year Falcon launch counts, and Falcon booster flight
records. If the version split stops reconciling against the total — meaning
McDowell relabelled a shell — the scraper logs a warning and publishes only the
totals rather than a wrong breakdown.

Not covered: Starship flight history, crew rosters and news. Those need
editorial judgement about what actually happened on a flight, and a scraper that
guessed would be worse than one that abstains. Edit them in
`src/PerigeeApp.jsx`, or publish them in the JSON — `applyLiveData` already
accepts `starshipStats`, `starshipFlights`, `crewMissions`, `newsItems` and
friends, so you can update them without touching the bundle.

## Limits worth knowing

- **Push notifications are not wired up.** The in-app T-1h alert uses the
  browser Notifications API and only fires while the app is open. Reliable
  background alerts are the one thing that genuinely needs a native app.
- **Launch Library 2 rate-limits anonymous callers.** Normal use is fine;
  hammering refresh is not.
- The bundle is ~650 kB (~184 kB gzipped), mostly charting. Fine over wifi,
  and it's cached after first load.
