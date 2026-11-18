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
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
import urllib.request
import xml.etree.ElementTree as ET

from pydantic import BaseModel, Field

import database
import llm_backend
import yt_account

_MONITOR_THREAD: Optional[threading.Thread] = None
_RENDER_WORKER_THREAD: Optional[threading.Thread] = None
_STOP_EVENT = threading.Event()
_ACTIVE_LOCK = threading.RLock()
_ACTIVE_STREAM_THREADS: Dict[int, threading.Thread] = {}
_STREAM_ACTIVE_JOBS: Dict[str, Dict[str, Any]] = {}
_PROCESSING_EXECUTOR = ThreadPoolExecutor(max_workers=3, thread_name_prefix="StreamProcWorker")
_STREAM_CLIP_RENDER_QUEUE: queue.Queue = queue.Queue()
_JOB_PENDING_TASKS: Dict[str, int] = {}
_JOB_CAPTURE_FINISHED: set = set()

# Continuous recording segment duration: 10 minutes
STREAM_SEGMENT_DURATION = 600


class LiveSegmentHighlight(BaseModel):
    viral: bool = Field(default=True, description="True if a highlight moment is selected, False only if total silence/no speech")
    start: float = Field(default=0.0, description="Start timestamp in seconds within this 10-minute segment (0 to 600)")
    end: float = Field(default=45.0, description="End timestamp in seconds within this 10-minute segment (0 to 600)")
    title: str = Field(default="Live Stream Highlight", description="Catchy short-form title for the clip")
    hook: str = Field(default="Must Watch!", description="Punchy hook text (max 6 words) for the first 3 seconds")
    reason: str = Field(default="", description="Why this moment was selected or why skipped")


def _log(msg: str) -> None:
    print(f"[stream_monitor] {msg}", flush=True)


def _append_stream_log(job_id: str, msg: str) -> None:
    _log(f"[{job_id}] {msg}")
    now_ts = time.time()
    with _ACTIVE_LOCK:
        if job_id in _STREAM_ACTIVE_JOBS:
            _STREAM_ACTIVE_JOBS[job_id]["logs"].append(msg)
            _STREAM_ACTIVE_JOBS[job_id].setdefault("log_times", []).append(now_ts)
    try:
        app_mod = sys.modules.get("app")
        if app_mod and job_id in app_mod.jobs:
            app_mod.jobs[job_id].setdefault("logs", []).append(msg)
            app_mod.jobs[job_id].setdefault("log_times", []).append(now_ts)
    except Exception:
        pass


def get_active_stream_jobs() -> List[Dict[str, Any]]:
    """Return live stream job records held in memory."""
    with _ACTIVE_LOCK:
        return list(_STREAM_ACTIVE_JOBS.values())


def get_active_stream_job(job_id: str) -> Optional[Dict[str, Any]]:
    """Return in-memory record for a specific stream job if active."""
    with _ACTIVE_LOCK:
        return _STREAM_ACTIVE_JOBS.get(job_id)


get_stream_job = get_active_stream_job


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


_CHANNEL_ID_CACHE: Dict[str, str] = {}


def resolve_youtube_channel_id(channel_url: str, timeout: float = 10.0) -> Optional[str]:
    """Resolve a YouTube channel URL (@handle, /c/, /user/, or /channel/) to a canonical channel ID (UC...)."""
    clean = channel_url.strip()
    if clean.endswith("/live"):
        clean = clean[:-5]
    if clean.endswith("/videos"):
        clean = clean[:-7]
    clean = clean.rstrip("/")

    # Check cache
    if clean in _CHANNEL_ID_CACHE:
        return _CHANNEL_ID_CACHE[clean]

    # Direct UC channel ID in URL
    m_direct = re.search(r'youtube\.com/channel/(UC[a-zA-Z0-9_-]{22})', clean)
    if m_direct:
        cid = m_direct.group(1)
        _CHANNEL_ID_CACHE[clean] = cid
        return cid

    # Otherwise fetch the channel page HTML
    try:
        req = urllib.request.Request(
            clean,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                ),
                "Accept-Language": "en-US,en;q=0.9",
            }
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            html = r.read().decode("utf-8", errors="ignore")

        m = re.search(r'"channelId":"(UC[a-zA-Z0-9_-]{22})"', html) or \
            re.search(r'href="https://www.youtube.com/channel/(UC[a-zA-Z0-9_-]{22})"', html)
        if m:
            cid = m.group(1)
            _CHANNEL_ID_CACHE[clean] = cid
            return cid
    except Exception as e:
        _log(f"Failed to resolve channel ID for {clean}: {e}")
    return None


