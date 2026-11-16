import React from 'react';

/**
 * Official ClipSnipr Brand Mark & Wordmark
 * Derived from ClipSnipr Brand Identity Toolkit:
 * - 4-corner crop/clip frame brackets
 * - Top-right bracket in signature #FF5A1F orange
 * - Top-left, bottom-left, bottom-right brackets in text-ink / white
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
      {/* Top-Right Bracket (Signature Brand Accent #FF5A1F) */}
      <path
        d="M22 10H27C28.6569 10 30 11.3431 30 13V18"
        stroke="#FF5A1F"
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
