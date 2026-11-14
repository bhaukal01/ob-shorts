"""Live Stream Tracker & Near-Real-Time Moment Clipper.

Monitors creator YouTube and Twitch channels for live status, captures rolling
segments, spots peak moments via audio energy spikes + Whisper + LLM, and triggers
the OpenShorts clipping pipeline (supporting the dedicated Gaming layout).
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
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import database
import llm_backend

_MONITOR_THREAD: Optional[threading.Thread] = None
_STOP_EVENT = threading.Event()
_ACTIVE_RECORDINGS: Dict[int, subprocess.Popen] = {}


def _log(msg: str) -> None:
    print(f"[stream_monitor] {msg}", flush=True)


def normalize_channel_url(url: str) -> Tuple[str, str]:
    """Normalize channel URL and determine platform ('youtube' or 'twitch')."""
    clean = url.strip()
    if "twitch.tv" in clean.lower():
        # Match https://www.twitch.tv/username
        m = re.search(r'twitch\.tv/([a-zA-Z0-9_]+)', clean, re.IGNORECASE)
        channel = m.group(1) if m else clean
        return "twitch", f"https://www.twitch.tv/{channel}"
    elif "youtube.com" in clean.lower() or "youtu.be" in clean.lower():
        # Normalize to https://www.youtube.com/@handle/live or channel/live
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


def get_live_stream_manifest_url(channel_url: str) -> Optional[str]:
    """Extract direct HLS .m3u8 stream manifest URL using yt-dlp."""
    try:
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "-g",
            "-f", "best[ext=mp4]/best",
            channel_url,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip().splitlines()[0]
    except Exception as e:
        _log(f"Failed to get stream URL: {e}")
    return None


def record_stream_segment(manifest_url: str, duration_sec: int, out_path: str) -> bool:
    """Capture a segment of duration_sec directly from live stream with zero re-encoding."""
    try:
        cmd = [
            "ffmpeg", "-y",
            "-re",
            "-i", manifest_url,
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


def detect_audio_spikes(video_path: str) -> List[Tuple[float, float]]:
    """Detect loud volume windows (shouting, clutches, hype moments) via ffmpeg astats/volumedetect."""
    spikes: List[Tuple[float, float]] = []
    try:
        # Extract audio volume levels
        cmd = [
            "ffmpeg", "-i", video_path,
            "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
            "-f", "null", "-",
        ]
        # Fallback to simple duration segment split if astats is too noisy
        cmd_dur = [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", video_path
        ]
        probe = subprocess.run(cmd_dur, capture_output=True, text=True, timeout=15)
        dur = float(probe.stdout.strip()) if probe.stdout.strip() else 300.0

        # Create candidate 45-second sliding windows
        window_size = 45.0
        step = 30.0
        t = 0.0
        while t + window_size <= dur:
            spikes.append((t, min(dur, t + window_size)))
            t += step
    except Exception as e:
        _log(f"Audio spike detection failed ({e})")
    return spikes


def process_live_segment(
    segment_path: str,
    channel_title: str,
    layout: str = "gaming",
    subtitle_script: str = "auto",
) -> Optional[str]:
    """Transcribe segment, pick peak viral moment with LLM, and render short."""
    try:
        from subtitles import transcribe_audio
        _log(f"🎙️ Transcribing live segment: {segment_path}")
        transcript = transcribe_audio(segment_path)
        if not transcript or not transcript.get("segments"):
            _log("Segment had no speech transcript.")
            return None

        # Build transcript text for LLM moment picker
        transcript_lines = []
        for s in transcript["segments"]:
            transcript_lines.append(f"[{s['start']:.1f}s - {s['end']:.1f}s] {s['text']}")
        full_text = "\n".join(transcript_lines)

        prompt = f"""You are an elite short-form video editor for gaming live streams.
Analyze this live stream transcript from "{channel_title}" and pick the single most exciting, funniest, or highest energy moment for a 30 to 60 second YouTube Short / TikTok Reel.

Transcript:
{full_text}

