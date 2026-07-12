# Herald — Build Spec

**One-liner:** Herald turns messy meeting notes into a clean summary, owned action items, and a ready-to-send follow-up email — then follows up to make sure things actually got done.

**Track:** Revenue (GrowthX Hermes Buildathon)

**Stack:** Python (FastAPI) backend · SQLite · vanilla HTML/CSS/JS frontend (no build step) · Hermes Agent (OpenAI-backed) for all LLM calls · Dodo Payments checkout **simulated** for now, real integration deferred

**Status note on this revision:** two things changed from the original plan — Hermes now runs on OpenAI as its model provider instead of Groq, and Dodo Payments is a simulated checkout flow rather than a live one. Both are called out explicitly below so nothing gets "corrected" back by accident later.

**Philosophy for this build:** Build it whole in one pass, then optimize. No auth system, no external DB, no real security — SQLite file + a random token is the entire "auth" layer. This is intentional, not a shortcut we regret: it removes every point of failure that doesn't affect what judges score.

---

## 1. Why these tech choices (so nothing gets "improved" into complexity later)

- **SQLite, not "no DB."** A judge needs to open your live URL on their own device and see it work — that requires shared server-side state, not browser localStorage. SQLite is one file, zero setup, and satisfies this completely. Do not upgrade to Postgres for this event.
- **Token-based pseudo-auth, not real auth.** Signup = name + email, no password. Backend generates a random token, returns it, frontend stores it in localStorage and sends it as a header on every request. This is not secure and that's fine — nobody is scored on your security model.
- **Vanilla HTML/CSS/JS frontend, not React.** No build step means no "npm install failed 20 minutes before demo." Client-side routing via URL hash (`#/`, `#/dashboard`, `#/meeting/:id`) is enough for this scope.
- **Lite-RAG, not real RAG.** A single meeting's transcript + summary + action items fits comfortably in an LLM context window. Skip embeddings and a vector DB entirely — just inject the meeting's full context into the chat prompt every time. Identical user experience, a fraction of the build time.
- **Hermes as the routing layer, not calling OpenAI directly.** The buildathon's only eligibility rule is "use Hermes." Herald qualifies via the **base harness** path (your product runs on Hermes; end users interact with a Hermes-driven capability). Every LLM call in the backend must go through your local Hermes API server (`http://localhost:8642/v1/chat/completions`), which is itself configured to use OpenAI (`gpt-5.6-sol`) as its model provider. This is a one-line base_url change, not an architecture decision — don't skip it, it's the difference between qualifying and not.

---

## 2. Data model (SQLite — 4 tables)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,          -- uuid
  name TEXT,
  email TEXT,
  token TEXT UNIQUE,             -- pseudo-auth token
  tier TEXT DEFAULT 'free',      -- 'free' | 'paid'
  meetings_used INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,           -- uuid
  user_id TEXT REFERENCES users(id),
  title TEXT,
  transcript TEXT,               -- raw pasted transcript/notes
  summary TEXT,                  -- LLM-generated
  members TEXT,                  -- JSON array of names/emails detected
  follow_up_email TEXT,          -- LLM-drafted email
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE action_items (
  id TEXT PRIMARY KEY,           -- uuid
  meeting_id TEXT REFERENCES meetings(id),
  text TEXT,
  owner TEXT,
  status TEXT DEFAULT 'pending', -- 'pending' | 'done'
  is_edited BOOLEAN DEFAULT 0
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id),
  role TEXT,                     -- 'user' | 'assistant'
  content TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

No migrations framework. Just a `CREATE TABLE IF NOT EXISTS` block that runs on backend startup.

---

