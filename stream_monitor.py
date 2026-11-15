"""Live Stream Tracker & Near-Real-Time Moment Clipper.

Monitors creator YouTube and Twitch channels for live status.
When a live stream starts, it immediately initializes a unified stream project
(1 Stream = 1 Project) and continuously captures rolling 10-minute segments.
Completed 10-minute segments are dispatched to a background processing queue
(transcription, virality analysis via LLM, and clipping) while recording of the
next segment proceeds concurrently without interruption. If a segment does not
contain a standout highlight, it is cleanly skipped.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import database
import llm_backend

_MONITOR_THREAD: Optional[threading.Thread] = None
_STOP_EVENT = threading.Event()
_ACTIVE_LOCK = threading.RLock()
_ACTIVE_STREAM_THREADS: Dict[int, threading.Thread] = {}
_STREAM_ACTIVE_JOBS: Dict[str, Dict[str, Any]] = {}
_PROCESSING_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="StreamProcWorker")

# Continuous recording segment duration: 10 minutes
STREAM_SEGMENT_DURATION = 600


def _log(msg: str) -> None:
    print(f"[stream_monitor] {msg}", flush=True)


def get_active_stream_jobs() -> List[Dict[str, Any]]:
    """Return live stream job records held in memory."""
    with _ACTIVE_LOCK:
        return list(_STREAM_ACTIVE_JOBS.values())


def get_active_stream_job(job_id: str) -> Optional[Dict[str, Any]]:
    """Return in-memory record for a specific stream job if active."""
    with _ACTIVE_LOCK:
        return _STREAM_ACTIVE_JOBS.get(job_id)


def normalize_channel_url(url: str) -> Tuple[str, str]:
    """Normalize channel URL and determine platform ('youtube' or 'twitch')."""
    clean = url.strip()
    if "twitch.tv" in clean.lower():
        m = re.search(r'twitch\.tv/([a-zA-Z0-9_]+)', clean, re.IGNORECASE)
        channel = m.group(1) if m else clean
        return "twitch", f"https://www.twitch.tv/{channel}"
    elif "youtube.com" in clean.lower() or "youtu.be" in clean.lower():
        if not clean.endswith("/live"):
            clean = clean.rstrip("/") + "/live"
        return "youtube", clean
    return "unknown", clean


def check_stream_live(channel_url: str, platform: str) -> Optional[Dict[str, Any]]:
    """Check if a YouTube or Twitch channel is currently live using yt-dlp."""
    try:
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--dump-json",
            "--no-warnings",
            "--playlist-items", "1",
            "--socket-timeout", "15",
            channel_url,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if res.returncode != 0 or not res.stdout.strip():
            return None

        data = json.loads(res.stdout.splitlines()[0])
        is_live = data.get("is_live") or data.get("live_status") == "is_live"
        if not is_live:
            return None

        return {
            "is_live": True,
            "title": data.get("title") or "Live Stream",
            "channel": data.get("channel") or data.get("uploader") or "",
            "video_id": data.get("id"),
            "url": data.get("webpage_url") or channel_url,
        }
    except Exception as e:
        _log(f"Check live failed for {channel_url}: {e}")
        return None


def get_live_stream_manifest_urls(channel_url: str) -> List[str]:
    """Extract direct HLS .m3u8 stream manifest URL(s) using yt-dlp.
    YouTube streams output separate video and audio manifests.
    Twitch streams output a combined stream manifest.
    """
    try:
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--no-warnings",
            "-g",
            channel_url,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        if res.returncode == 0 and res.stdout.strip():
            urls = [line.strip() for line in res.stdout.splitlines() if line.strip().startswith("http")]
            return urls
    except Exception as e:
        _log(f"Failed to get stream URLs: {e}")
    return []


def get_live_stream_manifest_url(channel_url: str) -> Optional[str]:
    """Backward-compatible helper returning the primary manifest URL."""
    urls = get_live_stream_manifest_urls(channel_url)
    return urls[0] if urls else None


def record_stream_segment(manifest_urls: Any, duration_sec: int, out_path: str) -> bool:
    """Capture a segment of duration_sec directly from live stream with zero re-encoding."""
    if isinstance(manifest_urls, str):
        manifest_urls = [manifest_urls] if manifest_urls else []
    if not manifest_urls:
        return False
    try:
        if len(manifest_urls) >= 2:
            # YouTube streams: mux separate video (0) and audio (1) streams
            cmd = [
                "ffmpeg", "-y",
                "-i", manifest_urls[0],
                "-i", manifest_urls[1],
                "-t", str(duration_sec),
                "-c", "copy",
                "-map", "0:v:0",
                "-map", "1:a:0?",
                "-avoid_negative_ts", "make_zero",
                out_path,
            ]
        else:
            # Single combined manifest (Twitch)
            cmd = [
                "ffmpeg", "-y",
                "-i", manifest_urls[0],
                "-t", str(duration_sec),
                "-c", "copy",
                "-avoid_negative_ts", "make_zero",
                out_path,
            ]
        p = subprocess.run(cmd, capture_output=True, timeout=duration_sec + 60)
        return p.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 100000
    except Exception as e:
        _log(f"Segment recording failed: {e}")
        return False


def get_or_create_stream_project(mon: Dict[str, Any], live_info: Dict[str, Any]) -> str:
    """Ensure a unified project exists for this livestream session (1 Stream = 1 Project).
    Uses the stream title as the project title.
    """
    video_id = live_info.get("video_id")
    title = live_info.get("title") or f"Live Stream - {mon.get('channel_name') or 'Creator'}"
    channel_name = live_info.get("channel") or mon.get("channel_name", "")
    channel_url = mon.get("channel_url", "")
    platform = mon.get("platform", "youtube")

    if video_id:
        job_id = f"stream_{video_id}"
    else:
        date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
        job_id = f"stream_{mon.get('id', 0)}_{date_str}"

    out_base = os.environ.get("OUTPUT_DIR", "output")
    job_dir = os.path.abspath(os.path.join(out_base, job_id))
    os.makedirs(job_dir, exist_ok=True)
    os.makedirs(os.path.join(job_dir, "segments"), exist_ok=True)

    info_path = os.path.join(job_dir, "_project_info.json")
    meta_path = os.path.join(job_dir, f"{job_id}_metadata.json")

    now_iso = datetime.now(timezone.utc).isoformat()

    if not os.path.exists(info_path):
        with open(info_path, "w", encoding="utf-8") as f:
            json.dump({
                "job_id": job_id,
                "title": title,
                "video_title": title,
                "status": "processing",
                "is_stream": True,
                "channel_name": channel_name,
                "channel_url": channel_url,
                "platform": platform,
                "started_at": now_iso,
            }, f, indent=2)

    if not os.path.exists(meta_path):
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump({
                "job_id": job_id,
                "title": title,
                "video_title": title,
                "is_stream": True,
                "channel_name": channel_name,
                "channel_url": channel_url,
                "platform": platform,
                "created_at": now_iso,
                "shorts": [],
            }, f, indent=2)

    # Register in memory active stream jobs
    with _ACTIVE_LOCK:
        if job_id not in _STREAM_ACTIVE_JOBS:
            shorts = []
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    shorts = json.load(f).get("shorts", [])
            except Exception:
                pass

            _STREAM_ACTIVE_JOBS[job_id] = {
                "job_id": job_id,
                "title": title,
                "video_title": title,
                "status": "processing",
                "is_stream": True,
                "channel_name": channel_name,
                "channel_url": channel_url,
                "platform": platform,
                "submitted_at": time.time(),
                "logs": [f"🔴 Live stream tracking active: {title}", "📥 Capturing 10-minute rolling segments..."],
                "result": {"clips": shorts},
                "ready_files": {os.path.basename(c.get("video_url", "")): c for c in shorts if c.get("video_url")},
            }

    try:
        database.update_live_monitor(mon["id"], current_job_id=job_id)
    except Exception:
        pass

    return job_id


def analyze_segment_for_viral_moment(transcript: Dict[str, Any], live_title: str) -> Optional[Dict[str, Any]]:
    """Analyze a 10-minute segment transcript with LLM.
    Returns None if no moment meets virality threshold (skipping clipping).
    Returns dict(start, end, title, hook) if a highlight is found.
    """
    if not transcript or not transcript.get("segments"):
        return None

    transcript_lines = []
    for s in transcript["segments"]:
        transcript_lines.append(f"[{s['start']:.1f}s - {s['end']:.1f}s] {s['text']}")
    full_text = "\n".join(transcript_lines)

    prompt = f"""You are an elite short-form video editor for live streams and gaming clips.
