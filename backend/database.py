"""
SQLite storage for Herald.

Hackathon decision: one .db file, no ORM, no migrations framework — just
CREATE TABLE IF NOT EXISTS run once on startup, per the build spec. If this
ever needs to survive real schema changes, swap in Alembic (or similar)
instead of hand-editing this file.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "herald.db"


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    conn = get_db()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT,
                email TEXT,
                token TEXT UNIQUE,
                tier TEXT DEFAULT 'free',
                meetings_used INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                password_hash TEXT,
                login_count INTEGER DEFAULT 0,
                role TEXT DEFAULT 'user'
            );

            CREATE TABLE IF NOT EXISTS waitlist (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id),
                title TEXT,
                transcript TEXT,
                summary TEXT,
                members TEXT,
                follow_up_email TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS action_items (
                id TEXT PRIMARY KEY,
                meeting_id TEXT REFERENCES meetings(id),
                text TEXT,
                owner TEXT,
                status TEXT DEFAULT 'pending',
                is_edited BOOLEAN DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                meeting_id TEXT REFERENCES meetings(id),
                role TEXT,
                content TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        
        # Ensure new columns exist for existing databases
        columns = [row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()]
        if "password_hash" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
        if "login_count" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN login_count INTEGER DEFAULT 0")
        if "role" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'")
            
        conn.commit()
    finally:
        conn.close()
