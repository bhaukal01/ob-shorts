"""
SQLite persistence layer for OpenShorts.

Stores persistent application settings, OAuth credentials/tokens for native
YouTube/Instagram publishing, and publish logs.
"""
from __future__ import annotations

import datetime
import json
import os
import sqlite3
import threading
from typing import Any, Dict, List, Optional

_LOCK = threading.RLock()


def get_db_path() -> str:
    """Resolve database path from DB_PATH env var or default to ./data/openshorts.db."""
    custom = os.environ.get("DB_PATH")
    if custom:
        path = custom
    elif os.path.exists("/app") and os.path.isdir("/app"):
        path = "/app/data/openshorts.db"
    else:
        path = os.path.abspath(os.path.join(os.path.dirname(__file__), "data", "openshorts.db"))
    
    dir_path = os.path.dirname(os.path.abspath(path))
    os.makedirs(dir_path, exist_ok=True)
    return path


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(get_db_path(), timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def init_db() -> None:
    """Create tables if they do not exist and seed initial values from env."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        
        # 1. app_settings
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP
            )
        """)
        
        # 2. social_accounts
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS social_accounts (
                platform TEXT PRIMARY KEY,
                client_id TEXT,
                client_secret TEXT,
                account_id TEXT,
                account_name TEXT,
                access_token TEXT,
                refresh_token TEXT,
                token_expiry INTEGER,
                extra_json TEXT,
                updated_at TIMESTAMP
            )
        """)
        
        # 3. publish_logs
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS publish_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT,
                clip_index INTEGER,
                platform TEXT,
                status TEXT,
                remote_url TEXT,
                error_msg TEXT,
                created_at TIMESTAMP
            )
        """)

        # 4. live_monitors
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS live_monitors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT,
                channel_url TEXT UNIQUE,
                channel_name TEXT,
                status TEXT DEFAULT 'offline',
                auto_clip INTEGER DEFAULT 1,
                layout TEXT DEFAULT 'gaming',
                subtitle_script TEXT DEFAULT 'auto',
                last_checked TIMESTAMP,
                last_live TIMESTAMP,
                created_at TIMESTAMP
            )
        """)
        conn.commit()

        # Seed settings from .env / os.environ on first run
        _seed_settings(cursor, conn)


def _seed_settings(cursor: sqlite3.Cursor, conn: sqlite3.Connection) -> None:
    cursor.execute("SELECT COUNT(*) as count FROM app_settings")
    row = cursor.fetchone()
    count = row["count"] if row else 0

    defaults = {
        "llm_provider": os.environ.get("LLM_PROVIDER") or ("gemini" if not os.environ.get("LLM_BASE_URL") and os.environ.get("GEMINI_API_KEY") else "openai"),
        "llm_base_url": os.environ.get("LLM_BASE_URL", ""),
        "llm_api_key": os.environ.get("LLM_API_KEY", ""),
        "llm_model": os.environ.get("LLM_MODEL", ""),
        "gemini_api_key": os.environ.get("GEMINI_API_KEY", ""),
        "upload_post_api_key": os.environ.get("UPLOAD_POST_API_KEY", ""),
        "public_api_url": os.environ.get("PUBLIC_API_URL", ""),
        "public_frontend_url": os.environ.get("PUBLIC_FRONTEND_URL", ""),
    }

    now = _now_iso()
    for k, v in defaults.items():
        # Check if already present
        cursor.execute("SELECT value FROM app_settings WHERE key = ?", (k,))
        existing = cursor.fetchone()
        if existing is None:
            cursor.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
                (k, v or "", now),
            )
        elif count == 0 and v:
            # First initialization update with env if present
            cursor.execute(
                "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ?",
                (v, now, k),
            )
    conn.commit()


def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    """Read a setting from SQLite app_settings."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM app_settings WHERE key = ?", (key,))
        row = cursor.fetchone()
        if row is not None and row["value"] is not None:
            return row["value"]
        return default


def set_setting(key: str, value: Any) -> None:
    """Store or update a setting in SQLite app_settings."""
    val_str = "" if value is None else str(value)
    now = _now_iso()
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (key, val_str, now),
        )
        conn.commit()


def get_all_settings() -> Dict[str, str]:
    """Return all app settings as a dict."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM app_settings")
        rows = cursor.fetchall()
        return {r["key"]: r["value"] or "" for r in rows}


def update_settings(updates: Dict[str, Any]) -> None:
    """Bulk update app settings."""
    now = _now_iso()
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        for k, v in updates.items():
            val_str = "" if v is None else str(v)
            cursor.execute(
                """
                INSERT INTO app_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (k, val_str, now),
            )
        conn.commit()