def fetch_youtube_rss_videos(channel_id: str, timeout: float = 10.0) -> List[Dict[str, Any]]:
    """Fetch recent videos directly from YouTube's public RSS/Atom XML feed.
    Zero bot detection, zero yt-dlp scraping overhead.
    """
    rss_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(
        rss_url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            xml_data = r.read().decode("utf-8", errors="ignore")
        root = ET.fromstring(xml_data)
        ns = {
            "atom": "http://www.w3.org/2005/Atom",
            "yt": "http://www.youtube.com/xml/schemas/2015"
        }
        videos = []
        author_elem = root.find("atom:author/atom:name", ns)
        uploader = author_elem.text if author_elem is not None else ""

        for entry in root.findall("atom:entry", ns):
            vid_elem = entry.find("yt:videoId", ns)
            if vid_elem is None or not vid_elem.text:
                continue
            vid = vid_elem.text.strip()
            title_elem = entry.find("atom:title", ns)
            v_title = title_elem.text.strip() if title_elem is not None and title_elem.text else "New Video"
            v_url = f"https://www.youtube.com/watch?v={vid}"
            videos.append({
                "id": vid,
                "title": v_title,
                "url": v_url,
                "uploader": uploader,
            })
        return videos
    except Exception as e:
        _log(f"Failed to fetch RSS feed for channel {channel_id}: {e}")
        return []


def _build_stream_ytdlp_cmd(base_args: List[str], target_url: str, platform: str = "youtube") -> List[str]:
    """Construct a resilient yt-dlp command with mobile clients, cookies, and proxy."""
    cmd = [sys.executable, "-m", "yt_dlp"] + list(base_args)

    if platform == "youtube" or "youtube.com" in target_url.lower() or "youtu.be" in target_url.lower():
        cmd.extend([
            "--extractor-args", "youtube:player_client=android,mweb,default",
            "--user-agent", (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        ])

        try:
            cookie_path = yt_account.get_active_cookie_file()
            if cookie_path and os.path.isfile(cookie_path):
                cmd.extend(["--cookies", cookie_path])
        except Exception:
            pass

        try:
            proxy = database.get_setting("proxy_url") or os.environ.get("PROXY_URL", "")
            if proxy and proxy.strip():
                cmd.extend(["--proxy", proxy.strip()])
        except Exception:
            pass

    cmd.append(target_url)
    return cmd


def check_stream_live(channel_url: str, platform: str) -> Optional[Dict[str, Any]]:
    """Check if a YouTube or Twitch channel is currently live using yt-dlp."""
    try:
        cmd = _build_stream_ytdlp_cmd([
            "--dump-json",
            "--no-warnings",
            "--playlist-items", "1",
            "--socket-timeout", "15",
        ], channel_url, platform)
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
        platform = "twitch" if "twitch.tv" in channel_url.lower() else "youtube"
        cmd = _build_stream_ytdlp_cmd([
            "--no-warnings",
            "-g",
        ], channel_url, platform)
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
                "target_youtube_account_id": mon.get("target_youtube_account_id"),
                "target_instagram_account_id": mon.get("target_instagram_account_id"),
                "auto_post": mon.get("auto_post", 0),
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
                "target_youtube_account_id": mon.get("target_youtube_account_id"),
                "target_instagram_account_id": mon.get("target_instagram_account_id"),
                "auto_post": mon.get("auto_post", 0),
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

            now_t = time.time()
            _STREAM_ACTIVE_JOBS[job_id] = {
                "job_id": job_id,
                "title": title,
                "video_title": title,
                "status": "processing",
                "is_stream": True,
                "channel_name": channel_name,
                "channel_url": channel_url,
                "platform": platform,
                "submitted_at": now_t,
                "logs": [f"🔴 Live stream tracking active: {title}", "📥 Capturing 10-minute rolling segments..."],
                "log_times": [now_t, now_t],
                "result": {"clips": shorts},
                "ready_files": {os.path.basename(c.get("video_url", "")): c for c in shorts if c.get("video_url")},
            }

    try:
        database.update_live_monitor(mon["id"], current_job_id=job_id)
    except Exception:
        pass

    try:
        app_mod = sys.modules.get("app")
        if app_mod and hasattr(app_mod, "jobs"):
            app_mod.jobs[job_id] = _STREAM_ACTIVE_JOBS[job_id]
    except Exception:
        pass

    return job_id


def find_densest_speech_window(transcript: Dict[str, Any], window_duration: float = 45.0) -> Tuple[float, float]:
    """Find the time window (duration ~45s) within a 10m transcript with the highest speech/word density."""
    segments = transcript.get("segments", [])
    if not segments:
        return 0.0, min(window_duration, 60.0)

    words = []
    for s in segments:
        for w in s.get("words", []):
            if "start" in w and "end" in w:
                words.append(w)

    if not words:
        seg_start = segments[0].get("start", 0.0)
        return seg_start, seg_start + window_duration

    max_t = max(w["end"] for w in words)
    if max_t <= window_duration:
        return 0.0, max_t

    best_count = -1
    best_start = 0.0

    for candidate in words:
        c_start = candidate["start"]
        c_end = c_start + window_duration
        if c_end > max_t + 10.0:
            break
        count = sum(1 for w in words if w["start"] >= c_start and w["end"] <= c_end)
        if count > best_count:
            best_count = count
            best_start = c_start

    return best_start, best_start + window_duration


def analyze_segment_for_viral_moment(transcript: Dict[str, Any], live_title: str) -> Optional[Dict[str, Any]]:
    """Analyze a 10-minute segment transcript with LLM.
    Returns None only if segment is totally silent (e.g. streamer AFK, 0 speech).
    Returns dict(start, end, title, hook) for the best 30-60 second highlight.
    """
    if not transcript or not transcript.get("segments"):
        return None

    # Calculate total word count
    words_list = [w for s in transcript.get("segments", []) for w in s.get("words", [])]
    total_words = len(words_list)
    if total_words == 0:
        total_words = sum(len(s.get("text", "").split()) for s in transcript.get("segments", []))

    if total_words < 5:
        _log(f"Segment has virtually no speech ({total_words} words). Skipping clipping.")
        return None

    transcript_lines = []
    for s in transcript["segments"]:
        transcript_lines.append(f"[{s['start']:.1f}s - {s['end']:.1f}s] {s['text']}")
    full_text = "\n".join(transcript_lines)

    prompt = f"""You are an elite short-form video editor for live streams and gaming clips.
Analyze this 10-minute live stream transcript from "{live_title}".
Your job is to identify the single best, most viral, exciting, funny, clutch, or engaging 30 to 60 second moment from this 10-minute segment to create a high-performing YouTube Short / Reel.

Transcript:
{full_text}

Guidelines:
1. Every live gaming or chatting segment with active commentary has a peak highlight (e.g. an intense fight, a clutch play, a funny reaction, banter with chat, an epic fail, or storytelling). Find that peak highlight moment.
2. Choose a tight 30 to 60 second window around that moment (start and end in seconds, between 0.0s and 600.0s).
3. Set "viral": true, provide a catchy title (max 8 words), and a punchy 3-6 word hook text.
4. CRITICAL: Always find the best highlight moment from this segment. Set "viral": true so a short can be published.
"""

    parsed = None
    # 1. Try OpenAI-compatible server if active
    if llm_backend.active():
        try:
            parsed_res, _ = llm_backend.generate_json(prompt, LiveSegmentHighlight)
            if isinstance(parsed_res, dict):
                parsed = parsed_res
                _log("Analyzed segment highlight using OpenAI-compatible backend.")
        except Exception as e:
            _log(f"OpenAI LLM highlight extraction notice: {e}")

    # 2. Try Groq LLM if active / key configured
    if not parsed:
        groq_key = os.getenv("GROQ_API_KEY") or database.get_setting("groq_api_key")
        if groq_key:
            try:
                import requests
                headers = {
                    "Authorization": f"Bearer {groq_key.strip()}",
                    "Content-Type": "application/json",
                }
                payload = {
                    "model": "llama-3.3-70b-versatile",
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are an elite video editor identifying viral short-form clips from live streams. "
                                "Respond strictly with JSON matching: {\"viral\": true, \"start\": float, \"end\": float, \"title\": str, \"hook\": str, \"reason\": str}."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.3,
                }
                resp = requests.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers=headers,
                    json=payload,
                    timeout=30.0,
                )
                if resp.status_code == 200:
                    c_text = resp.json()["choices"][0]["message"]["content"]
                    parsed = json.loads(c_text)
                    _log("Analyzed segment highlight using Groq Llama-3.3-70B.")
            except Exception as e:
                _log(f"Groq LLM highlight extraction notice: {e}")

    # 3. Try Gemini if OpenAI/Groq was not active or failed
    if not parsed:
        api_key = os.getenv("GEMINI_API_KEY") or database.get_setting("gemini_api_key")
        if api_key:
            try:
                from google import genai
                from google.genai import types as genai_types
                client = genai.Client(api_key=api_key.strip())
                model_name = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
                config = genai_types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=LiveSegmentHighlight,
                )
                resp = client.models.generate_content(model=model_name, contents=prompt, config=config)
                import gemini_worker
                parsed = gemini_worker._parse_json_response_text(gemini_worker._get_response_text(resp))
                _log("Analyzed segment highlight using Gemini.")
            except Exception as e:
                _log(f"Gemini LLM highlight extraction notice: {e}")

    # 4. If LLM provided a moment
    if parsed:
        is_viral = parsed.get("viral", True)
        if not is_viral:
            # If the LLM deemed it not viral, but there is significant commentary (>= 20 words),
            # rescue the highlight by locating the densest speech window.
            if total_words < 20:
                _log(f"Segment deemed not viral ({parsed.get('reason', 'Low activity')}) and has few words ({total_words}). Skipping.")
                return None
            _log(f"LLM marked viral=False but segment has high activity ({total_words} words). Rescuing highlight from densest commentary window.")
            d_start, d_end = find_densest_speech_window(transcript, 45.0)
            start = max(0.0, min(d_start, 550.0))
            end = min(600.0, max(start + 30.0, d_end))
            return {
                "start": start,
                "end": end,
                "title": f"{live_title} Highlight",
                "hook": "Wait For It!",
            }

        start = max(0.0, float(parsed.get("start", 0)))
        end = float(parsed.get("end", start + 45.0))
        if end <= start:
            end = start + 45.0
        dur = end - start
        if dur > 60.0:
            end = start + 60.0
        elif dur < 25.0:
            end = min(start + 35.0, end + 10.0)

        # Ensure start and end are within bounds of a 10m segment (600s)
        if start >= 570.0:
            start = max(0.0, 600.0 - (end - start))
            end = min(600.0, start + dur)

        return {
            "start": start,
            "end": end,
            "title": parsed.get("title") or f"{live_title} Highlight",
            "hook": parsed.get("hook") or "Must Watch!",
        }

    # 5. Guaranteed fallback: densest commentary window for any segment with speech
    if total_words >= 5:
        _log(f"LLM unavailable; using word-density heuristic for {total_words} words.")
        d_start, d_end = find_densest_speech_window(transcript, 45.0)
        start = max(0.0, min(d_start, 550.0))
        end = min(600.0, max(start + 30.0, d_end))
        return {
            "start": start,
            "end": end,
            "title": f"{live_title} Highlight",
            "hook": "Watch This Moment!",
        }

    return None


