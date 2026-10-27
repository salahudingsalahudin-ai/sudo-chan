// Tiny decorative illustrations shown above the copy of scenes 02-06 on phones only (the 3D / CSS companion is hidden there).
// Pure SVG, no state. They use the scene's text colour plus the accent, so they work on both themes. Illustration only.
type Kind = 'inside' | 'intelligence' | 'anatomy' | 'demo' | 'privacy' | 'join';

const ACCENT = 'var(--color-bot-rim)';

function Art({ kind }: { kind: Kind }) {
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeOpacity: 0.55, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const accent = { fill: 'none', stroke: ACCENT, strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'inside':
      return <>
        {Array.from({ length: 28 }, (_, i) => {
          const a = (i / 28) * Math.PI * 2; const len = 6 + ((i * 5) % 7) * 2.2;
          return <line key={i} x1={100 + Math.cos(a) * 38} y1={50 + Math.sin(a) * 38} x2={100 + Math.cos(a) * (38 + len)} y2={50 + Math.sin(a) * (38 + len)} {...accent} strokeOpacity={0.35 + (i % 3) * 0.2} />;
        })}
        <rect x="90" y="30" width="20" height="32" rx="10" {...accent} />
        <path d="M82 52a18 18 0 0 0 36 0M100 70v8" {...accent} />
      </>;
    case 'intelligence':
      return <>
        {[[34, 12], [108, 12], [34, 56], [108, 56]].map(([x, y], i) => (
          <g key={i}><rect x={x} y={y} width="58" height="34" rx="9" {...line} /><circle cx={x + 15} cy={y + 17} r="6" {...accent} strokeWidth={1.8} /><path d={`M${x + 28} ${y + 13}h20M${x + 28} ${y + 21}h13`} {...line} /></g>
        ))}
      </>;
    case 'anatomy':
      return <>
        <rect x="46" y="10" width="108" height="64" rx="12" {...line} />
        <path d="M60 28h50M60 40h34" {...line} />
        <rect x="60" y="50" width="38" height="16" rx="8" {...line} />
        <rect x="106" y="50" width="38" height="16" rx="8" {...accent} fill={ACCENT} fillOpacity=".18" strokeWidth={1.8} />
        <path d="M118 58l5 4 9-9" {...accent} strokeWidth={1.8} />
      </>;
    case 'demo':
      return <>
        <rect x="42" y="8" width="116" height="66" rx="8" {...line} />
        <path d="M88 84h24M100 74v10" {...line} />
        <rect x="62" y="26" width="48" height="30" rx="4" strokeDasharray="4 4" {...accent} strokeWidth={1.8} />
        <path d="M112 44l14 6-6 2-2 6z" fill={ACCENT} stroke="none" />
      </>;
    case 'join':
      return <>
        <rect x="56" y="20" width="88" height="56" rx="10" {...line} />
        <path d="M60 26l40 28 40-28" {...accent} />
        <circle cx="146" cy="22" r="6" fill={ACCENT} />
      </>;
    default:
      return <>
        <rect x="76" y="38" width="48" height="38" rx="8" {...accent} />
        <path d="M86 38v-8a14 14 0 0 1 28 0v8" {...accent} />
        <circle cx="100" cy="55" r="4" fill={ACCENT} />
        <path d="M100 59v8" {...accent} />
      </>;
  }
}

export default function SceneArt({ kind }: { kind: string }) {
  if (kind !== 'inside' && kind !== 'intelligence' && kind !== 'anatomy' && kind !== 'demo' && kind !== 'privacy' && kind !== 'join') return null;
  return <svg className="scene-art" viewBox="0 0 200 96" width="200" height="96" aria-hidden="true" focusable="false"><Art kind={kind} /></svg>;
}