## 3. Backend API surface (FastAPI)

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/signup` | `{name, email}` → creates user, returns `{token, user}` |
| `POST` | `/api/meetings` | `{title, transcript}` + token header → calls Hermes, parses response, stores meeting + action items, returns full meeting object |
| `GET` | `/api/meetings` | token header → list of user's meetings (id, title, created_at, action item counts) |
| `GET` | `/api/meetings/{id}` | token header → full meeting detail: summary, members, action items, follow-up email |
| `PATCH` | `/api/action-items/{id}` | `{text?, owner?, status?}` → manual edit, sets `is_edited = true` |
| `POST` | `/api/chat` | `{meeting_id, message}` → lite-RAG: injects that meeting's data into prompt, calls Hermes, stores + returns assistant reply |
| `GET` | `/api/analytics` | token header → `{total_meetings, total_action_items, completion_rate, meetings_used, tier}` |
| `POST` | `/api/checkout` | token header → creates a mock pending order, returns the simulated checkout page URL |
| `POST` | `/api/checkout/confirm` | token header → marks the mock order paid, sets `user.tier = 'paid'` |

**Free tier gating logic:** block `POST /api/meetings` once `meetings_used >= 3` for `tier == 'free'` users, return a 402-style response the frontend turns into an upgrade prompt.

### The core extraction call (the most important prompt in the product)

One well-structured call to Hermes per new meeting, asking for strict JSON back:

```
System: You are Herald, an assistant that extracts structured follow-up
data from meeting notes. Always respond with valid JSON only, matching
this schema exactly:
{
  "summary": "2-4 sentence summary",
  "members": ["name1", "name2"],
  "action_items": [{"text": "...", "owner": "name or null"}],
  "follow_up_email": "a ready-to-send email drafted in a neutral
    professional voice, referencing the specific action items"
}

User: <the pasted transcript/notes>
```

Parse the JSON response, insert one row per action item, store the rest on the meeting row. Handle the case where the model wraps JSON in markdown fences — strip those before parsing.

### The lite-RAG chat call

```
System: You are Herald's follow-up assistant for one specific meeting.
Use ONLY the context below to answer. If asked something not covered,
say so plainly.

Meeting summary: <summary>
Members: <members>
Action items: <formatted list with owner + status>
Follow-up email draft: <follow_up_email>

User: <their question, e.g. "did we decide who owns the budget doc?">
```

No vector search, no chunking — the whole meeting fits in context. Store both sides of the exchange in `chat_messages` so the thread persists on refresh.

---

## 4. Frontend structure

Single `index.html` + `styles.css` + `app.js`, hash-based routing, no framework.

**Views:**
1. **Landing (`#/`)** — public, no token needed. Full spec below.
2. **Signup (`#/signup`)** — name + email form → POST `/api/signup` → store token in localStorage → redirect to dashboard.
3. **Dashboard (`#/dashboard`)** — analytics strip at top (total meetings, action items, completion rate), "New meeting" button (paste-box for transcript + title), meeting list below.
4. **Meeting detail (`#/meeting/:id`)** — summary card, members list, action items (each with inline edit + status toggle), follow-up email (copy-to-clipboard button), chat panel pinned at the bottom or side for follow-up Q&A on that meeting.
5. **Upgrade modal / simulated checkout (`#/checkout`)** — tier comparison, then the mock card-style payment screen described in section 5.

---

### Design system

**Palette (named hex values):**
| Token | Hex | Use |
|---|---|---|
| `ink` | `#101425` | Primary background, deep indigo-black (not pure black) |
| `surface` | `#1B2036` | Cards, panels, raised elements |
| `surface-raised` | `#242B47` | Hover/active states on cards |
| `paper` | `#F6F2E7` | Reserved for the checkout screen and form inputs only — warm parchment, not a whole-page background |
| `ink-text` | `#E8E6DE` | Primary text on dark surfaces |
| `muted` | `#8890A6` | Secondary text, captions, timestamps |
| `signal-teal` | `#3ED9B8` | "Done/confirmed" states, primary CTA accent |
| `stamp-amber` | `#F2A93B` | "Pending" states, secondary accent |

Avoid the two generic AI-design defaults: warm-cream-background-plus-terracotta-accent, and near-black-plus-single-acid-green-accent. Herald's combination (ink + teal + amber, used as functional status colors rather than decoration) reads distinctly against both.