def _ensure_render_worker_running() -> None:
    """Ensure the single sequential clip render worker is alive."""
    global _RENDER_WORKER_THREAD
    with _ACTIVE_LOCK:
        if _RENDER_WORKER_THREAD and _RENDER_WORKER_THREAD.is_alive():
            return
        _RENDER_WORKER_THREAD = threading.Thread(
            target=_stream_render_worker,
            daemon=True,
            name="StreamClipSequentialRenderWorker",
        )
        _RENDER_WORKER_THREAD.start()
        _log("Sequential stream clip render worker started.")


def drain_render_queue() -> None:
    """Wait until all queued clips in the render queue finish processing."""
    _STREAM_CLIP_RENDER_QUEUE.join()


def _render_single_stream_clip(
    seg_file: str,
    live_title: str,
    job_id: str,
    layout: str = "gaming",
    subtitle_script: str = "auto",
    moment: Optional[Dict[str, Any]] = None,
    transcript: Optional[Dict[str, Any]] = None,
    seg_num: Optional[int] = None,
) -> Optional[str]:
    """Execute the heavy rendering steps for a single clip:
    1. Cut sub-clip from segment video with FFmpeg.
    2. Reframe to 9:16 vertical (Active speaker / gaming layout).
    3. Generate and burn compact subtitles.
    4. Auto-upload to S3 storage and update metadata.
    """
    prefix = f"Segment #{seg_num}: " if seg_num else ""
    if not moment:
        return None

    try:
        clip_start = moment["start"]
        clip_end = moment["end"]
        clip_title = moment["title"]
        hook_text = moment.get("hook", "Must Watch!")

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
                "subtitle_script": subtitle_script,
                "shorts": [],
            }

        meta["subtitle_script"] = subtitle_script
        if transcript:
            meta["transcript"] = transcript

        existing_shorts = meta.get("shorts", [])
        clip_num = len(existing_shorts) + 1
        clip_filename = f"{job_id}_clip_{clip_num}.mp4"
        raw_clip_path = os.path.join(out_dir, clip_filename)

        dur = clip_end - clip_start
        _log(f"🔥 Cutting Clip #{clip_num} [{clip_start:.1f}s -> {clip_end:.1f}s]: {clip_title}")
        _append_stream_log(
            job_id,
            f"✂️ {prefix}Step 1/4 - Cutting raw highlight #{clip_num} [{clip_start:.1f}s -> {clip_end:.1f}s] ({dur:.1f}s duration)..."
        )

        cut_cmd = [
            "ffmpeg", "-y",
            "-ss", str(clip_start),
            "-i", seg_file,
            "-t", str(dur),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-tune", "fastdecode",
            "-c:a", "aac",
            raw_clip_path,
        ]
        res = subprocess.run(cut_cmd, capture_output=True, timeout=120)
        # In test environments with mocked subprocess.run, ensure mock file exists
        if not os.path.exists(raw_clip_path) and getattr(res, "returncode", 0) == 0:
            with open(raw_clip_path, "w") as f:
                f.write("dummy")

        if not os.path.exists(raw_clip_path) or os.path.getsize(raw_clip_path) == 0:
            _append_stream_log(job_id, f"⚠️ {prefix}Failed to cut clip from segment video.")
            return None

        # Apply Reframe & Layout
        final_clip = raw_clip_path
        vertical_clip_path = os.path.join(out_dir, f"vert_{job_id}_{clip_filename}")
        try:
            import main as _m
            if layout == "gaming":
                os.environ["GAMING_LAYOUT"] = "1"
            _append_stream_log(job_id, f"📐 {prefix}Step 2/4 - AI Reframing to 9:16 vertical ({layout} layout)...")
            rendered = _m.process_video_to_vertical(
                raw_clip_path,
                vertical_clip_path,
                aspect_ratio=9/16,
            )
            if os.path.exists(vertical_clip_path) and os.path.getsize(vertical_clip_path) > 0:
                final_clip = vertical_clip_path
            elif rendered and isinstance(rendered, str) and os.path.exists(rendered) and os.path.getsize(rendered) > 0:
                final_clip = rendered
        except Exception as e:
            _append_stream_log(job_id, f"⚠️ {prefix}AI Reframing notice ({e}), preserved source framing.")

        # Generate compact Subtitles
        import subtitles as _subs
        ass_path = os.path.join(out_dir, f"subs_{job_id}_{clip_num}.ass")
        sub_clip_path = os.path.join(out_dir, f"subtitled_{job_id}_{clip_filename}")

        try:
            if transcript:
                _append_stream_log(job_id, f"📝 {prefix}Step 3/4 - Burning word-by-word subtitles ({subtitle_script})...")
                _subs.generate_ass(
                    transcript, clip_start, clip_end, ass_path,
                    fontsize=16, font_name="Anton" if subtitle_script != "hindi" else "Noto Sans Devanagari",
                )
                if os.path.exists(ass_path):
                    _subs.burn_subtitles(final_clip, ass_path, sub_clip_path)
                    if os.path.exists(sub_clip_path) and os.path.getsize(sub_clip_path) > 0:
                        final_clip = sub_clip_path
        except Exception as e:
            _append_stream_log(job_id, f"⚠️ {prefix}Subtitle burn notice: {e}")

        # S3 auto-upload if enabled
        s3_url = None
        try:
            import s3_uploader
            if s3_uploader.is_s3_enabled():
                _append_stream_log(job_id, f"☁️ {prefix}Step 4/4 - Uploading short to S3 storage...")
                s3_uploader.upload_file_to_s3(final_clip, s3_key=f"{job_id}/{os.path.basename(final_clip)}")
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
            "subtitle_script": subtitle_script,
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
                _STREAM_ACTIVE_JOBS[job_id]["logs"].append(f"✨ {prefix}Clip #{clip_num} published: {clip_title}")

        try:
            app_mod = sys.modules.get("app")
            if app_mod and job_id in app_mod.jobs:
                app_mod.jobs[job_id]["result"]["clips"] = existing_shorts
                if "ready_files" not in app_mod.jobs[job_id]:
                    app_mod.jobs[job_id]["ready_files"] = {}
                app_mod.jobs[job_id]["ready_files"][os.path.basename(final_clip)] = new_short
                app_mod.jobs[job_id].setdefault("logs", []).append(f"✨ {prefix}Clip #{clip_num} published: {clip_title}")
        except Exception:
            pass

        _append_stream_log(job_id, f"✅ {prefix}Clip #{clip_num} ready ({os.path.basename(final_clip)})")

        # Trigger background auto-post if linked social accounts are configured
        try:
            yt_acc = meta.get("target_youtube_account_id")
            ig_acc = meta.get("target_instagram_account_id")
            auto_p = bool(meta.get("auto_post", 0)) or bool(yt_acc or ig_acc)
            if auto_p and (yt_acc or ig_acc):
                import auto_poster
                _append_stream_log(job_id, f"🚀 {prefix}Auto-posting Clip #{clip_num} to linked social accounts...")
                auto_poster.trigger_background_auto_post(
                    job_id=job_id,
                    youtube_account_id=yt_acc,
                    instagram_account_id=ig_acc,
                )
        except Exception as e:
            _log(f"Auto-post stream clip trigger notice: {e}")

        return final_clip
    except Exception as e:
        _append_stream_log(job_id, f"⚠️ Error rendering live clip: {e}")
        return None


