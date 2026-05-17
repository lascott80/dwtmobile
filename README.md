# Disney Wait Times Mobile

Mobile-first Walt Disney World wait times app built with Next.js and a separate Python polling service.

## Stack

- Frontend: Next.js / React
- Local cache and history: SQLite
- Poller: Python standard library inside a local virtual environment

## Upstream APIs

- Queue-Times live waits and land grouping
- ThemeParks.wiki schedules, showtimes, and character greetings

## Local Setup

```bash
cd /Users/lascott/Development/dwtmobile
npm install
python3 -m venv .venv
source .venv/bin/activate
python python-service/collector.py --once
npm run dev
```

## Architecture

- `python-service/collector.py` polls the upstream services, normalizes data, and stores 60 days of snapshots.
- `app/api/*` exposes SQLite-backed internal endpoints for the frontend.
- The frontend never calls the third-party APIs directly.
- Favorites are stored in `localStorage` on the device.
