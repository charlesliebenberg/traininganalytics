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
| **Dashboard** | Fitness / fatigue / form tiles, ramp rate & ACWR, week-to-date TSS vs plan, FTP, **what your latest ride says about your fitness**, **this week so far** (the headline of its training review), **last night** (Eight Sleep: sleep, HRV and heart rate asleep against your normal, and with your form, what that means for today's training), next goal event with projected race-day CTL/TSB, compact PMC, upcoming workouts, recent activities with route thumbnails, 16-week volume |
| **Activity analysis** | **What this ride says**: what the session was (threshold intervals, a long endurance ride, a group ride…) and its main set rep by rep — how evenly it went, how heart rate answered and recovered — against the last time you did the same workout; a verdict from the heart rate the ride cost against your fitness and recent condition (heat, fatigue and indoor riding taken out); and efforts in context — close to or above your 90-day best, best power deep into a long ride, more than your current model allows — with the set's progress over the year and the ride among your last 8 weeks. Detected intervals are labelled by set |
| | Stacked stream charts (power, HR, pace/speed, grade-adjusted pace, cadence, **W′ balance**, elevation, temperature) with a shared crosshair that moves a marker on the map · drag to select any range → full stats (NP, IF, kJ, W/kg, W′ used, Pw:HR…) · time/distance x-axis · 1/5/10/30 s smoothing · zoom |
| | Laps, **auto-detected intervals**, and per-km / per-5 km splits (hover to highlight on chart + map, click to select) |
| | **Mean-maximal curves** for the activity vs your 90-day and all-time best (power, **NP**, HR, pace, **VAM**) — click a point to jump to that effort in the ride |
| | Time in zones (power, HR and grade-adjusted pace together), power distribution, **quadrant analysis** (pedal force vs velocity), **aerobic decoupling** (Pw:HR / Pa:HR) with drift chart, running best efforts |
| | **The night before** (Eight Sleep): how long you slept, and HRV and heart rate asleep against your normal · planned-vs-actual compliance, RPE, rename, change sport (recomputes), TSS explanation |
| **Fitness & Form** | Performance Management Chart (CTL / ATL / TSB) with form zones, race markers, and **projection from planned workouts and your season plan**; **measured aerobic fitness** — the output you hold at a reference heart rate, for rides and runs, with its uncertainty; CTL counts training, this measures what it did; **sleep & recovery** (Eight Sleep) — nightly HRV and heart rate asleep against your normal range, hours asleep beside training load, and how each size of training day shows in the night after it; weekly ramp rate; Foster **monotony & strain**; ACWR; 12-month load calendar; fitness goal calculator ("what daily TSS gets me to CTL 80 by June?") |
| **Power & Performance** | Power / **NP** / HR / pace / VAM curves over any range with comparisons (previous period, last year, all-time) · watts or W/kg · **your power-duration model** — the same critical power, W′ and FTP as Thresholds, drawn as a curve with your sprint power (Pmax) and time to exhaustion · Coggan **power profile** & rider type · **durability curves** (best power after 1 000 / 2 000 / 3 000 kJ) with retention table · **model history** (daily CP, W′, FTP and Pmax over 12 months) · peak table by period |
| **Trends** | **Training review** of any week, or of 4 or 12 weeks: load against your own normal, the session mix, hard days, long rides, how the key sets compared with last time, signs of fitness (new bests, the aerobic trend, FTP) and recovery (form, rest days, heart rate running high) · weekly/monthly volume by sport · **session mix** (what each week was made of) and intensity distribution (Seiler 3-zone, power zones, HR zones) · **interval sets** by workout family over time · **polarization index** · decoupling trend · year-over-year cumulative for every year |
| **Thresholds** | **Automatic FTP, run threshold pace and swim CSS**, re-estimated every day from the 6 months up to and including it, so a ride that sets a new best gets the threshold it earned that same day and everything after it is recalculated: a critical-power / critical-speed fit through your three most impressive, well-spread efforts, with FTP never below what you've actually held for 20 to 60 minutes. Shows the full history next to your manual values, plus the curve, chosen efforts and linear fit for any date so you can check it. Each activity's zones and TSS use its own day's threshold. **LTHR, run LTHR and max HR** are estimated the same way from your hardest sustained efforts |
| **Records** | **Best efforts for any duration** — type any length (7:30, 45 s, 1 h 20) or pick one, for power, run pace or heart rate, over any date range: every activity's best effort of exactly that length, ranked with no cut-off (W, W/kg, % of your best, heart rate during it, your form going into it), charted through time with this year's and the last 90 days' best placed among them; each opens the activity with the effort selected and zoomed · peak power by year, running best efforts (400 m → marathon) by year, and highlights (longest, most climbing, biggest TSS, most work, highest NP) · every record shows your form that day — TSB going into it, from the same PMC as the dashboard, coloured by zone; none for the first six weeks of your history, while fitness is still building from nothing |
| **Heatmap** | Every GPS route on one map, heat or per-sport colouring, click through to activities |

### Plan future training

| Area | Features |
|---|---|
| **Comeback** | Your best seasons — each dated to the effort that set its FTP and described by its own weeks — against where you are now. **What your data says**: the gap in 20-minute power, how fast it's closing since you came back, your aerobic engine at the same heart rate (heat, fatigue, indoor riding and age taken out), the long-term load behind it and the way back at your current load, then what to change for where you are: building up after time off, or the make-up of your training once riding is settled · your whole riding history with long breaks squeezed · best power by duration, **deep into a ride** (best 20 minutes after 1 000–3 000 kJ, with how many rides went that deep) and at the same heart rate · the year and the weeks before a peak, and what your peaks had in common · when a steady load gets you back, beside the path the model predicted for your comeback before it began, the load it takes by a date against the most you've ever sustained, and a plan to do it that fills your calendar |
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

### Eight Sleep (automatic sync)

The server reads your nights from your Eight Sleep account: sleep score, time asleep and in each stage, and HRV, heart rate and breathing rate asleep. It uses the API the Eight Sleep app uses.

1. Set `EIGHT_SLEEP_EMAIL` and `EIGHT_SLEEP_PASSWORD` to your Eight Sleep login.
2. Set `EIGHT_SLEEP_CLIENT_ID` and `EIGHT_SLEEP_CLIENT_SECRET` to the Eight Sleep app's own client ID and secret, which its password sign-in needs. They're the same for everyone and ship inside the app; open-source clients carry them, e.g. `KNOWN_CLIENT_ID` and `KNOWN_CLIENT_SECRET` in [`pyEight/constants.py`](https://github.com/lukas-clarke/eight_sleep/blob/main/custom_components/eight_sleep/pyEight/constants.py) of the Home Assistant integration.
3. Restart. **Settings → Eight Sleep** shows the sync.

What happens next:

- The first sync reads your whole history, newest first, a month at a time; after that, new nights are read every `EIGHT_SLEEP_SYNC_HOURS` (default 2), and on demand with **Sync now**. Each sync reads the last three nights again, to pick up nights Eight Sleep has finished processing since.
- A night is filed under the morning you woke up, so it sits with that day's training.
- Your password stays in the server's environment. The database keeps the account's email and the token from signing in, and `npm run pull` snapshots strip the token.
- Eight Sleep doesn't publish this API, so a change on its side can break the sync until this is updated. The Pod has no local API of its own: the community projects that read it over your Wi-Fi ([free-sleep](https://github.com/throwaway31265/free-sleep), [ninesleep](https://github.com/bobobo1618/ninesleep)) replace its software first, and a server in the cloud couldn't reach your home network anyway.

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
- **Power-duration model**: one estimate across the app. Critical power, W′ and FTP come from the daily threshold estimate (below); the omni-domain model of Puchowicz, Baker & Clarke (2020) draws them as one curve — Pmax fitted to the sprint end of the same 6 months of best efforts (asymmetric, log-time-weighted loss, Nelder–Mead), CP and W′ up to 30 minutes, and a decline beyond that set so the hour lands on FTP. Fitted freely to a whole curve, the model's CP follows whichever efforts are hardest relative to the rest — strong 1–8 minute efforts lift it above everything ridden for 10–40 minutes — so it isn't used on its own.
- **W′ balance**: Skiba's model in the differential form (Froncioni/Clarke), using the critical power of the automatic estimate and your W′ — bike power only.
- **Grade-adjusted pace** uses Minetti's metabolic cost of running on gradients. **NGP** applies the NP algorithm to GAP.
- **Aerobic decoupling**: output-per-heartbeat in the first vs second half of the moving time (skipping a 10-minute warm-up on long efforts), only for a steady hour on the bike or 45 minutes running with both halves within 5 % of each other — otherwise it describes the session, not the athlete. **EF** = NP (or NGP) / average HR.
- **Aerobic fitness from heart rate** ([`aerobic.ts`](shared/analytics/aerobic.ts)): steady stretches (8–10 min, both halves alike) pair output with the heart rate it settled at; rides without them are read whole, against power smoothed with heart rate's 40-second lag (not on hard, surgy rides, where surges hold heart rate up). A reference curve maps output to heart rate; each activity's heart-rate cost against it has heat, carried fatigue (TSB) and indoor riding removed — their sizes learned from your own data by comparing activities with their neighbours in time. A two-state Kalman filter then follows **fitness** (slow) and **condition** (spells that fade within a week), with noise levels fitted by maximum likelihood. Each activity gets a surprise score against fitness and against what was expected; fitness is reported as the output you'd hold at a reference heart rate under standard conditions, with an uncertainty that accounts for the shared evidence between two dates.
- **Efforts in context**: an activity's 1, 5, 20 and 60-minute power against the 90 days before it and all-time; durability (best 5 / 20 minutes after 1 000–3 000 kJ) against the last 90 days, when there are earlier rides that deep to compare with; 3–20 minute efforts against the critical-power model in effect that day.
- **Automatic thresholds**: for each day, the mean-max power (bike) or speed (run, swim) curve of the 182 days up to and including it, within the critical-power range (bike 3–30 min, run 2–40 min, swim 1–25 min). A hyperbola is fitted to the curve's upper envelope and each effort is scored against it. From all triples of efforts spaced ≥ 1.6× apart in duration (≥ 4× overall), the triple whose weakest effort scores highest is fitted with the linear work–time (distance–time) model. On the bike CP stays above FTP: when a 30–60 minute effort shows a higher FTP than 96 % of the fitted CP, the fit's long point was paced rather than all-out (the best 30 minutes inside a 40-minute ride), so CP is raised to match and W′ refitted so the model covers every 3–30 minute effort; and as the 2-parameter model overstates what can be held beyond ~30 minutes, an effort of 20–60 minutes above it raises CP to cover it. Interval sets count as well: the model must be able to ride every main set of 2+ reps of 3 minutes or more in the window (each rep at its average power, each recovery at its own, from a full W′, differential W′-balance model), so repeating a hard 10 minutes after a short rest — which a big W′ alone can't explain — raises CP to the lowest value that makes the set possible. The decline limit holds CP up in step with FTP. FTP = 96 % of CP, but never below what was actually held, scaled to an hour by the classic field test's ratio as a power law in time (P·(t / 60 min)^0.047, so 95 % of 20 minutes): 95 % of the best 20 minutes (capped at CP), and every effort from 30 to 60 minutes — 97 % of the best 30, 98 % of the best 40, the best hour in full. The Thresholds page shows which rule and which ride set it; run threshold = CS; CSS = CS. Applied values may fall by at most 1 % per week, compounded daily (fitness fades slowly, but a big effort leaves the window all at once); rises apply immediately, from the day of the ride; after a sync, every activity from the earliest day whose estimate changed is recalculated, so a ride uploaded late moves its own day and everything after it; after a break that empties the window, the first activities back use the first estimate fitted after it. **LTHR** is the second-highest best-30-minute heart rate of the window (run LTHR never below the bike's), **max HR** the second-highest maximum over 12 months; heart-rate thresholds carry the best value forward, less 0.7 bpm a year. Toggle auto/manual per sport on the Thresholds page.
- **PMC**: exponentially weighted CTL (42 d) and ATL (7 d); TSB = yesterday's CTL − ATL. The time constants can be changed in Preferences. Form zones are relative to fitness: TSB/CTL.
- **Sessions** ([`session.ts`](shared/analytics/session.ts)): work is found from power (or grade-adjusted pace) against threshold at three levels — sustained ≥ 80 % for 2½ min (runs 88 %), ≥ 105 % for 40 s, ≥ 130 % for 10 s — with edges trimmed to where the effort itself starts and ends; a block of on-off bursts (30/30s) becomes its bursts, and a sustained effort broken by a short or shallow dip stays one effort. Like efforts (lengths within 1.25×, intensity within 8 %) form sets. The main set is the biggest set that is large enough for its intensity to be the session's purpose (3 × 10 min at threshold is; two 3-minute rises in an endurance ride aren't), else a single sustained effort of 12 minutes or more, else a compact ladder. The session type follows the main set; without one, a hard ride with frequent surges is a group ride or race, and the rest go by intensity. For the main set: fade from the first rep to the last, consistency, how hard the reps opened, heart rate at the end of each rep and its drop a minute after. **Progression** compares a set with the comparable sets of the year before — the same kind, a similar dose (reps within one, rep lengths within 30 %, total time within 60 %) and output within 15 % — with how deep into the ride it came and the temperature as context.
- **Best efforts for any duration** ([`efforts.ts`](server/efforts.ts)): each activity's 1 Hz power, run speed (GPS glitches out, as the run curves use) and heart rate (gaps filled) are kept as compact typed arrays — in the database and in memory, about 12 MB for 1 100 activities — so any duration is an exact running-sum search over every activity (tens of milliseconds), one best per activity. Values match the stored mean-max curves exactly where the two overlap.
- **Training review** ([`review.ts`](shared/analytics/review.ts)): a week or block against your normal over the weeks before it (at least four), pro-rated while the week is under way; its title comes from the load ratio and CTL change (recovery, light, steady, build, big, a jump in load); its signs of fitness are sets stronger than last time, 90-day bests (by a margin of 0.5 % or more), an aerobic change beyond 1.5 sd, single strong heart-rate readings and FTP changes.
- **Comeback** ([`comeback.ts`](shared/analytics/comeback.ts), [`capacity.ts`](shared/analytics/capacity.ts)): peaks are the best of each season of daily FTP estimates — nothing higher within 120 days — with each estimate dated to the effort that sets it (its 20–60 minute floor, else the effort that raised CP, else the longest effort of the fit, which pins CP), so an estimate that adds a short new effort to old long ones stays with the old ones. A peak's numbers are the best power actually ridden in its own period, 8 weeks before to 4 after, without the monotonic fill of the best-effort curves (2 × 10 min holds more for 25 minutes than for any 20). Capacity is the 85th-percentile envelope of weekly best 20 minutes as a straight line in long-term load — an exponentially weighted average of ride TSS whose time constant (6 weeks to 2 years) is chosen by rolling-origin cross-validation over half-years; every time constant scoring within 3 % of the best stays plausible, and each is asked when it gets back to its own reading of the peak, so arrivals are ranges. The model is checked on the comeback, fitted only on the rides before it, against the 6-week CTL model on the same months, and the page says so when it does no better. A break is 90+ days without a ride (breaks a month or less apart are one); the current load is the last 6 weeks, or the comeback so far if that's shorter, and is set against the most ever sustained (the best 12-week average before it). Durability compares the best 20 minutes after each amount of work where both periods have 3+ rides that deep. The aerobic engine is the heart-rate model's then and now, also allowing for heart rate falling with age: 0.7 bpm a year, as for max HR, scaled by where the reference heart rate sits in the heart-rate reserve.
- **Sleep and recovery** ([`sleep.ts`](shared/analytics/sleep.ts)): HRV-guided training as in Plews et al. (2012) and Javaloyes et al. (2019). The 7-night average of ln HRV is set against your normal: the mean ± 0.5 SD of the 60 nights before, once there are 14 of them. Heart rate asleep is compared the same way, with ± 1 SD. HRV below its range, or heart rate above its range, says keep today easy. Form then says whether training is the likely cause (TSB −20 or lower) or something else is. **How training shows in the night after it** compares each night with the nights a month either side of it, so a change in fitness doesn't tilt every row. It groups the nights by the day before's training load (every sport) in five bands, from rest days to over 180 TSS, and shows medians.
- **Temperature** from a sensor stuck on one value (some head units report −7 °C throughout) is ignored.
- **Polarization index** follows Treff et al. (2019) on the Seiler 3-zone distribution.
- **Season plan**: phases are laid out backwards from race day. The build's CTL ramp is solved by simulation so race-day CTL lands on the target after the taper (capped by the max ramp and weekly hours); when it can't, the planner says whether hours or ramp is the limit and what would reach it. Recovery weeks run at 60 % load and the taper at 55–75 %. Hours use your own TSS per hour.

---

## Architecture

```
shared/            Pure TypeScript used by both server and browser
  analytics/       NP, curves, models, PMC, zones, running, workouts, season plan (+ tests)
  library.ts       Built-in structured workouts
server/            Hono API on Node, SQLite via node:sqlite
  providers/       Strava OAuth, webhooks and sync; Eight Sleep sync
  estimates.ts     Rolling daily FTP / threshold pace / CSS / heart-rate estimates
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
| `EIGHT_SLEEP_EMAIL`, `EIGHT_SLEEP_PASSWORD` | | Your Eight Sleep login, for the sleep sync |
| `EIGHT_SLEEP_CLIENT_ID`, `EIGHT_SLEEP_CLIENT_SECRET` | | The Eight Sleep app's client ID and secret (see [Eight Sleep](#eight-sleep-automatic-sync)) |
| `EIGHT_SLEEP_SYNC_HOURS` | `2` | How often new nights are read |
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
