import React, { useState, useEffect } from 'react';
import { Radio, Youtube, Plus, Trash2, Check, Loader2, AlertCircle, RefreshCw, Sparkles, ExternalLink, Play } from 'lucide-react';
import { apiFetch } from '../lib/api';

export default function LiveStreamTab() {
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
              Continuously tracks YouTube and Twitch creators. Automatically captures rolling streams when live, detects peak hype moments, and generates gaming shorts into your Library.
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
                          {mon.status === 'recording' ? 'Recording Stream' : mon.status === 'clipping' ? 'Clipping Peak' : 'LIVE NOW'}
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

                  <div className="flex items-center gap-3">
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
    </div>
  );
}

