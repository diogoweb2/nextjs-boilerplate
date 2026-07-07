/**
 * Pereira Lope$ brand mark — a money bill sprouting wings (money famously
 * leaves). The wing groups carry CSS classes so globals.css can flap them on
 * hover; the whole mark idles with a gentle float. Pure SVG, no assets.
 */
export function LogoMark({ className = 'h-8 w-10' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 52" className={`logo-mark ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id="lm-bill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#34d17b" />
          <stop offset="1" stopColor="#12934f" />
        </linearGradient>
        <linearGradient id="lm-wing" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#cbd5e1" />
        </linearGradient>
      </defs>
      <g className="logo-wing logo-wing-left">
        <path
          d="M17 21 C 12 10, 4 5, 1.5 7.5 C 0.5 12, 4 14, 8 14.5 C 4.5 15.5, 3.5 18, 5 20 C 8 21.5, 11 20.5, 13 19.5 C 12 21.5, 13 23.5, 15 24 Z"
          fill="url(#lm-wing)"
          stroke="#64748b"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </g>
      <g className="logo-wing logo-wing-right">
        <path
          d="M47 21 C 52 10, 60 5, 62.5 7.5 C 63.5 12, 60 14, 56 14.5 C 59.5 15.5, 60.5 18, 59 20 C 56 21.5, 53 20.5, 51 19.5 C 52 21.5, 51 23.5, 49 24 Z"
          fill="url(#lm-wing)"
          stroke="#64748b"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </g>
      <g>
        <rect x="14" y="20" width="36" height="24" rx="4.5" fill="url(#lm-bill)" stroke="#0b6b39" strokeWidth="1.6" />
        <rect
          x="17.5"
          y="23.5"
          width="29"
          height="17"
          rx="2.5"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.6"
          strokeWidth="1.2"
          strokeDasharray="3 2"
        />
        <circle cx="32" cy="32" r="7" fill="#0e7d43" stroke="#ffffff" strokeOpacity="0.75" strokeWidth="1.2" />
        <text x="32" y="36.6" textAnchor="middle" fontWeight="bold" fontSize="13" fill="#ffffff">
          $
        </text>
        <text x="20.5" y="27.8" textAnchor="middle" fontWeight="bold" fontSize="4.5" fill="#eafff2">
          P
        </text>
        <text x="43.5" y="40" textAnchor="middle" fontWeight="bold" fontSize="4.5" fill="#eafff2">
          L
        </text>
      </g>
    </svg>
  )
}

/** Wordmark: "Pereira Lope" with a tilted money-green $ doing its own thing. */
export function LogoWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-extrabold tracking-tight ${className}`}>
      Pereira&nbsp;Lope
      <span className="logo-dollar inline-block text-[var(--accent)]">$</span>
    </span>
  )
}
