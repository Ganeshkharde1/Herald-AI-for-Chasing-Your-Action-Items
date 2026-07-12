"""
Herald backend — FastAPI + SQLite, no ORM, no migrations.

Auth: pseudo-auth only, by design (see plan.md section 1). Signup returns a
random token; every authenticated request sends it back as the
`X-Auth-Token` header. There is no password, no session, no expiry. Do not
upgrade this to real auth for the hackathon — that's explicitly out of
scope.
"""

import json
import secrets
import uuid
import os
import bcrypt
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from database import get_db, init_db
from llm import chat_reply, extract_meeting_data

app = FastAPI(title="Herald API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # auth is a custom header, not cookies — no credentials needed, and "*" + credentials is rejected by browsers anyway
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    init_db()


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------

def get_current_user(x_auth_token: str | None = Header(default=None)) -> dict:
    if not x_auth_token:
        raise HTTPException(status_code=401, detail="Missing X-Auth-Token header")

    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM users WHERE token = ?", (x_auth_token,)).fetchone()
    finally:
        conn.close()

    if row is None:
        raise HTTPException(status_code=401, detail="Invalid token")

    return dict(row)


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------

class SignupBody(BaseModel):
    name: str
    email: str
    password: str

class LoginBody(BaseModel):
    email: str
    password: str

class WaitlistBody(BaseModel):
    email: str


class MeetingCreateBody(BaseModel):
    title: str
    transcript: str


class ActionItemPatchBody(BaseModel):
    text: str | None = None
    owner: str | None = None
    status: str | None = None


class ChatBody(BaseModel):
    meeting_id: str
    message: str


# ---------------------------------------------------------------------------
# Simulated checkout state (see checkout section below for why this is not
# a 5th SQLite table)
# ---------------------------------------------------------------------------

# user_id -> order_id, for pending mock orders. Simulated payments don't need
# to survive a server restart, so this stays in memory rather than adding a
# table the spec's data model (section 2) doesn't define.
_pending_orders: dict[str, str] = {}


# ---------------------------------------------------------------------------
# Signup
# ---------------------------------------------------------------------------

@app.post("/api/signup")
def signup(body: SignupBody):
    user_id = str(uuid.uuid4())
    token = secrets.token_hex(24)
    hashed_pw = bcrypt.hashpw(body.password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    conn = get_db()
    try:
        existing = conn.execute("SELECT id FROM users WHERE email = ?", (body.email,)).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="Email already registered")

        role = "admin" if "admin" in body.name.lower() or "admin" in body.email.lower() else "user"
        
        conn.execute(
            "INSERT INTO users (id, name, email, token, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, body.name, body.email, token, hashed_pw, role),
        )
        conn.commit()
    finally:
        conn.close()

    return {"message": "Signup successful"}


@app.post("/api/login")
def login(body: LoginBody):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (body.email,)).fetchone()
        if not row or not row["password_hash"]:
            raise HTTPException(status_code=401, detail="Invalid email or password")
            
        if not bcrypt.checkpw(body.password.encode("utf-8"), row["password_hash"].encode("utf-8")):
            raise HTTPException(status_code=401, detail="Invalid email or password")
            
        conn.execute("UPDATE users SET login_count = login_count + 1 WHERE id = ?", (row["id"],))
        conn.commit()
        
        updated_row = conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    finally:
        conn.close()
        
    return {"token": updated_row["token"], "user": dict(updated_row)}


# ---------------------------------------------------------------------------
# Meetings
# ---------------------------------------------------------------------------

FREE_TIER_MEETING_LIMIT = 3