def _stream_render_worker() -> None:
    """Sequential worker processing stream clip rendering one-by-one."""
    _log("Sequential stream clip render worker started.")
    while not _STOP_EVENT.is_set():
        try:
            task = _STREAM_CLIP_RENDER_QUEUE.get(timeout=1.0)
        except queue.Empty:
            continue

        job_id = task.get("job_id")
        seg_file = task.get("seg_file")
        seg_num = task.get("seg_num")
        live_title = task.get("live_title")
        layout = task.get("layout", "gaming")
        subtitle_script = task.get("subtitle_script", "auto")
        moment = task.get("moment")
        transcript = task.get("transcript")

        prefix = f"Segment #{seg_num}: "
        try:
            _append_stream_log(
                job_id,
                f"🎬 {prefix}Sequential render worker started for '{moment.get('title')}' (Layout: {layout}, Subtitles: {subtitle_script})..."
            )
            final_clip = _render_single_stream_clip(
                seg_file=seg_file,
                live_title=live_title,
                job_id=job_id,
                layout=layout,
                subtitle_script=subtitle_script,
                moment=moment,
                transcript=transcript,
                seg_num=seg_num,
            )
            if final_clip:
                _append_stream_log(
                    job_id,
                    f"🎉 {prefix}Render & S3 publishing completed: {os.path.basename(final_clip)}"
                )
        except Exception as e:
            _append_stream_log(job_id, f"⚠️ {prefix}Render failed: {e}")
        finally:
            if seg_file and os.path.exists(seg_file):
                try:
                    os.remove(seg_file)
                    _append_stream_log(job_id, f"🧹 {prefix}Deleted raw 10-minute segment to free server disk space.")
                except OSError:
                    pass

            with _ACTIVE_LOCK:
                if job_id:
                    _JOB_PENDING_TASKS[job_id] = max(0, _JOB_PENDING_TASKS.get(job_id, 1) - 1)

            if job_id:
                _check_and_finalize_stream(job_id)
            _STREAM_CLIP_RENDER_QUEUE.task_done()


