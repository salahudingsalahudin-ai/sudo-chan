'use client';

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { clamp } from '@/lib/heroScene';
import type { VoiceDemo } from '@/lib/heroScene';
import { EYE_BLINK_DAMPING } from '../sudoChanConfig';
import type { BotInteractions } from '../SudoChanCanvas';
import { drawDesktopCompanion } from './drawCompanion';

type Pointer = { current: { x: number; y: number; vx: number; vy: number } };
type Props = {
  pointer: Pointer;
  interactions: BotInteractions;
  voice: MutableRefObject<VoiceDemo>;
  progress: { current: number };
};

const CANVAS_W = 1024;
const CANVAS_H = 1070;

export default function CompanionBot({ pointer, interactions, voice }: Props) {
  const mesh = useRef<THREE.Mesh>(null);
  const blink = useRef(0);
  const nextBlink = useRef(2.4);
  const happyAmt = useRef(0);
  const lastDrawKey = useRef('');

  // Track website theme: 'dark' | 'light'
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined') return 'dark';
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  });

  useEffect(() => {
    const onTheme = () => {
      const nextTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      setTheme(nextTheme);
    };
    window.addEventListener('sudo-chan-theme-change', onTheme);
    return () => window.removeEventListener('sudo-chan-theme-change', onTheme);
  }, []);

  // Offscreen canvas & Three.js CanvasTexture
  const { canvas, ctx, texture } = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = CANVAS_W;
    c.height = CANVAS_H;
    const context = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    return { canvas: c, ctx: context, texture: tex };
  }, []);

  useEffect(() => () => {
    texture.dispose();
  }, [texture]);

  useFrame((state, dtRaw) => {
    if (!ctx) return;
    const dt = Math.min(dtRaw, 0.05);
    const t = state.clock.elapsedTime;
    const ptr = pointer.current;
    const v = voice.current;
    const reduced = interactions.reducedMotion;
    const sleeping = interactions.sleeping;
    const happy = performance.now() < interactions.happyUntilRef.current || interactions.mood === 'Happy';

    happyAmt.current = THREE.MathUtils.damp(happyAmt.current, happy && !sleeping ? 1 : 0, 6, dt);

    // Auto-blink logic
    if (!reduced && t > nextBlink.current) {
      blink.current = 1;
      nextBlink.current = t + 2.5 + Math.random() * 4.2;
    }
    blink.current = THREE.MathUtils.damp(blink.current, 0, EYE_BLINK_DAMPING, dt);

    // Interactive blinks from clicks / hovers
    const side0 = interactions.eyeBlinksRef.current[0];
    const side1 = interactions.eyeBlinksRef.current[1];
    const interactionBlink = Math.max(side0, side1);
    const activeBlink = sleeping ? 1 : Math.max(blink.current, interactionBlink);

    // Eye pointer tracking
    const gx = reduced ? 0 : clamp(ptr.x, -1, 1);
    const gy = reduced ? 0 : clamp(ptr.y, -1, 1);

    const isSpeaking = v.speak > 0.05;
    const voiceActive = v.listen > 0.05 || v.speak > 0.05;
    const voiceLevel = clamp(v.level, 0, 1);

    // Floating animation
    if (mesh.current) {
      mesh.current.position.y = reduced ? 0.05 : 0.05 + Math.sin(t * 1.5) * 0.016 + v.level * 0.012;
      mesh.current.rotation.y = THREE.MathUtils.damp(mesh.current.rotation.y, gx * 0.12, 5, dt);
      mesh.current.rotation.x = THREE.MathUtils.damp(mesh.current.rotation.x, gy * 0.08, 5, dt);
      mesh.current.rotation.z = THREE.MathUtils.damp(mesh.current.rotation.z, (sleeping ? 0.04 : 0), 4, dt);
    }

    // Quantize values to avoid unnecessary redraws
    const qShiftX = Math.round(gx * 20) / 20;
    const qShiftY = Math.round(gy * 20) / 20;
    const qBlink = Math.round(activeBlink * 15) / 15;
    const qLevel = Math.round(voiceLevel * 10) / 10;
    const qRedness = Math.round(interactions.redness * 10) / 10;

    const drawKey = `${theme}_${qShiftX}_${qShiftY}_${qBlink}_${sleeping}_${happy}_${isSpeaking}_${voiceActive}_${qLevel}_${qRedness}`;

    if (drawKey !== lastDrawKey.current) {
      lastDrawKey.current = drawKey;
      drawDesktopCompanion(ctx, CANVAS_W, CANVAS_H, {
        theme,
        eyeShiftX: gx,
        eyeShiftY: gy,
        blink: activeBlink,
        sleeping,
        happy,
        mood: interactions.mood ?? 'calm',
        isSpeaking,
        voiceActive,
        voiceLevel,
        redness: interactions.redness,
      });
      texture.needsUpdate = true;
    }
  });

  const handleClick = (e: { stopPropagation: () => void; uv?: THREE.Vector2 }) => {
    e.stopPropagation();
    if (e.uv) {
      // UV mapping in plane: x 0..1 (left to right), y 0..1 (bottom to top)
      // Visor eyes are around x: 0.35..0.45 (left eye), x: 0.55..0.65 (right eye), y: 0.48..0.58
      if (e.uv.y > 0.45 && e.uv.y < 0.6) {
        if (e.uv.x > 0.32 && e.uv.x < 0.46) {
          interactions.onEyeClick(0);
          return;
        }
        if (e.uv.x > 0.54 && e.uv.x < 0.68) {
          interactions.onEyeClick(1);
          return;
        }
      }
    }
    interactions.onWelcome();
  };

  const handlePointerMove = (e: { uv?: THREE.Vector2 }) => {
    if (e.uv && e.uv.y > 0.45 && e.uv.y < 0.6) {
      if (e.uv.x > 0.32 && e.uv.x < 0.46) {
        interactions.onEyeHover(0);
      } else if (e.uv.x > 0.54 && e.uv.x < 0.68) {
        interactions.onEyeHover(1);
      }
    }
  };

  return (
    <group position={[0, 0.05, 0]}>
      {/* 
        Sudo-chan Desktop Companion:
        Plane geometry with 100% pixel-perfect vector canvas texture.
        MeshBasicMaterial with toneMapped=false guarantees the colors, visor, 
        and glasses match the desktop app without 3D blowout or distortion!
      */}
      <mesh
        ref={mesh}
        position={[0, 0, 0]}
        onClick={handleClick}
        onPointerMove={handlePointerMove}
      >
        <planeGeometry args={[2.2, 2.3]} />
        <meshBasicMaterial
          map={texture}
          transparent
          alphaTest={0.01}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}