@app.post("/api/meetings")
def create_meeting(body: MeetingCreateBody, x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)

    if user["tier"] == "free" and user["meetings_used"] >= FREE_TIER_MEETING_LIMIT:
        raise HTTPException(
            status_code=402,
            detail="Free tier limit reached — upgrade to process more meetings",
        )

    try:
        extracted = extract_meeting_data(body.transcript)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    meeting_id = str(uuid.uuid4())
    members = extracted.get("members", [])
    summary = extracted.get("summary", "")
    follow_up_email = extracted.get("follow_up_email", "")
    action_items = extracted.get("action_items", [])

    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO meetings (id, user_id, title, transcript, summary, members, follow_up_email)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (meeting_id, user["id"], body.title, body.transcript, summary, json.dumps(members), follow_up_email),
        )

        for item in action_items:
            conn.execute(
                "INSERT INTO action_items (id, meeting_id, text, owner) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), meeting_id, item.get("text", ""), item.get("owner")),
            )

        conn.execute(
            "UPDATE users SET meetings_used = meetings_used + 1 WHERE id = ?",
            (user["id"],),
        )
        conn.commit()
    finally:
        conn.close()

    return _get_meeting_detail(meeting_id, user["id"])


@app.get("/api/meetings")
def list_meetings(x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)

    conn = get_db()
    try:
        meetings = conn.execute(
            "SELECT id, title, created_at FROM meetings WHERE user_id = ? ORDER BY created_at DESC",
            (user["id"],),
        ).fetchall()

        result = []
        for meeting in meetings:
            counts = conn.execute(
                """SELECT
                     COUNT(*) AS total,
                     SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
                   FROM action_items WHERE meeting_id = ?""",
                (meeting["id"],),
            ).fetchone()
            result.append(
                {
                    "id": meeting["id"],
                    "title": meeting["title"],
                    "created_at": meeting["created_at"],
                    "action_item_count": counts["total"] or 0,
                    "action_items_done": counts["done"] or 0,
                }
            )
    finally:
        conn.close()

    return result


def _get_meeting_detail(meeting_id: str, user_id: str) -> dict:
    conn = get_db()
    try:
        meeting = conn.execute(
            "SELECT * FROM meetings WHERE id = ? AND user_id = ?", (meeting_id, user_id)
        ).fetchone()

        if meeting is None:
            raise HTTPException(status_code=404, detail="Meeting not found")

        action_items = conn.execute(
            "SELECT * FROM action_items WHERE meeting_id = ? ORDER BY rowid ASC", (meeting_id,)
        ).fetchall()

        meeting_dict = dict(meeting)
        try:
            meeting_dict["members"] = json.loads(meeting_dict["members"] or "[]")
        except json.JSONDecodeError:
            meeting_dict["members"] = []

        meeting_dict["action_items"] = [dict(item) for item in action_items]
        return meeting_dict
    finally:
        conn.close()


@app.get("/api/meetings/{meeting_id}")
def get_meeting(meeting_id: str, x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)
    return _get_meeting_detail(meeting_id, user["id"])


# ---------------------------------------------------------------------------
# Action items
# ---------------------------------------------------------------------------

@app.patch("/api/action-items/{item_id}")
def patch_action_item(item_id: str, body: ActionItemPatchBody, x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)

    conn = get_db()
    try:
        # Ownership check: the action item's meeting must belong to this user.
        row = conn.execute(
            """SELECT action_items.* FROM action_items
               JOIN meetings ON meetings.id = action_items.meeting_id
               WHERE action_items.id = ? AND meetings.user_id = ?""",
            (item_id, user["id"]),
        ).fetchone()

        if row is None:
            raise HTTPException(status_code=404, detail="Action item not found")

        updates = []
        params: list = []

        if body.text is not None:
            updates.append("text = ?")
            params.append(body.text)
        if body.owner is not None:
            updates.append("owner = ?")
            params.append(body.owner)
        if body.status is not None:
            if body.status not in ("pending", "done"):
                raise HTTPException(status_code=400, detail="status must be 'pending' or 'done'")
            updates.append("status = ?")
            params.append(body.status)

        if updates:
            updates.append("is_edited = 1")
            params.append(item_id)
            conn.execute(f"UPDATE action_items SET {', '.join(updates)} WHERE id = ?", params)
            conn.commit()

        updated = conn.execute("SELECT * FROM action_items WHERE id = ?", (item_id,)).fetchone()
        return dict(updated)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Chat (lite-RAG)
# ---------------------------------------------------------------------------