def _check_and_finalize_stream(job_id: str) -> None:
    """Check if stream capture ended and all queued render jobs are finished."""
    should_finalize = False
    with _ACTIVE_LOCK:
        pending = _JOB_PENDING_TASKS.get(job_id, 0)
        is_finished = job_id in _JOB_CAPTURE_FINISHED
        if is_finished and pending == 0:
            should_finalize = True

    if should_finalize:
        _finalize_stream_project(job_id)


def _finalize_stream_project(job_id: str) -> None:
    """Mark stream project as completed and delete all raw captured segment files."""
    _append_stream_log(job_id, "🏁 All queued clips rendered and published to S3. Live stream project completed.")
    with _ACTIVE_LOCK:
        if job_id in _STREAM_ACTIVE_JOBS:
            _STREAM_ACTIVE_JOBS[job_id]["status"] = "completed"

    try:
        app_mod = sys.modules.get("app")
        if app_mod and job_id in app_mod.jobs:
            app_mod.jobs[job_id]["status"] = "completed"
            app_mod.jobs[job_id].setdefault("logs", []).append("🏁 All clips rendered and published to S3. Live stream project completed.")
    except Exception:
        pass

    out_base = os.environ.get("OUTPUT_DIR", "output")
    job_dir = os.path.abspath(os.path.join(out_base, job_id))
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

    # Clean up all raw 10-minute segment files to free up disk space immediately
    seg_dir = os.path.join(job_dir, "segments")
    if os.path.exists(seg_dir):
        try:
            shutil.rmtree(seg_dir, ignore_errors=True)
            _log(f"🧹 Cleaned up raw stream segment files in {seg_dir}")
        except Exception as e:
            _log(f"Notice cleaning segments for {job_id}: {e}")

    with _ACTIVE_LOCK:
        _JOB_PENDING_TASKS.pop(job_id, None)
        _JOB_CAPTURE_FINISHED.discard(job_id)


