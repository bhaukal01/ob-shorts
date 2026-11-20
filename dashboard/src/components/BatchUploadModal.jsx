import React, { useState, useEffect } from 'react';
import { 
  Share2, Youtube, Instagram, Loader2, Play, Pause, XCircle, AlertCircle, 
  CheckCircle2, Clock, ShieldCheck, ChevronDown, ChevronUp, Terminal, ExternalLink 
} from 'lucide-react';
import Modal from './ui/Modal';
import { apiFetch } from '../lib/api';

export default function BatchUploadModal({ isOpen, onClose, project, batchState, onBatchUpdated }) {
  const [accounts, setAccounts] = useState({ youtube: [], instagram: [] });
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [selectedYt, setSelectedYt] = useState('');
  const [selectedIg, setSelectedIg] = useState('');
  const [privacyStatus, setPrivacyStatus] = useState('public');
  const [delaySeconds, setDelaySeconds] = useState(300); // 5 minutes default
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [showLogs, setShowLogs] = useState(false);

  // Load connected social accounts
  useEffect(() => {
    if (!isOpen) return;
    setLoadingAccounts(true);
    setActionError('');
    apiFetch('/api/publish/accounts')
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const accs = data.accounts || [];
          const yts = accs.filter((a) => a.platform === 'youtube');
          const igs = accs.filter((a) => a.platform === 'instagram');
          setAccounts({ youtube: yts, instagram: igs });
          if (yts.length > 0 && !selectedYt) setSelectedYt(String(yts[0].id));
          if (igs.length > 0 && !selectedIg) setSelectedIg(String(igs[0].id));
        }
      })
      .catch((e) => console.error('Failed to load publish accounts', e))
      .finally(() => setLoadingAccounts(false));
  }, [isOpen]);

  if (!isOpen || !project) return null;

  const currentBatch = batchState;
  const isRunning = currentBatch && ['running', 'waiting_interval', 'rate_limited'].includes(currentBatch.status);
  const isPaused = currentBatch && currentBatch.status === 'paused';
  const isCompleted = currentBatch && currentBatch.status === 'completed';

  const formatRemaining = (secs) => {
    if (!secs || secs <= 0) return '00:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const handleStart = async () => {
    if (!selectedYt && !selectedIg) {
      setActionError('Please select at least one connected social account to publish to.');
      return;
    }
    setStarting(true);
    setActionError('');
    try {
      const res = await apiFetch('/api/publish/batch/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: project.job_id,
          youtube_account_id: selectedYt ? parseInt(selectedYt, 10) : null,
          instagram_account_id: selectedIg ? parseInt(selectedIg, 10) : null,
          privacy_status: privacyStatus,
          delay_seconds: parseInt(delaySeconds, 10) || 300,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to start batch upload.');
      }
      const data = await res.json();
      if (onBatchUpdated) onBatchUpdated(data.batch);
    } catch (e) {
      setActionError(e.message || 'Error starting batch upload.');
    } finally {
      setStarting(false);
    }
  };

  const handlePause = async () => {
    try {
      await apiFetch(`/api/publish/batch/${encodeURIComponent(project.job_id)}/pause`, { method: 'POST' });
      if (onBatchUpdated) onBatchUpdated({ ...currentBatch, status: 'paused' });
    } catch (e) {
      console.error(e);
    }
  };

  const handleResume = async () => {
    try {
      await apiFetch(`/api/publish/batch/${encodeURIComponent(project.job_id)}/resume`, { method: 'POST' });
      if (onBatchUpdated) onBatchUpdated({ ...currentBatch, status: 'running' });
    } catch (e) {
      console.error(e);
    }
  };

  const handleCancel = async () => {
    if (!window.confirm('Are you sure you want to cancel this batch upload? Any remaining clips will not be uploaded.')) return;
    try {
      await apiFetch(`/api/publish/batch/${encodeURIComponent(project.job_id)}/cancel`, { method: 'POST' });
      if (onBatchUpdated) onBatchUpdated({ ...currentBatch, status: 'cancelled' });
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      eyebrow="BATCH AUTO-POSTING ENGINE"
      title="Upload Complete Project"
      size="lg"
    >
      <div className="space-y-5 animate-fade">
        {/* Project Target Info */}
        <div className="p-3.5 bg-paper rounded-xl border border-rule flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted font-bold block mb-0.5">Project</span>
            <p className="text-sm font-semibold text-ink truncate" title={project.title}>
              {project.title}
            </p>
          </div>
          <span className="tag-uniform tag-green text-xs font-mono font-bold shrink-0">
            {project.clip_count || 'All'} Clips Total
          </span>
        </div>

        {/* Feature Highlights Banner */}
        <div className="p-3.5 bg-brandblue/10 border border-brandblue/30 rounded-xl space-y-2 text-xs">
          <div className="flex items-center gap-2 font-semibold text-brandblue">
            <ShieldCheck size={16} />
            <span>Automated Cooldown &amp; Rate-Limit Protection</span>
          </div>
          <ul className="text-ink2 space-y-1.5 text-[11px] leading-relaxed">
            <li className="flex items-start gap-1.5">
              <span className="text-brandblue font-bold">•</span>
              <span><strong>1 clip every 5 minutes:</strong> Cooldown delay between uploads prevents platform anti-spam rate limits.</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-brandblue font-bold">•</span>
              <span><strong>Automatic Pause &amp; Retry:</strong> If YouTube quota (10k units) or upload limits are hit, the queue pauses automatically and retries without failing clips.</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-brandblue font-bold">•</span>
              <span><strong>Runs in background:</strong> Executes on the server — feel free to close this browser window at any time.</span>
            </li>
          </ul>
        </div>

        {actionError && (
          <div className="p-3 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs flex items-center gap-2">
            <AlertCircle size={15} className="shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        {/* ACTIVE BATCH STATE DISPLAY */}
        {currentBatch && currentBatch.status !== 'pending' && (
          <div className="p-4 bg-paper rounded-xl border border-rule space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-ink uppercase tracking-wider flex items-center gap-1.5">
                <Clock size={13} className="text-brass" /> Batch Progress
              </span>
              {/* Dynamic Status Tag */}
              {currentBatch.status === 'running' && (
                <span className="tag-uniform bg-brandblue/20 text-brandblue border-brandblue/30 text-xs py-0.5 px-2 flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin" /> Uploading Clip #{currentBatch.current_clip_index + 1}
                </span>
              )}
              {currentBatch.status === 'waiting_interval' && (
                <span className="tag-uniform bg-cyan-500/20 text-cyan-400 border-cyan-500/30 text-xs py-0.5 px-2 flex items-center gap-1.5 font-mono">
                  <Clock size={11} /> Next Clip in {formatRemaining(currentBatch.remaining_seconds)}
                </span>
              )}
              {currentBatch.status === 'rate_limited' && (
                <span className="tag-uniform bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs py-0.5 px-2 flex items-center gap-1.5 font-mono">
                  <AlertCircle size={11} /> Paused (Rate Limit) · Retry in {formatRemaining(currentBatch.remaining_seconds)}
                </span>
              )}
              {currentBatch.status === 'paused' && (
                <span className="tag-uniform bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-xs py-0.5 px-2">
                  Paused by User
                </span>
              )}
              {currentBatch.status === 'completed' && (
                <span className="tag-uniform bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs py-0.5 px-2 flex items-center gap-1.5">
                  <CheckCircle2 size={11} /> All Clips Completed
                </span>
              )}
              {currentBatch.status === 'cancelled' && (
                <span className="tag-uniform bg-red-500/20 text-red-400 border-red-500/30 text-xs py-0.5 px-2">
                  Cancelled
                </span>
              )}
            </div>

            {/* Progress Bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono text-muted">
                <span>Clips Uploaded: {currentBatch.uploaded_clips} / {currentBatch.total_clips}</span>
                <span>{currentBatch.total_clips > 0 ? Math.round((currentBatch.uploaded_clips / currentBatch.total_clips) * 100) : 0}%</span>
              </div>
              <div className="w-full bg-paper3 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-brandblue h-full transition-all duration-500"
                  style={{ width: `${currentBatch.total_clips > 0 ? (currentBatch.uploaded_clips / currentBatch.total_clips) * 100 : 0}%` }}
                />
              </div>
            </div>

            {/* Live Message & Controls */}
            <div className="pt-2 flex items-center justify-between gap-2 border-t border-rule/50">
              <div className="flex items-center gap-2">
                {isRunning && (
                  <button
                    onClick={handlePause}
                    className="btn-ghost py-1.5 px-3 text-xs flex items-center gap-1.5 border border-rule text-ink"
                    title="Pause batch upload queue"
                  >
                    <Pause size={12} /> Pause Queue
                  </button>
                )}
                {isPaused && (
                  <button
                    onClick={handleResume}
                    className="btn-primary py-1.5 px-3 text-xs flex items-center gap-1.5"
                    title="Resume batch upload queue"
                  >
                    <Play size={12} /> Resume Queue
                  </button>
                )}
                {(isRunning || isPaused) && (
                  <button
                    onClick={handleCancel}
                    className="btn-ghost text-red-400 hover:bg-red-500/10 py-1.5 px-3 text-xs flex items-center gap-1.5"
                    title="Cancel remaining uploads"
                  >
                    <XCircle size={12} /> Cancel
                  </button>
                )}
              </div>

              {/* Toggle Live Logs */}
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="text-xs text-muted hover:text-ink flex items-center gap-1"
              >
                <Terminal size={12} />
                <span>Logs ({currentBatch.logs?.length || 0})</span>
                {showLogs ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            </div>

            {/* Logs Viewer */}
            {showLogs && (
              <div className="mt-2 bg-black/80 rounded-lg p-3 font-mono text-[11px] text-muted max-h-48 overflow-y-auto custom-scrollbar space-y-1">
                {currentBatch.logs && currentBatch.logs.length > 0 ? (
                  currentBatch.logs.map((lg, i) => (
                    <div key={i} className="text-ink2 leading-tight">
                      <span className="text-white/40">{lg.time ? new Date(lg.time).toLocaleTimeString() : ''}:</span> {lg.message}
                    </div>
                  ))
                ) : (
                  <div className="text-muted/60">No activity logged yet.</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* CONFIGURATION & LAUNCH (Enabled if not already running) */}
        {!isRunning && !isPaused && (
          <div className="space-y-4 pt-1">
            {/* Account Selection */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* YouTube Account */}
              <div className="p-3 bg-paper rounded-xl border border-rule space-y-2">
                <label className="text-xs font-semibold text-ink flex items-center gap-1.5">
                  <Youtube size={14} className="text-red-500" /> YouTube Shorts Account
                </label>
                {accounts.youtube.length > 0 ? (
                  <select
                    value={selectedYt}
                    onChange={(e) => setSelectedYt(e.target.value)}
                    className="w-full bg-paper3 border border-rule rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brandblue outline-none"
                  >
                    <option value="">Don't post to YouTube</option>
                    {accounts.youtube.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.account_name || `YouTube Account #${acc.id}`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-[11px] text-muted">
                    No YouTube account linked. Link one in Settings &amp; Accounts.
                  </p>
                )}
              </div>

              {/* Instagram Account */}
              <div className="p-3 bg-paper rounded-xl border border-rule space-y-2">
                <label className="text-xs font-semibold text-ink flex items-center gap-1.5">
                  <Instagram size={14} className="text-pink-500" /> Instagram Reels Account
                </label>
                {accounts.instagram.length > 0 ? (
                  <select
                    value={selectedIg}
                    onChange={(e) => setSelectedIg(e.target.value)}
                    className="w-full bg-paper3 border border-rule rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brandblue outline-none"
                  >
                    <option value="">Don't post to Instagram</option>
                    {accounts.instagram.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.account_name || `Instagram Account #${acc.id}`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-[11px] text-muted">
                    No Instagram account linked. Link one in Settings &amp; Accounts.
                  </p>
                )}
              </div>
            </div>

            {/* Privacy & Timing Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-ink2">YouTube Privacy Status</label>
                <select
                  value={privacyStatus}
                  onChange={(e) => setPrivacyStatus(e.target.value)}
                  className="w-full bg-paper border border-rule rounded-lg px-3 py-2 text-xs text-ink focus:border-brandblue outline-none"
                >
                  <option value="public">Public (Recommended)</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-ink2">Upload Cooldown Interval</label>
                <select
                  value={delaySeconds}
                  onChange={(e) => setDelaySeconds(parseInt(e.target.value, 10))}
                  className="w-full bg-paper border border-rule rounded-lg px-3 py-2 text-xs text-ink focus:border-brandblue outline-none font-mono"
                >
                  <option value={300}>5 Minutes (Default &amp; Recommended)</option>
                  <option value={600}>10 Minutes</option>
                  <option value={900}>15 Minutes</option>
                  <option value={1800}>30 Minutes</option>
                </select>
              </div>
            </div>

            {/* Primary Submit Button */}
            <div className="pt-2">
              <button
                onClick={handleStart}
                disabled={starting || (!selectedYt && !selectedIg)}
                className="w-full btn-green py-3 px-4 text-xs font-bold text-white flex items-center justify-center gap-2 rounded-xl shadow-xs hover:brightness-105 disabled:opacity-50"
              >
                {starting ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    <span>Initiating Batch Upload…</span>
                  </>
                ) : (
                  <>
                    <Share2 size={15} />
                    <span>Start Project Upload (1 Clip / 5 Mins)</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
