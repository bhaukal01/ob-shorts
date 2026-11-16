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


async def post_all_project_clips_sequentially(
    job_id: str,
    youtube_account_id: Optional[int] = None,
    instagram_account_id: Optional[int] = None,
    request_base_url: Optional[str] = None,
    delay_seconds: float = 3.0,
) -> List[Dict[str, Any]]:
    """Iterate through all clips of a project and post them sequentially."""
    if not youtube_account_id and not instagram_account_id:
        return []

    out_dir = _resolve_output_dir()
    job_dir = os.path.join(out_dir, job_id)
    meta_files = glob.glob(os.path.join(job_dir, "*_metadata.json"))
    if not meta_files:
        print(f"[auto_poster] No metadata found for {job_id}")
        return []

    with open(meta_files[0], "r", encoding="utf-8") as f:
        meta = json.load(f)

    shorts = meta.get("shorts", [])
    if not shorts:
        return []

    all_results = []
    print(f"[auto_poster] Starting sequential auto-publish for {job_id} ({len(shorts)} clip(s))...")

    for idx in range(len(shorts)):
        try:
            res = await post_clip_to_accounts(
                job_id=job_id,
                clip_index=idx,
                youtube_account_id=youtube_account_id,
                instagram_account_id=instagram_account_id,
                request_base_url=request_base_url,
            )
            all_results.extend(res)
        except Exception as e:
            print(f"[auto_poster] Error auto-posting clip #{idx + 1} of {job_id}: {e}")

        if idx < len(shorts) - 1 and delay_seconds > 0:
            await asyncio.sleep(delay_seconds)

    print(f"[auto_poster] Finished sequential auto-publish for {job_id}.")
    return all_results


def trigger_background_auto_post(
    job_id: str,
    youtube_account_id: Optional[int] = None,
    instagram_account_id: Optional[int] = None,
    request_base_url: Optional[str] = None,
    delay_seconds: float = 3.0,
) -> None:
    """Launch sequential auto-posting in a background daemon thread."""
    if not youtube_account_id and not instagram_account_id:
        return

    def _worker():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(
                post_all_project_clips_sequentially(
                    job_id=job_id,
                    youtube_account_id=youtube_account_id,
                    instagram_account_id=instagram_account_id,
                    request_base_url=request_base_url,
                    delay_seconds=delay_seconds,
                )
            )
        finally:
            loop.close()

    t = threading.Thread(target=_worker, daemon=True, name=f"AutoPost-{job_id}")
    t.start()
