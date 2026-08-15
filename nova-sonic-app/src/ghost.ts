// Kiro-style ghost mascot as an inline SVG. Rendered into the background,
// low opacity, pointer-events:none — purely decorative (aria-hidden by caller).
export function ghostSvg(): string {
  return `
  <svg viewBox="0 0 220 260" fill="none" xmlns="http://www.w3.org/2000/svg" class="ghost-svg" focusable="false">
    <defs>
      <radialGradient id="ghostBody" cx="50%" cy="38%" r="70%">
        <stop offset="0%" stop-color="#c4a8ff" />
        <stop offset="55%" stop-color="#8b5cf6" />
        <stop offset="100%" stop-color="#5b21b6" />
      </radialGradient>
      <filter id="ghostGlow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="10" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
    <g filter="url(#ghostGlow)">
      <path
        d="M40 130 A70 70 0 0 1 180 130
           L180 215
           C173 202 160 202 152 215
           C144 228 128 228 120 215
           C112 202 96 202 88 215
           C80 228 64 228 56 215
           C48 202 40 205 40 205 Z"
        fill="url(#ghostBody)" />
      <ellipse cx="88" cy="120" rx="12" ry="16" fill="#1a0b2e" />
      <ellipse cx="132" cy="120" rx="12" ry="16" fill="#1a0b2e" />
      <circle cx="92" cy="114" r="4" fill="#fff" opacity="0.9" />
      <circle cx="136" cy="114" r="4" fill="#fff" opacity="0.9" />
    </g>
  </svg>`;
}