Analyze this 10-minute live stream transcript from "{live_title}".
Decide if there is a genuinely viral, funny, exciting, clutch, dramatic, or peak moment worthy of a 30-60 second Short/Reel.

Transcript:
{full_text}

Rules:
1. If the segment is mostly mundane, routine gameplay, silence, menu navigation, or standard casual talk with NO clear highlight, respond with:
{{"viral": false, "reason": "No standout viral highlight in this window"}}
2. If there IS a standout highlight, choose a tight 30 to 60 second window around that moment and respond with:
{{
  "viral": true,
  "start": <start_seconds_float>,
  "end": <end_seconds_float>,
  "title": "<viral_catchy_title>",
  "hook": "<punchy_hook_text_max_6_words>"
}}
"""
    schema = {
        "type": "OBJECT",
        "properties": {
            "viral": {"type": "BOOLEAN"},
            "start": {"type": "NUMBER"},
            "end": {"type": "NUMBER"},
            "title": {"type": "STRING"},
            "hook": {"type": "STRING"},
            "reason": {"type": "STRING"},
        },
        "required": ["viral"],
    }

    try:
        parsed, _ = llm_backend.generate_json(prompt, schema)
        if not parsed or not parsed.get("viral"):
            _log(f"Segment deemed not viral: {parsed.get('reason', 'Skipped') if parsed else 'No response'}")
            return None

        start = max(0.0, float(parsed.get("start", 0)))
        end = float(parsed.get("end", start + 45.0))
        if end <= start:
            end = start + 45.0
        dur = end - start
        if dur > 60.0:
            end = start + 60.0
        elif dur < 20.0:
            end = min(start + 30.0, end + 10.0)

        return {
            "start": start,
            "end": end,
            "title": parsed.get("title") or "Epic Live Moment",
            "hook": parsed.get("hook") or "Must Watch!",
        }
    except Exception as e:
        _log(f"Viral analysis error ({e})")
        return None


def process_live_segment(
    segment_path: str,
    live_title: str,
    job_id: str,
    layout: str = "gaming",
    subtitle_script: str = "auto",
) -> Optional[str]:
    """Transcribe 10m segment, analyze for viral highlight, cut and render short if worthy,
    and append to the unified stream project ({job_id}_metadata.json).
    """
    try:
        from subtitles import transcribe_audio
        _log(f"🎙️ Transcribing live segment: {segment_path}")
        transcript = transcribe_audio(segment_path)
        if not transcript or not transcript.get("segments"):
            _log("Segment had no speech transcript. Skipping clipping.")
            return None

        moment = analyze_segment_for_viral_moment(transcript, live_title)
        if not moment:
            _log(f"Segment from '{live_title}' skipped: No viral moment found.")
            return None

        clip_start = moment["start"]
        clip_end = moment["end"]
        clip_title = moment["title"]
        hook_text = moment["hook"]

        out_base = os.environ.get("OUTPUT_DIR", "output")
        out_dir = os.path.abspath(os.path.join(out_base, job_id))
        os.makedirs(out_dir, exist_ok=True)
        meta_path = os.path.join(out_dir, f"{job_id}_metadata.json")

        meta = {}
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                pass
        if not meta:
            meta = {
                "job_id": job_id,
                "title": live_title,
                "video_title": live_title,
                "is_stream": True,
                "shorts": [],
            }

        existing_shorts = meta.get("shorts", [])
        clip_num = len(existing_shorts) + 1
        clip_filename = f"{job_id}_clip_{clip_num}.mp4"
        raw_clip_path = os.path.join(out_dir, clip_filename)

        _log(f"🔥 Cutting Clip #{clip_num} [{clip_start:.1f}s -> {clip_end:.1f}s]: {clip_title}")

        dur = clip_end - clip_start
        cut_cmd = [
            "ffmpeg", "-y",
            "-ss", str(clip_start),
            "-i", segment_path,
            "-t", str(dur),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac",
            raw_clip_path,
        ]
        subprocess.run(cut_cmd, capture_output=True, timeout=120)

        # Apply Reframe & Layout
        from reframe_v2 import render as reframe_render
        if layout == "gaming":
            os.environ["GAMING_LAYOUT"] = "1"
        rendered_clip = reframe_render(
            raw_clip_path,
            1080, 1920,
            os.path.join(out_dir, f"workdir_{clip_num}"),
        )
        final_clip = rendered_clip or raw_clip_path

        # Generate compact Subtitles
        import subtitles as _subs
        ass_path = os.path.join(out_dir, f"subs_{job_id}_{clip_num}.ass")
        sub_clip_path = os.path.join(out_dir, f"subtitled_{job_id}_{clip_filename}")

        transcript_to_use = transcript
        if subtitle_script == "hinglish":
            try:
                import hindi_transliterator
                transcript_to_use = hindi_transliterator.transliterate_transcript(transcript)
            except Exception:
                pass

        _subs.generate_ass(
            transcript_to_use, clip_start, clip_end, ass_path,
            fontsize=16, font_name="Anton" if subtitle_script != "hindi" else "Noto Sans Devanagari",
        )
        if os.path.exists(ass_path):
            try:
                _subs.burn_subtitles(final_clip, ass_path, sub_clip_path)
                if os.path.exists(sub_clip_path):
                    final_clip = sub_clip_path
            except Exception as e:
                _log(f"Burning subtitles failed: {e}")

        # S3 auto-upload if enabled
        s3_url = None
        try:
            import s3_uploader
            if s3_uploader.is_s3_enabled():
                s3_uploader.upload_final_video(final_clip, job_id, os.path.basename(final_clip))
                s3_url = s3_uploader.get_presigned_stream_url_for_clip(job_id, os.path.basename(final_clip))
        except Exception as e:
            _log(f"S3 upload notice: {e}")

        new_short = {
            "title": clip_title,
            "video_title_for_youtube_short": clip_title,
            "video_description_for_instagram": f"{clip_title}\n\n#Shorts #Gaming #Live",
            "viral_hook_text": hook_text,
            "start": clip_start,
            "end": clip_end,
            "video_url": f"/videos/{job_id}/{os.path.basename(final_clip)}",
            "stream_url": s3_url,
            "duration": dur,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        existing_shorts.append(new_short)
        meta["shorts"] = existing_shorts

        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)

        with _ACTIVE_LOCK:
            if job_id in _STREAM_ACTIVE_JOBS:
                _STREAM_ACTIVE_JOBS[job_id]["result"]["clips"] = existing_shorts
                _STREAM_ACTIVE_JOBS[job_id]["ready_files"][os.path.basename(final_clip)] = new_short
                _STREAM_ACTIVE_JOBS[job_id]["logs"].append(f"✨ Clip #{clip_num} published: {clip_title}")

        _log(f"✅ Clip #{clip_num} published to stream project {job_id}: {final_clip}")
        return final_clip
    except Exception as e:
        _log(f"Error processing live segment: {e}")
        return None


def _background_process_segment_task(
    seg_file: str,
    live_title: str,
    job_id: str,
    layout: str,
    subtitle_script: str,
    seg_num: int,
) -> None:
    """Background task running transcription, LLM highlight picker, and clipping."""
    try:
        _log(f"⚙️ Background processing started for segment #{seg_num} of {job_id}")
        clip = process_live_segment(
            seg_file,
            live_title=live_title,
            job_id=job_id,
            layout=layout,
            subtitle_script=subtitle_script,
        )
        if clip:
            _log(f"🎉 Generated new short from segment #{seg_num}: {clip}")
        else:
            _log(f"ℹ️ Segment #{seg_num} had no viral clip; skipped.")
    except Exception as e:
        _log(f"Segment #{seg_num} processing failed: {e}")
    finally:
        if os.path.exists(seg_file):
            try:
                os.remove(seg_file)
            except OSError:
                pass


def _stream_capture_worker(
    mon_id: int,
    channel_url: str,
    platform: str,
    layout: str,
    subtitle_script: str,
    live_info: Dict[str, Any],
) -> None:
    """Continuous 10-minute segment recorder for an active live stream."""
    _log(f"🎬 Started live stream capture thread for monitor {mon_id} ({live_info['title']})")
    mon = database.get_live_monitor(mon_id) or {"id": mon_id, "channel_url": channel_url}
    job_id = get_or_create_stream_project(mon, live_info)

    out_base = os.environ.get("OUTPUT_DIR", "output")
    job_dir = os.path.abspath(os.path.join(out_base, job_id))
    seg_dir = os.path.join(job_dir, "segments")
    os.makedirs(seg_dir, exist_ok=True)

    seg_index = 0
    try:
        while not _STOP_EVENT.is_set():
            live_check = check_stream_live(channel_url, platform)
            if not live_check:
                _log(f"Stream '{live_info['title']}' ended (no longer live).")
                break

            now_str = datetime.now(timezone.utc).isoformat()
            database.update_live_monitor(mon_id, status="recording", last_live=now_str)

            manifest_urls = get_live_stream_manifest_urls(channel_url)
            if not manifest_urls:
                _log(f"⚠️ Manifest extraction returned empty for {channel_url}. Retrying in 15s...")
                time.sleep(15)
                continue

            seg_file = os.path.join(seg_dir, f"seg_{seg_index}_{int(time.time())}.mp4")
            _log(f"📥 [Monitor {mon_id}] Recording 10m segment #{seg_index + 1}...")

            with _ACTIVE_LOCK:
                if job_id in _STREAM_ACTIVE_JOBS:
                    _STREAM_ACTIVE_JOBS[job_id]["logs"].append(
                        f"📥 Recording 10-minute segment #{seg_index + 1}..."
                    )

            recorded = record_stream_segment(manifest_urls, STREAM_SEGMENT_DURATION, seg_file)

            if recorded and os.path.exists(seg_file) and os.path.getsize(seg_file) > 100000:
                _log(f"📦 [Monitor {mon_id}] Segment #{seg_index + 1} captured ({os.path.getsize(seg_file)} bytes). Dispatching to background processor...")
                with _ACTIVE_LOCK:
                    if job_id in _STREAM_ACTIVE_JOBS:
                        _STREAM_ACTIVE_JOBS[job_id]["logs"].append(
                            f"⚙️ Segment #{seg_index + 1} captured. Analyzing for viral highlight in background..."
                        )

                # Dispatch to background processing pool immediately so next segment records concurrently!
                _PROCESSING_EXECUTOR.submit(
                    _background_process_segment_task,
                    seg_file,
                    live_info["title"],
                    job_id,
                    layout,
                    subtitle_script,
                    seg_index + 1,
                )
            else:
                _log(f"⚠️ Segment #{seg_index + 1} capture failed or empty.")
                if os.path.exists(seg_file):
                    try:
                        os.remove(seg_file)
                    except OSError:
                        pass

            seg_index += 1

    except Exception as e:
        _log(f"Stream capture worker error: {e}")
    finally:
        _log(f"⏹️ Live stream capture worker finished for {job_id}")
        database.update_live_monitor(mon_id, status="offline")
        with _ACTIVE_LOCK:
            if job_id in _STREAM_ACTIVE_JOBS:
                _STREAM_ACTIVE_JOBS[job_id]["status"] = "completed"
                _STREAM_ACTIVE_JOBS[job_id]["logs"].append("🏁 Live stream broadcast ended. Project completed.")
        info_path = os.path.join(job_dir, "_project_info.json")
        if os.path.exists(info_path):
            try:
                with open(info_path, "r", encoding="utf-8") as f:
                    idata = json.load(f)
                idata["status"] = "completed"
                with open(info_path, "w", encoding="utf-8") as f:
                    json.dump(idata, f, indent=2)
            except Exception:
                pass
        with _ACTIVE_LOCK:
            _ACTIVE_STREAM_THREADS.pop(mon_id, None)


def get_creator_streams(monitor_id: int) -> List[Dict[str, Any]]:
    """Retrieve all stream projects and their clips associated with a creator channel."""
    mon = database.get_live_monitor(monitor_id)
    if not mon:
        return []

    target_url = mon.get("channel_url", "").lower().rstrip("/")
    target_name = (mon.get("channel_name") or "").lower().strip()
    mid_prefix = f"stream_{monitor_id}_"

    out_base = os.environ.get("OUTPUT_DIR", "output")
    if not os.path.exists(out_base):
        return []

    streams = []
    seen = set()

    for entry in sorted(os.listdir(out_base), reverse=True):
        if not entry.startswith("stream_") or entry in seen:
            continue
        job_dir = os.path.join(out_base, entry)
        if not os.path.isdir(job_dir) or os.path.exists(os.path.join(job_dir, ".deleted")):
            continue

        meta_files = [f for f in os.listdir(job_dir) if f.endswith("_metadata.json")]
        info_file = os.path.join(job_dir, "_project_info.json")

        meta = {}
        if meta_files:
            try:
                with open(os.path.join(job_dir, meta_files[0]), "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                pass
        elif os.path.exists(info_file):
            try:
                with open(info_file, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                pass

        if not meta:
            continue

        is_match = False
        p_url = str(meta.get("channel_url") or "").lower().rstrip("/")
        p_name = str(meta.get("channel_name") or "").lower().strip()

        if target_url and (p_url == target_url or p_url.startswith(target_url)):
            is_match = True
        elif target_name and (p_name == target_name or target_name in p_name):
            is_match = True
        elif entry.startswith(mid_prefix):
            is_match = True

        if not is_match:
            continue

        seen.add(entry)
        shorts = meta.get("shorts", [])
        status = meta.get("status", "completed")
        with _ACTIVE_LOCK:
            if entry in _STREAM_ACTIVE_JOBS:
                status = _STREAM_ACTIVE_JOBS[entry].get("status", status)

        import s3_uploader
        s3_on = s3_uploader.is_s3_enabled()

        formatted_clips = []
        for idx, c in enumerate(shorts):
            v_url = c.get("video_url") or ""
            fn = os.path.basename(v_url) if v_url else f"{entry}_clip_{idx+1}.mp4"
            stream_url = c.get("stream_url")
            if not stream_url and s3_on:
                stream_url = s3_uploader.get_presigned_stream_url_for_clip(entry, fn)
            formatted_clips.append({
                "index": idx,
                "title": c.get("title") or c.get("video_title_for_youtube_short") or f"Clip {idx+1}",
                "video_url": v_url or f"/videos/{entry}/{fn}",
                "stream_url": stream_url or v_url,
                "duration": c.get("duration", (c.get("end", 0) - c.get("start", 0)) or 30),
                "created_at": c.get("created_at"),
            })

        streams.append({
            "job_id": entry,
            "title": meta.get("video_title") or meta.get("title") or entry,
            "status": status,
            "is_stream": True,
            "channel_name": meta.get("channel_name") or mon.get("channel_name", ""),
            "channel_url": meta.get("channel_url") or mon.get("channel_url", ""),
            "created_at": meta.get("created_at") or datetime.fromtimestamp(os.path.getmtime(job_dir), timezone.utc).isoformat(),
            "clip_count": len(shorts),
            "clips": formatted_clips,
        })

    return streams


def run_monitor_cycle() -> None:
    """Run one check-and-process iteration across all tracked live monitors."""
    monitors = database.list_live_monitors()
    if not monitors:
        return

    for mon in monitors:
        if _STOP_EVENT.is_set():
            break

        mid = mon["id"]
        url = mon["channel_url"]
        platform = mon["platform"]
        layout = mon.get("layout", "gaming")
        sub_script = mon.get("subtitle_script", "auto")
        auto_clip = bool(mon.get("auto_clip", 1))

        now_str = datetime.now(timezone.utc).isoformat()

        # Check if already running a capture worker
        with _ACTIVE_LOCK:
            t = _ACTIVE_STREAM_THREADS.get(mid)
            if t and t.is_alive():
                continue

        live_info = check_stream_live(url, platform)
        if not live_info:
            database.update_live_monitor(mid, status="offline", last_checked=now_str)
            continue

        _log(f"🔴 Live detected for {url}: {live_info['title']}")
        database.update_live_monitor(
            mid,
            status="live",
            channel_name=live_info.get("channel") or mon.get("channel_name"),
            last_checked=now_str,
            last_live=now_str,
        )

        if not auto_clip:
            continue

        # Spawn concurrent 10-minute continuous capture thread
        with _ACTIVE_LOCK:
            t = threading.Thread(
                target=_stream_capture_worker,
                args=(mid, url, platform, layout, sub_script, live_info),
                daemon=True,
                name=f"StreamWorker-{mid}",
            )
            _ACTIVE_STREAM_THREADS[mid] = t
            t.start()


def _monitor_loop() -> None:
    """Background polling loop running every 60 seconds."""
    _log("Starting background live stream monitor...")
    while not _STOP_EVENT.is_set():
        try:
            run_monitor_cycle()
        except Exception as e:
            _log(f"Monitor cycle error: {e}")
        _STOP_EVENT.wait(60.0)


def start_background_monitor() -> None:
    """Start the background stream monitor daemon."""
    global _MONITOR_THREAD
    if _MONITOR_THREAD and _MONITOR_THREAD.is_alive():
        return
    _STOP_EVENT.clear()
    _MONITOR_THREAD = threading.Thread(target=_monitor_loop, daemon=True, name="LiveStreamMonitor")
    _MONITOR_THREAD.start()
    _log("Live stream monitor daemon running.")


def stop_background_monitor() -> None:
    """Stop the background stream monitor daemon."""
    _STOP_EVENT.set()
    _log("Live stream monitor daemon stopped.")
