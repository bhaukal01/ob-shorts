import React from 'react';
import { Check, AlertCircle, Loader2 } from 'lucide-react';

/**
 * Uniform Tag & Mark Component across Settings and entire ClipSnipr interface.
 * Standardizes typography (JetBrains Mono 11px), dimensions, padding, and state indicators.
 */
export default function StatusTag({ status, label, className = '' }) {
  const norm = (status || '').toLowerCase().trim();

  if (norm === 'connected' || norm === 'verified' || norm === 'saved') {
    return (
      <span className={`tag-uniform tag-connected ${className}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
        {label || (norm === 'saved' ? 'Saved to Database' : 'Connected')}
      </span>
    );
  }

  if (norm === 'active') {
    return (
      <span className={`tag-uniform tag-active ${className}`}>
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500" />
        </span>
        {label || 'Active'}
      </span>
    );
  }

  if (norm === 'live' || norm === 'recording') {
    return (
      <span className={`tag-uniform tag-recording ${className}`}>
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
        </span>
        {label || (norm === 'live' ? 'Live Stream' : 'Recording')}
      </span>
    );
  }

  if (norm === 'loading' || norm === 'saving') {
    return (
      <span className={`tag-uniform tag-inactive text-sky-400 ${className}`}>
        <Loader2 size={11} className="animate-spin shrink-0" />
        {label || (norm === 'saving' ? 'Saving...' : 'Connecting...')}
      </span>
    );
  }

  if (norm === 'error' || norm === 'failed') {
    return (
      <span className={`tag-uniform tag-recording ${className}`}>
        <AlertCircle size={11} className="shrink-0" />
        {label || 'Error'}
      </span>
    );
  }

  // Fallback: Disconnected / Inactive / Not Configured
  return (
    <span className={`tag-uniform tag-disconnected ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 dark:bg-neutral-600 shrink-0" />
      {label || 'Not Connected'}
    </span>
  );
}
