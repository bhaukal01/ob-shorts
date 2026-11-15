import React, { useState, useEffect } from 'react';
import { Radio, Youtube, Plus, Trash2, Check, Loader2, AlertCircle, RefreshCw, Sparkles, ExternalLink, Play, Film, FolderOpen, ChevronDown, ChevronUp, X, Download, HardDrive } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { getApiUrl } from '../config';

export default function LiveStreamTab({ onReopenProject }) {
  const [monitors, setMonitors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [channelUrl, setChannelUrl] = useState('');
  const [channelName, setChannelName] = useState('');
  const [layout, setLayout] = useState('gaming');
  const [subtitleScript, setSubtitleScript] = useState('auto');
  const [autoClip, setAutoClip] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Creator streams view & modal
  const [selectedCreator, setSelectedCreator] = useState(null);
  const [creatorStreams, setCreatorStreams] = useState([]);
  const [loadingStreams, setLoadingStreams] = useState(false);
  const [expandedStreamId, setExpandedStreamId] = useState(null);

  // Single active video player modal
  const [activePlayerClip, setActivePlayerClip] = useState(null);

  const fetchMonitors = async () => {
    try {
      const res = await apiFetch('/api/live/monitors');
      if (res.ok) {
        const data = await res.json();
        setMonitors(data.monitors || []);
      }
    } catch (e) {
      console.error('Failed to load live monitors', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMonitors();
    const interval = setInterval(fetchMonitors, 10000);
    return () => clearInterval(interval);
  }, []);

  const openCreatorStreams = async (mon) => {
    setSelectedCreator(mon);
    setLoadingStreams(true);
    setExpandedStreamId(null);
    try {
      const res = await apiFetch(`/api/live/monitors/${mon.id}/streams`);
      if (res.ok) {
        const data = await res.json();
        setCreatorStreams(data.streams || []);
      }
    } catch (e) {
      console.error('Failed to load creator streams', e);
    } finally {
      setLoadingStreams(false);
    }
  };

  const handleAddMonitor = async (e) => {
    e.preventDefault();
    if (!channelUrl.trim()) return;
    setAdding(true);
    setError('');
    setSuccess('');
    try {
      const res = await apiFetch('/api/live/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_url: channelUrl.trim(),
          channel_name: channelName.trim(),
          layout,
          subtitle_script: subtitleScript,
          auto_clip: autoClip ? 1 : 0,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || 'Failed to add monitor');
      }
      setChannelUrl('');
      setChannelName('');
      setSuccess('Channel added to live tracking!');
      await fetchMonitors();
    } catch (err) {
      setError(err.message || 'Failed to add channel');
    } finally {
      setAdding(false);
    }
  };

  const handleToggle = async (id) => {
    try {
      const res = await apiFetch(`/api/live/monitors/${id}/toggle`, { method: 'POST' });
      if (res.ok) {
        await fetchMonitors();
      }
    } catch (e) {
      console.error('Failed to toggle monitor', e);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Remove this channel from live tracking?')) return;
    try {
      const res = await apiFetch(`/api/live/monitors/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setMonitors((prev) => prev.filter((m) => m.id !== id));
      }
    } catch (e) {
      console.error('Failed to delete monitor', e);
    }
  };

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }) : '');

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-fade">
      {/* Header Banner */}
      <div className="card p-6 border-l-4 border-l-red-500">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-full bg-red-500/10 text-red-500">
            <Radio size={24} className="animate-pulse" />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-ink">Live Stream Auto-Clipper</h2>
            <p className="text-sm text-muted mt-0.5">
              Continuously captures rolling 10-minute segments from YouTube and Twitch live streams. Highlights are spotted and clipped into your Library automatically while recording continues without interruption.
            </p>
          </div>
        </div>
      </div>

      {/* Add New Stream Form */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold text-ink uppercase tracking-wider mb-4 flex items-center gap-2">
          <Plus size={16} /> Track New Creator Channel
        </h3>
        <form onSubmit={handleAddMonitor} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="eyebrow block mb-1.5">Channel or Live URL *</label>
              <input
                type="text"
                required
                value={channelUrl}
                onChange={(e) => setChannelUrl(e.target.value)}
                placeholder="https://youtube.com/@creator/live or twitch.tv/channel"
                className="input-field"
              />
            </div>
            <div>
              <label className="eyebrow block mb-1.5">Channel Name (Optional)</label>
              <input
                type="text"
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                placeholder="e.g. Mortal, Shroud, CarryMinati"
                className="input-field"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            <div>
              <label className="eyebrow block mb-1.5">Clipping Layout</label>
              <select
                value={layout}
                onChange={(e) => setLayout(e.target.value)}
                className="input-field"
              >
                <option value="gaming">Gaming (Facecam Top + Gameplay Bottom)</option>
                <option value="auto">Auto Layout</option>
                <option value="screencast">Screen over presenter</option>
                <option value="none">Single Crop</option>
              </select>
            </div>
            <div>
              <label className="eyebrow block mb-1.5">Subtitle Script</label>
              <select
                value={subtitleScript}
                onChange={(e) => setSubtitleScript(e.target.value)}
                className="input-field"
              >
                <option value="auto">Auto (Default)</option>
                <option value="hindi">Hindi (Devanagari - हिंदी)</option>
                <option value="hinglish">Hinglish (Roman Script)</option>
              </select>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <label className="flex items-center gap-2 text-xs text-ink cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoClip}
                  onChange={(e) => setAutoClip(e.target.checked)}
                  className="w-4 h-4 rounded accent-red-500"
                />
                <span>Auto-generate clips when live</span>
              </label>
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-500 flex items-center gap-1.5 pt-1">
              <AlertCircle size={14} /> {error}
            </p>
          )}
          {success && (
            <p className="text-xs text-emerald-500 flex items-center gap-1.5 pt-1">
              <Check size={14} /> {success}
            </p>
          )}

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={adding || !channelUrl.trim()}
              className="btn-primary !bg-red-600 hover:!bg-red-700 flex items-center gap-2"
            >
              {adding ? <Loader2 size={16} className="animate-spin" /> : <Radio size={16} />}
              Start Tracking Stream
            </button>
          </div>
        </form>
      </div>

      {/* Monitored Channels List */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-ink uppercase tracking-wider flex items-center gap-2">
            Monitored Live Channels ({monitors.length})
          </h3>
          <button
            onClick={fetchMonitors}
            className="text-xs text-muted hover:text-ink flex items-center gap-1"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        {loading ? (
          <div className="py-12 flex justify-center text-muted">
            <Loader2 size={24} className="animate-spin" />
          </div>
        ) : monitors.length === 0 ? (
          <div className="text-center py-10 text-muted space-y-2">
            <Radio size={36} className="mx-auto opacity-30" />
            <p className="text-sm">No live streams are currently being tracked.</p>
            <p className="text-xs text-muted/70">Add a YouTube or Twitch channel above to begin automated live moment clipping.</p>
          </div>
        ) : (
          <div className="divide-y divide-rule">
            {monitors.map((mon) => {
              const isLive = mon.status === 'live' || mon.status === 'recording' || mon.status === 'clipping';
              return (
                <div key={mon.id} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5">
                      {isLive ? (
                        <span className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider rounded-full bg-red-500/15 text-red-500 animate-pulse">
                          <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                          {mon.status === 'recording' ? 'Recording Stream (10m)' : mon.status === 'clipping' ? 'Clipping Highlight' : 'LIVE NOW'}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider rounded-full bg-muted/15 text-muted">
                          Offline
                        </span>
                      )}
                      <h4 className="font-semibold text-sm text-ink flex items-center gap-1.5">
                        {mon.channel_name || mon.channel_url}
                      </h4>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                      <a
                        href={mon.channel_url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-ink2 flex items-center gap-1 underline underline-offset-2"
                      >
                        {mon.platform === 'twitch' ? 'Twitch' : 'YouTube'} Channel <ExternalLink size={11} />
                      </a>
                      <span>•</span>
                      <span>Layout: <strong className="text-ink2">{mon.layout || 'gaming'}</strong></span>
                      <span>•</span>
                      <span>Script: <strong className="text-ink2">{mon.subtitle_script || 'auto'}</strong></span>
                      {mon.last_checked && (
                        <>
                          <span>•</span>
                          <span>Checked: {new Date(mon.last_checked).toLocaleTimeString()}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 flex-wrap">
                    {/* View Creator Streams Button */}
                    <button
                      onClick={() => openCreatorStreams(mon)}
                      className="text-xs px-3 py-1.5 rounded font-medium border border-rule hover:border-rule2 hover:text-ink text-muted flex items-center gap-1.5 transition-colors bg-surface"
                      title="View streams and generated clips from this creator"
                    >
                      <Film size={13} className="text-brass" />
                      <span>Streams</span>
                    </button>

                    <button
                      onClick={() => handleToggle(mon.id)}
                      className={`text-xs px-3 py-1.5 rounded font-medium border transition-colors ${
                        mon.auto_clip
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          : 'bg-muted/10 border-rule text-muted'
                      }`}
                    >
                      {mon.auto_clip ? 'Auto-Clip: Active' : 'Auto-Clip: Paused'}
                    </button>
                    <button
                      onClick={() => handleDelete(mon.id)}
                      className="p-1.5 text-muted hover:text-red-400 transition-colors rounded hover:bg-red-500/10"
                      title="Remove channel"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* MODAL: Creator Streams & Clips Explorer */}
      {selectedCreator && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/75 backdrop-blur-xs animate-fade">
          <div
            className="card max-w-3xl w-full max-h-[88vh] flex flex-col overflow-hidden border-rule shadow-2xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="p-4 sm:p-5 border-b border-rule flex items-center justify-between bg-paper2 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-md bg-brass/10 text-brass">
                  <Film size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-ink">
                    Streams &amp; Clips: {selectedCreator.channel_name || selectedCreator.channel_url}
                  </h3>
                  <p className="text-xs text-muted">
                    {selectedCreator.platform === 'twitch' ? 'Twitch' : 'YouTube'} Channel Streams
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedCreator(null)}
                className="p-1.5 text-muted hover:text-ink rounded hover:bg-paper3 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Body: Streams List */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 custom-scrollbar space-y-4">
              {loadingStreams ? (
                <div className="py-16 flex flex-col items-center justify-center gap-2 text-muted">
                  <Loader2 size={24} className="animate-spin text-brass" />
                  <span className="text-xs font-mono">Fetching creator streams…</span>
                </div>
              ) : creatorStreams.length === 0 ? (
                <div className="text-center py-12 text-muted space-y-2">
                  <Film size={32} className="mx-auto opacity-40" />
                  <p className="text-sm">No recorded stream sessions found for this creator yet.</p>
                  <p className="text-xs text-muted/70">
                    When this creator goes live, 10-minute segments will be recorded and clips will show here.
                  </p>
                </div>
              ) : (
                creatorStreams.map((st) => {
                  const isExp = expandedStreamId === st.job_id;
                  const isLive = st.status === 'processing';
                  return (
                    <div
                      key={st.job_id}
                      className={`border rounded-lg overflow-hidden transition-all ${
                        isExp ? 'border-brass/50 bg-paper2/50' : 'border-rule bg-paper hover:border-rule2'
                      }`}
                    >
                      {/* Stream Item Header */}
                      <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <h4 className="font-semibold text-sm text-ink truncate" title={st.title}>
                              {st.title}
                            </h4>
                            {isLive ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-red-500/20 text-red-400 font-semibold shrink-0 flex items-center gap-1 animate-pulse">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
                                Live Now
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-muted/20 text-muted font-medium shrink-0">
                                Completed
                              </span>
                            )}
                            <span className="text-[10px] font-mono px-2 py-0.5 bg-paper3 border border-rule rounded text-muted">
                              {st.clip_count} {st.clip_count === 1 ? 'clip' : 'clips'}
                            </span>
                          </div>
                          <p className="text-xs text-muted font-mono">
                            {fmtDate(st.created_at)}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {onReopenProject && (
                            <button
                              onClick={() => {
                                setSelectedCreator(null);
                                onReopenProject(st.job_id, st.status);
                              }}
                              className="btn-primary py-1.5 px-3 text-xs flex items-center gap-1.5"
                              title="Open stream in Generator workspace"
                            >
                              <FolderOpen size={13} /> Open Project
                            </button>
                          )}
                          <button
                            onClick={() => setExpandedStreamId(isExp ? null : st.job_id)}
                            className="btn-ghost py-1.5 px-3 text-xs border border-rule flex items-center gap-1"
                          >
                            <span>Clips</span>
                            {isExp ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                          </button>
                        </div>
                      </div>

                      {/* Stream Clips Drawer */}
                      {isExp && (
                        <div className="border-t border-rule bg-paper3/30 p-4 animate-fade">
                          {st.clips?.length === 0 ? (
                            <p className="text-xs text-muted text-center py-3">
                              No clips extracted from this stream session yet.
                            </p>
                          ) : (
                            <div className="space-y-3">
                              <div className="flex items-center justify-between text-xs text-muted font-mono">
                                <span className="flex items-center gap-1.5 text-brass">
                                  <HardDrive size={12} /> S3 Direct Playback
                                </span>
                                <span>{st.clips.length} shorts</span>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {st.clips.map((clip) => (
                                  <div
                                    key={clip.index}
                                    className="p-3 bg-paper border border-rule rounded-input flex flex-col justify-between hover:border-brass/40 transition-colors"
                                  >
                                    <div>
                                      <p className="text-xs font-semibold text-ink line-clamp-2 mb-1" title={clip.title}>
                                        {clip.title}
                                      </p>
                                      <p className="text-[10px] text-muted font-mono mb-2">
                                        Duration: {Math.round(clip.duration)}s
                                      </p>
                                    </div>
                                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-rule/50">
                                      <button
                                        onClick={() => setActivePlayerClip(clip)}
                                        className="btn-ghost py-1 px-2.5 text-[11px] text-brass hover:text-ink flex items-center gap-1 font-mono"
                                      >
                                        <Play size={11} /> Play Short
                                      </button>
                                      <a
                                        href={clip.stream_url ? clip.stream_url : getApiUrl(clip.video_url)}
                                        download
                                        target="_blank"
                                        rel="noreferrer"
                                        className="p-1 text-muted hover:text-ink rounded"
                                        title="Download Short"
                                      >
                                        <Download size={13} />
                                      </a>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* SINGLE INSTANCE VIDEO PLAYER MODAL */}
      {activePlayerClip && (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-ink/80 backdrop-blur-xs animate-fade"
          onClick={() => setActivePlayerClip(null)}
        >
          <div
            className="card max-w-sm w-full p-4 flex flex-col gap-3 border-rule shadow-2xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-muted flex items-center gap-1.5">
                <HardDrive size={12} className="text-brass" /> Direct Stream
              </span>
              <button
                onClick={() => setActivePlayerClip(null)}
                className="p-1 text-muted hover:text-ink rounded"
              >
                <X size={16} />
              </button>
            </div>

            <div className="relative aspect-[9/16] bg-black rounded-lg overflow-hidden flex items-center justify-center">
              <video
                src={activePlayerClip.stream_url ? activePlayerClip.stream_url : getApiUrl(activePlayerClip.video_url)}
                controls
                autoPlay
                playsInline
                className="w-full h-full object-contain"
              />
            </div>

            <div>
              <p className="text-xs font-semibold text-ink line-clamp-2">
                {activePlayerClip.title}
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-1 border-t border-rule">
              <a
                href={activePlayerClip.stream_url ? activePlayerClip.stream_url : getApiUrl(activePlayerClip.video_url)}
                download
                target="_blank"
                rel="noreferrer"
                className="btn-primary py-1.5 px-3 text-xs flex items-center gap-1.5"
              >
                <Download size={13} /> Download Video
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