def get_social_account(platform: str) -> Optional[Dict[str, Any]]:
    """Retrieve OAuth credentials and token info for a platform (youtube, instagram)."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM social_accounts WHERE platform = ?", (platform.lower(),))
        row = cursor.fetchone()
        if not row:
            return None
        return dict(row)


def save_social_account(
    platform: str,
    client_id: Optional[str] = None,
    client_secret: Optional[str] = None,
    account_id: Optional[str] = None,
    account_name: Optional[str] = None,
    access_token: Optional[str] = None,
    refresh_token: Optional[str] = None,
    token_expiry: Optional[int] = None,
    extra_json: Optional[str] = None,
) -> None:
    """Save or update social account credentials and tokens."""
    plat = platform.lower()
    now = _now_iso()
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM social_accounts WHERE platform = ?", (plat,))
        existing = cursor.fetchone()
        
        if existing:
            # Update only provided non-None fields
            fields = {
                "client_id": client_id if client_id is not None else existing["client_id"],
                "client_secret": client_secret if client_secret is not None else existing["client_secret"],
                "account_id": account_id if account_id is not None else existing["account_id"],
                "account_name": account_name if account_name is not None else existing["account_name"],
                "access_token": access_token if access_token is not None else existing["access_token"],
                "refresh_token": refresh_token if refresh_token is not None else existing["refresh_token"],
                "token_expiry": token_expiry if token_expiry is not None else existing["token_expiry"],
                "extra_json": extra_json if extra_json is not None else existing["extra_json"],
                "updated_at": now,
            }
            cursor.execute(
                """
                UPDATE social_accounts SET
                    client_id = :client_id,
                    client_secret = :client_secret,
                    account_id = :account_id,
                    account_name = :account_name,
                    access_token = :access_token,
                    refresh_token = :refresh_token,
                    token_expiry = :token_expiry,
                    extra_json = :extra_json,
                    updated_at = :updated_at
                WHERE platform = :platform
                """,
                {**fields, "platform": plat},
            )
        else:
            cursor.execute(
                """
                INSERT INTO social_accounts (
                    platform, client_id, client_secret, account_id, account_name,
                    access_token, refresh_token, token_expiry, extra_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    plat,
                    client_id or "",
                    client_secret or "",
                    account_id or "",
                    account_name or "",
                    access_token or "",
                    refresh_token or "",
                    token_expiry or 0,
                    extra_json or "{}",
                    now,
                ),
            )
        conn.commit()


def delete_social_account(platform: str) -> None:
    """Remove social account credentials for a platform."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM social_accounts WHERE platform = ?", (platform.lower(),))
        conn.commit()


def add_publish_log(
    job_id: str,
    clip_index: int,
    platform: str,
    status: str,
    remote_url: Optional[str] = None,
    error_msg: Optional[str] = None,
) -> int:
    """Record an entry in publish_logs."""
    now = _now_iso()
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO publish_logs (
                job_id, clip_index, platform, status, remote_url, error_msg, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                clip_index,
                platform.lower(),
                status.lower(),
                remote_url or "",
                error_msg or "",
                now,
            ),
        )
        conn.commit()
        return cursor.lastrowid or 0


def get_publish_logs(job_id: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    """Retrieve recent publish logs, optionally filtered by job_id."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        if job_id:
            cursor.execute(
                "SELECT * FROM publish_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?",
                (job_id, limit),
            )
        else:
            cursor.execute(
                "SELECT * FROM publish_logs ORDER BY id DESC LIMIT ?",
                (limit,),
            )
        rows = cursor.fetchall()
        return [dict(r) for r in rows]


def list_live_monitors() -> List[Dict[str, Any]]:
    """List all tracked live stream monitors."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM live_monitors ORDER BY id DESC")
        return [dict(r) for r in cursor.fetchall()]


def get_live_monitor(monitor_id: int) -> Optional[Dict[str, Any]]:
    """Get a single live monitor by ID."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM live_monitors WHERE id = ?", (monitor_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def add_live_monitor(
    channel_url: str,
    platform: str = "youtube",
    channel_name: str = "",
    layout: str = "gaming",
    auto_clip: int = 1,
    subtitle_script: str = "auto",
) -> int:
    """Add a channel to track for live streams."""
    now = _now_iso()
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO live_monitors (
                platform, channel_url, channel_name, status, auto_clip,
                layout, subtitle_script, last_checked, created_at
            ) VALUES (?, ?, ?, 'offline', ?, ?, ?, ?, ?)
            ON CONFLICT(channel_url) DO UPDATE SET
                platform = excluded.platform,
                channel_name = CASE WHEN excluded.channel_name != '' THEN excluded.channel_name ELSE live_monitors.channel_name END,
                auto_clip = excluded.auto_clip,
                layout = excluded.layout,
                subtitle_script = excluded.subtitle_script
            """,
            (
                platform.lower(),
                channel_url.strip(),
                channel_name.strip(),
                auto_clip,
                layout,
                subtitle_script,
                now,
                now,
            ),
        )
        conn.commit()
        return cursor.lastrowid or 0


def update_live_monitor(
    monitor_id: int,
    status: Optional[str] = None,
    channel_name: Optional[str] = None,
    last_checked: Optional[str] = None,
    last_live: Optional[str] = None,
    auto_clip: Optional[int] = None,
) -> None:
    """Update live monitor status and timestamps."""
    updates = []
    params = []
    if status is not None:
        updates.append("status = ?")
        params.append(status)
    if channel_name is not None:
        updates.append("channel_name = ?")
        params.append(channel_name)
    if last_checked is not None:
        updates.append("last_checked = ?")
        params.append(last_checked)
    if last_live is not None:
        updates.append("last_live = ?")
        params.append(last_live)
    if auto_clip is not None:
        updates.append("auto_clip = ?")
        params.append(auto_clip)

    if not updates:
        return

    params.append(monitor_id)
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(f"UPDATE live_monitors SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()


def delete_live_monitor(monitor_id: int) -> bool:
    """Delete a live stream monitor."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM live_monitors WHERE id = ?", (monitor_id,))
        conn.commit()
        return cursor.rowcount > 0


# Auto-initialize on import
init_db()

