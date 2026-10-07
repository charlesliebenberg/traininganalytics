# Training Analytics

A self-hosted training analytics and planning suite for endurance athletes. It syncs with **Strava** and **TrainingPeaks**, imports FIT/TCX/GPX files, and covers everything Strava and TrainingPeaks offer plus several analyses neither has: a normalized-power curve, durability (fatigue-resistance) curves, an omni-domain power-duration model, quadrant analysis, W′ balance, and PMC projection all the way to race day.

```bash
npm install
npm run demo   # optional: generate 18 months of realistic demo training
npm run dev    # API on :8787, web app on http://localhost:5173
```

Requires Node.js ≥ 22.13. SQLite is built in (`node:sqlite`), so there is nothing to compile and no database to install.

---

## What's inside

### Analyze past training

| Area | Features |
|---|---|
| **Dashboard** | Fitness / fatigue / form tiles, ramp rate & ACWR, week-to-date TSS vs plan, eFTP, next goal event with projected race-day CTL/TSB, compact PMC, upcoming workouts, recent activities with route thumbnails, 16-week volume |
| **Activity analysis** | Stacked stream charts (power, HR, pace/speed, grade-adjusted pace, cadence, **W′ balance**, elevation, temperature) with a shared crosshair that moves a marker on the map · drag to select any range → full stats (NP, IF, kJ, W/kg, W′ used, Pw:HR…) · time/distance x-axis · 1/5/10/30 s smoothing · zoom |
| | Laps, **auto-detected intervals**, and per-km / per-5 km splits (hover to highlight on chart + map, click to select) |
| | **Mean-maximal curves** for the activity vs your 90-day and all-time best (power, **NP**, HR, pace, **VAM**) — click a point to jump to that effort in the ride |
| | Time in zones (power, HR and grade-adjusted pace together), power distribution, **quadrant analysis** (pedal force vs velocity), **aerobic decoupling** (Pw:HR / Pa:HR) with drift chart, running best efforts |
| | Planned-vs-actual compliance, RPE, rename, change sport (recomputes), TSS explanation |
| **Fitness & Form** | Performance Management Chart (CTL / ATL / TSB) with form zones, race markers, and **projection from planned workouts and your season plan**; weekly ramp rate; Foster **monotony & strain**; ACWR; 12-month load calendar; fitness goal calculator ("what daily TSS gets me to CTL 80 by June?") |
| **Power & Performance** | Power / **NP** / HR / pace / VAM curves over any range with comparisons (previous period, last year, all-time) · watts or W/kg · **OmPD power-duration model** (CP/eFTP, W′, Pmax, modelled 60-min power, time-to-exhaustion) with one-click "use eFTP" · Coggan **power profile** & rider type · **durability curves** (best power after 1 000 / 2 000 / 3 000 kJ) with retention table · **model history** (eFTP, W′, Pmax over 12 months vs your FTP setting) · peak table by period |
| **Trends** | Weekly/monthly volume by sport (hours, distance, TSS, elevation, kJ, count) · intensity distribution (Seiler 3-zone, power zones, HR zones) · **polarization index** · aerobic efficiency (EF) trends for rides and runs · decoupling trend · year-over-year cumulative |
| **Records** | Peak power by year, running best efforts (400 m → marathon) by year, and highlights (longest, most climbing, biggest TSS, most work, highest NP) |
| **Heatmap** | Every GPS route on one map, heat or per-sport colouring, click through to activities |

### Plan future training

