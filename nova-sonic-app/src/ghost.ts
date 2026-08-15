// White "Kiro-style" ghost mark, used as the brand LOGO in the header
// (not a background decoration). Recreated as a plain SVG to match the look
// of kiro.dev's ghost — a rounded white body with a scalloped bottom and two
// tall black eyes. `currentColor` drives the body so it can be themed.
export function ghostSvg(): string {
  return `
  <svg viewBox="0 0 100 108" fill="none" xmlns="http://www.w3.org/2000/svg" class="ghost-svg" focusable="false" aria-hidden="true">
    <path
      d="M50 4
         C27 4 15 22 15 45
         L15 93
         C15 98 20 100 24 97
         C28 94 32 94 36 97
         C40 100 44 100 48 97
         C51 94.5 55 94.5 58 97
         C62 100 66 100 70 97
         C74 94 78 94 82 97
         C85.5 99.6 85 94 85 92
         L85 45
         C85 22 73 4 50 4 Z"
      fill="currentColor" />
    <ellipse cx="39" cy="45" rx="6.5" ry="10.5" fill="#0b0b0f" />
    <ellipse cx="61" cy="45" rx="6.5" ry="10.5" fill="#0b0b0f" />
  </svg>`;
}