**Typography:**
- **Display — Space Grotesk.** Headlines and the hero statement only. Used sparingly — if more than ~3 elements per screen use it, pull it back.
- **Body/UI — IBM Plex Sans.** Everything else: paragraph copy, nav, buttons, form labels.
- **Data/utility — IBM Plex Mono.** Timestamps, meeting IDs, action-item counts, the "stamped" badge text (PENDING / SENT) — anything that reads as a data point rather than prose. This is what gives the dispatch-desk feel its texture.
- Load all three via Google Fonts CDN. Set a clear type scale (e.g. hero 56–72px, section headers 32px, body 16–18px, mono data 13–14px) rather than letting default browser sizes carry the hierarchy.

**Signature element:** action items render as a **stamped dispatch slip** — a compact card with a circular badge in the corner (amber ring + "PENDING" in mono type, or teal filled circle + "SENT" once marked done). This is the one visual idea Herald should be remembered by. Reuse it consistently: on the meeting detail page, in the dashboard's recent-activity list, even as a small motif in the landing page's product screenshot. Keep every other UI element quiet and disciplined around it — no competing decorative flourishes elsewhere.

**Motion:** one deliberate moment, not scattered hover effects. On the landing page hero, a short looping or on-load animation showing scrambled meeting notes resolving into a clean stamped action item card — this doubles as the clearest one-glance explanation of the product. Elsewhere: standard, restrained transitions only (200ms fades/slides), nothing ornamental.

---

### Landing page — full section-by-section spec

Write real copy here, not lorem ipsum or generic SaaS phrasing. Voice: plain, direct, slightly wry — like Herald itself is the dispatch operator talking, not a marketing team.

**1. Nav bar**
Logo mark (a simple stamp/seal icon + "Herald" in Space Grotesk) · anchor links (How it works, Pricing) · "Log in" (ghost button) · "Try it free" (filled teal button) on the right.

**2. Hero**
- Eyebrow (small mono-type label): `MEETING FOLLOW-THROUGH, AUTOMATED`
- Headline (Space Grotesk, large): something like *"Your meetings end. The follow-through doesn't have to."*
- Subhead (Plex Sans, muted color): one sentence naming the actual problem — notes get taken, action items quietly die, nobody's fault, just entropy.
- The signature animation described above, or a static product screenshot of a meeting detail page with a few stamped action items visible, sitting to the right or below the headline.
- Primary CTA: "Paste your first meeting free" → scrolls to or opens the try-it flow directly. Avoid a generic "Get Started" — name the actual first action.

**3. How it works (3 steps — genuinely sequential, numbering earned here)**
- 01 Paste your notes or transcript
- 02 Herald extracts the summary, owners, and a drafted follow-up in seconds
- 03 Chase what's still pending — Herald tracks it so you don't have to
Each step: a short line of copy plus a small illustrative snippet (e.g. a mini stamped action-item card for step 3).

**4. Product preview**
A larger, real-looking screenshot or embedded mock of the meeting detail page — summary card, member list, a couple of stamped action items, the chat panel. This is the section doing the actual convincing; don't under-invest here relative to the hero.

**5. Why it's different (not another summarizer)**
Short section directly naming Otter/Fireflies-style tools and the gap: they stop at the summary, Herald follows through. Two or three columns: "Summary" (table stakes, everyone has this) vs. "Owned action items" vs. "Actually chased" — visually show the third column as the one with the teal accent, since that's the differentiator.

**6. Pricing**
Two cards: Free (3 meetings, all core features, no card required) and Paid (flat monthly, unlimited meetings). Keep it to two tiers — a three-tier ladder is more design and copy work than this scope needs, and doesn't change what gets scored.

**7. Footer CTA**
Repeat the primary action once more, simply: headline + "Try it free" button. No need for a large multi-column footer with social links etc. — a single line with the logo mark and a copyright line is enough.

**Copy principles to hold throughout:** name things by what the person does, not how the system works ("paste your notes," not "submit transcript data"); active voice on every button ("Try it free," not "Get Started Now!!"); no exclamation-point energy — the tone is competent and calm, like a good assistant, not hypey.

---

## 5. Payments (Dodo — simulated for now)

