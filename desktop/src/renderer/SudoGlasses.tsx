export function SudoGlasses({
  visible = true,
  className = '',
  id = 'sudo-glasses',
}: {
  visible?: boolean;
  className?: string;
  id?: string;
}) {
  if (!visible) return null;

  return (
    <g className={`bot-glasses ${className}`} pointerEvents="none" aria-hidden="true">
      <defs>
        {/* Soft cyan-white glow matching Sudo-chan cybernetic theme */}
        <filter id={`${id}-frame-glow`} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0.8" stdDeviation="1.2" floodColor="#38e8ff" floodOpacity="0.45" />
        </filter>
        {/* Transparent glass lens gradient with subtle specular sheen */}
        <linearGradient id={`${id}-lens-sheen`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.18" />
          <stop offset="40%" stopColor="#c7f9ff" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* --- Left Lens (Cute round/rounded-square, transparent, centered at x=87, y=110) --- */}
      <rect
        x="72.5"
        y="93.5"
        width="29"
        height="33"
        rx="12"
        fill={`url(#${id}-lens-sheen)`}
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${id}-frame-glow)`}
      />
      {/* Light glass reflection arc on top-left of left lens */}
      <path
        d="M76.5 102.5 C 77.5 97.5, 83 95.5, 87.5 95.5"
        stroke="#ffffff"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
        opacity="0.8"
      />
      <circle cx="94.5" cy="98" r="0.9" fill="#ffffff" opacity="0.85" />

      {/* --- Right Lens (Cute round/rounded-square, transparent, centered at x=133, y=110) --- */}
      <rect
        x="118.5"
        y="93.5"
        width="29"
        height="33"
        rx="12"
        fill={`url(#${id}-lens-sheen)`}
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${id}-frame-glow)`}
      />
      {/* Light glass reflection arc on top-left of right lens */}
      <path
        d="M122.5 102.5 C 123.5 97.5, 129 95.5, 133.5 95.5"
        stroke="#ffffff"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
        opacity="0.8"
      />
      <circle cx="140.5" cy="98" r="0.9" fill="#ffffff" opacity="0.85" />

      {/* --- Cute Arched Nose Bridge --- */}
      <path
        d="M101.5 109 C 105.5 105.5, 114.5 105.5, 118.5 109"
        stroke="#ffffff"
        strokeWidth="1.9"
        strokeLinecap="round"
        fill="none"
        filter={`url(#${id}-frame-glow)`}
      />

      {/* --- Thin White Temples connecting to visor edges --- */}
      <path
        d="M72.5 108.5 C 65 107.5, 57.5 106, 52 104.5"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
        opacity="0.92"
      />
      <path
        d="M147.5 108.5 C 155 107.5, 162.5 106, 168 104.5"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
        opacity="0.92"
      />
    </g>
  );
}
