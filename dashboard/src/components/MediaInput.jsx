import React, { useState, useEffect, useRef } from 'react';
import {
  Link2, Upload, FileVideo, X, Info, Loader2,
  Gamepad2, Users, User, Monitor, Sparkles, Check,
  Youtube, Instagram, Layers, Subtitles, Share2, HelpCircle
} from 'lucide-react';
import { track } from '../lib/analytics';
import { getApiUrl } from '../config';
import { BrandIcon } from './BrandLogo';

const SUPPORTED_PLATFORMS = [
  'YouTube', 'Twitch', 'Kick', 'TikTok', 'X / Twitter',
  'Instagram', 'Facebook', 'Vimeo', 'Reddit', 'Streamable',
];

const MIN_SOURCE_SECONDS = 45;

const readVideoDuration = (file) => new Promise((resolve) => {
  try {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = url;
  } catch { resolve(null); }
});

const LAYOUT_OPTIONS = [
  {
    id: 'gaming',
    title: 'Gaming',
    subtitle: 'Facecam Top + Gameplay Below',
    desc: 'Auto-crops gameplay to 100% height below camera without black fillers.',
    icon: Gamepad2,
    badge: 'Popular for Gaming',
  },
  {
    id: 'split',
    title: 'Split Screen',
    subtitle: 'Dual Speaker Split',
    desc: 'Two speakers dynamic vertical framing with active voice detection.',
    icon: Users,
    badge: 'Podcasts & Talk Shows',
  },
  {
    id: 'auto',
    title: 'Smart Focus',
    subtitle: 'Dynamic Speaker Zoom',
    desc: 'Intelligent face tracking center crop that follows the primary speaker.',
    icon: User,
    badge: 'Vlogs & Solo Video',
  },
  {
    id: 'screencast',
    title: 'Screencast',
    subtitle: 'Full Desktop / Presentation',
    desc: 'Preserves software UI and presentation slides with top speaker inset.',
    icon: Monitor,
    badge: 'Tech & Tutorials',
  },
];

const SUBTITLE_SCRIPTS = [
  { id: 'auto', label: 'Auto (Default)', desc: 'Matches original spoken audio' },
  { id: 'hinglish', label: 'Hinglish', desc: 'Hindi spoken in Latin / English alphabet' },
  { id: 'en', label: 'English', desc: 'English script & grammar' },
  { id: 'hi', label: 'Hindi', desc: 'Devanagari script (हिंदी)' },
];

