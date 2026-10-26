import { useId } from 'react';

export function SonicOrb({
  isSpeaking = false,
  isListening = true,
  isBusy = false,
  audioLevel = 0,
  size = 200,
  onClick,
  className = '',
}: {
  isSpeaking?: boolean;
  isListening?: boolean;
  isBusy?: boolean;
  audioLevel?: number;
  size?: number;
  onClick?: () => void;
  className?: string;
}) {
  const id = useId().replace(/:/g, '');

  // Calculate dynamic expansion based on audio level
  const dynamicScale = isSpeaking
    ? 1.08 + Math.min(0.25, audioLevel * 0.4)
    : 1 + Math.min(0.2, audioLevel * 0.35);

  const statusClass = isSpeaking
    ? 'is-speaking'
    : isBusy
    ? 'is-busy'
    : 'is-listening';

  return (
    <div
      className={`sonic-orb-container ${statusClass} ${className}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      role={onClick ? 'button' : 'img'}
      tabIndex={onClick ? 0 : undefined}
      aria-label={
        isSpeaking
          ? 'Sudo-chan is speaking'
          : isBusy
          ? 'Thinking'
          : 'Listening to your voice'
      }
    >
      <svg
        className="sonic-orb-svg"
        viewBox="0 0 240 240"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          transform: `scale(${dynamicScale})`,
          transition: 'transform 0.12s cubic-bezier(0.2, 0.9, 0.3, 1.2)',
        }}
      >
        <defs>
          {/* Deep ambient background aura */}
          <radialGradient id={`${id}-aura`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity={isSpeaking ? 0.75 : 0.45} />
            <stop offset="45%" stopColor="#0284c7" stopOpacity={isSpeaking ? 0.45 : 0.25} />
            <stop offset="75%" stopColor="#4f46e5" stopOpacity={isSpeaking ? 0.2 : 0.08} />
            <stop offset="100%" stopColor="#0369a1" stopOpacity="0" />
          </radialGradient>

          {/* Fluid morphing primary layer gradient */}
          <linearGradient id={`${id}-fluid-1`} x1="20" y1="20" x2="220" y2="220" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="40%" stopColor="#0ea5e9" />
            <stop offset="70%" stopColor="#2563eb" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>

          {/* Fluid morphing secondary highlight gradient */}
          <linearGradient id={`${id}-fluid-2`} x1="220" y1="20" x2="20" y2="220" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#67e8f9" />
            <stop offset="35%" stopColor="#38bdf8" />
            <stop offset="75%" stopColor="#0284c7" />
            <stop offset="100%" stopColor="#1e40af" />
          </linearGradient>

          {/* Radiant core light */}
          <radialGradient id={`${id}-core`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="30%" stopColor="#e0f2fe" stopOpacity="0.95" />
            <stop offset="65%" stopColor="#38bdf8" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#0284c7" stopOpacity="0" />
          </radialGradient>

          {/* Intense multi-stage glow filters */}
          <filter id={`${id}-glow-intense`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="6" result="blur1" />
            <feGaussianBlur stdDeviation="14" result="blur2" />
            <feMerge>
              <feMergeNode in="blur2" />
              <feMergeNode in="blur1" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id={`${id}-glow-subtle`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Ambient atmospheric aura */}
        <circle cx="120" cy="120" r="110" fill={`url(#${id}-aura)`} className="sonic-ambient-aura" />

        {/* Dynamic acoustic sound wave ripples radiating outward */}
        <g className="sonic-ripples-group">
          <circle
            cx="120"
            cy="120"
            r="82"
            stroke="#38bdf8"
            strokeWidth="1.2"
            fill="none"
            className="sonic-ripple sonic-ripple-1"
          />
          <circle
            cx="120"
            cy="120"
            r="94"
            stroke="#0ea5e9"
            strokeWidth="1"
            fill="none"
            className="sonic-ripple sonic-ripple-2"
          />
          <circle
            cx="120"
            cy="120"
            r="108"
            stroke="#6366f1"
            strokeWidth="0.8"
            fill="none"
            className="sonic-ripple sonic-ripple-3"
          />
        </g>

        {/* Organic Morphing Fluid Liquid Layer 1 */}
        <path
          className="sonic-morph-layer-1"
          d="M120 45 C165 45 195 75 195 120 C195 165 165 195 120 195 C75 195 45 165 45 120 C45 75 75 45 120 45 Z"
          fill={`url(#${id}-fluid-1)`}
          filter={`url(#${id}-glow-intense)`}
          opacity={isSpeaking ? 0.95 : 0.8}
        />

        {/* Organic Morphing Fluid Liquid Layer 2 (Cross Swirl) */}
        <path
          className="sonic-morph-layer-2"
          d="M120 52 C158 52 188 82 188 120 C188 158 158 188 120 188 C82 188 52 158 52 120 C52 82 82 52 120 52 Z"
          fill={`url(#${id}-fluid-2)`}
          filter={`url(#${id}-glow-subtle)`}
          opacity={isSpeaking ? 0.9 : 0.75}
        />

        {/* Inner High-Energy Swirling Wave Filament */}
        <path
          className="sonic-wave-filament"
          d="M60 120 Q90 90 120 120 T180 120 Q150 150 120 120 T60 120 Z"
          fill="#e0f2fe"
          opacity={isSpeaking ? 0.85 : 0.45}
          filter={`url(#${id}-glow-subtle)`}
        />

        {/* Central Luminous Quantum Core (ChatGPT Style Center Spark) */}
        <circle
          cx="120"
          cy="120"
          r={isSpeaking ? 28 : 22}
          fill={`url(#${id}-core)`}
          filter={`url(#${id}-glow-intense)`}
          className="sonic-quantum-core"
        />

        {/* Central Bright Diamond Spark */}
        <path
          className="sonic-core-sparkle"
          d="M120 108 L123 117 L132 120 L123 123 L120 132 L117 123 L108 120 L117 117 Z"
          fill="#ffffff"
          opacity={isSpeaking ? 1 : 0.7}
        />
      </svg>
    </div>
  );
}
