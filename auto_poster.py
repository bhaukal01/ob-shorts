"""Sequential Auto-Posting Engine for YouTube Shorts and Instagram Reels.

Publishes rendered clips sequentially to configured social accounts,
records post links into clip metadata, and creates audit publish logs.
"""
from __future__ import annotations

import asyncio
import datetime
import glob
import json
import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import database
import publishers


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _resolve_output_dir() -> str:
    return os.environ.get("OUTPUT_DIR", "output")


class RateLimitError(Exception):
    """Raised when an upstream platform indicates rate limit or quota exhaustion."""
    def __init__(self, platform: str, reason: str, backoff_seconds: int = 900):
        super().__init__(f"[{platform}] {reason}")
        self.platform = platform
        self.reason = reason
        self.backoff_seconds = backoff_seconds


def is_rate_limit_error(err_str: str) -> Tuple[bool, str, int]:
    """Inspect error message for rate limit, upload limit, or quota exhaustion.
    Returns: (is_rate_limit, reason, backoff_seconds)
    """
    low = err_str.lower()
    
    # 1. YouTube Daily Quota Exceeded (10k units daily cap, resets at midnight PT)
    if "quotaexceeded" in low or "quota exceeded" in low:
        return True, "YouTube daily API quota exceeded. Pausing upload queue.", 1800  # 30 min check
    
    # 2. YouTube Upload / Creator Limit (creator hit daily video upload max on channel)
    if "uploadlimitexceeded" in low or "upload limit exceeded" in low:
        return True, "YouTube channel upload limit reached. Pausing upload queue.", 1800  # 30 min check

    # 3. Rate Limit / Concurrency / Too Many Requests (HTTP 429)
    if "ratelimit" in low or "rate limit" in low or "429" in low or "too many requests" in low:
        return True, "API rate limit encountered (HTTP 429). Pausing upload queue.", 900  # 15 min check

    # 4. Instagram Application / User / Page request limit (codes 4, 17, 32, 613)
    if any(k in low for k in ("exceeded the rate limit", "request limit reached", "(#4)", "(#17)", "(#32)", "(#613)")):
        return True, "Instagram Reels rate limit reached. Pausing upload queue.", 900  # 15 min check

    return False, "", 0


def find_clip_file_for_job(job_id: str, clip_index: int) -> Tuple[str, str, Dict[str, Any], str]:
    """Locate clip file and metadata on disk for a given job and clip index."""
    out_dir = _resolve_output_dir()
    job_dir = os.path.join(out_dir, job_id)
    if not os.path.isdir(job_dir):
        raise FileNotFoundError(f"Job directory not found: {job_dir}")

    meta_files = glob.glob(os.path.join(job_dir, "*_metadata.json"))
    if not meta_files:
        raise FileNotFoundError(f"No metadata found in {job_dir}")
    meta_path = meta_files[0]

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    shorts = meta.get("shorts", [])
    if clip_index < 0 or clip_index >= len(shorts):
        raise IndexError(f"Clip index {clip_index} out of range (total: {len(shorts)})")

    clip = shorts[clip_index]
    video_url = clip.get("video_url") or ""
    filename = os.path.basename(video_url) if video_url else f"{job_id}_clip_{clip_index + 1}.mp4"
    file_path = os.path.join(job_dir, filename)

    if not os.path.exists(file_path):
        # Fallback candidate search
        candidates = [
            f for f in os.listdir(job_dir)
            if f.endswith(".mp4") and (f"_clip_{clip_index + 1}" in f or f"_{clip_index + 1}." in f)
        ]
        if candidates:
            filename = candidates[0]
            file_path = os.path.join(job_dir, filename)
        else:
            raise FileNotFoundError(f"Clip video file not found for index {clip_index} at {file_path}")

    return file_path, filename, clip, meta_path


