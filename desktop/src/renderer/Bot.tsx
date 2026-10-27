import { useId } from 'react';
import type { Mood } from '../shared/types';
import { SudoGlasses } from './SudoGlasses';

export function Bot({
  mood = 'calm',
  paused = false,
  className = '',
  cursorOffset,
  isSpeaking = false,
  voiceActive = false,
  audioLevel = 0,
  glasses = true,
  onToggleVoice,
  onOpenSettings,
}: {
  mood?: Mood;
  paused?: boolean;
  className?: string;
  cursorOffset?: { x: number; y: number };
  isSpeaking?: boolean;
  voiceActive?: boolean;
  audioLevel?: number;
  glasses?: boolean;
  onToggleVoice?: () => void;
  onOpenSettings?: () => void;
}) {
  const id = useId().replace(/:/g, '');
  const eyeShiftX = cursorOffset ? Math.max(-4, Math.min(4, Math.round(cursorOffset.x * 4))) : 0;
  const eyeShiftY = cursorOffset ? Math.max(-3, Math.min(3, Math.round(cursorOffset.y * 3))) : 0;
  const eyeTransform = eyeShiftX || eyeShiftY ? `translate(${eyeShiftX} ${eyeShiftY})` : undefined;

  // Reactivity scaling for live voice / speech: mouth ONLY opens while companion is actively speaking
  const isMouthOpen = Boolean(isSpeaking);
  const talkScale = isSpeaking ? Math.max(1, 1 + audioLevel * 0.4) : 1;

  return <svg className={`bot-art ${className}`} data-mood={mood} data-paused={paused} data-speaking={isSpeaking} data-talking={isSpeaking} viewBox="0 0 220 230" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-shell`} x1="56" y1="35" x2="178" y2="200" gradientUnits="userSpaceOnUse"><stop stopColor="#fff"/><stop offset=".47" stopColor="#f9fcfd"/><stop offset="1" stopColor="#c9dae1"/></linearGradient>
      <linearGradient id={`${id}-visor`} x1="63" y1="78" x2="166" y2="132" gradientUnits="userSpaceOnUse"><stop stopColor="#213c49"/><stop offset=".52" stopColor="#11232e"/><stop offset="1" stopColor="#0a1721"/></linearGradient>
      <radialGradient id={`${id}-core`}><stop stopColor="#efffff"/><stop offset=".48" stopColor="#82eef2"/><stop offset="1" stopColor="#30b8c9"/></radialGradient>
      <radialGradient id={`${id}-halo`}><stop stopColor="#9debf0" stopOpacity=".28"/><stop offset="1" stopColor="#a4eaf1" stopOpacity="0"/></radialGradient>
      <radialGradient id={`${id}-mouth-blue-light`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="1"/>
        <stop offset="30%" stopColor="#38bdf8" stopOpacity="0.95"/>
        <stop offset="70%" stopColor="#0284c7" stopOpacity="0.85"/>
        <stop offset="100%" stopColor="#0369a1" stopOpacity="0"/>
      </radialGradient>
      <filter id={`${id}-blue-glow`} x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
        <feMerge>
          <feMergeNode in="coloredBlur"/>
          <feMergeNode in="coloredBlur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
      <filter id={`${id}-shadow`} x="-50%" y="-30%" width="200%" height="180%"><feDropShadow dx="0" dy="9" stdDeviation="7" floodColor="#486b80" floodOpacity=".16"/></filter>
    </defs>
    <ellipse cx="110" cy="120" rx="109" ry="105" fill={`url(#${id}-halo)`}/>
    <ellipse className="bot-ground" cx="110" cy="213" rx="48" ry="6" fill="#81a9b6" opacity=".14"/>
    <g className="bot-float">
      <ellipse cx="110" cy="108" rx="91" ry="75" stroke="#95dce4" strokeOpacity=".5" transform="rotate(-24 110 108)"/>
      <circle cx="184" cy="66" r="3" fill="#67d6df"/>
      <path d="M110 41V24" stroke="#b1cfd7" strokeWidth="3" strokeLinecap="round"/>
      <g
        className={`bot-antenna-feature ${voiceActive ? 'is-active' : ''}`}
        tabIndex={0}
        role="button"
        aria-label={voiceActive ? 'Finish Live Talk' : 'Start Live Talk'}
        onClick={e => {
          e.stopPropagation();
          onToggleVoice?.();
        }}
        style={{ cursor: 'pointer' }}
      >
        <title>{voiceActive ? '✨ Live Talk Active (Tap antenna to finish)' : '✨ Tap antenna to start Live Talk'}</title>
        {/* Generous transparent hit-target for effortless clicking */}
        <circle cx="110" cy="21" r="16" fill="transparent"/>

        {/* Dynamic sonic pulse rings when voice call / live talk is active */}
        {voiceActive && (
          <>
            <circle className="antenna-sonic-ring ring-1" cx="110" cy="21" r="11" fill="none" stroke="#38bdf8" strokeWidth="1.5"/>
            <circle className="antenna-sonic-ring ring-2" cx="110" cy="21" r="17" fill="none" stroke="#0ea5e9" strokeWidth="1"/>
          </>
        )}

        {/* Glowing cybernetic antenna orb */}
        <circle
          className="antenna-bulb"
          cx="110"
          cy="21"
          r={voiceActive ? 7.5 : 5.5}
          fill={voiceActive ? '#38bdf8' : '#88e4eb'}
          filter={`url(#${id}-blue-glow)`}
        />
        <circle cx="109" cy="19.5" r="1.8" fill="white"/>

        {/* Sleek neural sonic spark emblem on antenna tip */}
        <path
          className="antenna-spark"
          d="M110 17 L111.2 19.8 L114 21 L111.2 22.2 L110 25 L108.8 22.2 L106 21 L108.8 19.8 Z"
          fill="white"
          opacity={voiceActive ? 1 : 0.85}
        />
      </g>
      <g filter={`url(#${id}-shadow)`}>
        <path d="M80 151C81 139 139 139 140 151L146 177C148 200 132 210 110 210C88 210 72 200 74 177L80 151Z" fill={`url(#${id}-shell)`} stroke="#fff" strokeWidth="1.2"/>
        <path d="M73 162C56 159 52 174 59 183C62 186 68 184 74 179M147 162C164 159 168 174 161 183C158 186 152 184 146 179" fill={`url(#${id}-shell)`}/>

        {/* Companion Smartwatch / Wrist Gadget on Sudo-chan's Right Hand */}
        <g
          className="bot-hand-gadget"
          tabIndex={0}
          role="button"
          aria-label="Open settings"
          onClick={e => {
            e.stopPropagation();
            onOpenSettings?.();
          }}
          style={{ cursor: 'pointer' }}
        >
          <title>⚙️ Companion Settings</title>
          {/* Easy hit target */}
          <circle cx="160" cy="174" r="14" fill="transparent"/>
          {/* Sleek watch casing */}
          <circle cx="160" cy="174" r="6.5" fill="#f8fafc" stroke="#94d3dd" strokeWidth="1.2" filter={`url(#${id}-shadow)`}/>
          {/* Teal inner dial */}
          <circle cx="160" cy="174" r="4.5" fill="#132731"/>
          {/* Cyan gear center & crosshairs */}
          <circle cx="160" cy="174" r="1.8" fill="#72d3bf"/>
          <path d="M160 171.2v1M160 175.8v1M157.2 174h1M161.8 174h1" stroke="#9ef1e0" strokeWidth="0.8" strokeLinecap="round"/>
        </g>
        <rect x="45" y="41" width="130" height="121" rx="55" fill={`url(#${id}-shell)`} stroke="#fff" strokeWidth="1.5"/>
        <path d="M56 73C62 57 79 49 95 49" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity=".9"/>
        <rect x="51" y="83" width="118" height="57" rx="27" fill={`url(#${id}-visor)`} stroke="#88bbc7" strokeOpacity=".55"/>
        <path d="M65 92C87 85 114 85 147 91" stroke="#fff" strokeOpacity=".09" strokeWidth="3" strokeLinecap="round"/>
        {paused ? <g className="bot-eyes-closed" fill="none" stroke="#9cf3ec" strokeWidth="3.5" strokeLinecap="round">
          <path d="M78 111Q87 119 96 111"/><path d="M124 111Q133 119 142 111"/>
        </g> : <g className="bot-eyes" transform={eyeTransform}>
          <ellipse cx="87" cy="110" rx="9" ry="13" fill="#9af6f3"/><ellipse cx="133" cy="110" rx="9" ry="13" fill="#9af6f3"/>
          <ellipse cx="89" cy="111" rx="4" ry="7" fill="#174951"/><ellipse cx="135" cy="111" rx="4" ry="7" fill="#174951"/>
          <circle cx="85" cy="105" r="2.5" fill="white"/><circle cx="131" cy="105" r="2.5" fill="white"/>
        </g>}
        {/* Cute white glasses sitting in front of eyes, moving with head */}
        <SudoGlasses visible={glasses} id={id} />
        {isMouthOpen ? (
          <g
            className={`bot-mouth-gpt ${isSpeaking ? 'is-talking-level' : 'is-listening'}`}
            style={isSpeaking ? { transform: `scale(${(1 + audioLevel * 0.35).toFixed(3)}, ${(0.4 + Math.min(1, audioLevel) * 1.3).toFixed(3)})`, transition: 'transform 60ms linear' } : undefined}
          >
            <clipPath id={`${id}-mouth-clip`}>
              <path
                className="gpt-mouth-cutout"
                d="M96 128 C100 122, 120 122, 124 128 C122 138, 98 138, 96 128 Z"
              />
            </clipPath>

            {/* Ambient Blue Plasma Backlight */}
            <ellipse
              cx="110"
              cy="130"
              rx={isSpeaking ? 17 : 13}
              ry={isSpeaking ? 11 : 7}
              fill={`url(#${id}-mouth-blue-light)`}
              filter={`url(#${id}-blue-glow)`}
              className="gpt-plasma-back"
            />

            {/* Lip outline that moves with speech */}
            <path
              className="gpt-mouth-lip"
              d="M96 128 C100 122, 120 122, 124 128 C122 138, 98 138, 96 128 Z"
              fill="#031a29"
              stroke="#38bdf8"
              strokeWidth="1.8"
            />

            {/* Liquid dancing light waves inside the mouth */}
            <g clipPath={`url(#${id}-mouth-clip)`}>
              {/* Outer fluid morphing wave */}
              <path
                className="gpt-fluid-wave-1"
                d="M92 130 Q102 124 110 130 T128 130 Q120 137 110 135 T92 130 Z"
                fill="#0284c7"
                opacity="0.85"
              />
              {/* Inner vibrant cyan swirling wave */}
              <path
                className="gpt-fluid-wave-2"
                d="M95 130 Q105 125 110 129 T125 130 Q118 136 110 134 T95 130 Z"
                fill="#38bdf8"
                filter={`url(#${id}-blue-glow)`}
                opacity="0.9"
              />
              {/* Central bright glowing plasma spark */}
              <ellipse
                cx="110"
                cy="130"
                rx="6"
                ry="3"
                fill="#ffffff"
                filter={`url(#${id}-blue-glow)`}
                className="gpt-fluid-core"
              />
            </g>
          </g>
        ) : (
          <path className="bot-smile" d="M102 130Q110 136 118 130" stroke="#9cf3ec" strokeWidth="2.5" strokeLinecap="round"/>
        )}
        <ellipse className="bot-cheek" cx="67" cy="123" rx="5" ry="2.5" fill="#eab7ce" opacity=".55"/><ellipse className="bot-cheek" cx="153" cy="123" rx="5" ry="2.5" fill="#eab7ce" opacity=".55"/>
        <circle cx="110" cy="177" r="12" fill="#e2f1f2" stroke="white"/><circle className="bot-heart" cx="110" cy="177" r="7" fill={`url(#${id}-core)`}/>
      </g>
    </g>
  </svg>;
}