export default function MediaInput({
  onProcess,
  isProcessing,
  youtubeAccounts = [],
  instagramAccounts = []
}) {
  const [mode, setMode] = useState('url'); // 'url' | 'file'
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [fileSeconds, setFileSeconds] = useState(null);
  const fileTooShort = fileSeconds != null && fileSeconds < MIN_SOURCE_SECONDS;
  const [acknowledged, setAcknowledged] = useState(true);
  const [outputFormat, setOutputFormat] = useState('vertical'); // vertical | horizontal | square

  // Framing & Layout
  const [layout, setLayout] = useState(() => {
    try { return localStorage.getItem('clipsnipr_layout') || 'gaming'; } catch { return 'gaming'; }
  });

  // Subtitle Language
  const [subtitleScript, setSubtitleScript] = useState(() => {
    try { return localStorage.getItem('clipsnipr_subtitle_script') || 'auto'; } catch { return 'auto'; }
  });

  // Auto Hook
  const [autoHook, setAutoHook] = useState(() => {
    try { return localStorage.getItem('clipsnipr_auto_hook') !== '0'; } catch { return true; }
  });

  // Social Auto-Posting
  const [postYoutubeAccountId, setPostYoutubeAccountId] = useState('');
  const [postInstagramAccountId, setPostInstagramAccountId] = useState('');
  const [autoPost, setAutoPost] = useState(false);

  const [showPlatforms, setShowPlatforms] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFileSeconds(null);
    if (!file) return undefined;
    readVideoDuration(file).then((d) => {
      if (cancelled) return;
      setFileSeconds(d);
      if (d != null && d < MIN_SOURCE_SECONDS) {
        track('SourceTooShort', { props: { seconds: String(Math.round(d)) } });
      }
    });
    return () => { cancelled = true; };
  }, [file]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!acknowledged) return;

    const advanced = {
      targetClips: null,
      clipMinSeconds: null,
      clipMaxSeconds: null,
      autoHook,
      autoHookStyle: 'pill',
      layout,
      subtitleScript,
      metadataScript: subtitleScript,
      sourceStart: null,
      sourceEnd: null,
      postYoutubeAccountId: postYoutubeAccountId ? Number(postYoutubeAccountId) : null,
      postInstagramAccountId: postInstagramAccountId ? Number(postInstagramAccountId) : null,
      autoPost: autoPost || Boolean(postYoutubeAccountId || postInstagramAccountId),
    };

    try {
      localStorage.setItem('clipsnipr_layout', layout);
      localStorage.setItem('clipsnipr_subtitle_script', subtitleScript);
      localStorage.setItem('clipsnipr_auto_hook', autoHook ? '1' : '0');
    } catch { /* ignore */ }

    if (mode === 'url' && url.trim()) {
      onProcess({ type: 'url', payload: url.trim(), acknowledged: true, outputFormat, ...advanced });
    } else if (mode === 'file' && file && !fileTooShort) {
      onProcess({ type: 'file', payload: file, acknowledged: true, outputFormat, ...advanced });
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
      setMode('file');
    }
  };

  const canSubmit = acknowledged && !isProcessing && (
    (mode === 'url' && url.trim().length > 0) ||
    (mode === 'file' && file && !fileTooShort)
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* 1. MEDIA INGEST CARD */}
      <div className="card p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-rule pb-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-brandblue" />
            <span className="text-xs font-mono uppercase tracking-wider font-semibold text-ink">
              Step 1 · Ingest Source Footage
            </span>
          </div>

          {/* Mode Switcher */}
          <div className="flex items-center p-1 bg-paper3 rounded-lg border border-rule text-xs font-medium">
            <button
              type="button"
              onClick={() => setMode('url')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${
                mode === 'url'
                  ? 'bg-paper text-ink shadow-xs font-semibold'
                  : 'text-muted hover:text-ink'
              }`}
            >
              <Link2 size={13} />
              <span>Video URL</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${
                mode === 'file'
                  ? 'bg-paper text-ink shadow-xs font-semibold'
                  : 'text-muted hover:text-ink'
              }`}
            >
              <Upload size={13} />
              <span>Upload File</span>
            </button>
          </div>
        </div>

        {/* URL Ingest Mode */}
        {mode === 'url' && (
          <div className="space-y-2">
            <div className="relative">
              <input
                type="url"
                required={mode === 'url'}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste YouTube, Twitch, TikTok, or video link..."
                className="input-field pr-20 text-sm sm:text-base font-medium"
              />
              {url ? (
                <button
                  type="button"
                  onClick={() => setUrl('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink"
                  title="Clear"
                >
                  <X size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      if (text) setUrl(text);
                    } catch {}
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 px-2.5 py-1 text-xs font-mono font-medium rounded bg-paper border border-rule text-brandblue hover:brightness-110"
                >
                  PASTE
                </button>
              )}
            </div>

            <div className="flex items-center justify-between text-xs text-muted pt-1">
              <span className="flex items-center gap-1.5">
                <Check size={12} className="text-emerald-500" />
                Supports 1080p, 60fps &amp; live VODs
              </span>
              <button
                type="button"
                onClick={() => setShowPlatforms(!showPlatforms)}
                className="hover:text-ink underline transition-colors"
              >
                Supported Platforms ({SUPPORTED_PLATFORMS.length})
              </button>
            </div>

            {showPlatforms && (
              <div className="p-3 bg-paper3 rounded-lg border border-rule text-xs space-y-1 animate-fade">
                <span className="font-semibold text-ink block">Directly supported streaming platforms:</span>
                <p className="text-muted leading-relaxed">
                  {SUPPORTED_PLATFORMS.join(' · ')}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Local File Ingest Mode */}
        {mode === 'file' && (
          <div>
            {file ? (
              <div className="p-4 bg-paper3 rounded-lg border border-rule flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-brandblue/10 text-brandblue flex items-center justify-center shrink-0">
                    <FileVideo size={20} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">{file.name}</p>
                    <p className="text-xs text-muted font-mono">
                      {(file.size / (1024 * 1024)).toFixed(1)} MB
                      {fileSeconds ? ` · ${Math.round(fileSeconds)}s duration` : ''}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setFile(null); setFileSeconds(null); }}
                  className="p-1.5 text-muted hover:text-red-500 rounded transition-colors"
                  title="Remove file"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <label
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                className="border-2 border-dashed border-rule hover:border-brandblue/50 rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition-colors bg-paper3/30 hover:bg-paper3/60 text-center"
              >
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])}
                />
                <div className="w-12 h-12 rounded-full bg-brandblue/10 text-brandblue flex items-center justify-center mb-3">
                  <Upload size={22} />
                </div>
                <p className="text-sm font-semibold text-ink mb-1">Click to select video or drag &amp; drop</p>
                <p className="text-xs text-muted font-mono">MP4, MOV, WEBM up to 500MB (at least {MIN_SOURCE_SECONDS}s)</p>
              </label>
            )}

            {fileTooShort && (
              <p className="text-xs text-red-500 mt-2 font-medium">
                Video is too short ({Math.round(fileSeconds)}s). ClipSnipr requires footage of at least {MIN_SOURCE_SECONDS}s to analyze viral pacing.
              </p>
            )}
          </div>
        )}
      </div>

      {/* 2. FRAMING & LAYOUT STUDIO */}
      <div className="card p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-rule pb-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-sniprorange" />
            <span className="text-xs font-mono uppercase tracking-wider font-semibold text-ink">
              Step 2 · Framing &amp; Visual Layout
            </span>
          </div>
          <span className="text-xs font-mono text-muted">9:16 Vertical Shorts</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {LAYOUT_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const isSelected = layout === opt.id;
            return (
              <div
                key={opt.id}
                onClick={() => setLayout(opt.id)}
                className={`p-4 rounded-xl border cursor-pointer transition-all flex flex-col justify-between ${
                  isSelected
                    ? 'border-brandblue bg-brandblue/5 shadow-xs'
                    : 'border-rule hover:border-rule2 bg-paper3/40'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      <div className={`p-2 rounded-lg ${isSelected ? 'bg-brandblue text-white' : 'bg-paper text-muted'}`}>
                        <Icon size={16} />
                      </div>
                      <span className="font-semibold text-sm text-ink">{opt.title}</span>
                    </div>
                    {isSelected && (
                      <span className="w-2 h-2 rounded-full bg-brandblue" />
                    )}
                  </div>
                  <p className="text-xs text-muted leading-relaxed mb-3">
                    {opt.desc}
                  </p>
                </div>
                <span className="text-[10px] font-mono uppercase font-semibold text-brandblue/80">
                  {opt.badge}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 3. SUBTITLES & AUDIO INTELLIGENCE */}
      <div className="card p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-rule pb-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-xs font-mono uppercase tracking-wider font-semibold text-ink">
              Step 3 · Captions &amp; Subtitle Script
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {SUBTITLE_SCRIPTS.map((s) => {
            const isSelected = subtitleScript === s.id;
            return (
              <button
                type="button"
                key={s.id}
                onClick={() => setSubtitleScript(s.id)}
                className={`p-3 text-left rounded-lg border transition-all ${
                  isSelected
                    ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400 font-semibold'
                    : 'border-rule bg-paper3 text-muted hover:text-ink'
                }`}
              >
                <span className="block text-xs font-semibold text-ink mb-0.5">{s.label}</span>
                <span className="block text-[10.5px] font-mono text-muted leading-tight">{s.desc}</span>
              </button>
            );
          })}
        </div>

        <div className="pt-2 flex items-center justify-between">
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoHook}
              onChange={(e) => setAutoHook(e.target.checked)}
              className="w-4 h-4 accent-sniprorange rounded"
            />
            <span className="text-xs text-ink font-medium">
              Burn punchy 3-second hook overlay on every generated short
            </span>
          </label>
        </div>
      </div>

      {/* 4. AUTO-PUBLISHING DESTINATIONS */}
      {(youtubeAccounts.length > 0 || instagramAccounts.length > 0) && (
        <div className="card p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-rule pb-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-brandblue" />
              <span className="text-xs font-mono uppercase tracking-wider font-semibold text-ink">
                Step 4 · Auto-Publish Destinations (Optional)
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {youtubeAccounts.length > 0 && (
              <div>
                <label className="eyebrow block mb-1.5 flex items-center gap-1.5">
                  <Youtube size={13} className="text-red-500" /> YouTube Shorts Account
                </label>
                <select
                  value={postYoutubeAccountId}
                  onChange={(e) => setPostYoutubeAccountId(e.target.value)}
                  className="input-field text-xs font-medium"
                >
                  <option value="">Don't auto-publish to YouTube</option>
                  {youtubeAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.account_name} ({acc.account_id || 'Linked Channel'})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {instagramAccounts.length > 0 && (
              <div>
                <label className="eyebrow block mb-1.5 flex items-center gap-1.5">
                  <Instagram size={13} className="text-pink-500" /> Instagram Reels Account
                </label>
                <select
                  value={postInstagramAccountId}
                  onChange={(e) => setPostInstagramAccountId(e.target.value)}
                  className="input-field text-xs font-medium"
                >
                  <option value="">Don't auto-publish to Instagram</option>
                  {instagramAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      @{acc.account_name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 5. LAUNCH BAR */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
        <label className="flex items-center gap-2 text-xs text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="w-4 h-4 accent-brandblue rounded"
          />
          <span>I confirm I have rights to clip and process this source material</span>
        </label>

        <button
          type="submit"
          disabled={!canSubmit}
          className="btn-snipr w-full sm:w-auto px-8 py-3 text-sm font-bold shadow-md uppercase tracking-wider flex items-center justify-center gap-2.5"
        >
          {isProcessing ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              <span>Analyzing Video...</span>
            </>
          ) : (
            <>
              <BrandIcon size={18} />
              <span>Snip Viral Clips</span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