async def post_clip_to_accounts(
    job_id: str,
    clip_index: int,
    youtube_account_id: Optional[int] = None,
    instagram_account_id: Optional[int] = None,
    request_base_url: Optional[str] = None,
    privacy_status: str = "public",
) -> List[Dict[str, Any]]:
    """Publish a single clip to YouTube and/or Instagram accounts sequentially,
    updating clip metadata with published post links.
    """
    file_path, filename, clip_data, meta_path = find_clip_file_for_job(job_id, clip_index)

    title = (
        clip_data.get("video_title_for_youtube_short")
        or clip_data.get("title")
        or "Viral Short"
    )
    caption = (
        clip_data.get("video_description_for_instagram")
        or clip_data.get("video_description_for_tiktok")
        or title
    )

    published_posts: List[Dict[str, Any]] = list(clip_data.get("published_posts") or [])
    results: List[Dict[str, Any]] = []

    # 1. Post to YouTube Shorts if configured
    if youtube_account_id:
        try:
            print(f"[auto_poster] Uploading clip #{clip_index + 1} of {job_id} to YouTube (account {youtube_account_id})...")
            yt_res = await publishers.upload_youtube_shorts(
                file_path=file_path,
                title=title,
                description=caption,
                privacy_status=privacy_status,
                account_id=youtube_account_id,
            )
            remote_url = yt_res.get("remote_url", "")
            database.add_publish_log(
                job_id=job_id,
                clip_index=clip_index,
                platform="youtube",
                status="success",
                remote_url=remote_url,
            )
            post_entry = {
                "platform": "youtube",
                "account_id": youtube_account_id,
                "account_name": yt_res.get("account_name", ""),
                "url": remote_url,
                "video_id": yt_res.get("video_id", ""),
                "status": "success",
                "posted_at": _now_iso(),
            }
            published_posts.append(post_entry)
            results.append(post_entry)
            print(f"[auto_poster] ✅ Successfully posted to YouTube Shorts: {remote_url}")
        except Exception as e:
            err_msg = str(e)
            is_rl, reason, backoff = is_rate_limit_error(err_msg)
            if is_rl:
                raise RateLimitError("youtube", reason, backoff)
            print(f"[auto_poster] ❌ Failed to post clip #{clip_index + 1} to YouTube: {err_msg}")
            database.add_publish_log(
                job_id=job_id,
                clip_index=clip_index,
                platform="youtube",
                status="failed",
                error_msg=err_msg,
            )

    # 2. Post to Instagram Reels if configured
    if instagram_account_id:
        try:
            print(f"[auto_poster] Uploading clip #{clip_index + 1} of {job_id} to Instagram (account {instagram_account_id})...")
            base_url = publishers.resolve_public_base_url(request_base_url)
            signed_url = publishers.generate_signed_media_url(job_id, filename, base_url)
            ig_res = await publishers.upload_instagram_reels(
                signed_video_url=signed_url,
                caption=caption,
                account_id=instagram_account_id,
            )
            remote_url = ig_res.get("remote_url", "")
            database.add_publish_log(
                job_id=job_id,
                clip_index=clip_index,
                platform="instagram",
                status="success",
                remote_url=remote_url,
            )
            post_entry = {
                "platform": "instagram",
                "account_id": instagram_account_id,
                "account_name": ig_res.get("account_name", ""),
                "url": remote_url,
                "media_id": ig_res.get("media_id", ""),
                "status": "success",
                "posted_at": _now_iso(),
            }
            published_posts.append(post_entry)
            results.append(post_entry)
            print(f"[auto_poster] ✅ Successfully posted to Instagram Reels: {remote_url}")
        except Exception as e:
            err_msg = str(e)
            is_rl, reason, backoff = is_rate_limit_error(err_msg)
            if is_rl:
                raise RateLimitError("instagram", reason, backoff)
            print(f"[auto_poster] ❌ Failed to post clip #{clip_index + 1} to Instagram: {err_msg}")
            database.add_publish_log(
                job_id=job_id,
                clip_index=clip_index,
                platform="instagram",
                status="failed",
                error_msg=err_msg,
            )

    # Update metadata file with newly added published_posts
    if published_posts:
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if "shorts" in meta and clip_index < len(meta["shorts"]):
                meta["shorts"][clip_index]["published_posts"] = published_posts
                temp_path = f"{meta_path}.tmp"
                with open(temp_path, "w", encoding="utf-8") as f:
                    json.dump(meta, f, indent=2)
                os.replace(temp_path, meta_path)
        except Exception as e:
            print(f"[auto_poster] Warning: Could not update metadata with published_posts: {e}")

    return results


