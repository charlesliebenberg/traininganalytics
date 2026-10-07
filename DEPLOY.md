# Deploying

The recommended setup auto-deploys from GitHub on every push:

| Part | Host | Config file |
|---|---|---|
| Backend API, sync worker, SQLite database | **Render** (web service + persistent disk) | `render.yaml` |
| Frontend | **Vercel** *or* **Netlify** | `vercel.json` / `netlify.toml` |

The frontend proxies `/api/*` to Render, so the browser only ever talks to one domain. Login cookies, Strava OAuth and webhooks all work without any CORS setup.

> The Render service also builds and serves the frontend, so its own `onrender.com` URL is a complete, working copy of the app. Vercel/Netlify is optional and gives you a faster CDN-hosted frontend that doesn't wait for a sleeping backend to serve the page.

## 1. Backend on Render

1. Render dashboard → **New → Blueprint** → connect the `traininganalytics` GitHub repo. Render reads `render.yaml`.
2. Pick the branch to deploy from (auto-deploy is on, so every push redeploys).
3. Fill in the environment variables Render asks for:

   | Variable | Value |
   |---|---|
   | `APP_PASSWORD` | A strong password. **Required**: without it anyone with the URL can read and change your data. |
   | `PUBLIC_URL` | The URL you'll open the app at, e.g. `https://traininganalytics.vercel.app`. Use the `onrender.com` URL if you skip Vercel/Netlify. |
   | `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` | From <https://www.strava.com/settings/api> (step 3). |

4. Deploy. Note the service URL, normally `https://traininganalytics-api.onrender.com`.

**Plan.** The blueprint uses the **Starter** instance with a **1 GB disk** mounted at `/var/data` for the database. Render's free instances have no persistent disk, so your data would be wiped on every deploy and restart. A free instance also sleeps after 15 minutes idle, which stops the background Strava polling.

## 2. Frontend on Vercel (or Netlify)

**If Render gave you a different URL** than `traininganalytics-api.onrender.com` (e.g. the name was taken), first update the API destination in `vercel.json` (or `netlify.toml`) and push.

- **Vercel:** *Add New → Project* → import the repo. Framework, build command and output directory are read from `vercel.json`. Deploy.
- **Netlify:** *Add new site → Import from Git* → pick the repo. Settings come from `netlify.toml`. Deploy.

Then set `PUBLIC_URL` on Render to the final Vercel/Netlify URL (or your custom domain) and let Render redeploy.

## 3. Connect Strava

1. At <https://www.strava.com/settings/api> set **Authorization Callback Domain** to the host of `PUBLIC_URL`, without `https://` (e.g. `traininganalytics.vercel.app`).
2. Open the app, sign in, go to **Settings → Connections → Connect Strava**.
3. Click **Enable webhook** so new activities arrive within seconds. Polling every 15 minutes is the fallback.

## Notes

- **Big imports.** Vercel and Netlify proxies limit request size and duration. Small batches of FIT/GPX files are fine. For a large TrainingPeaks or Strava export ZIP, open the app at its `onrender.com` URL and import there, since that goes straight to the backend.
- **Backups.** The whole database is one file, `/var/data/training.db`. Render's disk snapshots cover it, or copy it out from a Render shell.
- **Frontend on another domain without the proxy.** Build the frontend with `VITE_API_URL=https://<your-api>`. On Render, set `API_URL` to the API's own URL and `PUBLIC_URL` to the frontend URL. The API then allows that origin via CORS and issues a cross-site cookie. The proxy setup above is simpler and is the one to use unless you have a reason not to.
- **Single service only.** Skip step 2 and set `PUBLIC_URL` to the Render URL.
