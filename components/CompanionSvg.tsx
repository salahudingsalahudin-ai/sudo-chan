'use client';

import type { MouseEvent, MutableRefObject } from 'react';

type Props = {
  eyeNodes: MutableRefObject<Array<SVGGElement | null>>;
  pupils: MutableRefObject<Array<SVGGElement | null>>;
  redness: number;
  sleeping: boolean;
  reducedMotion: boolean;
  happy: boolean;
  mood: string;
  onEyeEnter: (side: 0 | 1) => void;
  onEyeClick: (event: MouseEvent<SVGElement>, side: 0 | 1) => void;
};

const OUTLINE = '#151a3d';
const EYES: ReadonlyArray<{ cx: number; side: 0 | 1 }> = [{ cx: 98, side: 0 }, { cx: 152, side: 1 }];

// The lightweight twin of the 3D companion: pure SVG, no WebGL. Used on phones, low-power devices, Save-Data,
// reduced-motion and whenever WebGL is unavailable.
export default function CompanionSvg({ eyeNodes, pupils, redness, sleeping, reducedMotion, happy, mood, onEyeEnter, onEyeClick }: Props) {
  const red = Math.round(255), green = Math.round(255 - 150 * redness), blue = Math.round(255 - 140 * redness);
  const mouth = happy ? 'M112 160 Q125 176 138 160 Q125 166 112 160Z' : mood === 'worried' ? 'M115 166 Q125 159 135 166' : 'M116 162 Q125 169 134 162';
  return (
    <svg className="companion-svg" viewBox="0 0 250 300" width="250" height="300" aria-hidden="true" focusable="false" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
      <defs>
        <radialGradient id="cs-glow" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="currentColor" stopOpacity=".42" /><stop offset=".6" stopColor="currentColor" stopOpacity=".12" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient>
        <linearGradient id="cs-hair" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5a5fd0" /><stop offset=".45" stopColor="#33337f" /><stop offset="1" stopColor="#262768" /></linearGradient>
        <linearGradient id="cs-skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff2ec" /><stop offset="1" stopColor="#f6d3d0" /></linearGradient>
        <linearGradient id="cs-jacket" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#d8def2" /></linearGradient>
        <linearGradient id="cs-iris" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#171b52" /><stop offset=".55" stopColor="#2a56b8" /><stop offset="1" stopColor="#4ee6f0" /></linearGradient>
      </defs>
      {/* Listening glow: cycles teal, green (listening), violet (speaking), like the desktop app */}
      <g className="cs-aura">
        <circle cx="125" cy="130" r="128" fill="url(#cs-glow)" />
        <circle cx="125" cy="130" r="104" fill="none" stroke="currentColor" strokeOpacity=".55" strokeWidth="1.5" />
        {Array.from({ length: 36 }, (_, i) => {
          const a = (i / 36) * Math.PI * 2;
          const len = 5 + ((i * 7) % 5) * 1.6;
          return <line key={i} x1={125 + Math.cos(a) * 110} y1={130 + Math.sin(a) * 110} x2={125 + Math.cos(a) * (110 + len)} y2={130 + Math.sin(a) * (110 + len)} stroke="currentColor" strokeOpacity=".7" strokeWidth="2.4" strokeLinecap="round" />;
        })}
      </g>
      {/* Body */}
      <g strokeLinejoin="round" stroke={OUTLINE} strokeWidth="3">
        <path d="M82 190 Q82 176 125 176 Q168 176 168 190 L172 262 Q172 276 125 276 Q78 276 78 262Z" fill="url(#cs-jacket)" />
        <path d="M82 186 Q60 200 62 236 Q70 242 78 236 L86 206Z" fill="url(#cs-jacket)" />
        <path d="M168 186 Q190 200 188 236 Q180 242 172 236 L164 206Z" fill="url(#cs-jacket)" />
        <circle cx="68" cy="240" r="9" fill="url(#cs-skin)" />
        <circle cx="182" cy="240" r="9" fill="url(#cs-skin)" />
        <path d="M104 176 Q125 192 146 176" fill="#2b3170" />
      </g>
      <circle cx="125" cy="222" r="9" className="cs-led" />
      <circle cx="125" cy="222" r="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeOpacity=".8" />
      {/* Hair behind the face */}
      <g stroke={OUTLINE} strokeWidth="3" strokeLinejoin="round">
        <path d="M52 112 Q48 36 125 34 Q202 36 198 112 Q200 150 188 170 Q176 154 178 120 L72 120 Q74 154 62 170 Q50 150 52 112Z" fill="url(#cs-hair)" />
        <ellipse cx="125" cy="116" rx="68" ry="62" fill="url(#cs-skin)" />
      </g>
      {/* Headphones */}
      <g stroke={OUTLINE} strokeWidth="3">
        <rect x="45" y="104" width="14" height="34" rx="7" fill="url(#cs-jacket)" />
        <rect x="191" y="104" width="14" height="34" rx="7" fill="url(#cs-jacket)" />
      </g>
      <rect x="49" y="112" width="6" height="18" rx="3" className="cs-led" />
      <rect x="195" y="112" width="6" height="18" rx="3" className="cs-led" />
      {/* Fringe, ahoge and hair clip */}
      <g stroke={OUTLINE} strokeWidth="3" strokeLinejoin="round">
        <path d="M56 100 Q56 38 125 36 Q194 38 194 100 Q182 70 168 84 Q158 64 142 88 Q134 66 122 90 Q108 66 98 90 Q84 66 76 90 Q66 76 56 100Z" fill="url(#cs-hair)" />
        <path d="M125 38 Q118 20 130 12 Q140 6 134 -4" fill="none" strokeWidth="5" stroke={OUTLINE} strokeLinecap="round" />
      </g>
      <path d="M125 38 Q118 20 130 12 Q140 6 134 -4" fill="none" stroke="#33337f" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="134" cy="-4" r="5.5" className="cs-led" />
      <g className="cs-led-stroke" strokeWidth="3" strokeLinecap="round" fill="none"><path d="M78 62 L88 68 L78 74" /><path d="M92 76 L102 76" /></g>
      {/* Eyes */}
      {EYES.map(({ cx, side }) => (
        <g key={side} transform={`translate(${cx} 0)`}>
          <g ref={node => { eyeNodes.current[side] = node; }} className="cs-eye" style={{ transform: sleeping ? 'scaleY(.06)' : undefined, transition: reducedMotion ? 'none' : 'transform 80ms ease-out' }}>
            <ellipse cx="0" cy="128" rx="15" ry="19" fill={`rgb(${red},${green},${blue})`} />
            <g ref={node => { pupils.current[side] = node; }} className="cs-iris">
              <ellipse cx="0" cy="130" rx="11.5" ry="15" fill="url(#cs-iris)" />
              <ellipse cx="0" cy="130" rx="5.2" ry="7.4" fill={OUTLINE} />
              <circle cx="-4" cy="123" r="3.6" fill="#fff" />
              <circle cx="4" cy="136" r="1.8" fill="#e8ffff" />
            </g>
          </g>
          <path d={`M-17 118 Q0 106 17 118`} fill="none" stroke={OUTLINE} strokeWidth="3.4" strokeLinecap="round" />
          <path d={side === 0 ? 'M-17 118 L-22 114' : 'M17 118 L22 114'} stroke={OUTLINE} strokeWidth="3" strokeLinecap="round" />
          <circle cx="0" cy="128" r="22" fill="transparent" style={{ pointerEvents: 'all', cursor: 'pointer' }} onPointerEnter={() => onEyeEnter(side)} onClick={event => onEyeClick(event, side)} />
        </g>
      ))}
      <path d="M86 104 Q98 98 110 103" fill="none" stroke="#33337f" strokeWidth="2.6" strokeLinecap="round" style={{ transform: mood === 'worried' ? 'rotate(8deg)' : undefined, transformOrigin: '98px 102px' }} />
      <path d="M140 103 Q152 98 164 104" fill="none" stroke="#33337f" strokeWidth="2.6" strokeLinecap="round" style={{ transform: mood === 'worried' ? 'rotate(-8deg)' : undefined, transformOrigin: '152px 102px' }} />
      <ellipse cx="82" cy="150" rx="9" ry="5" fill="#ff8fb0" opacity={happy ? 0.7 : 0.4} />
      <ellipse cx="168" cy="150" rx="9" ry="5" fill="#ff8fb0" opacity={happy ? 0.7 : 0.4} />
      <path className="cs-mouth" d={mouth} fill={happy ? '#7a2646' : 'none'} stroke={OUTLINE} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />

      {/* Sudo-chan Signature Cute Round Smart Glasses (matching desktop companion) */}
      <g className="cs-glasses" pointerEvents="none" aria-hidden="true">
        <defs>
          <filter id="cs-glasses-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0.8" stdDeviation="1.5" floodColor="#38e8ff" floodOpacity="0.5" />
          </filter>
          <linearGradient id="cs-glasses-lens" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
            <stop offset="45%" stopColor="#c7f9ff" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#38e8ff" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        {/* Left Lens (over left eye cx=98, cy=128) */}
        <rect
          x="78"
          y="108"
          width="40"
          height="42"
          rx="15"
          fill="url(#cs-glasses-lens)"
          stroke="#ffffff"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#cs-glasses-glow)"
        />
        <path
          d="M84 119 C 85 113, 91 111, 97 111"
          stroke="#ffffff"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.85"
        />
        <circle cx="105" cy="114" r="1.1" fill="#ffffff" opacity="0.9" />

        {/* Right Lens (over right eye cx=152, cy=128) */}
        <rect
          x="132"
          y="108"
          width="40"
          height="42"
          rx="15"
          fill="url(#cs-glasses-lens)"
          stroke="#ffffff"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#cs-glasses-glow)"
        />
        <path
          d="M138 119 C 139 113, 145 111, 151 111"
          stroke="#ffffff"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.85"
        />
        <circle cx="159" cy="114" r="1.1" fill="#ffffff" opacity="0.9" />

        {/* Cute Arched Nose Bridge */}
        <path
          d="M118 127 C 121 122, 129 122, 132 127"
          stroke="#ffffff"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
          filter="url(#cs-glasses-glow)"
        />

        {/* Temples connecting to headphones */}
        <path
          d="M78 127 C 68 125, 59 123, 52 121"
          stroke="#ffffff"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
          opacity="0.9"
        />
        <path
          d="M172 127 C 182 125, 191 123, 198 121"
          stroke="#ffffff"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
          opacity="0.9"
        />
      </g>
    </svg>
  );
}