class ProjectBatchUploader:
    """Orchestrates 1-clip-every-5-minutes batch publishing of a complete project.
    Automatically detects API rate limits, upload quotas, and pauses with auto-retry.
    """
    def __init__(self):
        self._cancel_flags: Dict[str, bool] = {}
        self._pause_flags: Dict[str, bool] = {}
        self._active_threads: Dict[str, threading.Thread] = {}
        self._lock = threading.Lock()

    def start_batch(
        self,
        job_id: str,
        youtube_account_id: Optional[int] = None,
        instagram_account_id: Optional[int] = None,
        privacy_status: str = "public",
        delay_seconds: int = 300,  # 5 minutes default
        request_base_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Start or re-trigger batch project publishing."""
        with self._lock:
            # Check existing status
            existing = database.get_batch_post(job_id)
            if existing and existing.get("status") in ("running", "waiting_interval", "rate_limited"):
                th = self._active_threads.get(job_id)
                if th and th.is_alive():
                    return existing

            out_dir = _resolve_output_dir()
            job_dir = os.path.join(out_dir, job_id)
            meta_files = glob.glob(os.path.join(job_dir, "*_metadata.json"))
            if not meta_files:
                raise FileNotFoundError(f"Project metadata not found for job: {job_id}")

            with open(meta_files[0], "r", encoding="utf-8") as f:
                meta = json.load(f)

            shorts = meta.get("shorts", [])
            total_clips = len(shorts)
            if total_clips == 0:
                raise ValueError("Project has 0 clips available to upload.")

            self._cancel_flags[job_id] = False
            self._pause_flags[job_id] = False

            batch = database.create_or_update_batch_post(
                job_id=job_id,
                youtube_account_id=youtube_account_id,
                instagram_account_id=instagram_account_id,
                privacy_status=privacy_status,
                delay_seconds=delay_seconds,
                total_clips=total_clips,
            )

            def _worker():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    loop.run_until_complete(
                        self._process_batch_loop(
                            job_id=job_id,
                            youtube_account_id=youtube_account_id,
                            instagram_account_id=instagram_account_id,
                            privacy_status=privacy_status,
                            delay_seconds=delay_seconds,
                            request_base_url=request_base_url,
                        )
                    )
                finally:
                    loop.close()

            th = threading.Thread(target=_worker, daemon=True, name=f"BatchUpload-{job_id}")
            self._active_threads[job_id] = th
            th.start()
            return batch

    async def _process_batch_loop(
        self,
        job_id: str,
        youtube_account_id: Optional[int],
        instagram_account_id: Optional[int],
        privacy_status: str,
        delay_seconds: int,
        request_base_url: Optional[str],
    ):
        mins = max(1, delay_seconds // 60)
        database.update_batch_post_progress(
            job_id,
            status="running",
            new_log=f"🚀 Starting batch project upload ({mins} min cooldown between clips). Rate limits auto-paused with retry.",
        )

        batch = database.get_batch_post(job_id)
        if not batch:
            return

        total_clips = batch.get("total_clips", 0)
        start_idx = batch.get("current_clip_index", 0)
        uploaded = batch.get("uploaded_clips", 0)
        failed = batch.get("failed_clips", 0)

        clip_idx = start_idx
        while clip_idx < total_clips:
            # 1. Check user cancel
            if self._cancel_flags.get(job_id):
                database.update_batch_post_progress(
                    job_id, status="cancelled", new_log="🛑 Batch project upload cancelled by user."
                )
                return

            # 2. Check user pause
            while self._pause_flags.get(job_id):
                database.update_batch_post_progress(
                    job_id, status="paused", new_log="⏸️ Upload queue paused by user."
                )
                await asyncio.sleep(2.0)
                if self._cancel_flags.get(job_id):
                    database.update_batch_post_progress(
                        job_id, status="cancelled", new_log="🛑 Batch project upload cancelled by user."
                    )
                    return

            # 3. Check if already posted to all target accounts
            try:
                _, _, clip_data, _ = find_clip_file_for_job(job_id, clip_idx)
                pub_posts = clip_data.get("published_posts") or []
                already_yt = not youtube_account_id or any(
                    p.get("platform") == "youtube" and p.get("status") == "success" for p in pub_posts
                )
                already_ig = not instagram_account_id or any(
                    p.get("platform") == "instagram" and p.get("status") == "success" for p in pub_posts
                )
                if already_yt and already_ig:
                    database.update_batch_post_progress(
                        job_id,
                        status="running",
                        current_clip_index=clip_idx + 1,
                        new_log=f"⏩ Clip #{clip_idx + 1} already posted to selected accounts. Skipping.",
                    )
                    clip_idx += 1
                    continue
            except Exception:
                pass

            # 4. Attempt upload for current clip
            database.update_batch_post_progress(
                job_id,
                status="running",
                current_clip_index=clip_idx,
                next_upload_at=0,
                new_log=f"📤 Uploading Clip #{clip_idx + 1} of {total_clips}...",
            )

            try:
                res = await post_clip_to_accounts(
                    job_id=job_id,
                    clip_index=clip_idx,
                    youtube_account_id=youtube_account_id,
                    instagram_account_id=instagram_account_id,
                    request_base_url=request_base_url,
                    privacy_status=privacy_status,
                )
                if res and any(r.get("status") == "success" for r in res):
                    uploaded += 1
                    urls = " ".join([r.get("url") for r in res if r.get("url")])
                    database.update_batch_post_progress(
                        job_id,
                        uploaded_clips=uploaded,
                        new_log=f"✅ Clip #{clip_idx + 1} uploaded successfully! {urls}".strip(),
                    )
                else:
                    failed += 1
                    database.update_batch_post_progress(
                        job_id,
                        failed_clips=failed,
                        new_log=f"⚠️ Clip #{clip_idx + 1} completed with no active platform responses.",
                    )
            except RateLimitError as rle:
                # Quota or rate limit hit! Pause queue and automatically retry after backoff
                backoff_s = rle.backoff_seconds
                retry_at = time.time() + backoff_s
                mins_wait = max(1, backoff_s // 60)
                database.update_batch_post_progress(
                    job_id,
                    status="rate_limited",
                    next_upload_at=retry_at,
                    last_error=f"[{rle.platform}] {rle.reason}",
                    new_log=f"⏸️ [Rate Limit / Quota] {rle.reason}. Queue paused. Automatically retrying Clip #{clip_idx + 1} in {mins_wait} minutes...",
                )
                print(f"[auto_poster] Rate limit on {rle.platform}: {rle.reason}. Sleeping {backoff_s}s...")
                while time.time() < retry_at:
                    if self._cancel_flags.get(job_id):
                        database.update_batch_post_progress(
                            job_id, status="cancelled", new_log="🛑 Batch project upload cancelled by user."
                        )
                        return
                    if not self._pause_flags.get(job_id) and database.get_batch_post(job_id).get("status") == "running":
                        break
                    await asyncio.sleep(2.0)
                # Retry SAME clip (do not advance clip_idx)
                continue
            except Exception as e:
                failed += 1
                database.update_batch_post_progress(
                    job_id,
                    failed_clips=failed,
                    last_error=str(e),
                    new_log=f"❌ Clip #{clip_idx + 1} failed: {e}",
                )

            # Advance clip index
            clip_idx += 1
            database.update_batch_post_progress(job_id, current_clip_index=clip_idx)

            # 5. Cooldown Interval: wait delay_seconds before next clip starts
            if clip_idx < total_clips:
                next_at = time.time() + delay_seconds
                mins_cd = max(1, delay_seconds // 60)
                database.update_batch_post_progress(
                    job_id,
                    status="waiting_interval",
                    next_upload_at=next_at,
                    new_log=f"⏳ Clip #{clip_idx} finished. Waiting {mins_cd} minute(s) before starting Clip #{clip_idx + 1}...",
                )
                while time.time() < next_at:
                    if self._cancel_flags.get(job_id):
                        database.update_batch_post_progress(
                            job_id, status="cancelled", new_log="🛑 Batch project upload cancelled by user."
                        )
                        return
                    if self._pause_flags.get(job_id):
                        break
                    await asyncio.sleep(1.0)

        # 6. Completed
        database.update_batch_post_progress(
            job_id,
            status="completed",
            next_upload_at=0,
            new_log=f"🎉 Project batch upload complete! {uploaded} uploaded, {failed} failed.",
        )

    def pause_batch(self, job_id: str):
        self._pause_flags[job_id] = True
        database.update_batch_post_progress(job_id, status="paused", new_log="⏸️ Upload queue paused by user.")

    def resume_batch(self, job_id: str):
        self._pause_flags[job_id] = False
        batch = database.get_batch_post(job_id)
        if batch:
            database.update_batch_post_progress(job_id, status="running", next_upload_at=0, new_log="▶️ Upload queue resumed.")
            th = self._active_threads.get(job_id)
            if not th or not th.is_alive():
                self.start_batch(
                    job_id=job_id,
                    youtube_account_id=batch.get("youtube_account_id"),
                    instagram_account_id=batch.get("instagram_account_id"),
                    privacy_status=batch.get("privacy_status", "public"),
                    delay_seconds=batch.get("delay_seconds", 300),
                )

    def cancel_batch(self, job_id: str):
        self._cancel_flags[job_id] = True
        database.update_batch_post_progress(job_id, status="cancelled", next_upload_at=0, new_log="🛑 Upload queue cancelled.")

    def resume_active_batches(self):
        """Resume any active batches found in database (e.g. after server boot)."""
        active = database.get_all_active_batch_posts()
        for b in active:
            st = b.get("status")
            if st in ("running", "waiting_interval", "rate_limited"):
                print(f"[auto_poster] Resuming batch upload for project {b.get('job_id')} (status: {st})...")
                self.start_batch(
                    job_id=b.get("job_id"),
                    youtube_account_id=b.get("youtube_account_id"),
                    instagram_account_id=b.get("instagram_account_id"),
                    privacy_status=b.get("privacy_status", "public"),
                    delay_seconds=b.get("delay_seconds", 300),
                )


_BATCH_UPLOADER = ProjectBatchUploader()


def start_batch_project_upload(
    job_id: str,
    youtube_account_id: Optional[int] = None,
    instagram_account_id: Optional[int] = None,
    privacy_status: str = "public",
    delay_seconds: int = 300,
    request_base_url: Optional[str] = None,
) -> Dict[str, Any]:
    return _BATCH_UPLOADER.start_batch(
        job_id=job_id,
        youtube_account_id=youtube_account_id,
        instagram_account_id=instagram_account_id,
        privacy_status=privacy_status,
        delay_seconds=delay_seconds,
        request_base_url=request_base_url,
    )


def pause_batch_project_upload(job_id: str) -> None:
    _BATCH_UPLOADER.pause_batch(job_id)


def resume_batch_project_upload(job_id: str) -> None:
    _BATCH_UPLOADER.resume_batch(job_id)


def cancel_batch_project_upload(job_id: str) -> None:
    _BATCH_UPLOADER.cancel_batch(job_id)


def resume_active_batch_uploads() -> None:
    _BATCH_UPLOADER.resume_active_batches()


async def post_all_project_clips_sequentially(
    job_id: str,
    youtube_account_id: Optional[int] = None,
    instagram_account_id: Optional[int] = None,
    request_base_url: Optional[str] = None,
    delay_seconds: float = 300.0,
) -> List[Dict[str, Any]]:
    """Iterate through all clips of a project and post them sequentially."""
    start_batch_project_upload(
        job_id=job_id,
        youtube_account_id=youtube_account_id,
        instagram_account_id=instagram_account_id,
        request_base_url=request_base_url,
        delay_seconds=int(delay_seconds),
    )
    return []


def trigger_background_auto_post(
    job_id: str,
    youtube_account_id: Optional[int] = None,
    instagram_account_id: Optional[int] = None,
    request_base_url: Optional[str] = None,
    delay_seconds: float = 300.0,
) -> None:
    """Launch sequential auto-posting using batch project uploader."""
    start_batch_project_upload(
        job_id=job_id,
        youtube_account_id=youtube_account_id,
        instagram_account_id=instagram_account_id,
        request_base_url=request_base_url,
        delay_seconds=int(delay_seconds),
    )
