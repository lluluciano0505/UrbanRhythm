---
description: Start the UrbanRhythm backend (FastAPI) and frontend (Vite) servers, then open the browser.
---

# /run — Start UrbanRhythm

## Steps

1. Check if backend (port 8000) is already running via `curl -s http://localhost:8000/api/health`. If it returns `{"status":"ok"}`, skip starting it.
2. If backend is down: `cd /Users/luchieeoo/Documents/GitHub/UrbanRhythm/backend && uvicorn main:app --port 8000 --reload` in background.
3. Check if frontend (port 3000) is already running via `curl -s http://localhost:3000`. If it responds, skip starting it.
4. If frontend is down: `cd /Users/luchieeoo/Documents/GitHub/UrbanRhythm && npm run dev` in background.
5. Wait ~3 seconds, confirm both are up, then `open http://localhost:3000`.

## Notes

- Backend must be started from `backend/` directory (not repo root) — otherwise module imports fail.
- Frontend runs on port 3000 (Vite config), not the default 5173.
- If port 8000 is already in use but health check fails, kill the old process: `lsof -ti:8000 | xargs kill -9`.
