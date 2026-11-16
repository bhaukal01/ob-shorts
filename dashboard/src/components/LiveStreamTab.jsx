import React, { useState, useEffect } from 'react';
import { Radio, Youtube, Plus, Trash2, Check, Loader2, AlertCircle, RefreshCw, Sparkles, ExternalLink, Play, Film, FolderOpen, ChevronDown, ChevronUp, X, Download, HardDrive } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { getApiUrl } from '../config';

export default function LiveStreamTab({ onReopenProject, youtubeAccounts: propYtAccounts, instagramAccounts: propIgAccounts }) {
  const [monitors, setMonitors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [channelUrl, setChannelUrl] = useState('');
  const [channelName, setChannelName] = useState('');
  const [layout, setLayout] = useState('gaming');
  const [subtitleScript, setSubtitleScript] = useState('auto');
  const [autoClip, setAutoClip] = useState(true);
  const [monitorMode, setMonitorMode] = useState('both');
  const [targetYoutubeAccountId, setTargetYoutubeAccountId] = useState('');
  const [targetInstagramAccountId, setTargetInstagramAccountId] = useState('');
  const [autoPost, setAutoPost] = useState(true);
  const [socialAccounts, setSocialAccounts] = useState({ youtube: [], instagram: [] });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Creator streams view & modal
  const [selectedCreator, setSelectedCreator] = useState(null);
  const [creatorStreams, setCreatorStreams] = useState([]);
  const [loadingStreams, setLoadingStreams] = useState(false);
  const [expandedStreamId, setExpandedStreamId] = useState(null);

  // Single active video player modal
  const [activePlayerClip, setActivePlayerClip] = useState(null);

  const fetchAccounts = async () => {
    try {
      const res = await apiFetch('/api/publish/accounts');
      if (res.ok) {
        const data = await res.json();
        const accs = data.accounts || [];
        setSocialAccounts({
          youtube: accs.filter((a) => a.platform === 'youtube'),
          instagram: accs.filter((a) => a.platform === 'instagram'),
        });
      }
    } catch (e) {
      console.error('Failed to load social accounts', e);
    }
  };

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
    fetchAccounts();
    const interval = setInterval(fetchMonitors, 10000);
    return () => clearInterval(interval);
  }, []);

  const ytAccounts = propYtAccounts?.length ? propYtAccounts : socialAccounts.youtube;
  const igAccounts = propIgAccounts?.length ? propIgAccounts : socialAccounts.instagram;

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
          monitor_mode: monitorMode,
          target_youtube_account_id: targetYoutubeAccountId ? Number(targetYoutubeAccountId) : null,
          target_instagram_account_id: targetInstagramAccountId ? Number(targetInstagramAccountId) : null,
          auto_post: autoPost ? 1 : 0,
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
            <h2 className="text-xl font-bold tracking-tight text-ink">Creator Monitor &amp; Auto-Clipper</h2>
            <p className="text-sm text-muted mt-0.5">
              Continuously track creators for both live streams (rolling 10-minute segments) and new uploaded videos. Generated highlights are sequentially auto-published directly to your designated YouTube Shorts and Instagram Reels accounts.
            </p>
          </div>
        </div>
      </div>

      {/* Add New Stream Form */}
      <div className="card p-6 border-l-4 border-l-red-500">
        <h3 className="text-sm font-semibold text-ink uppercase tracking-wider mb-4 flex items-center gap-2">
          <Plus size={16} className="text-red-500" /> Track New Creator Channel
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
              <label className="eyebrow block mb-1.5">Monitor Mode</label>
              <select
                value={monitorMode}
                onChange={(e) => setMonitorMode(e.target.value)}
                className="input-field"
              >
                <option value="both">Both (Live Streams &amp; Uploaded Videos)</option>
                <option value="stream">Live Streams Only</option>
                <option value="video">New Uploaded Videos Only</option>
              </select>
            </div>
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
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-rule/50">
            <div>
              <label className="eyebrow block mb-1.5">Auto-Post to YouTube Channel</label>
              <select
                value={targetYoutubeAccountId}
                onChange={(e) => setTargetYoutubeAccountId(e.target.value)}
                className="input-field"
              >
                <option value="">-- No Auto-Post to YouTube --</option>
                {ytAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.account_name || `Account #${acc.id}`} {acc.account_id ? `(${acc.account_id})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="eyebrow block mb-1.5">Auto-Post to Instagram Account</label>
              <select
                value={targetInstagramAccountId}
                onChange={(e) => setTargetInstagramAccountId(e.target.value)}
                className="input-field"
              >
                <option value="">-- No Auto-Post to Instagram --</option>
                {igAccounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.account_name ? `@${acc.account_name}` : `Account #${acc.id}`}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 pt-2">
            <label className="flex items-center gap-2 text-xs text-ink cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoClip}
                onChange={(e) => setAutoClip(e.target.checked)}
                className="w-4 h-4 rounded accent-red-500"
              />
              <span>Auto-generate clips from detected content</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoPost}
                onChange={(e) => setAutoPost(e.target.checked)}
                className="w-4 h-4 rounded accent-emerald-500"
              />
              <span>Auto-post clips sequentially to selected accounts</span>
            </label>
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
              className="btn-red px-6 py-2.5 text-xs font-bold uppercase tracking-wider flex items-center gap-2 shadow-md hover:brightness-110"
            >
              {adding ? <Loader2 size={16} className="animate-spin text-white" /> : <Radio size={16} className="text-white" />}
              <span className="text-white">Start Tracking Stream</span>
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
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-paper3 border border-rule font-mono text-ink2 uppercase">
                        {mon.monitor_mode === 'video' ? 'Videos' : mon.monitor_mode === 'stream' ? 'Streams' : 'Stream & Video'}
                      </span>
                      <span>•</span>
                      <span>Layout: <strong className="text-ink2">{mon.layout || 'gaming'}</strong></span>
                      <span>•</span>
                      <span>Script: <strong className="text-ink2">{mon.subtitle_script || 'auto'}</strong></span>
                      {mon.auto_post ? (
                        <>
                          <span>•</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono">
                            Auto-Post ON
                          </span>
                        </>
                      ) : null}
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
                      className="text-xs px-3 py-1.5 rounded font-semibold border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 flex items-center gap-1.5 transition-colors"
                      title="View streams and generated clips from this creator"
                    >
                      <Film size={13} className="text-sky-400" />
                      <span>Streams &amp; Clips</span>
                    </button>

                    <button
                      onClick={() => handleToggle(mon.id)}
                      className={`text-xs px-3 py-1.5 rounded font-semibold border transition-colors ${
                        mon.auto_clip
                          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
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
                <div className="p-2 rounded-md bg-sky-500/15 text-sky-400">
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
                  <Loader2 size={24} className="animate-spin text-sky-400" />
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
                        isExp ? 'border-sky-500/50 bg-paper2/50' : 'border-rule bg-paper hover:border-rule2'
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
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-emerald-500/15 text-emerald-400 font-semibold shrink-0">
                                Completed
                              </span>
                            )}
                            <span className="text-[10px] font-mono px-2 py-0.5 bg-paper3 border border-rule rounded text-ink2">
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
                              className="btn-green py-1.5 px-3 text-xs flex items-center gap-1.5 text-white font-bold shadow-xs hover:brightness-105"
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
                                <span className="flex items-center gap-1.5 text-sky-400">
                                  <HardDrive size={12} /> S3 Direct Playback
                                </span>
                                <span>{st.clips.length} shorts</span>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {st.clips.map((clip) => (
                                  <div
                                    key={clip.index}
                                    className="p-3 bg-paper border border-rule rounded-input flex flex-col justify-between hover:border-sky-500/40 transition-colors"
                                  >
                                    <div>
                                      <p className="text-xs font-semibold text-ink line-clamp-2 mb-1" title={clip.title}>
                                        {clip.title}
                                      </p>
                                      <p className="text-[10px] text-muted font-mono mb-2">
                                        Duration: {Math.round(clip.duration)}s
                                      </p>
                                      {clip.published_posts && clip.published_posts.length > 0 && (
                                        <div className="flex flex-wrap gap-1.5 mb-2">
                                          {clip.published_posts.map((post, pIdx) => (
                                            <a
                                              key={pIdx}
                                              href={post.url}
                                              target="_blank"
                                              rel="noreferrer"
                                              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-medium rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                                              title={`Posted to ${post.platform === 'youtube' ? 'YouTube Shorts' : 'Instagram Reels'}${post.account_name ? ` (${post.account_name})` : ''}`}
                                            >
                                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                                              <span>Posted ({post.platform === 'youtube' ? 'YouTube' : 'Instagram'})</span>
                                              <ExternalLink size={10} />
                                            </a>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-rule/50">
                                      <button
                                        onClick={() => setActivePlayerClip(clip)}
                                        className="btn-ghost py-1 px-2.5 text-[11px] text-sky-400 hover:text-ink flex items-center gap-1 font-mono"
                                      >
                                        <Play size={11} /> Play Short
                                      </button>
                                      <a
                                        href={clip.stream_url ? clip.stream_url : getApiUrl(clip.video_url)}
                                        download
                                        target="_blank"
                                        rel="noreferrer"
                                        className="p-1 text-muted hover:text-red-400 rounded transition-colors"
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
                <HardDrive size={12} className="text-sky-400" /> Direct Stream
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
                className="btn-red py-1.5 px-3 text-xs flex items-center gap-1.5 text-white font-bold shadow-xs hover:brightness-105"
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