| Area | Features |
|---|---|
| **Calendar** | Month grid with completed activities (colour-coded compliance), planned workouts (with mini profiles), races, missed sessions · drag to reschedule · drag workouts from the library onto a day · weekly summary column (actual vs planned vs season-plan target TSS, hours, distance, end-of-week CTL/TSB) · workout detail with profile and exports |
| **Workout Builder** | Structured steps, repeats and ramps with power (% FTP), pace (% threshold) or HR (% LTHR) targets and cadence · live profile and TSS / IF / kJ / time-in-zone · save to library · schedule · export **Zwift .zwo**, **.erg**, **.mrc**, JSON · 21 built-in workouts (sweet spot, threshold, over-unders, VO2max, 30/30s, anaerobic, sprints, FTP & ramp tests, run sessions) |
| **Season Planner** | Annual-training-plan style periodisation working back from your A race (Prep → Base → Build → Peak → Taper → Race) with 2:1 / 3:1 / 4:1 loading, a max ramp rate, weekly-hours cap and a taper · live preview of weekly TSS and the CTL/ATL/TSB it produces · **"Fill calendar"** generates phase-appropriate structured workouts sized to each week's TSS · the active plan drives calendar targets and long-range PMC projection · A/B/C event management |

---

## Data sources

### Strava (automatic sync)

1. Create an API application at <https://www.strava.com/settings/api>.
2. Set **Authorization Callback Domain** to the host of `PUBLIC_URL` (e.g. `localhost`).
3. Copy `.env.example` to `.env` and fill in `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`.
4. Restart, open **Settings → Connections → Connect Strava**.

What happens next:

- The whole history is listed and stored as summaries immediately, then detailed streams are fetched **newest first**, respecting Strava's rate limits (the queue pauses at the 15-minute/daily limit and resumes on its own). The queue is persisted, so a restart continues where it left off.
- New activities arrive by **polling** every `SYNC_INTERVAL_MINUTES` (default 15).
- For instant sync, make the app reachable from the internet (a reverse proxy or a tunnel such as `cloudflared` or `ngrok`), set `PUBLIC_URL` to that address and click **Enable webhook**. Creates, updates, deletes and deauthorisations are handled.
- FTP and weight from your Strava profile seed your thresholds if you haven't set any.

### TrainingPeaks

TrainingPeaks' API is only available to [approved partners](https://github.com/TrainingPeaks/PartnersAPI/wiki). If you have credentials, set `TRAININGPEAKS_CLIENT_ID` / `TRAININGPEAKS_CLIENT_SECRET` (and `TRAININGPEAKS_SANDBOX=true` for the sandbox). The client syncs completed workouts (downloading device files through the full analytics pipeline), and imports **planned workouts** into your calendar. Endpoint paths follow the partner API docs; adjust them in `server/providers/trainingpeaks.ts` if your partner agreement exposes different versions.

**No API access?** In TrainingPeaks go to *Settings → Export Data → Export Workout Files* and drop the ZIP on **Settings → Import files**. Everything is recomputed with your own thresholds, so the analysis is identical.

### Files

FIT, TCX and GPX — individually, gzipped (`.fit.gz`, as in Strava bulk exports), or inside a ZIP. The same workout arriving from two sources (e.g. Strava and TrainingPeaks) is de-duplicated by start time and duration, keeping the richer copy.

### Demo athlete

`npm run demo`, or the button on the welcome screen, generates ~18 months of physiologically modelled training: power from a physics model on synthetic terrain, heart rate with lag, cardiac drift and fitness effects, GPS loops, periodised blocks with recovery weeks, FTP tests that update thresholds, races, planned workouts, events and a season plan. Remove it from **Settings → Data**.

---

## Methods

All analytics live in [`shared/analytics`](shared/analytics) and are covered by unit tests (`npm test`).

