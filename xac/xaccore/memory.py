"""Persistent chat memory (SQLite) and context-window packing.

Three layers of memory keep long chats coherent without overflowing the context window:
  1. Recent messages - sent verbatim, newest first, until the history budget is used.
  2. Condensed summary - older messages are auto-condensed into a per-conversation summary by the
     model before the window fills, so a chat can continue indefinitely. The full transcript stays
     on disk; only the model's view is condensed.
  3. Saved notes - long-term facts about the user, included in every conversation.

Conversations are "active" (loaded in the model's memory) or "parked" (saved to disk, using no
VRAM/RAM). Sending a message to a parked chat resumes it automatically.
"""

from __future__ import annotations

import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'New chat',
    created REAL NOT NULL,
    updated REAL NOT NULL,
    summary TEXT,
    summary_upto INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'parked' CHECK (state IN ('active', 'parked')),
    condense_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    thinking TEXT,
    tokens INTEGER,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created REAL NOT NULL
);
"""


def estimate_tokens(text: str) -> int:
    """~3.5 characters per token is a safe average for English + code."""
    return max(1, int(len(text) / 3.5) + 4)


class Store:
    def __init__(self, path: str):
        self._lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.executescript(SCHEMA)
        self.db.commit()

    def _q(self, sql: str, args: tuple = ()) -> list[dict]:
        with self._lock:
            cur = self.db.execute(sql, args)
            rows = [dict(r) for r in cur.fetchall()]
            self.db.commit()
            return rows

    def _x(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur.lastrowid or cur.rowcount

    def close(self) -> None:
        with self._lock:
            self.db.close()

    # ------------------------------------------------------------- conversations
    def create_conversation(self, title: str = "New chat") -> dict:
        now = time.time()
        cid = self._x("INSERT INTO conversations (title, created, updated) VALUES (?, ?, ?)", (title, now, now))
        return self.get_conversation(cid)

    def get_conversation(self, cid: int) -> dict | None:
        rows = self._q("SELECT * FROM conversations WHERE id = ?", (cid,))
        return rows[0] if rows else None

    def list_conversations(self) -> list[dict]:
        return self._q("SELECT id, title, created, updated, state, condense_count, "
                       "(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count "
                       "FROM conversations c ORDER BY updated DESC")

    def set_state(self, cid: int, state: str) -> None:
        self._x("UPDATE conversations SET state = ? WHERE id = ?", (state, cid))

    def park_all(self, except_id: int | None = None) -> None:
        self._x("UPDATE conversations SET state = 'parked' WHERE state = 'active' AND id IS NOT ?", (except_id,))

    def rename_conversation(self, cid: int, title: str) -> None:
        self._x("UPDATE conversations SET title = ? WHERE id = ?", (title.strip()[:120] or "New chat", cid))

    def delete_conversation(self, cid: int) -> None:
        self._x("DELETE FROM conversations WHERE id = ?", (cid,))

    def set_summary(self, cid: int, summary: str, upto: int) -> None:
        self._x("UPDATE conversations SET summary = ?, summary_upto = ?, condense_count = condense_count + 1 "
                "WHERE id = ?", (summary, upto, cid))

    # ------------------------------------------------------------------ messages
    def add_message(self, cid: int, role: str, content: str, thinking: str | None = None,
                    tokens: int | None = None) -> int:
        now = time.time()
        mid = self._x(
            "INSERT INTO messages (conversation_id, role, content, thinking, tokens, created) VALUES (?, ?, ?, ?, ?, ?)",
            (cid, role, content, thinking, tokens or estimate_tokens(content), now),
        )
        self._x("UPDATE conversations SET updated = ? WHERE id = ?", (now, cid))
        return mid

    def messages(self, cid: int) -> list[dict]:
        return self._q("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id", (cid,))

    def delete_last_assistant(self, cid: int) -> None:
        self._x(
            "DELETE FROM messages WHERE id = (SELECT MAX(id) FROM messages WHERE conversation_id = ? "
            "AND role = 'assistant')", (cid,),
        )

    # ------------------------------------------------------------------ memories
    def add_memory(self, content: str) -> int:
        return self._x("INSERT INTO memories (content, created) VALUES (?, ?)", (content.strip()[:500], time.time()))

    def list_memories(self) -> list[dict]:
        return self._q("SELECT * FROM memories ORDER BY id")

    def delete_memory(self, mid: int) -> None:
        self._x("DELETE FROM memories WHERE id = ?", (mid,))


def live_messages(msgs: list[dict], summary_upto: int) -> list[dict]:
    """Messages not yet condensed into the summary - the ones the model still sees verbatim."""
    return [m for m in msgs if m["id"] > summary_upto]


def tokens_of(msgs: list[dict]) -> int:
    return sum(m.get("tokens") or estimate_tokens(m["content"]) for m in msgs)


def pack_history(live: list[dict], budget_tokens: int) -> tuple[list[dict], int]:
    """Fit the newest live messages into `budget_tokens` (always keeping the latest one).
    Returns (chat messages oldest-first, tokens used)."""
    kept: list[dict] = []
    used = 0
    for m in reversed(live):
        t = m.get("tokens") or estimate_tokens(m["content"])
        if kept and used + t > budget_tokens:
            break
        kept.append(m)
        used += t
    kept.reverse()
    return [{"role": m["role"], "content": m["content"]} for m in kept], used


def condense_split(live: list[dict], budget_tokens: int, target: float = 0.4, keep_last: int = 4) -> list[dict]:
    """Choose the oldest live messages to condense so that what remains is <= target x budget,
    always keeping the last `keep_last` messages verbatim. Returns the messages to condense."""
    if len(live) <= keep_last:
        return []
    total = tokens_of(live)
    goal = int(budget_tokens * target)
    out = []
    for m in live[:-keep_last]:
        if total <= goal:
            break
        out.append(m)
        total -= m.get("tokens") or estimate_tokens(m["content"])
    # Don't split a question from its answer: condense whole user/assistant pairs.
    if out and out[-1]["role"] == "user" and len(out) < len(live) - keep_last:
        out.append(live[len(out)])
    return out