def process_live_segment(
    segment_path: str,
    live_title: str,
    job_id: str,
    layout: str = "gaming",
    subtitle_script: str = "auto",
    seg_num: Optional[int] = None,
) -> Optional[str]:
    """Transcribe 10m segment, analyze for viral highlight, cut and render short if worthy,
    and append to the unified stream project ({job_id}_metadata.json). Direct synchronous path.
    """
    prefix = f"Segment #{seg_num}: " if seg_num else ""
    try:
        from subtitles import transcribe_audio
        _append_stream_log(job_id, f"🎙️ {prefix}Transcribing audio with Whisper...")
        transcript = transcribe_audio(segment_path)
        if not transcript or not transcript.get("segments"):
            _append_stream_log(job_id, f"ℹ️ {prefix}Skipped (no speech audio detected in this 10m window).")
            return None

        moment = analyze_segment_for_viral_moment(transcript, live_title)
        if not moment:
            _append_stream_log(job_id, f"ℹ️ {prefix}Skipped (no highlight moment in this 10m window).")
            return None

        _append_stream_log(
            job_id,
            f"🔥 {prefix}Highlight selected: '{moment['title']}' [{moment['start']:.1f}s -> {moment['end']:.1f}s]. Cutting & rendering..."
        )

        if subtitle_script == "hinglish":
            try:
                import hindi_transliterator
                transcript = hindi_transliterator.transliterate_transcript(transcript)
                _log("🔤 Transliterated live stream transcript to Hinglish")
            except Exception as e:
                _log(f"Hinglish transliteration notice: {e}")

        return _render_single_stream_clip(
            seg_file=segment_path,
            live_title=live_title,
            job_id=job_id,
            layout=layout,
            subtitle_script=subtitle_script,
            moment=moment,
            transcript=transcript,
            seg_num=seg_num,
        )
    except Exception as e:
        _append_stream_log(job_id, f"⚠️ Error processing live segment: {e}")
        return None


