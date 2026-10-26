'use client';

export function SudoGlassesSVG({
  visible = true,
  className = '',
  id = 'sudo-landing-glasses',
}: {
  visible?: boolean;
  className?: string;
  id?: string;
}) {
  if (!visible) return null;

  return (
    <svg
      className={`bot-glasses-svg ${className}`}
      viewBox="0 0 122 48"
      fill="none"
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <defs>
        <filter id={`${id}-frame-glow`} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0.8" stdDeviation="1.2" floodColor="#38e8ff" floodOpacity="0.45" />
        </filter>
        <linearGradient id={`${id}-lens-sheen`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="40%" stopColor="#c7f9ff" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.03" />
        </linearGradient>
      </defs>

      {/* Left frame (cute rounded-square, transparent, centered over left eye) */}
      <rect
        x="10"
        y="6"
        width="38"
        height="36"
        rx="13"
        fill={`url(#${id}-lens-sheen)`}
        stroke="#ffffff"
        strokeWidth="2.0"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${id}-frame-glow)`}
      />
      <path
        d="M15 17 C 16 11, 23 9, 29 9"
        stroke="#ffffff"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.85"
      />
      <circle cx="39" cy="12" r="1.1" fill="#ffffff" opacity="0.9" />

      {/* Right frame (cute rounded-square, transparent, centered over right eye) */}
      <rect
        x="74"
        y="6"
        width="38"
        height="36"
        rx="13"
        fill={`url(#${id}-lens-sheen)`}
        stroke="#ffffff"
        strokeWidth="2.0"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${id}-frame-glow)`}
      />
      <path
        d="M79 17 C 80 11, 87 9, 93 9"
        stroke="#ffffff"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.85"
      />
      <circle cx="103" cy="12" r="1.1" fill="#ffffff" opacity="0.9" />

      {/* Cute arched nose bridge */}
      <path
        d="M48 23 C 54 19, 68 19, 74 23"
        stroke="#ffffff"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
        filter={`url(#${id}-frame-glow)`}
      />

      {/* Temples to visor edges */}
      <path
        d="M10 24 C 6 23, 2 21.5, 0 20"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
        opacity="0.9"
      />
      <path
        d="M112 24 C 116 23, 120 21.5, 122 20"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
        opacity="0.9"
      />
    </svg>
  );
}

export function SudoGlasses3D() {
  return (
    <group position={[0, 0.02, 0.98]}>
      {/* Left frame (thin white rounded ring) */}
      <mesh position={[-0.27, 0, 0.035]}>
        <torusGeometry args={[0.13, 0.012, 16, 48]} />
        <meshStandardMaterial color="#ffffff" roughness={0.15} metalness={0.08} emissive="#c7f9ff" emissiveIntensity={0.2} />
      </mesh>
      {/* Left transparent lens with light reflection */}
      <mesh position={[-0.27, 0, 0.033]}>
        <circleGeometry args={[0.126, 32]} />
        <meshPhysicalMaterial color="#ffffff" transparent opacity={0.16} transmission={0.92} roughness={0.08} clearcoat={1} clearcoatRoughness={0.1} />
      </mesh>

      {/* Right frame (thin white rounded ring) */}
      <mesh position={[0.27, 0, 0.035]}>
        <torusGeometry args={[0.13, 0.012, 16, 48]} />
        <meshStandardMaterial color="#ffffff" roughness={0.15} metalness={0.08} emissive="#c7f9ff" emissiveIntensity={0.2} />
      </mesh>
      {/* Right transparent lens with light reflection */}
      <mesh position={[0.27, 0, 0.033]}>
        <circleGeometry args={[0.126, 32]} />
        <meshPhysicalMaterial color="#ffffff" transparent opacity={0.16} transmission={0.92} roughness={0.08} clearcoat={1} clearcoatRoughness={0.1} />
      </mesh>

      {/* Cute arched nose bridge */}
      <mesh position={[0, 0.025, 0.035]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.009, 0.009, 0.16, 16]} />
        <meshStandardMaterial color="#ffffff" roughness={0.15} metalness={0.08} />
      </mesh>

      {/* Thin white side temples stretching towards visor sides */}
      <mesh position={[-0.44, 0.01, -0.01]} rotation={[0, 0.28, 0]}>
        <cylinderGeometry args={[0.008, 0.008, 0.22, 16]} />
        <meshStandardMaterial color="#ffffff" roughness={0.15} />
      </mesh>
      <mesh position={[0.44, 0.01, -0.01]} rotation={[0, -0.28, 0]}>
        <cylinderGeometry args={[0.008, 0.008, 0.22, 16]} />
        <meshStandardMaterial color="#ffffff" roughness={0.15} />
      </mesh>
    </group>
  );
}
