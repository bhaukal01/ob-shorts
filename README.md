# OpenShorts 🎬

**The high-performance, open-source AI video platform & OpusClip alternative.**  
Turn long videos and live streams into viral 9:16 Shorts, TikToks, and Instagram Reels. Self-host free on your own VPS with Docker Compose or Dokploy, with zero watermarks and full privacy.

| Feature | OpenShorts (Self-Hosted) | OpusClip | Vizard | Klap |
|---|---|---|---|---|
| **License** | **Open Source (MIT)** | Proprietary | Proprietary | Proprietary |
| **Watermark** | **None (Never)** | Watermarked on free | Watermarked on free | Watermarked on free |
| **Self-Hostable** | **Yes (Docker / Dokploy)** | No | No | No |
| **Live Stream Clipper** | **Yes (YouTube & Twitch)** | No | No | No |
| **Hindi & Hinglish Support** | **Yes (Devanagari + Hinglish)** | Limited | Limited | Limited |
| **Gaming Dual-Band Layout** | **Yes (Webcam top + Game bottom)** | Limited | Limited | Limited |
| **OpenAI-Compatible LLMs** | **Yes (Ollama, vLLM, DeepSeek...)**| No | No | No |
| **API + MCP Server** | **Yes (Built-in)** | API only | API only | API only |

---

## What's New in This Version

- 🗄️ **Persistent SQLite Database (`data/openshorts.db`)**: Settings, API keys, OAuth credentials, and publish logs now persist across container restarts and redeployments with automatic schema migrations.
- 🤖 **Universal OpenAI-Compatible LLM Backend**: Use **any** OpenAI-compatible provider (Ollama, vLLM, LM Studio, DeepSeek, LocalAI, OpenRouter). Features dynamic model auto-discovery (`/v1/models`) and instant connectivity testing in the Settings UI.
- 🇮🇳 **Hindi Subtitles & Phonetic Hinglish Transliteration**:
  - Bundled **Noto Sans Devanagari Bold** font eliminates tofu/box artifacts in Hindi videos.
  - Subtitle script mode selector in Advanced Options: **Auto**, **Hindi (Devanagari)**, or **Hinglish (Roman Script)**.
  - Rule-based phonetic transliteration preserves exact word timestamps for animated karaoke captions.
- 🎮 **Gaming Dual-Band Layout**:
  - Automatically identifies gamer facecam corners from widescreen gameplay.
  - Seamlessly splits the vertical frame: **streamer webcam cropped to top (1080x720)** and **widescreen gameplay positioned at bottom (1080x1200)** with ambient backdrop.
- 🔴 **Live Stream Tracker & Real-Time Peak Clipper**:
  - Dedicated **Live Streams** tab to track active YouTube & Twitch channel streams.
  - Rolling 5-minute chunk monitoring with audio loudness peak detection, faster-whisper transcription, LLM peak scoring, and automatic vertical clip cutting.
- 🚀 **100% Dokploy & Single-Domain Ready**:
  - Production Nginx reverse proxy routes all frontend SPA routes, `/api/` endpoints, `/videos/` streams, `/thumbnails/`, and `/render/` requests through a **single domain** with zero CORS hassles.
  - Optimized for 8 vCPU / 16 GB RAM VPS instances.

---

## 🚀 100% Dokploy Deployment Guide (Step-by-Step)

Deploying OpenShorts on Dokploy takes less than 3 minutes using Docker Compose.

### Step 1: Create a Compose Application in Dokploy
1. Log in to your **Dokploy** dashboard.
2. Select your Project and Environment.
3. Click **Create Service** and select **Compose**.
4. Set a name for your application (e.g., `openshorts`).

### Step 2: Configure Git Source
In the Compose application settings:
- **Source Type**: `Git`
- **Repository URL**: `https://github.com/bhaukal01/ob-shorts.git`
- **Branch**: `main`
- **Compose Path**: `docker-compose.yml`

### Step 3: Exact Domain Configuration in Dokploy (Single Domain Setup)

> [!IMPORTANT]
> OpenShorts features an integrated Nginx reverse proxy inside the `frontend` container that routes all API (`/api/`), video delivery (`/videos/`), thumbnails (`/thumbnails/`), and Remotion renders (`/render/`) automatically. You only need to configure **ONE** domain!

