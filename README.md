# Herald

Herald turns messy meeting notes into a clean summary, owned action items, and a ready-to-send follow-up email — then follows up to make sure things actually got done. Built for the GrowthX Hermes Buildathon (Revenue track). Every LLM call in the backend routes through a local Hermes API server (which is itself configured to use OpenAI as its model provider) — the backend never calls OpenAI, Groq, or Anthropic directly.

## Setup

### Prerequisites

- Python 3.11+ (uses `str | None` union syntax)
- A running Hermes instance with its local API server enabled (see [Hermes wiring](#hermes-wiring) below)
- Any static file server or just opening `frontend/index.html` directly in a browser

### 1. Install backend dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Hermes wiring

Herald's backend never calls OpenAI directly — it calls Hermes' local API server, which is itself configured (on the Hermes side) to use OpenAI as its model provider.

On the **Hermes** side:

1. Point Hermes at OpenAI. In `~/.hermes/.env` (or `%LOCALAPPDATA%\hermes\.env` on native Windows):
   ```
   OPENAI_API_KEY=sk-...
   ```
2. In Hermes' `config.yaml`:
   ```yaml
   model:
     provider: "openai-api"
     default: "gpt-5.6-sol"
   ```
3. Enable Hermes' API server, in the same `.env`:
   ```
   API_SERVER_ENABLED=true
   API_SERVER_KEY=herald-local-dev
   ```
4. Run `hermes doctor` once to confirm the config landed.

On the **Herald backend** side, the same values are read from environment variables (with the spec's defaults baked in if you don't set them), in `backend/llm.py`:

| Env var | Default | Purpose |
|---|---|---|
| `HERMES_URL` | `http://localhost:8642/v1/chat/completions` | Hermes' local OpenAI-shaped chat completions endpoint |
| `HERMES_KEY` | `herald-local-dev` | Must match Hermes' `API_SERVER_KEY` |
| `HERMES_MODEL` | `gpt-5.6-sol` | Model name passed through to Hermes |

If your Hermes instance uses different values, set them before starting the backend, e.g.:

```bash
export HERMES_URL=http://localhost:8642/v1/chat/completions
export HERMES_KEY=herald-local-dev
```

### 3. Start the backend

```bash
cd backend
uvicorn main:app --reload --port 8000
```

This creates `backend/herald.db` on first run (SQLite, `CREATE TABLE IF NOT EXISTS`, no migrations).

### 4. Open the frontend

The frontend is plain HTML/CSS/JS with no build step. Just open `frontend/index.html` in a browser, or serve the folder with any static server, e.g.:

```bash
cd frontend
python -m http.server 5500
```

Then visit `http://localhost:5500`. If your backend isn't on `http://localhost:8000`, change `API_BASE` at the top of `frontend/app.js`.

## Usage

1. **Sign up** — from the landing page, click "Try it free," enter a name and email (no password). A token is generated and stored in your browser's localStorage; it's sent as the `X-Auth-Token` header on every request after that.
2. **Paste a transcript** — on the dashboard, use the "New meeting" panel: give it a title, paste any messy notes or transcript, and click "Process meeting." Herald calls Hermes once, extracts a summary/members/action items/follow-up email, and takes you to the meeting detail page.
3. **Edit an action item** — on the meeting detail page, click directly into an action item's text or owner to edit it inline (it saves on blur), or click the circular badge to toggle it between PENDING and SENT (done).
4. **Use the follow-up chat** — on the meeting detail page's chat panel, ask a question about that specific meeting (e.g. "did we decide who owns the budget doc?"). Herald injects that meeting's summary, members, action items, and email draft into the prompt each time (lite-RAG — no vector DB) and the thread persists across refreshes.
5. **Trigger the simulated upgrade** — once you hit the 3-meeting free tier limit (or anytime from the pricing section), you'll be sent to `#/checkout`. Click "Upgrade now," then fill out the mock card form on the next screen and click "Pay $5" — this flips your account to the paid tier with unlimited meetings.

## What's simulated / not real yet

- **Dodo Payments checkout is fully simulated.** `POST /api/checkout` never calls Dodo's API — it just creates an in-memory mock pending order and hands back a link to Herald's own mock payment screen. `POST /api/checkout/confirm` flips `tier = 'paid'` directly in SQLite, with no webhook and no external call. The seam for a real integration is exactly two functions in `backend/main.py`: `create_checkout_session()` and `confirm_payment()` — only those change when wiring up real Dodo Payments and webhook signature verification.
- **Teams/Meet import is a UI-only placeholder.** The "Teams / Meet import — coming soon" pill on the dashboard is disabled and does nothing; there is no live meeting integration.
- **Scheduled 24-hour follow-up nudges do not exist.** Herald's chat panel answers questions on demand, but nothing runs on a timer to proactively chase people — that's roadmap, not built.
- **Auth is intentionally not real.** Signup is name + email, no password, no email verification, no password reset, no session expiry — just a random token in localStorage sent as a header. This is a deliberate hackathon simplification, not an oversight.

Do not demo any of the above as if it were live — call it out as "built the flow, real integration is next" if asked directly.

## Project structure

```
hermes/
├── README.md
├── backend/
│   ├── requirements.txt
│   ├── database.py     # SQLite schema (4 tables) + connection helper, CREATE TABLE IF NOT EXISTS on startup
│   ├── llm.py           # The ONLY file that calls an LLM — Hermes call helper, extraction prompt, lite-RAG chat prompt
│   ├── main.py           # FastAPI app: every route, pseudo-auth, free-tier gating, simulated checkout seam
│   └── herald.db         # Created on first run — not checked in
└── frontend/
    ├── index.html         # Shell page, Google Fonts, mount point for the router
    ├── styles.css          # Full design system: palette, type pairing, stamped dispatch slip, motion
    └── app.js               # Hash router, all views, API calls, auth/localStorage handling
```

## API surface

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/signup` | `{name, email}` → creates user, returns `{token, user}` |
| `POST` | `/api/meetings` | `{title, transcript}` + token header → calls Hermes, stores meeting + action items |
| `GET` | `/api/meetings` | Token header → list of user's meetings with action item counts |
| `GET` | `/api/meetings/{id}` | Token header → full meeting detail |
| `PATCH` | `/api/action-items/{id}` | `{text?, owner?, status?}` → manual edit, sets `is_edited = true` |
| `POST` | `/api/chat` | `{meeting_id, message}` → lite-RAG chat reply, persisted both sides |
| `GET` | `/api/chat/{meeting_id}` | Token header → chat history for a meeting (used to restore the thread on refresh) |
| `GET` | `/api/analytics` | Token header → `{total_meetings, total_action_items, completion_rate, meetings_used, tier}` |
| `POST` | `/api/checkout` | Token header → creates a simulated pending order, returns a mock checkout URL |
| `POST` | `/api/checkout/confirm` | Token header → marks the mock order paid, sets `tier = 'paid'` |

Free tier gating: `POST /api/meetings` returns `402` once a free-tier user has used 3 meetings; the frontend turns that into an upgrade prompt linking to `#/checkout`.
