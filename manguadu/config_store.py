"""Configuracao por guild e estado de tickets persistidos em SQLite."""

from __future__ import annotations

import json
import sqlite3
from copy import deepcopy
from pathlib import Path
from threading import RLock
from typing import Any


DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "bot-config.sqlite3"


DEFAULT_SETTINGS: dict[str, Any] = {
    "channels": {
        "admin": None, "chat": None, "evolution": None, "stats": None,
        "ranking": None, "anticheat": None, "ticket_panel": None,
        "lore": None, "wl_audit": None, "wl_decisions": None,
    },
    "ticket_category_id": None,
    "admin_role_id": None,
    "ticket_panel_message_id": None,
    "stats_panel_message_id": None,
    "ranking_panel_message_id": None,
    "wl": {
        "enabled": True,
        "require_lore": True,
        "lore_reference": "",
        "lore_min_score": 0.28,
        "review_failed_lore": True,
        "auto_approve": False,
        "server_id": "default",
    },
}


def _merged_settings(raw: dict[str, Any] | None) -> dict[str, Any]:
    config = deepcopy(DEFAULT_SETTINGS)
    if not isinstance(raw, dict):
        return config
    config["channels"].update(raw.get("channels") if isinstance(raw.get("channels"), dict) else {})
    config["wl"].update(raw.get("wl") if isinstance(raw.get("wl"), dict) else {})
    for key in ("ticket_category_id", "admin_role_id", "ticket_panel_message_id", "stats_panel_message_id", "ranking_panel_message_id"):
        if key in raw:
            config[key] = raw[key]
    return config


class ConfigStore:
    def __init__(self, path: str | Path = DEFAULT_DB_PATH):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.execute("PRAGMA busy_timeout = 5000")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS guild_settings (
                guild_id INTEGER PRIMARY KEY,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tickets (
                channel_id INTEGER PRIMARY KEY,
                guild_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_open_ticket_per_user
                ON tickets(guild_id, user_id) WHERE status = 'open';
            CREATE TABLE IF NOT EXISTS wl_requests (
                channel_id INTEGER PRIMARY KEY,
                guild_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                character_name TEXT NOT NULL,
                lore TEXT NOT NULL,
                password_ciphertext TEXT NOT NULL DEFAULT '',
                score REAL NOT NULL,
                status TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS whitelist (
                guild_id INTEGER NOT NULL,
                username_key TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                channel_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(guild_id, username_key)
            );
        """)
        columns = {row["name"] for row in self._db.execute("PRAGMA table_info(wl_requests)")}
        if "password_ciphertext" not in columns:
            self._db.execute("ALTER TABLE wl_requests ADD COLUMN password_ciphertext TEXT NOT NULL DEFAULT ''")
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def get_settings(self, guild_id: int) -> dict[str, Any]:
        with self._lock:
            row = self._db.execute("SELECT payload FROM guild_settings WHERE guild_id = ?", (guild_id,)).fetchone()
            return _merged_settings(json.loads(row["payload"]) if row else None)

    def save_settings(self, guild_id: int, config: dict[str, Any]) -> dict[str, Any]:
        normalized = _merged_settings(config)
        with self._lock, self._db:
            self._db.execute("INSERT INTO guild_settings(guild_id, payload) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET payload=excluded.payload", (guild_id, json.dumps(normalized, ensure_ascii=False)))
        return normalized

    def set_value(self, guild_id: int, section: str, key: str, value: Any) -> dict[str, Any]:
        if section not in ("channels", "wl") or key not in DEFAULT_SETTINGS[section]:
            raise ValueError("Campo de configuracao desconhecido")
        with self._lock:
            config = self.get_settings(guild_id)
            config[section][key] = value
            return self.save_settings(guild_id, config)

    def set_top_value(self, guild_id: int, key: str, value: Any) -> dict[str, Any]:
        if key not in ("ticket_category_id", "admin_role_id", "ticket_panel_message_id", "stats_panel_message_id", "ranking_panel_message_id"):
            raise ValueError("Campo de configuracao desconhecido")
        with self._lock:
            config = self.get_settings(guild_id)
            config[key] = value
            return self.save_settings(guild_id, config)

    def get_open_ticket(self, guild_id: int, user_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'", (guild_id, user_id)).fetchone()
            return dict(row) if row else None

    def get_ticket(self, channel_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM tickets WHERE channel_id = ?", (channel_id,)).fetchone()
            return dict(row) if row else None

    def create_ticket(self, guild_id: int, user_id: int, channel_id: int) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT INTO tickets(channel_id, guild_id, user_id) VALUES (?, ?, ?)", (channel_id, guild_id, user_id))

    def close_ticket(self, channel_id: int) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE tickets SET status = 'closed' WHERE channel_id = ?", (channel_id,))

    def get_request(self, channel_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM wl_requests WHERE channel_id = ?", (channel_id,)).fetchone()
            return dict(row) if row else None

    def save_request(self, channel_id: int, guild_id: int, user_id: int, username: str, character_name: str, lore: str, score: float, status: str, password_ciphertext: str = "") -> None:
        with self._lock, self._db:
            self._db.execute("""INSERT INTO wl_requests(channel_id, guild_id, user_id, username, character_name, lore, password_ciphertext, score, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(channel_id) DO UPDATE SET username=excluded.username,
                    character_name=excluded.character_name, lore=excluded.lore,
                    password_ciphertext=excluded.password_ciphertext,
                    score=excluded.score, status=excluded.status,
                    updated_at=CURRENT_TIMESTAMP""",
                (channel_id, guild_id, user_id, username, character_name, lore, password_ciphertext, score, status))

    def set_request_status(self, channel_id: int, status: str) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE wl_requests SET status = ?, updated_at=CURRENT_TIMESTAMP WHERE channel_id = ?", (status, channel_id))

    def clear_request_password(self, channel_id: int) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE wl_requests SET password_ciphertext = '' WHERE channel_id = ?", (channel_id,))

    def username_owner(self, guild_id: int, username: str) -> int | None:
        with self._lock:
            row = self._db.execute("SELECT user_id FROM whitelist WHERE guild_id = ? AND username_key = ?", (guild_id, username.casefold())).fetchone()
            return int(row["user_id"]) if row else None

    def record_whitelist(self, guild_id: int, username: str, user_id: int, channel_id: int) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT INTO whitelist(guild_id, username_key, user_id, channel_id) VALUES (?, ?, ?, ?)", (guild_id, username.casefold(), user_id, channel_id))