In Dokploy under the **Domains** tab of your Compose application:
1. Click **Add Domain**.
2. **Domain**: Enter your domain or subdomain (e.g. `shorts.yourdomain.com`).
3. **Service / Container**: Select **`frontend`**.
4. **Container Port**: Set to **`80`** (Internal Nginx port inside the Docker network. Dokploy's Traefik routes domain traffic directly here).
5. **Certificate**: Select **Let's Encrypt** and enable **HTTPS / SSL**.
6. Click **Save** and **Deploy**.

```
                           ┌────────────────────────┐
                           │   Dokploy (Traefik)    │
                           │  shorts.yourdomain.com │
                           └───────────┬────────────┘
                                       │ Port 80 (HTTPS)
                                       ▼
                     ┌───────────────────────────────────┐
                     │         frontend (Nginx)          │
                     │  - React Dashboard SPA            │
                     │  - Reverse Proxy Route Map        │
                     └───────┬───────────────────┬───────┘
                             │                   │
               /api/, /videos/, /thumbnails      │ /render/
                             ▼                   ▼
                 ┌──────────────────────┐   ┌──────────────────────┐
                 │    backend:8000      │   │    renderer:3100     │
                 │   (FastAPI + AI)     │   │  (Remotion Node SSR) │
                 └──────────────────────┘   └──────────────────────┘
```

### Step 4: Environment Variables (Optional)
In Dokploy's **Environment** tab, you can add environment variables if you want to pre-configure defaults:

```ini
# Hardware Tuning (Pre-configured for 8 vCPUs / 16 GB RAM)
CLIP_WORKERS=3
DETECT_STRIDE=6
SCENE_ENGINE=pyscenedetect
FFMPEG_THREADS=3
OMP_NUM_THREADS=2
OPENBLAS_NUM_THREADS=2
MKL_NUM_THREADS=2

# Optional Default LLM Provider (Can also be set in Web UI Settings)
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.onebyt.live/v1
LLM_MODEL=deepseek-flash-2
LLM_API_KEY=your_api_key_here
```

### Step 5: Persistent Volumes
Dokploy automatically provisions the named volumes declared in `docker-compose.yml`:
- `openshorts_data`: Persists the SQLite database (`openshorts.db`), settings, and OAuth tokens.
- `openshorts_output`: Stores generated video clips and thumbnails shared between backend and renderer.

Click **Deploy**! Once deployment completes, open your domain in the browser to start clipping.

---

## 🛠️ Local Bare-Metal Setup & Development

If you prefer developing on your local machine without Docker:

### 1. Prerequisites
- **Python 3.11 or 3.12**
- **Node.js 18+** & **npm**
- **FFmpeg** installed and in system PATH

### 2. Backend Setup
```bash
# Clone the repository
git clone https://github.com/bhaukal01/ob-shorts.git
cd ob-shorts

# Install Python dependencies
pip install -r requirements.txt

# Start backend FastAPI server
python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Frontend Setup
```bash
cd dashboard

# Install dependencies
npm install

# Start Vite dev server
npm run dev
```
Navigate to **`http://localhost:5173`** in your browser.

---

## 💡 Core Features Breakdown

### 1. Clip Generator
- **AI Moment Detection**: Scans transcripts and scene shifts to extract the most engaging moments (15s–60s).
- **Face & Subject Tracking**: MediaPipe and YOLOv8 track active speakers and crop landscape video dynamically into vertical 9:16.
- **Smart Layout Modes**:
  - `Auto`: AI detects layout per scene.
  - `Gaming`: Split frame with streamer webcam on top and gameplay on bottom.
  - `Split`: Two speakers vertically stacked with captions on the seam.
  - `Track`: Dynamic single speaker face-tracking.
  - `General`: Full video centered with blurred ambient background.
- **Word-Level Animated Subtitles**: Word-by-word highlight karaoke animations with customizable colors and font sizes.
- **Hindi & Hinglish**: Full Devanagari script support and automatic phonetic Hinglish transliteration.

### 2. Live Stream Auto-Clipper
- Paste YouTube Live or Twitch stream links.
- OpenShorts polls active broadcasts, downloads rolling 5-minute audio/video windows, detects sound spikes, transcribes speech, selects viral moments via LLM, and produces ready-to-share vertical clips while the streamer is still live!

### 3. AI UGC Shorts Creator
- Generate complete video ads from a text prompt or product URL.
- AI scriptwriting, AI avatar actor generation, voiceover via ElevenLabs, b-roll generation with Ken Burns effect, and synchronized lip-sync.

### 4. YouTube Studio
- Generate 10 viral YouTube titles, descriptions with chapter timestamps, and customized thumbnails with face overlays.

---

## 🤖 MCP Server & API Automation

OpenShorts includes a built-in **Model Context Protocol (MCP)** server for AI agents (Cursor, Claude Desktop, Claude Code, Windsurf, n8n):

```bash
# Connect local MCP server to Claude Code or Cursor
claude mcp add --transport http openshorts http://localhost:8000/mcp

# Or via stdio transport:
claude mcp add openshorts -- python mcp_stdio.py
```

### Available Tools:
- `process_video`: Turn any YouTube URL or uploaded video into vertical clips.
- `get_job_status`: Poll progress of processing jobs.
- `list_clips`: Fetch completed video clips, download URLs, and viral scores.
- `recut_clip`: Re-adjust start/end boundaries and re-render.
- `publish_clip`: Publish clip to YouTube Shorts, Instagram Reels, or TikTok.

---

## ⚙️ Environment Variables Reference

| Variable | Default | Purpose |
|---|---|---|
| `DB_PATH` | `./data/openshorts.db` | Custom path for SQLite database file |
| `LLM_PROVIDER` | `openai` | `openai` (or `gemini`) for moment picker |
| `LLM_BASE_URL` | - | Base URL for OpenAI-compatible LLM (e.g. `http://localhost:11434/v1`) |
| `LLM_API_KEY` | - | Optional API key for custom LLM provider |
| `LLM_MODEL` | `llama3.1:8b` | Model name for transcript scoring |
| `CLIP_WORKERS` | `3` | Parallel clip rendering processes |
| `FFMPEG_THREADS` | `3` | Max CPU threads per FFmpeg encode process |
| `DETECT_STRIDE` | `6` | Frame skipping stride for scene detection |
| `SCENE_ENGINE` | `pyscenedetect` | Scene detection library |
| `GEMINI_API_KEY` | - | Google Gemini API key (optional if using OpenAI LLM) |

---

## 🛡️ License

Core OpenShorts application is released under the **MIT License**.  
Free for personal and commercial self-hosting.