- **Streams** are resampled to 1 Hz. Short gaps are interpolated; longer power gaps are zero-filled (stopped) so mean-max curves are never inflated.
- **Normalized Power**: 4th-power mean of the 30 s rolling average. **IF** = NP / FTP. **TSS** = hours × IF² × 100. **VI** = NP / average power.
- **TSS method priority**: power (rides) → **rTSS** from normalized graded pace (runs) → **sTSS** from CSS (swims, IF³) → **hrTSS** (Banister TRIMP normalised so an hour at LTHR = 100) → a per-sport estimate. The method is shown on every activity. Thresholds are **date-effective**, so historical TSS stays right as you get fitter.
- **Normalized-power curve**: for each duration ≥ 30 s, the highest NP over any window of that length. It shows what variable, surging efforts really cost, which a mean-max power curve understates.
- **Durability curves**: the mean-max power curve computed only over the part of each ride after the rider had already done 500 … 4 000 kJ of work.
- **Power-duration model**: the omni-domain model of Puchowicz, Baker & Clarke (2020), fitted to the curve's upper envelope with an asymmetric, log-time-weighted loss (Nelder–Mead). eFTP is the model's critical power. A classic 2-parameter CP fit (3–20 min work–time regression) is also reported.
- **W′ balance**: Skiba's model in the differential form (Froncioni/Clarke), using FTP as CP and your W′.
- **Grade-adjusted pace** uses Minetti's metabolic cost of running on gradients. **NGP** applies the NP algorithm to GAP.
- **Aerobic decoupling**: output-per-heartbeat in the first vs second half of the moving time (skipping a 10-minute warm-up on long efforts). **EF** = NP (or NGP) / average HR.
- **PMC**: exponentially weighted CTL (42 d) and ATL (7 d); TSB = yesterday's CTL − ATL. The time constants can be changed in Preferences. Form zones are relative to fitness: TSB/CTL.
- **Intervals** are detected in two passes: sustained ≥ 88 % of threshold for ≥ 3 min, and ≥ 120 % for ≥ 15 s.
- **Polarization index** follows Treff et al. (2019) on the Seiler 3-zone distribution.
- **Season plan**: phases are laid out backwards from race day. Load-week TSS is solved from the CTL ramp required to reach the target (capped by the max ramp and weekly hours). Recovery weeks run at 60 % load and the taper at 55–75 %.

---

## Architecture

```
shared/            Pure TypeScript used by both server and browser
  analytics/       NP, curves, models, PMC, zones, running, workouts, season plan (+ tests)
  library.ts       Built-in structured workouts
server/            Hono API on Node, SQLite via node:sqlite
  providers/       Strava & TrainingPeaks OAuth + sync
  importers/       FIT / TCX / GPX / ZIP parsing
  queue.ts         Persistent, rate-limit-aware job queue
  ingest.ts        Metrics computation & storage (streams gzipped)
  aggregate.ts     PMC, curve aggregation, trends, records
  demo.ts          Synthetic athlete generator
src/               React + Vite + Tailwind front end, ECharts, Leaflet
```

Per-activity metrics, mean-max curves (power, NP, HR, speed, VAM, fatigue-state power) and zone times are computed once on ingest and stored, so range queries over years of data stay fast. Changing thresholds and pressing **Recalculate** recomputes everything.

### Scripts

| Command | |
|---|---|
| `npm run dev` | API (watch mode) + Vite dev server |
| `npm run build` | Type-check and build the front end to `dist/` |
| `npm start` | Production: serves the API and the built app on `PORT` |
| `npm test` | Analytics unit tests |
| `npm run demo` | Generate the demo athlete |

### Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | API / production port |
| `PUBLIC_URL` | `http://localhost:5173` (dev) | Used for OAuth redirects and the Strava webhook |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | | Strava API app |
| `STRAVA_WEBHOOK_VERIFY_TOKEN` | | Any random string |
| `TRAININGPEAKS_CLIENT_ID`, `TRAININGPEAKS_CLIENT_SECRET`, `TRAININGPEAKS_SANDBOX` | | Partner API credentials |
| `SYNC_INTERVAL_MINUTES` | `15` | Polling interval |
| `DATA_DIR` | `./data` | Where `training.db` lives |

| `APP_PASSWORD` | | Password-protects the app (login screen). Set it for any public deployment |
| `API_URL`, `CORS_ORIGINS` | | Only for a frontend calling the API cross-origin without a proxy |

## Deploying

Auto-deploy from GitHub with **Render** (backend + database) and **Vercel or Netlify** (frontend). See **[DEPLOY.md](DEPLOY.md)**: `render.yaml`, `vercel.json` and `netlify.toml` are included.

This is a single-user app. Set `APP_PASSWORD` whenever it's reachable from the internet.