@app.post("/api/chat")
def chat(body: ChatBody, x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)
    meeting = _get_meeting_detail(body.meeting_id, user["id"])

    conn = get_db()
    try:
        user_msg_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO chat_messages (id, meeting_id, role, content) VALUES (?, ?, 'user', ?)",
            (user_msg_id, body.meeting_id, body.message),
        )
        conn.commit()

        try:
            reply = chat_reply(
                meeting["summary"],
                meeting["members"],
                meeting["action_items"],
                meeting["follow_up_email"],
                body.message,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        assistant_msg_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO chat_messages (id, meeting_id, role, content) VALUES (?, ?, 'assistant', ?)",
            (assistant_msg_id, body.meeting_id, reply),
        )
        conn.commit()

        return {"role": "assistant", "content": reply}
    finally:
        conn.close()


@app.get("/api/chat/{meeting_id}")
def get_chat_history(meeting_id: str, x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)
    _get_meeting_detail(meeting_id, user["id"])  # ownership + existence check

    conn = get_db()
    try:
        messages = conn.execute(
            "SELECT * FROM chat_messages WHERE meeting_id = ? ORDER BY created_at ASC",
            (meeting_id,),
        ).fetchall()
        return [dict(m) for m in messages]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

@app.get("/api/analytics")
def analytics(x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)

    conn = get_db()
    try:
        total_meetings = conn.execute(
            "SELECT COUNT(*) AS c FROM meetings WHERE user_id = ?", (user["id"],)
        ).fetchone()["c"]

        counts = conn.execute(
            """SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
               FROM action_items
               WHERE meeting_id IN (SELECT id FROM meetings WHERE user_id = ?)""",
            (user["id"],),
        ).fetchone()

        total_action_items = counts["total"] or 0
        done_action_items = counts["done"] or 0
        completion_rate = (done_action_items / total_action_items) if total_action_items else 0.0
    finally:
        conn.close()

    return {
        "total_meetings": total_meetings,
        "total_action_items": total_action_items,
        "completion_rate": round(completion_rate, 4),
        "meetings_used": user["meetings_used"],
        "tier": user["tier"],
    }

# ---------------------------------------------------------------------------
# Waitlist & Admin
# ---------------------------------------------------------------------------

@app.post("/api/waitlist")
def join_waitlist(body: WaitlistBody):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO waitlist (id, email) VALUES (?, ?)",
            (str(uuid.uuid4()), body.email),
        )
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()
    return {"message": "Joined waitlist"}

@app.get("/api/admin/stats")
def admin_stats(x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Forbidden: Admins only")
        
    conn = get_db()
    try:
        users = conn.execute("SELECT id, name, email, tier, meetings_used, login_count, role, created_at FROM users ORDER BY created_at DESC").fetchall()
        waitlist = conn.execute("SELECT * FROM waitlist ORDER BY created_at DESC").fetchall()
    finally:
        conn.close()
        
    return {
        "users": [dict(u) for u in users],
        "waitlist": [dict(w) for w in waitlist]
    }
# ---------------------------------------------------------------------------
# Checkout — SIMULATED. See README "what's simulated" section.
#
# create_checkout_session() and confirm_payment() are the entire seam for a
# real Dodo integration later: swap their bodies to call Dodo's API and
# verify its webhook signature, and nothing else in the app needs to change.
# ---------------------------------------------------------------------------

def create_checkout_session(user_id: str) -> dict:
    """Simulated: creates a mock pending order, does not call Dodo."""
    order_id = str(uuid.uuid4())
    _pending_orders[user_id] = order_id
    return {"order_id": order_id, "checkout_url": "#/checkout-simulated"}


def confirm_payment(user_id: str) -> None:
    """Simulated: flips the user to paid directly, no webhook, no external call."""
    conn = get_db()
    try:
        conn.execute("UPDATE users SET tier = 'paid' WHERE id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()
    _pending_orders.pop(user_id, None)


@app.post("/api/checkout")
def checkout(x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)
    return create_checkout_session(user["id"])


@app.post("/api/checkout/confirm")
def checkout_confirm(x_auth_token: str | None = Header(default=None)):
    user = get_current_user(x_auth_token)
    confirm_payment(user["id"])
    return {"tier": "paid"}