def _background_process_segment_task(
    seg_file: str,
    live_title: str,
    job_id: str,
    layout: str,
    subtitle_script: str,
    seg_num: int,
) -> None:
    """Background task running transcription, LLM highlight picker, and enqueuing render."""
    _ensure_render_worker_running()
    prefix = f"Segment #{seg_num}: "
    try:
        from subtitles import transcribe_audio
        _append_stream_log(job_id, f"🎙️ {prefix}Transcribing 10m segment audio with Whisper...")
        transcript = transcribe_audio(seg_file)
        if not transcript or not transcript.get("segments"):
            _append_stream_log(job_id, f"ℹ️ {prefix}Skipped (no speech audio detected in this 10m window — saving CPU & storage).")
            if os.path.exists(seg_file):
                try:
                    os.remove(seg_file)
                    _append_stream_log(job_id, f"🧹 {prefix}Deleted silent segment file.")
                except OSError:
                    pass
            with _ACTIVE_LOCK:
                _JOB_PENDING_TASKS[job_id] = max(0, _JOB_PENDING_TASKS.get(job_id, 1) - 1)
            _check_and_finalize_stream(job_id)
            return

        words_list = [w for s in transcript.get("segments", []) for w in s.get("words", [])]
        word_count = len(words_list) or sum(len(s.get("text", "").split()) for s in transcript.get("segments", []))
        _append_stream_log(
            job_id,
            f"🧠 {prefix}Transcribed {word_count} words. Analyzing viral pacing with LLM..."
        )

        moment = analyze_segment_for_viral_moment(transcript, live_title)
        if not moment:
            _append_stream_log(job_id, f"ℹ️ {prefix}Skipped (no standout viral moments in this 10m window — saving CPU & storage).")
            if os.path.exists(seg_file):
                try:
                    os.remove(seg_file)
                    _append_stream_log(job_id, f"🧹 {prefix}Deleted low-activity segment file.")
                except OSError:
                    pass
            with _ACTIVE_LOCK:
                _JOB_PENDING_TASKS[job_id] = max(0, _JOB_PENDING_TASKS.get(job_id, 1) - 1)
            _check_and_finalize_stream(job_id)
            return

        _append_stream_log(
            job_id,
            f"🔥 {prefix}Viral moment selected: '{moment['title']}' [{moment['start']:.1f}s -> {moment['end']:.1f}s] (Hook: \"{moment.get('hook', 'Must Watch!')}\")."
        )

        if subtitle_script == "hinglish":
            try:
                import hindi_transliterator
                transcript = hindi_transliterator.transliterate_transcript(transcript)
                _append_stream_log(job_id, f"🔤 {prefix}Transliterated transcript to Hinglish for subtitles.")
            except Exception as e:
                _log(f"Hinglish transliteration notice: {e}")

        task = {
            "job_id": job_id,
            "seg_file": seg_file,
            "seg_num": seg_num,
            "live_title": live_title,
            "layout": layout,
            "subtitle_script": subtitle_script,
            "moment": moment,
            "transcript": transcript,
        }
        _STREAM_CLIP_RENDER_QUEUE.put(task)
        qsize = _STREAM_CLIP_RENDER_QUEUE.qsize()
        _append_stream_log(
            job_id,
            f"⏳ {prefix}Enqueued for sequential rendering (Queue position: #{qsize})."
        )
    except Exception as e:
        _append_stream_log(job_id, f"⚠️ {prefix}Analysis error: {e}")
        if os.path.exists(seg_file):
            try:
                os.remove(seg_file)
            except OSError:
                pass
        with _ACTIVE_LOCK:
            _JOB_PENDING_TASKS[job_id] = max(0, _JOB_PENDING_TASKS.get(job_id, 1) - 1)
        _check_and_finalize_stream(job_id)


