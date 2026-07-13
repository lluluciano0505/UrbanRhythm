---
description: Kick off a scrape for a given city, monitor progress via the API, and report a summary when done.
---

# /test-city — Test a New City

## Input

The user provides a city name, e.g. `/test-city Austin` or `/test-city "New Orleans"`.

## Steps

1. Confirm backend is running: `curl -s http://localhost:8000/api/health`. If not, tell the user to run `/run` first.

2. Start the run:
```bash
curl -s -X POST http://localhost:8000/api/run \
  -H "Content-Type: application/json" \
  -d '{"city": "<CITY>", "radius_km": 30}'
```
Extract `run_id` from the response.

3. Poll status every 15 seconds:
```bash
curl -s http://localhost:8000/api/run/<run_id>/status
```
Print a one-line update each poll: `[elapsed] venues_done/venues_total, events_found so far`.
Stop when `finished=true` or `still_running=false`.

4. When done, print final summary:
- City, total venues discovered
- Venues scraped successfully vs failed
- Events found and accepted
- Time taken
- Top 3 event titles as a sample

5. Remind user to open `http://localhost:3000` to see results on the map (or open it automatically).

## Notes

- If the user doesn't provide a city name, ask for one before proceeding.
- If a run is already in progress (409 response), tell the user and show the current run's status.
- Radius defaults to 30km; user can override: `/test-city Austin 50`.
