# Training Analytics

A self-hosted training analytics and planning suite for endurance athletes. It syncs with **Strava**, imports FIT/TCX/GPX files (including TrainingPeaks exports), and covers everything Strava and TrainingPeaks offer plus several analyses neither has: a normalized-power curve, durability (fatigue-resistance) curves, an omni-domain power-duration model, quadrant analysis, W′ balance, and PMC projection all the way to race day.

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
| **Dashboard** | Fitness / fatigue / form tiles, ramp rate & ACWR, week-to-date TSS vs plan, FTP, **what your latest ride says about your fitness**, next goal event with projected race-day CTL/TSB, compact PMC, upcoming workouts, recent activities with route thumbnails, 16-week volume |
| **Activity analysis** | **What this ride says**: a verdict from the heart rate the ride cost against your fitness and recent condition (heat, fatigue and indoor riding taken out), and efforts in context — close to or above your 90-day best, best power deep into a long ride, more than your current model allows — with the ride shown among your last 8 weeks |
| | Stacked stream charts (power, HR, pace/speed, grade-adjusted pace, cadence, **W′ balance**, elevation, temperature) with a shared crosshair that moves a marker on the map · drag to select any range → full stats (NP, IF, kJ, W/kg, W′ used, Pw:HR…) · time/distance x-axis · 1/5/10/30 s smoothing · zoom |
| | Laps, **auto-detected intervals**, and per-km / per-5 km splits (hover to highlight on chart + map, click to select) |
| | **Mean-maximal curves** for the activity vs your 90-day and all-time best (power, **NP**, HR, pace, **VAM**) — click a point to jump to that effort in the ride |
| | Time in zones (power, HR and grade-adjusted pace together), power distribution, **quadrant analysis** (pedal force vs velocity), **aerobic decoupling** (Pw:HR / Pa:HR) with drift chart, running best efforts |
| | Planned-vs-actual compliance, RPE, rename, change sport (recomputes), TSS explanation |
| **Fitness & Form** | Performance Management Chart (CTL / ATL / TSB) with form zones, race markers, and **projection from planned workouts and your season plan**; **measured aerobic fitness** — the output you hold at a reference heart rate, for rides and runs, with its uncertainty; CTL counts training, this measures what it did; weekly ramp rate; Foster **monotony & strain**; ACWR; 12-month load calendar; fitness goal calculator ("what daily TSS gets me to CTL 80 by June?") |
| **Power & Performance** | Power / **NP** / HR / pace / VAM curves over any range with comparisons (previous period, last year, all-time) · watts or W/kg · **OmPD power-duration model** (CP/eFTP, W′, Pmax, modelled 60-min power, time-to-exhaustion) with one-click "use eFTP" · Coggan **power profile** & rider type · **durability curves** (best power after 1 000 / 2 000 / 3 000 kJ) with retention table · **model history** (eFTP, W′, Pmax over 12 months vs your FTP setting) · peak table by period |
| **Trends** | Weekly/monthly volume by sport (hours, distance, TSS, elevation, kJ, count) · intensity distribution (Seiler 3-zone, power zones, HR zones) · **polarization index** · decoupling trend · year-over-year cumulative for every year |
| **Thresholds** | **Automatic FTP, run threshold pace and swim CSS**, re-estimated every week from the previous 6 months: a critical-power / critical-speed fit through your three most impressive, well-spread efforts. Shows the full history next to your manual values, plus the curve, chosen efforts and linear fit for any week so you can check it. Each activity's zones and TSS use the threshold that applied on its date. **LTHR, run LTHR and max HR** are estimated the same way from your hardest sustained efforts |
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

### TrainingPeaks history

To bring in history that only lives in TrainingPeaks, go to *Settings → Export Data → Export Workout Files* there and drop the ZIP on **Settings → Import files**. Everything is recomputed with your own thresholds.

### Files

FIT, TCX and GPX — individually, gzipped (`.fit.gz`, as in Strava bulk exports), or inside a ZIP. The same workout arriving from two sources (e.g. Strava and TrainingPeaks) is de-duplicated by start time and duration, keeping the richer copy.

### Demo athlete

`npm run demo`, or the button on the welcome screen, generates ~18 months of physiologically modelled training: power from a physics model on synthetic terrain, heart rate with lag, cardiac drift and fitness effects, GPS loops, periodised blocks with recovery weeks, FTP tests that update thresholds, races, planned workouts, events and a season plan. Remove it from **Settings → Data**.

---

## Methods

All analytics live in [`shared/analytics`](shared/analytics) and are covered by unit tests (`npm test`).