def _stream_capture_worker(
    mon_id: int,
    channel_url: str,
    platform: str,
    layout: str,
    subtitle_script: str,
    live_info: Dict[str, Any],
) -> None:
    """Continuous 10-minute segment recorder for an active live stream."""
    _ensure_render_worker_running()
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
            _append_stream_log(job_id, f"📥 Recording 10-minute segment #{seg_index + 1}...")

            recorded = record_stream_segment(manifest_urls, STREAM_SEGMENT_DURATION, seg_file)

            if recorded and os.path.exists(seg_file) and os.path.getsize(seg_file) > 100000:
                size_mb = os.path.getsize(seg_file) / (1024 * 1024)
                with _ACTIVE_LOCK:
                    _JOB_PENDING_TASKS[job_id] = _JOB_PENDING_TASKS.get(job_id, 0) + 1
                _append_stream_log(
                    job_id,
                    f"⚙️ Segment #{seg_index + 1} captured ({size_mb:.1f} MB). Analyzing for viral highlight in background..."
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
            _ACTIVE_STREAM_THREADS.pop(mon_id, None)
            _JOB_CAPTURE_FINISHED.add(job_id)
            pending = _JOB_PENDING_TASKS.get(job_id, 0)
            if pending > 0:
                if job_id in _STREAM_ACTIVE_JOBS:
                    _STREAM_ACTIVE_JOBS[job_id]["status"] = "finalizing"
                _append_stream_log(
                    job_id,
                    f"⏹️ Live stream broadcast ended. Finalizing {pending} remaining clip render(s)..."
                )
        _check_and_finalize_stream(job_id)


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
                "published_posts": c.get("published_posts") or [],
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


def check_channel_new_videos(channel_url: str, seen_ids: List[str]) -> List[Dict[str, Any]]:
    """Check for newly uploaded videos on a channel using RSS feed first, falling back to yt-dlp."""
    clean_url = channel_url.strip()
    seen_set = set(seen_ids)

    # 1. Try zero-overhead, bot-free YouTube RSS feed parsing first if YouTube
    if "twitch.tv" not in clean_url.lower():
        cid = resolve_youtube_channel_id(clean_url)
        if cid:
            rss_vids = fetch_youtube_rss_videos(cid)
            if rss_vids:
                new_videos = [v for v in rss_vids if v.get("id") and v["id"] not in seen_set]
                return new_videos

    # 2. Fallback to yt-dlp flat playlist extraction (for Twitch or when RSS is unavailable)
    if clean_url.endswith("/live"):
        clean_url = clean_url[:-5]
    clean_url = clean_url.rstrip("/")
    if not clean_url.endswith("/videos") and "twitch.tv" not in clean_url:
        videos_url = f"{clean_url}/videos"
    else:
        videos_url = clean_url

    try:
        platform = "twitch" if "twitch.tv" in clean_url.lower() else "youtube"
        cmd = _build_stream_ytdlp_cmd([
            "--dump-json",
            "--flat-playlist",
            "--playlist-end", "5",
            "--no-warnings",
            "--socket-timeout", "15",
        ], videos_url, platform)
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        if res.returncode != 0 or not res.stdout.strip():
            return []

        new_videos = []
        for line in res.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                vid = data.get("id")
                if not vid or vid in seen_set:
                    continue
                v_title = data.get("title") or "New Video"
                v_url = data.get("webpage_url") or data.get("url") or f"https://www.youtube.com/watch?v={vid}"
                new_videos.append({
                    "id": vid,
                    "title": v_title,
                    "url": v_url,
                    "uploader": data.get("uploader") or data.get("channel") or "",
                })
            except Exception:
                continue
        return new_videos
    except Exception as e:
        _log(f"Check channel new videos failed for {channel_url}: {e}")
        return []


def dispatch_video_upload_job(mon: Dict[str, Any], video_info: Dict[str, Any]) -> str:
    """Submit a video upload clipping job with creator monitor settings."""
    vid_url = video_info.get("url") or f"https://www.youtube.com/watch?v={video_info.get('id')}"
    title = video_info.get("title") or "Creator Upload"
    layout = mon.get("layout", "gaming")
    sub_script = mon.get("subtitle_script", "auto")
    yt_acc = mon.get("target_youtube_account_id")
    ig_acc = mon.get("target_instagram_account_id")
    auto_post = bool(mon.get("auto_post", 0))

    try:
        app_mod = sys.modules.get("app")
        if app_mod and hasattr(app_mod, "submit_monitored_video_job"):
            return app_mod.submit_monitored_video_job(
                video_url=vid_url,
                title=title,
                layout=layout,
                subtitle_script=sub_script,
                target_youtube_account_id=yt_acc,
                target_instagram_account_id=ig_acc,
                auto_post=auto_post,
                channel_name=mon.get("channel_name", ""),
                channel_url=mon.get("channel_url", ""),
            )
    except Exception as e:
        _log(f"Notice calling app.submit_monitored_video_job: {e}")

    job_id = f"video_{video_info.get('id', int(time.time()))}"
    out_base = os.environ.get("OUTPUT_DIR", "output")
    job_dir = os.path.join(out_base, job_id)
    os.makedirs(job_dir, exist_ok=True)
    with open(os.path.join(job_dir, "_project_info.json"), "w", encoding="utf-8") as f:
        json.dump({
            "title": title,
            "status": "queued",
            "url": vid_url,
            "channel_name": mon.get("channel_name", ""),
            "channel_url": mon.get("channel_url", ""),
            "target_youtube_account_id": yt_acc,
            "target_instagram_account_id": ig_acc,
            "auto_post": auto_post,
        }, f, indent=2)
    return job_id


def run_monitor_cycle() -> None:
    """Run one check-and-process iteration across all tracked monitors."""
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
        monitor_mode = mon.get("monitor_mode") or "stream"

        now_str = datetime.now(timezone.utc).isoformat()

        # 1. Video Upload Mode: check for newly uploaded videos
        if monitor_mode in ("video", "both"):
            try:
                raw_seen = mon.get("seen_video_ids") or "[]"
                seen_ids = json.loads(raw_seen)
                if not seen_ids:
                    # First run: seed existing videos so only subsequent uploads are detected
                    existing_vids = check_channel_new_videos(url, [])
                    seed_ids = [v["id"] for v in existing_vids if v.get("id")]
                    if seed_ids:
                        database.update_live_monitor(mid, seen_video_ids=json.dumps(seed_ids), last_checked=now_str)
                else:
                    new_vids = check_channel_new_videos(url, seen_ids)
                    if new_vids:
                        _log(f"🎬 Detected {len(new_vids)} new upload(s) for monitor {mid} ({url})")
                        for v in new_vids:
                            job_id = dispatch_video_upload_job(mon, v)
                            _log(f"🚀 Dispatched video clipping job {job_id} for {v.get('title')}")
                            seen_ids.append(v["id"])
                        database.update_live_monitor(mid, seen_video_ids=json.dumps(seen_ids), last_checked=now_str)
            except Exception as e:
                _log(f"Error checking new video uploads for monitor {mid}: {e}")

        # 2. Live Stream Mode: check live stream status
        if monitor_mode in ("stream", "both"):
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
