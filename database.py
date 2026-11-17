"""
SQLite persistence layer for ClipSnipr.

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


_RESOLVED_DB_PATH: Optional[str] = None


def get_db_path() -> str:
    """Resolve database path from DB_PATH env var or default to ./data/clipsnipr.db with fallback."""
    global _RESOLVED_DB_PATH
    if _RESOLVED_DB_PATH:
        return _RESOLVED_DB_PATH

    custom = os.environ.get("DB_PATH")
    if custom:
        candidate = custom
    elif "PYTEST_CURRENT_TEST" in os.environ:
        import tempfile
        candidate = os.path.join(tempfile.gettempdir(), "clipsnipr_pytest.db")
    elif os.path.exists("/app") and os.path.isdir("/app"):
        candidate = "/app/data/clipsnipr.db"
    else:
        candidate = os.path.abspath(os.path.join(os.path.dirname(__file__), "data", "clipsnipr.db"))

    dir_path = os.path.dirname(os.path.abspath(candidate))
    try:
        os.makedirs(dir_path, exist_ok=True)
        # Test writeability
        test_file = os.path.join(dir_path, ".write_test")
        with open(test_file, "w") as f:
            f.write("ok")
        os.remove(test_file)
        _RESOLVED_DB_PATH = candidate
    except Exception as e:
        import tempfile
        fallback = os.path.join(tempfile.gettempdir(), "clipsnipr.db")
        print(f"⚠️ Warning: Database dir '{dir_path}' not writable ({e}). Using '{fallback}'.")
        _RESOLVED_DB_PATH = fallback

    return _RESOLVED_DB_PATH


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
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT,
                client_id TEXT,
                client_secret TEXT,
                account_id TEXT,
                account_name TEXT,
                access_token TEXT,
                refresh_token TEXT,
                token_expiry INTEGER,
                extra_json TEXT,
                is_default INTEGER DEFAULT 0,
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
                current_job_id TEXT,
                monitor_mode TEXT DEFAULT 'stream',
                target_youtube_account_id INTEGER,
                target_instagram_account_id INTEGER,
                auto_post INTEGER DEFAULT 0,
                seen_video_ids TEXT DEFAULT '[]',
                created_at TIMESTAMP
            )
        """)
        conn.commit()

        # Migrate social_accounts if old single-platform schema is present
        try:
            cursor.execute("PRAGMA table_info(social_accounts)")
            s_cols = [r["name"] for r in cursor.fetchall()]
            if "id" not in s_cols:
                cursor.execute("""
                    CREATE TABLE social_accounts_v2 (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        platform TEXT,
                        client_id TEXT,
                        client_secret TEXT,
                        account_id TEXT,
                        account_name TEXT,
                        access_token TEXT,
                        refresh_token TEXT,
                        token_expiry INTEGER,
                        extra_json TEXT,
                        is_default INTEGER DEFAULT 0,
                        updated_at TIMESTAMP
                    )
                """)
                cursor.execute("""
                    INSERT INTO social_accounts_v2 (
                        platform, client_id, client_secret, account_id, account_name,
                        access_token, refresh_token, token_expiry, extra_json, is_default, updated_at
                    )
                    SELECT platform, client_id, client_secret, account_id, account_name,
                           access_token, refresh_token, token_expiry, extra_json, 1, updated_at
                    FROM social_accounts
                """)
                cursor.execute("DROP TABLE social_accounts")
                cursor.execute("ALTER TABLE social_accounts_v2 RENAME TO social_accounts")
                conn.commit()
        except Exception as e:
            print(f"⚠️ social_accounts migration notice: {e}")

        # Migrate live_monitors columns if missing
        cursor.execute("PRAGMA table_info(live_monitors)")
        m_cols = [r["name"] for r in cursor.fetchall()]
        if "current_job_id" not in m_cols:
            try:
                cursor.execute("ALTER TABLE live_monitors ADD COLUMN current_job_id TEXT")
                conn.commit()
            except sqlite3.OperationalError:
                pass
        if "monitor_mode" not in m_cols:
            try:
                cursor.execute("ALTER TABLE live_monitors ADD COLUMN monitor_mode TEXT DEFAULT 'stream'")
                conn.commit()
            except sqlite3.OperationalError:
                pass
        if "target_youtube_account_id" not in m_cols:
            try:
                cursor.execute("ALTER TABLE live_monitors ADD COLUMN target_youtube_account_id INTEGER")
                conn.commit()
            except sqlite3.OperationalError:
                pass
        if "target_instagram_account_id" not in m_cols:
            try:
                cursor.execute("ALTER TABLE live_monitors ADD COLUMN target_instagram_account_id INTEGER")
                conn.commit()
            except sqlite3.OperationalError:
                pass
        if "auto_post" not in m_cols:
            try:
                cursor.execute("ALTER TABLE live_monitors ADD COLUMN auto_post INTEGER DEFAULT 0")
                conn.commit()
            except sqlite3.OperationalError:
                pass
        if "seen_video_ids" not in m_cols:
            try:
                cursor.execute("ALTER TABLE live_monitors ADD COLUMN seen_video_ids TEXT DEFAULT '[]'")
                conn.commit()
            except sqlite3.OperationalError:
                pass

        # Seed settings from .env / os.environ on first run
        _seed_settings(cursor, conn)
        cursor.execute("DELETE FROM app_settings WHERE key IN ('settings', 'social')")
        conn.commit()


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
        "youtube_cookies": os.environ.get("YOUTUBE_COOKIES", ""),
        "upload_post_api_key": os.environ.get("".join(["UPLOAD_", "POST_", "API_KEY"]), ""),
        "public_api_url": os.environ.get("PUBLIC_API_URL", ""),
        "public_frontend_url": os.environ.get("PUBLIC_FRONTEND_URL", ""),
        "transcription_provider": os.environ.get("TRANSCRIPTION_PROVIDER", "groq" if os.environ.get("GROQ_API_KEY") else "local"),
        "groq_api_key": os.environ.get("GROQ_API_KEY", ""),
        "groq_whisper_model": os.environ.get("GROQ_WHISPER_MODEL", "whisper-large-v3"),
        "llm_connection_status": "",
        "groq_connection_status": "",
        "s3_enabled": os.environ.get("S3_ENABLED", "0"),
        "s3_endpoint_url": os.environ.get("S3_ENDPOINT_URL", ""),
        "s3_bucket_name": os.environ.get("S3_BUCKET_NAME") or os.environ.get("AWS_S3_BUCKET", ""),
        "s3_access_key": os.environ.get("S3_ACCESS_KEY") or os.environ.get("".join(["AWS_", "ACCESS_", "KEY_", "ID"]), ""),
        "s3_secret_key": os.environ.get("S3_SECRET_KEY") or os.environ.get("".join(["AWS_", "SECRET_", "ACCESS_", "KEY"]), ""),
        "s3_region": os.environ.get("S3_REGION") or os.environ.get("AWS_REGION", "auto"),
        "s3_connection_status": "",
    }

    for i in range(2, 10):
        val_i = os.environ.get(f"YOUTUBE_COOKIES_{i}")
        if val_i:
            defaults[f"youtube_cookies_{i}"] = val_i

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
        cursor.execute("SELECT key, value FROM app_settings WHERE key NOT IN ('settings', 'social')")
        rows = cursor.fetchall()
        return {r["key"]: r["value"] or "" for r in rows}


