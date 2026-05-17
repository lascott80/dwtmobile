# Python Collector

This service runs independently from the Next.js frontend and polls the upstream APIs into a local SQLite database.

## Setup

```bash
cd /Users/lascott/Development/dwtmobile
python3 -m venv .venv
source .venv/bin/activate
python python-service/collector.py --once
```

## Continuous Run

```bash
source .venv/bin/activate
python python-service/collector.py
```

For more verbose troubleshooting output:

```bash
python python-service/collector.py --once --log-level DEBUG
```

Polling cadence:

- Every 5 minutes from 6:00 AM through 11:59 PM Eastern
- Every 30 minutes from 12:00 AM through 5:59 AM Eastern

The collector keeps 60 days of historical wait snapshots in `python-service/data/disney_wait_times.db`.
It logs each poll cycle, per-park update counts, failures, and the next sleep interval so you can confirm it is alive.
