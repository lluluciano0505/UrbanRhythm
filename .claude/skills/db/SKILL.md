---
description: Show a quick summary of the UrbanRhythm SQLite database — cities, runs, event counts, and recent activity.
---

# /db — Database Status

## Steps

Run the following Python snippet against `data/urbanrhythm.sqlite` (repo root):

```python
import sqlite3, json
from pathlib import Path

db = Path("/Users/luchieeoo/Documents/GitHub/UrbanRhythm/data/urbanrhythm.sqlite")
conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row

# Finished runs per city
print("=== RUNS (finished) ===")
for r in conn.execute("""
    SELECT city, finished_at, stats
    FROM runs WHERE finished_at IS NOT NULL
    ORDER BY finished_at DESC
""").fetchall():
    stats = json.loads(r["stats"]) if r["stats"] else {}
    print(f"  {r['city'][:30]:<30} | finished: {r['finished_at'][:16]} | venues: {stats.get('venues_done',0)} | events: {stats.get('events_accepted',0)}")

# Events per city
print()
print("=== EVENTS per city ===")
for r in conn.execute("SELECT city, verdict, COUNT(*) as cnt FROM events GROUP BY city, verdict ORDER BY city, verdict").fetchall():
    print(f"  {r['city'][:25]:<25} | {r['verdict']:<8} | {r['cnt']}")

# Playbook size
pb = conn.execute("SELECT COUNT(*) as cnt FROM playbook").fetchone()
print(f"\n=== PLAYBOOK: {pb['cnt']} domain entries ===")

# KG summary
kg = conn.execute("SELECT COUNT(DISTINCT venue_id) as v, COUNT(*) as t FROM kg_tags").fetchone()
print(f"=== KNOWLEDGE GRAPH: {kg['v']} venues tagged, {kg['t']} total tags ===")
```

Print the output clearly so the user can see the full DB state at a glance.