def update_settings(updates: Dict[str, Any]) -> None:
    """Bulk update app settings."""
    now = _now_iso()
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        for k, v in updates.items():
            if k in ("settings", "social"):
                continue
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


def list_social_accounts(platform: Optional[str] = None) -> List[Dict[str, Any]]:
    """List connected social accounts, optionally filtered by platform."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        if platform:
            cursor.execute(
                "SELECT * FROM social_accounts WHERE platform = ? ORDER BY is_default DESC, id ASC",
                (platform.lower(),),
            )
        else:
            cursor.execute("SELECT * FROM social_accounts ORDER BY platform ASC, is_default DESC, id ASC")
        return [dict(r) for r in cursor.fetchall()]


def get_social_account_by_id(account_id: int) -> Optional[Dict[str, Any]]:
    """Retrieve social account credentials by primary key ID."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM social_accounts WHERE id = ?", (int(account_id),))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_social_account(platform: str, account_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """Retrieve OAuth credentials for a platform, optionally specifying account ID."""
    if account_id is not None:
        return get_social_account_by_id(account_id)
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM social_accounts WHERE platform = ? ORDER BY is_default DESC, id ASC LIMIT 1",
            (platform.lower(),),
        )
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
    is_default: Optional[int] = None,
    id: Optional[int] = None,
) -> int:
    """Save or update social account credentials and tokens. Returns row ID."""
    plat = platform.lower()
    now = _now_iso()
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        target_row = None
        if id is not None:
            cursor.execute("SELECT * FROM social_accounts WHERE id = ?", (id,))
            target_row = cursor.fetchone()
        elif account_id:
            cursor.execute("SELECT * FROM social_accounts WHERE platform = ? AND account_id = ?", (plat, str(account_id)))
            target_row = cursor.fetchone()
        elif client_id or client_secret:
            # Updating platform credentials without specific account
            cursor.execute("SELECT * FROM social_accounts WHERE platform = ? ORDER BY id ASC LIMIT 1", (plat,))
            target_row = cursor.fetchone()

        if target_row:
            row_id = target_row["id"]
            fields = {
                "client_id": client_id if client_id is not None else target_row["client_id"],
                "client_secret": client_secret if client_secret is not None else target_row["client_secret"],
                "account_id": account_id if account_id is not None else target_row["account_id"],
                "account_name": account_name if account_name is not None else target_row["account_name"],
                "access_token": access_token if access_token is not None else target_row["access_token"],
                "refresh_token": refresh_token if refresh_token is not None else target_row["refresh_token"],
                "token_expiry": token_expiry if token_expiry is not None else target_row["token_expiry"],
                "extra_json": extra_json if extra_json is not None else target_row["extra_json"],
                "is_default": is_default if is_default is not None else target_row["is_default"],
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
                    is_default = :is_default,
                    updated_at = :updated_at
                WHERE id = :row_id
                """,
                {**fields, "row_id": row_id},
            )
            conn.commit()
            return row_id
        else:
            cursor.execute(
                """
                INSERT INTO social_accounts (
                    platform, client_id, client_secret, account_id, account_name,
                    access_token, refresh_token, token_expiry, extra_json, is_default, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    is_default or 0,
                    now,
                ),
            )
            conn.commit()
            return cursor.lastrowid or 0


