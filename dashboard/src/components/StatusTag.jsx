import React from 'react';
import { Check, AlertCircle, Loader2 } from 'lucide-react';

/**
 * Uniform Tag & Mark Component across Settings and entire ClipSnipr interface.
 * Clean 4-Color system:
 * - Green: Connected, Verified, Saved, Complete
 * - Blue: Active, Ingest, Processing, Stream
 * - Red: Live broadcast, Recording, Error
 * - White: Neutral, Default, Version
 */
export default function StatusTag({ status, label, className = '' }) {
  const norm = (status || '').toLowerCase().trim();

  // GREEN: Connected, Verified, Saved, Complete
  if (norm === 'connected' || norm === 'verified' || norm === 'saved' || norm === 'complete' || norm === 'green') {
    return (
      <span className={`tag-uniform tag-green ${className}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
        {label || (norm === 'saved' ? 'Saved to Database' : 'Connected')}
      </span>
    );
  }

  // BLUE: Active, Selected, Processing
  if (norm === 'active' || norm === 'processing' || norm === 'blue') {
    return (
      <span className={`tag-uniform tag-blue ${className}`}>
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-400" />
        </span>
        {label || 'Active Engine'}
      </span>
    );
  }

  // RED: Live broadcast, Recording, Danger
  if (norm === 'live' || norm === 'recording' || norm === 'red') {
    return (
      <span className={`tag-uniform tag-red ${className}`}>
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
        </span>
        {label || (norm === 'live' ? 'Live Stream' : 'Recording')}
      </span>
    );
  }

  // RED: Error
  if (norm === 'error' || norm === 'failed') {
    return (
      <span className={`tag-uniform tag-red ${className}`}>
        <AlertCircle size={11} className="shrink-0 text-red-400" />
        {label || 'Error'}
      </span>
    );
  }

  // WHITE / NEUTRAL: Default, Inactive
  if (norm === 'white' || norm === 'neutral') {
    return (
      <span className={`tag-uniform tag-white ${className}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-white shrink-0" />
        {label || 'Ready'}
      </span>
    );
  }

  if (norm === 'loading' || norm === 'saving') {
    return (
      <span className={`tag-uniform tag-blue ${className}`}>
        <Loader2 size={11} className="animate-spin shrink-0 text-sky-400" />
        {label || (norm === 'saving' ? 'Saving...' : 'Connecting...')}
      </span>
    );
  }

  // Fallback: Disconnected
  return (
    <span className={`tag-uniform tag-disconnected ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 dark:bg-neutral-600 shrink-0" />
      {label || 'Not Connected'}
    </span>
  );
}
