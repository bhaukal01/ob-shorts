import React from 'react';

/**
 * Official ClipSnipr Brand Mark & Wordmark
 * 4-Corner crop/clip frame brackets:
 * - Top-right cutting bracket in signature Crimson Red (#ef4444)
 * - Frame brackets in text-ink / crisp white
 */
export function BrandIcon({ size = 28, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
    >
      {/* Top-Left Bracket */}
      <path
        d="M10 18V13C10 11.3431 11.3431 10 13 10H18"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      {/* Top-Right Cutting Bracket (Crimson Red #ef4444) */}
      <path
        d="M22 10H27C28.6569 10 30 11.3431 30 13V18"
        stroke="#ef4444"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      {/* Bottom-Right Bracket */}
      <path
        d="M30 22V27C30 28.6569 28.6569 30 27 30H22"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      {/* Bottom-Left Bracket */}
      <path
        d="M18 30H13C11.3431 30 10 28.6569 10 27V22"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function BrandLogo({ size = 28, showWordmark = true, showVersion = false, className = '' }) {
  return (
    <div className={`inline-flex items-center gap-2.5 select-none ${className}`}>
      <div className="text-ink">
        <BrandIcon size={size} />
      </div>
      {showWordmark && (
        <div className="flex items-baseline gap-1.5">
          <span className="font-display font-extrabold tracking-tight text-ink text-base sm:text-lg">
            Clip<span className="text-ink">Snipr</span>
          </span>
          {showVersion && (
            <span className="text-[10px] font-mono font-semibold px-1.5 py-0.2 rounded bg-paper3 border border-rule text-muted uppercase">
              v1.0
            </span>
          )}
        </div>
      )}
    </div>
  );
}