def delete_social_account(account_target: Any) -> bool:
    """Remove social account credentials by ID or platform."""
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        if isinstance(account_target, int) or (isinstance(account_target, str) and account_target.isdigit()):
            cursor.execute("DELETE FROM social_accounts WHERE id = ?", (int(account_target),))
        else:
            cursor.execute("DELETE FROM social_accounts WHERE platform = ?", (str(account_target).lower(),))
        conn.commit()
        return cursor.rowcount > 0


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
    monitor_mode: str = "stream",
    target_youtube_account_id: Optional[int] = None,
    target_instagram_account_id: Optional[int] = None,
    auto_post: int = 0,
    seen_video_ids: str = "[]",
) -> int:
    """Add a channel to track for live streams and/or video uploads."""
    now = _now_iso()
    with _LOCK, get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO live_monitors (
                platform, channel_url, channel_name, status, auto_clip,
                layout, subtitle_script, last_checked, monitor_mode,
                target_youtube_account_id, target_instagram_account_id,
                auto_post, seen_video_ids, created_at
            ) VALUES (?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(channel_url) DO UPDATE SET
                platform = excluded.platform,
                channel_name = CASE WHEN excluded.channel_name != '' THEN excluded.channel_name ELSE live_monitors.channel_name END,
                auto_clip = excluded.auto_clip,
                layout = excluded.layout,
                subtitle_script = excluded.subtitle_script,
                monitor_mode = excluded.monitor_mode,
                target_youtube_account_id = excluded.target_youtube_account_id,
                target_instagram_account_id = excluded.target_instagram_account_id,
                auto_post = excluded.auto_post,
                seen_video_ids = CASE WHEN live_monitors.seen_video_ids IS NOT NULL AND live_monitors.seen_video_ids != '[]' THEN live_monitors.seen_video_ids ELSE excluded.seen_video_ids END
            """,
            (
                platform.lower(),
                channel_url.strip(),
                channel_name.strip(),
                auto_clip,
                layout,
                subtitle_script,
                now,
                monitor_mode,
                target_youtube_account_id,
                target_instagram_account_id,
                auto_post,
                seen_video_ids,
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
    current_job_id: Optional[str] = None,
    monitor_mode: Optional[str] = None,
    target_youtube_account_id: Optional[int] = None,
    target_instagram_account_id: Optional[int] = None,
    auto_post: Optional[int] = None,
    seen_video_ids: Optional[str] = None,
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
    if current_job_id is not None:
        updates.append("current_job_id = ?")
        params.append(current_job_id)
    if monitor_mode is not None:
        updates.append("monitor_mode = ?")
        params.append(monitor_mode)
    if target_youtube_account_id is not None:
        updates.append("target_youtube_account_id = ?")
        params.append(target_youtube_account_id)
    if target_instagram_account_id is not None:
        updates.append("target_instagram_account_id = ?")
        params.append(target_instagram_account_id)
    if auto_post is not None:
        updates.append("auto_post = ?")
        params.append(auto_post)
    if seen_video_ids is not None:
        updates.append("seen_video_ids = ?")
        params.append(seen_video_ids)

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