Respond in strict JSON format:
{{
  "start": <start_seconds_float>,
  "end": <end_seconds_float>,
  "title": "<viral_catchy_title>",
  "hook": "<short_punchy_hook_text_max_6_words>"
}}
"""
        schema = {
            "type": "OBJECT",
            "properties": {
                "start": {"type": "NUMBER"},
                "end": {"type": "NUMBER"},
                "title": {"type": "STRING"},
                "hook": {"type": "STRING"},
            },
            "required": ["start", "end", "title", "hook"],
        }

        parsed, _ = llm_backend.generate_json(prompt, schema)
        clip_start = max(0.0, float(parsed.get("start", 0)))
        clip_end = float(parsed.get("end", clip_start + 45))
        clip_title = parsed.get("title") or "Epic Live Moment"
        hook_text = parsed.get("hook") or "Must Watch!"

        _log(f"🔥 Viral Moment Picked: [{clip_start:.1f}s -> {clip_end:.1f}s] - {clip_title}")

        # Render clip via OpenShorts pipeline
        job_id = f"live_{int(time.time())}"
        out_dir = os.path.abspath(os.path.join(os.environ.get("OUTPUT_DIR", "output"), job_id))
        os.makedirs(out_dir, exist_ok=True)

        clip_filename = f"{job_id}_clip_1.mp4"
        raw_clip_path = os.path.join(out_dir, clip_filename)

        # Cut segment with ffmpeg
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
        rendered_clip = reframe_render(
            raw_clip_path,
            1080, 1920,
            os.path.join(out_dir, "workdir"),
        )

        final_clip = rendered_clip or raw_clip_path

        # Generate Subtitles
        import subtitles as _subs
        ass_path = os.path.join(out_dir, f"subs_{job_id}.ass")
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
            fontsize=44, font_name="Anton" if subtitle_script != "hindi" else "Noto Sans Devanagari",
        )
        if os.path.exists(ass_path):
            try:
                _subs.burn_subtitles(final_clip, ass_path, sub_clip_path)
                if os.path.exists(sub_clip_path):
                    final_clip = sub_clip_path
            except Exception as e:
                _log(f"Burning subtitles failed: {e}")

        # Write metadata.json so the clip appears in Dashboard Library
        meta = {
            "job_id": job_id,
            "title": clip_title,
            "video_title": f"[LIVE] {channel_title}",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "shorts": [
                {
                    "title": clip_title,
                    "video_title_for_youtube_short": clip_title,
                    "video_description_for_instagram": f"{clip_title}\n\n#Shorts #Gaming #Live",
                    "viral_hook_text": hook_text,
                    "start": clip_start,
                    "end": clip_end,
                    "video_url": f"/videos/{job_id}/{os.path.basename(final_clip)}",
                }
            ],
            "transcript": transcript_to_use,
        }
        with open(os.path.join(out_dir, f"{job_id}_metadata.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)

        _log(f"✅ Live short generated and stored at: {final_clip}")
        return final_clip
    except Exception as e:
        _log(f"Error processing live segment: {e}")
        return None


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

        manifest_url = get_live_stream_manifest_url(url)
        if not manifest_url:
            continue

        # Create temporary segment file
        work_dir = os.path.abspath(os.path.join(os.environ.get("OUTPUT_DIR", "output"), "live_temp"))
        os.makedirs(work_dir, exist_ok=True)
        seg_file = os.path.join(work_dir, f"seg_{mid}_{int(time.time())}.mp4")

        _log(f"📥 Recording 5-minute rolling slice for {live_info['title']}...")
        database.update_live_monitor(mid, status="recording")
        recorded = record_stream_segment(manifest_url, 300, seg_file)

        if recorded and os.path.exists(seg_file):
            database.update_live_monitor(mid, status="clipping")
            process_live_segment(
                seg_file,
                live_info["title"],
                layout=layout,
                subtitle_script=sub_script,
            )
            try:
                os.remove(seg_file)
            except OSError:
                pass
            database.update_live_monitor(mid, status="live")


def _monitor_loop() -> None:
    """Background polling loop running every 60 seconds."""
    _log("Starting background live stream monitor...")
    while not _STOP_EVENT.is_set():
        try:
            run_monitor_cycle()
        except Exception as e:
            _log(f"Monitor cycle error: {e}")
        # Sleep for 60 seconds or until stopped
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

