'use client';

import { useId } from 'react';
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

// Sudo-chan SVG Companion:
// Lightweight, pure SVG twin of the desktop companion bot.
// Features the clean white robot shell, dark obsidian visor, glowing cyan eyes,
// cute white smart glasses, smiling cyan mouth, antenna orb, power core, and smartwatch.
export default function CompanionSvg({
  eyeNodes,
  pupils,
  redness,
  sleeping,
  reducedMotion,
  happy,
  mood,
  onEyeEnter,
  onEyeClick,
}: Props) {
  const reactId = useId().replace(/:/g, '');
  const id = `cs-${reactId}`;

  const mouthD = happy
    ? 'M99 127 Q110 138 121 127'
    : mood === 'worried'
    ? 'M102 133 Q110 128 118 133'
    : 'M102 130 Q110 136 118 130';

  return (
    <svg
      className="companion-svg"
      viewBox="0 0 220 230"
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
      style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
    >
      <defs>
        {/* Soft Pearly White Robot Shell Gradient */}
        <linearGradient id={`${id}-shell`} x1="56" y1="35" x2="178" y2="200" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" />
          <stop offset=".47" stopColor="#f9fcfd" />
          <stop offset="1" stopColor="#c9dae1" />
        </linearGradient>

        {/* Deep Obsidian Visor Screen Gradient */}
        <linearGradient id={`${id}-visor`} x1="63" y1="78" x2="166" y2="132" gradientUnits="userSpaceOnUse">
          <stop stopColor="#213c49" />
          <stop offset=".52" stopColor="#11232e" />
          <stop offset="1" stopColor="#0a1721" />
        </linearGradient>

        {/* Cybernetic Power Core Cyan Radial */}
        <radialGradient id={`${id}-core`}>
          <stop stopColor="#efffff" />
          <stop offset=".48" stopColor="#82eef2" />
          <stop offset="1" stopColor="#30b8c9" />
        </radialGradient>

        {/* Gentle Ambient Cyan Halo */}
        <radialGradient id={`${id}-halo`}>
          <stop stopColor="#9debf0" stopOpacity=".28" />
          <stop offset="1" stopColor="#a4eaf1" stopOpacity="0" />
        </radialGradient>

        {/* Cyan Cybernetic Glow Filter */}
        <filter id={`${id}-blue-glow`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.5" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Ground Drop Shadow */}
        <filter id={`${id}-shadow`} x="-50%" y="-30%" width="200%" height="180%">
          <feDropShadow dx="0" dy="8" stdDeviation="6" floodColor="#486b80" floodOpacity=".18" />
        </filter>

        {/* Glasses White Frame Glow */}
        <filter id={`${id}-glasses-glow`} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0.8" stdDeviation="1.2" floodColor="#38e8ff" floodOpacity="0.45" />
        </filter>

        {/* Glasses Lens Sheen Gradient */}
        <linearGradient id={`${id}-lens-sheen`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.18" />
          <stop offset="40%" stopColor="#c7f9ff" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Ambient Cybernetic Halo */}
      <ellipse cx="110" cy="120" rx="109" ry="105" fill={`url(#${id}-halo)`} />

      {/* Ground Shadow */}
      <ellipse className="bot-ground" cx="110" cy="213" rx="48" ry="6" fill="#81a9b6" opacity=".14" />

      {/* Floating Orbital Ring & Satellite Bead */}
      <g className="bot-float">
        <ellipse
          cx="110"
          cy="108"
          rx="91"
          ry="75"
          stroke="#95dce4"
          strokeOpacity=".5"
          fill="none"
          transform="rotate(-24 110 108)"
        />
        <circle cx="184" cy="66" r="3" fill="#67d6df" />

        {/* Top Antenna */}
        <path d="M110 41V24" stroke="#b1cfd7" strokeWidth="3" strokeLinecap="round" />
        <g className="bot-antenna">
          <circle cx="110" cy="21" r="5.5" fill="#88e4eb" filter={`url(#${id}-blue-glow)`} />
          <circle cx="109" cy="19.5" r="1.8" fill="white" />
          <path
            d="M110 17 L111.2 19.8 L114 21 L111.2 22.2 L110 25 L108.8 22.2 L106 21 L108.8 19.8 Z"
            fill="white"
            opacity="0.9"
          />
        </g>

        {/* Robot Main Body Shell & Shadow */}
        <g filter={`url(#${id}-shadow)`}>
          {/* Lower Chubby Porcelain Body */}
          <path
            d="M80 151C81 139 139 139 140 151L146 177C148 200 132 210 110 210C88 210 72 200 74 177L80 151Z"
            fill={`url(#${id}-shell)`}
            stroke="#ffffff"
            strokeWidth="1.2"
          />
          {/* Cute Little Arm Nubs */}
          <path
            d="M73 162C56 159 52 174 59 183C62 186 68 184 74 179M147 162C164 159 168 174 161 183C158 186 152 184 146 179"
            fill={`url(#${id}-shell)`}
          />

          {/* Smartwatch Gadget on Right Arm */}
          <g className="bot-hand-gadget">
            <circle cx="160" cy="174" r="6.5" fill="#f8fafc" stroke="#94d3dd" strokeWidth="1.2" />
            <circle cx="160" cy="174" r="4.5" fill="#132731" />
            <circle cx="160" cy="174" r="1.8" fill="#72d3bf" />
            <path d="M160 171.2v1M160 175.8v1M157.2 174h1M161.8 174h1" stroke="#9ef1e0" strokeWidth="0.8" strokeLinecap="round" />
          </g>

          {/* Chest Cybernetic Power Core (Heart) */}
          <circle cx="110" cy="177" r="12" fill="#e2f1f2" stroke="white" />
          <circle cx="110" cy="177" r="7" fill={`url(#${id}-core)`} />

          {/* Pearly White Porcelain Head Shell */}
          <rect x="45" y="41" width="130" height="121" rx="55" fill={`url(#${id}-shell)`} stroke="#ffffff" strokeWidth="1.5" />
          {/* Forehead Specular Shine */}
          <path d="M56 73C62 57 79 49 95 49" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" opacity=".9" />

          {/* Dark Obsidian Visor Screen */}
          <rect x="51" y="83" width="118" height="57" rx="27" fill={`url(#${id}-visor)`} stroke="#88bbc7" strokeOpacity=".55" />
          <path d="M65 92C87 85 114 85 147 91" stroke="#ffffff" strokeOpacity=".09" strokeWidth="3" strokeLinecap="round" />

          {/* Eyes: Either Cute Curved Sleeping Lines or Animated Glowing Cyan Eyes */}
          {sleeping ? (
            <g className="bot-eyes-closed" fill="none" stroke="#9cf3ec" strokeWidth="3.5" strokeLinecap="round">
              <path d="M78 111Q87 119 96 111" />
              <path d="M124 111Q133 119 142 111" />
            </g>
          ) : (
            <g className="bot-eyes">
              {/* Left Eye */}
              <g
                ref={node => { eyeNodes.current[0] = node; }}
                style={{ transformOrigin: '87px 110px', transition: reducedMotion ? 'none' : 'transform 80ms ease-out' }}
              >
                <ellipse cx="87" cy="110" rx="9" ry="13" fill="#9af6f3" />
                <g ref={node => { pupils.current[0] = node; }} style={{ transformOrigin: '87px 110px' }}>
                  <ellipse cx="89" cy="111" rx="4" ry="7" fill="#174951" />
                  <circle cx="85" cy="105" r="2.5" fill="white" />
                </g>
              </g>

              {/* Right Eye */}
              <g
                ref={node => { eyeNodes.current[1] = node; }}
                style={{ transformOrigin: '133px 110px', transition: reducedMotion ? 'none' : 'transform 80ms ease-out' }}
              >
                <ellipse cx="133" cy="110" rx="9" ry="13" fill="#9af6f3" />
                <g ref={node => { pupils.current[1] = node; }} style={{ transformOrigin: '133px 110px' }}>
                  <ellipse cx="135" cy="111" rx="4" ry="7" fill="#174951" />
                  <circle cx="131" cy="105" r="2.5" fill="white" />
                </g>
              </g>

              {/* Invisible Pointer Hit Targets for Eye Interactions */}
              <circle
                cx="87"
                cy="110"
                r="18"
                fill="transparent"
                style={{ pointerEvents: 'all', cursor: 'pointer' }}
                onPointerEnter={() => onEyeEnter(0)}
                onClick={event => onEyeClick(event, 0)}
              />
              <circle
                cx="133"
                cy="110"
                r="18"
                fill="transparent"
                style={{ pointerEvents: 'all', cursor: 'pointer' }}
                onPointerEnter={() => onEyeEnter(1)}
                onClick={event => onEyeClick(event, 1)}
              />
            </g>
          )}

          {/* Sudo-chan Signature Cute Round Smart Glasses (Over Visor) */}
          <g className="bot-glasses" pointerEvents="none" aria-hidden="true">
            {/* Left Lens */}
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
              filter={`url(#${id}-glasses-glow)`}
            />
            <path
              d="M76.5 102.5 C 77.5 97.5, 83 95.5, 87.5 95.5"
              stroke="#ffffff"
              strokeWidth="1.3"
              strokeLinecap="round"
              fill="none"
              opacity="0.8"
            />
            <circle cx="94.5" cy="98" r="0.9" fill="#ffffff" opacity="0.85" />

            {/* Right Lens */}
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
              filter={`url(#${id}-glasses-glow)`}
            />
            <path
              d="M122.5 102.5 C 123.5 97.5, 129 95.5, 133.5 95.5"
              stroke="#ffffff"
              strokeWidth="1.3"
              strokeLinecap="round"
              fill="none"
              opacity="0.8"
            />
            <circle cx="140.5" cy="98" r="0.9" fill="#ffffff" opacity="0.85" />

            {/* Arched Nose Bridge */}
            <path
              d="M101.5 109 C 105.5 105.5, 114.5 105.5, 118.5 109"
              stroke="#ffffff"
              strokeWidth="1.9"
              strokeLinecap="round"
              fill="none"
              filter={`url(#${id}-glasses-glow)`}
            />

            {/* Side Temples */}
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

          {/* Cute Cyan Smiling Mouth */}
          <path
            className="bot-smile"
            d={mouthD}
            fill="none"
            stroke="#9cf3ec"
            strokeWidth={happy ? '2.8' : '2.5'}
            strokeLinecap="round"
          />

          {/* Soft Pink Blushing Cheeks */}
          <ellipse
            className="bot-cheek"
            cx="67"
            cy="123"
            rx="5"
            ry="2.5"
            fill="#eab7ce"
            opacity={happy ? 0.75 : 0.45 + redness * 0.25}
          />
          <ellipse
            className="bot-cheek"
            cx="153"
            cy="123"
            rx="5"
            ry="2.5"
            fill="#eab7ce"
            opacity={happy ? 0.75 : 0.45 + redness * 0.25}
          />
        </g>
      </g>
    </svg>
  );
}