- **Streams** are resampled to 1 Hz. Short gaps are interpolated; longer power gaps are zero-filled (stopped) so mean-max curves are never inflated.
- **Moving time**: power, cadence or speed counts as moving; only stops of 20 s or more are excluded (the device's flag is used only without those channels).
- **Normalized Power**: 4th-power mean of the 30 s rolling average over moving time. **IF** = NP / FTP. **TSS** = moving hours × IF² × 100. **VI** = NP / average power.
- **TSS method priority**: power (rides) → **rTSS** from normalized graded pace (runs) → **sTSS** from CSS (swims, IF³) → **hrTSS** (Banister TRIMP normalised so an hour at LTHR = 100) → a per-sport estimate. The method is shown on every activity. Thresholds are **date-effective**, so historical TSS stays right as you get fitter.
- **Normalized-power curve**: for each duration ≥ 30 s, the highest NP over any window of that length. It shows what variable, surging efforts really cost, which a mean-max power curve understates.
- **Durability curves**: the mean-max power curve computed only over the part of each ride after the rider had already done 500 … 4 000 kJ of work.
- **Power-duration model**: the omni-domain model of Puchowicz, Baker & Clarke (2020), fitted to the curve's upper envelope with an asymmetric, log-time-weighted loss (Nelder–Mead). eFTP is the model's critical power. A classic 2-parameter CP fit (3–20 min work–time regression) is also reported.
- **W′ balance**: Skiba's model in the differential form (Froncioni/Clarke), using the critical power of the automatic estimate and your W′ — bike power only.
- **Grade-adjusted pace** uses Minetti's metabolic cost of running on gradients. **NGP** applies the NP algorithm to GAP.
- **Aerobic decoupling**: output-per-heartbeat in the first vs second half of the moving time (skipping a 10-minute warm-up on long efforts), only for a steady hour on the bike or 45 minutes running with both halves within 5 % of each other — otherwise it describes the session, not the athlete. **EF** = NP (or NGP) / average HR.
- **Aerobic fitness from heart rate** ([`aerobic.ts`](shared/analytics/aerobic.ts)): steady stretches (8–10 min, both halves alike) pair output with the heart rate it settled at; rides without them are read whole, against power smoothed with heart rate's 40-second lag (not on hard, surgy rides, where surges hold heart rate up). A reference curve maps output to heart rate; each activity's heart-rate cost against it has heat, carried fatigue (TSB) and indoor riding removed — their sizes learned from your own data by comparing activities with their neighbours in time. A two-state Kalman filter then follows **fitness** (slow) and **condition** (spells that fade within a week), with noise levels fitted by maximum likelihood. Each activity gets a surprise score against fitness and against what was expected; fitness is reported as the output you'd hold at a reference heart rate under standard conditions, with an uncertainty that accounts for the shared evidence between two dates.
- **Efforts in context**: an activity's 1, 5, 20 and 60-minute power against the 90 days before it and all-time; durability (best 5 / 20 minutes after 1 000–3 000 kJ) against the last 90 days, when there are earlier rides that deep to compare with; 3–20 minute efforts against the critical-power model in effect that day.
- **Automatic thresholds**: for each week, the mean-max power (bike) or speed (run, swim) curve of the previous 182 days within the critical-power range (bike 3–30 min, run 2–40 min, swim 1–25 min). A hyperbola is fitted to the curve's upper envelope and each effort is scored against it. From all triples of efforts spaced ≥ 1.6× apart in duration (≥ 4× overall), the triple whose weakest effort scores highest is fitted with the linear work–time (distance–time) model. FTP = 96 % of CP, but never below 95 % of the best 20 minutes (capped at CP) or the best hour; run threshold = CS; CSS = CS. Applied values may fall by at most 1 % per week (fitness fades slowly, but a big effort leaves the window all at once); rises apply immediately; after a break that empties the window, the first activities back use the first estimate fitted after it. **LTHR** is the second-highest best-30-minute heart rate of the window (run LTHR never below the bike's), **max HR** the second-highest maximum over 12 months; heart-rate thresholds carry the best value forward, less 0.7 bpm a year. Toggle auto/manual per sport on the Thresholds page.
- **PMC**: exponentially weighted CTL (42 d) and ATL (7 d); TSB = yesterday's CTL − ATL. The time constants can be changed in Preferences. Form zones are relative to fitness: TSB/CTL.
- **Intervals** are detected in two passes: sustained ≥ 88 % of threshold for ≥ 3 min, and ≥ 120 % for ≥ 15 s.
- **Polarization index** follows Treff et al. (2019) on the Seiler 3-zone distribution.
- **Season plan**: phases are laid out backwards from race day. The build's CTL ramp is solved by simulation so race-day CTL lands on the target after the taper (capped by the max ramp and weekly hours); when it can't, the planner says whether hours or ramp is the limit and what would reach it. Recovery weeks run at 60 % load and the taper at 55–75 %. Hours use your own TSS per hour.

---

## Architecture

```
shared/            Pure TypeScript used by both server and browser
  analytics/       NP, curves, models, PMC, zones, running, workouts, season plan (+ tests)
  library.ts       Built-in structured workouts
server/            Hono API on Node, SQLite via node:sqlite
  providers/       Strava OAuth, webhooks and sync
  estimates.ts     Rolling weekly FTP / threshold pace / CSS estimates
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
| `SYNC_INTERVAL_MINUTES` | `15` | Polling interval |
| `DATA_DIR` | `./data` | Where `training.db` lives |
| `APP_PASSWORD` | | Password-protects the app (login screen). Set it for any public deployment |
| `API_URL`, `CORS_ORIGINS` | | Only for a frontend calling the API cross-origin without a proxy |

## Testing against real data

Set `READ_TOKEN` (24+ random characters) on the deployed API to allow read-only (GET) access with
`Authorization: Bearer <token>`. Then, with the same value in `TA_READ_TOKEN`:

```sh
npm run pull                     # → data/real.db (Strava tokens stripped); --no-streams for a small copy
DB_PATH=data/real.db npm run dev
```

## Deploying

Auto-deploy from GitHub with **Render** (backend + database) and **Vercel or Netlify** (frontend). See **[DEPLOY.md](DEPLOY.md)**: `render.yaml`, `vercel.json` and `netlify.toml` are included.

This is a single-user app. Set `APP_PASSWORD` whenever it's reachable from the internet.