**Goal for this phase:** the full checkout *experience* works end to end — clicking upgrade, seeing a checkout screen, "paying," landing back on an unlocked dashboard — without touching Dodo's real API. This keeps the product demo-complete while you decide later whether to wire the real integration.

- Free tier: 3 meetings, no card required.
- Paid tier: one flat plan for the demo (e.g. "$5/mo, unlimited meetings").
- `POST /api/checkout` does **not** call Dodo. It creates a `pending` mock order row and returns a URL to your own `/checkout-simulated` page — a simple screen with card-style input fields (not wired to any real payment rail) and a "Pay $5" button.
- Clicking "Pay" on that simulated page calls `POST /api/checkout/confirm`, which flips `tier = 'paid'` for that user directly in SQLite — no webhook, no external call.
- Structure the code so this is an easy swap later: keep a single `create_checkout_session()` function and a single `confirm_payment()` function as the seam. When you're ready for the real integration, only those two functions change to call Dodo's actual API and verify their webhook signature — nothing else in the app needs to know the difference.
- **Be upfront in the demo** that the checkout is simulated if asked directly — framing it as "payment flow built, Dodo integration is the next step" is honest and still shows the full product experience working.

---

## 6. Hermes/OpenAI wiring — the exact config

**Why Hermes still has to be in the loop:** the buildathon's only eligibility rule is "no Hermes, no score." Herald qualifies via the **base harness** path — your product's end users interact with a capability that Hermes is actually driving. That means every LLM call in the backend must still hit your local Hermes API server, not OpenAI's API directly. Switching Hermes' model provider to OpenAI is fine and encouraged (the handbook itself recommends OpenAI/`gpt-5.6-sol` as the strongest driver) — but the call path stays `your backend → Hermes → OpenAI`, not `your backend → OpenAI`. Skipping Hermes entirely to save a step disqualifies the build.

1. Point Hermes at OpenAI instead of Groq. In `~/.hermes/.env` (or `%LOCALAPPDATA%\hermes\.env` on native Windows):
   ```
   OPENAI_API_KEY=sk-...
   ```
2. In `config.yaml`, set the provider id exactly as `openai-api` (not `openai`):
   ```yaml
   model:
     provider: "openai-api"
     default: "gpt-5.6-sol"
   ```
3. Enable the API server so your backend can reach it: in Hermes' `.env`, add
   ```
   API_SERVER_ENABLED=true
   API_SERVER_KEY=herald-local-dev
   ```
4. Backend's LLM helper function points at Hermes' local server, never at OpenAI directly:
   ```python
   HERMES_URL = "http://localhost:8642/v1/chat/completions"
   HERMES_KEY = "herald-local-dev"
   ```
5. Every call (extraction + chat) is a standard OpenAI-shaped POST to that URL with the Bearer token above. Run `hermes doctor` once after the provider swap to confirm the config landed before wiring the backend to it.

---

## 7. Feature priority (what to protect vs. what to cut first if time runs short)

**Non-negotiable (this is the entire score):**
- Landing page
- Signup → dashboard
- Transcript upload → summary/members/action items/email
- Manual action-item edit
- Simulated Dodo checkout — full flow works end to end, real API deferred

**Build if time allows:**
- Lite-RAG chat panel
- Analytics strip
- Meeting search/filter

**Do not build — fake or defer:**
- Teams/Meet live integration → a visibly disabled "Coming soon" button on the dashboard is enough
- Real scheduled 24-hour follow-up nudges → mention as roadmap in the pitch; do not build a scheduler for this event
- Any real authentication, password reset, email verification

---

## 8. Demo script anchor (for whoever builds this to keep in mind while building)

The live demo moment this whole build is optimized for: a mentor's own real, messy meeting notes get pasted in, and within a few seconds a clean summary, correctly-owned action items, and a usable follow-up email appear — followed by asking the chat panel a real follow-up question about that meeting and getting a grounded answer back. If you later want a live "speed" beat for the demo, that's the moment to reconsider Groq as the provider — OpenAI via Hermes is the right default for quality and reliability today, and swapping providers later is a one-line config change on the Hermes side, not an app rewrite.