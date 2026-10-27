'use client';

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { clamp, smoothstep } from '@/lib/heroScene';
import type { StoryWeights } from '@/lib/heroScene';
import { CARD_FONT, drawGlassCard, drawIcon, makeCanvasTexture } from './cardTextures';
import type { CardIcon } from './cardTextures';

type CardDef = { title: string; caption: string; icon: CardIcon; accent: string };

// Short and honest. These mirror the four things the copy promises, nothing more.
export const CARDS: readonly CardDef[] = [
  { title: 'Voice', caption: 'Urdu and English', icon: 'mic', accent: '#62d9be' },
  { title: 'Screen', caption: 'Only after you click', icon: 'screen', accent: '#58c8ff' },
  { title: 'Tools', caption: 'You approve first', icon: 'tools', accent: '#9678ff' },
  { title: 'Privacy', caption: 'Keys stay on your PC', icon: 'lock', accent: '#ffc46b' },
];

const W = 1.06;
const H = 0.53;

function drawCard(def: CardDef) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawGlassCard(ctx, w, h, def.accent, 40);
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.beginPath();
    ctx.arc(96, h / 2, 54, 0, Math.PI * 2);
    ctx.fill();
    drawIcon(ctx, def.icon, 96, h / 2, 62, def.accent);
    ctx.fillStyle = '#f3fbff';
    ctx.font = `600 54px ${CARD_FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(def.title, 176, h / 2 - 2);
    ctx.fillStyle = '#c3dbe5';
    ctx.font = `400 31px ${CARD_FONT}`;
    ctx.fillText(def.caption, 178, h / 2 + 44);
  };
}

// Four UI cards orbiting her. Each has a sharp and a blurred texture: the further a card is from her (the focus plane),
// the more of the blurred one shows. A cheap, GPU-friendly depth-of-field that also works on low-power machines.
export default function FloatingCards({ weights, reduced }: { weights: MutableRefObject<StoryWeights>; reduced: boolean }) {
  const root = useRef<THREE.Group>(null);
  const items = useRef<Array<{ group: THREE.Group | null; sharp: THREE.MeshBasicMaterial | null; soft: THREE.MeshBasicMaterial | null }>>(
    CARDS.map(() => ({ group: null, sharp: null, soft: null })),
  );
  const textures = useMemo(() => CARDS.map(def => ({
    sharp: makeCanvasTexture(512, 256, drawCard(def)),
    soft: makeCanvasTexture(512, 256, drawCard(def), 7),
  })), []);
  useEffect(() => () => textures.forEach(t => { t.sharp.dispose(); t.soft.dispose(); }), [textures]);

  useFrame(state => {
    const w = weights.current.cards;
    const group = root.current;
    if (!group) return;
    group.visible = w > 0.01;
    if (!group.visible) return;
    const t = reduced ? 0.6 : state.clock.elapsedTime;
    CARDS.forEach((_, i) => {
      const item = items.current[i];
      if (!item.group || !item.sharp || !item.soft) return;
      const a = t * 0.2 + (i * Math.PI) / 2;
      const s = Math.sin(a);
      const x = Math.cos(a) * 1.78;
      const z = s * 1.0 - 0.05;
      // Tilted orbit: cards pass low in front of her body, high behind her head, so they never cover her face.
      const y = 0.55 - s * 0.62 + Math.sin(t * 0.7 + i * 1.9) * 0.05;
      item.group.position.set(x, y, z);
      item.group.rotation.set(0, -Math.cos(a) * 0.38, Math.cos(a) * 0.03);
      const grow = 0.72 + 0.28 * smoothstep(0, 0.8, w);
      item.group.scale.setScalar(grow * (0.92 + 0.12 * (s * 0.5 + 0.5)));
      const blur = clamp((Math.abs(z - 0.1) - 0.15) / 1.0) * 0.9;
      const fade = w * (0.72 + 0.28 * (s * 0.5 + 0.5));
      item.sharp.opacity = (1 - blur) * fade;
      item.soft.opacity = blur * fade;
    });
  });

  return (
    <group ref={root} position={[0, 0.15, 0]} visible={false}>
      {CARDS.map((def, i) => (
        <group key={def.title} ref={node => { items.current[i].group = node; }}>
          <mesh>
            <planeGeometry args={[W, H]} />
            <meshBasicMaterial ref={node => { items.current[i].sharp = node; }} map={textures[i].sharp} transparent depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0, 0.001]}>
            <planeGeometry args={[W, H]} />
            <meshBasicMaterial ref={node => { items.current[i].soft = node; }} map={textures[i].soft} transparent depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
