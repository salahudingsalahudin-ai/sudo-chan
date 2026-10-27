'use client';

import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { clamp, smoothstep } from '@/lib/heroScene';
import type { StoryWeights } from '@/lib/heroScene';
import { CARD_FONT, drawGlassCard, drawIcon, makeCanvasTexture, roundRectPath } from './cardTextures';
import { PALETTE, makeToonMaterial } from './toon';

type Shared = { weights: MutableRefObject<StoryWeights>; reduced: boolean; mobile: MutableRefObject<boolean> };

const useDispose = (items: THREE.Texture[]) => useEffect(() => () => items.forEach(t => t.dispose()), [items]);

// Shared pop-in: scales a group in and hides it once its scroll window is over (and always on narrow screens).
function usePop(ref: MutableRefObject<THREE.Group | null>, key: keyof StoryWeights, { weights, mobile }: Shared, base = 1) {
  useFrame(() => {
    const group = ref.current;
    if (!group) return;
    const w = weights.current[key];
    group.visible = w > 0.01 && !mobile.current;
    group.scale.setScalar(base * (0.78 + 0.22 * smoothstep(0, 0.9, w)));
  });
}

function fadeMaterial(material: THREE.MeshBasicMaterial | null, w: number) {
  if (material) material.opacity = w;
}

// Scene 02: the wake word.
export function WakeChip(shared: Shared) {
  const group = useRef<THREE.Group>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const texture = useMemo(() => makeCanvasTexture(640, 200, (ctx, w, h) => {
    drawGlassCard(ctx, w, h, PALETTE.listening, 44);
    ctx.fillStyle = PALETTE.listening;
    ctx.beginPath();
    ctx.arc(70, h / 2, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f3fbff';
    ctx.font = `600 46px ${CARD_FONT}`;
    ctx.fillText('Say “Sudo” or “Sid”', 108, h / 2 + 4);
    ctx.fillStyle = '#c3dbe5';
    ctx.font = `400 29px ${CARD_FONT}`;
    ctx.fillText('Mic is on only while listening is on', 108, h / 2 + 50);
  }), []);
  useDispose([texture]);
  usePop(group, 'voice', shared);
  useFrame(() => fadeMaterial(material.current, shared.weights.current.voice));
  return (
    <group ref={group} position={[1.25, 1.15, 0.4]} rotation={[0, -0.25, 0]} visible={false}>
      <mesh><planeGeometry args={[1.4, 0.44]} /><meshBasicMaterial ref={material} map={texture} transparent depthWrite={false} toneMapped={false} /></mesh>
    </group>
  );
}

const cursorShape = (() => {
  const s = new THREE.Shape();
  [[0, 0], [0, -0.26], [0.07, -0.2], [0.115, -0.31], [0.155, -0.295], [0.11, -0.185], [0.2, -0.185]].forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
})();

// Scene 04: an approval card. Only a click can say yes.
export function ApprovalCard(shared: Shared) {
  const group = useRef<THREE.Group>(null);
  const cardMat = useRef<THREE.MeshBasicMaterial>(null);
  const allowMat = useRef<THREE.MeshBasicMaterial>(null);
  const denyMat = useRef<THREE.MeshBasicMaterial>(null);
  const allow = useRef<THREE.Group>(null);
  const cursor = useRef<THREE.Group>(null);
  const cursorMat = useRef<THREE.MeshBasicMaterial>(null);
  const textures = useMemo(() => ({
    card: makeCanvasTexture(760, 460, (ctx, w, h) => {
      drawGlassCard(ctx, w, h, '#9678ff', 48);
      ctx.fillStyle = '#b7a6ff';
      ctx.font = `600 27px ${CARD_FONT}`;
      ctx.fillText('TOOLS  ·  EXAMPLE', 52, 74);
      ctx.fillStyle = '#f3fbff';
      ctx.font = `600 52px ${CARD_FONT}`;
      ctx.fillText('Move 3 files to', 52, 154);
      ctx.fillText('Downloads?', 52, 214);
      ctx.fillStyle = '#c3dbe5';
      ctx.font = `400 29px ${CARD_FONT}`;
      ctx.fillText('Your voice cannot approve this.', 52, 266);
      ctx.fillText('Only your click can.', 52, 304);
    }),
    allow: makeCanvasTexture(256, 96, (ctx, w, h) => {
      roundRectPath(ctx, 4, 4, w - 8, h - 8, 40);
      ctx.fillStyle = '#2fc986';
      ctx.fill();
      ctx.fillStyle = '#04261a';
      ctx.font = `700 40px ${CARD_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('Allow', w / 2, h / 2 + 14);
    }),
    deny: makeCanvasTexture(256, 96, (ctx, w, h) => {
      roundRectPath(ctx, 5, 5, w - 10, h - 10, 40);
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(214,232,240,.7)';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.fillStyle = '#e4f1f6';
      ctx.font = `600 40px ${CARD_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('Deny', w / 2, h / 2 + 14);
    }),
  }), []);
  useDispose(Object.values(textures));
  usePop(group, 'approval', shared);
  useFrame(state => {
    const w = shared.weights.current.approval;
    fadeMaterial(cardMat.current, w);
    fadeMaterial(allowMat.current, w);
    fadeMaterial(denyMat.current, w);
    fadeMaterial(cursorMat.current, w);
    // A looping "you click Allow" story: the pointer glides to Allow, hovers, presses.
    const u = shared.reduced ? 0.7 : (state.clock.elapsedTime % 6) / 6;
    const move = smoothstep(0.08, 0.42, u);
    const press = smoothstep(0.52, 0.56, u) * (1 - smoothstep(0.62, 0.68, u));
    if (cursor.current) {
      cursor.current.position.set(THREE.MathUtils.lerp(1.15, 0.7, move), THREE.MathUtils.lerp(-0.85, -0.36, move), 0.12);
      cursor.current.scale.setScalar(1 - press * 0.12);
    }
    if (allow.current) allow.current.scale.setScalar(1 + smoothstep(0.4, 0.5, u) * 0.04 - press * 0.1);
    if (allowMat.current) allowMat.current.color.setScalar(1 + press * 0.5 + smoothstep(0.4, 0.5, u) * 0.15);
  });
  return (
    <group ref={group} position={[0.1, -0.7, 0.8]} rotation={[0, 0.12, 0]} visible={false}>
      <mesh renderOrder={10}><planeGeometry args={[1.9, 1.15]} /><meshBasicMaterial ref={cardMat} map={textures.card} transparent depthWrite={false} toneMapped={false} /></mesh>
      <mesh position={[-0.12, -0.36, 0.01]} renderOrder={11}><planeGeometry args={[0.6, 0.225]} /><meshBasicMaterial ref={denyMat} map={textures.deny} transparent depthWrite={false} toneMapped={false} /></mesh>
      <group ref={allow} position={[0.62, -0.36, 0.01]}>
        <mesh renderOrder={11}><planeGeometry args={[0.6, 0.225]} /><meshBasicMaterial ref={allowMat} map={textures.allow} transparent depthWrite={false} toneMapped={false} /></mesh>
      </group>
      <group ref={cursor}>
        <mesh position={[0.012, -0.012, -0.002]} scale={1.12} renderOrder={12}><shapeGeometry args={[cursorShape]} /><meshBasicMaterial color="#04101c" transparent depthWrite={false} /></mesh>
        <mesh renderOrder={13}><shapeGeometry args={[cursorShape]} /><meshBasicMaterial ref={cursorMat} color="#ffffff" transparent depthWrite={false} toneMapped={false} /></mesh>
      </group>
    </group>
  );
}

function drawScreen(ctx: CanvasRenderingContext2D, w: number, h: number, fixed: boolean) {
  roundRectPath(ctx, 10, 10, w - 20, h - 20, 40);
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#06131d');
  grad.addColorStop(1, '#0b2130');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(88,200,255,.55)';
  ctx.stroke();
  ctx.font = `600 26px ${CARD_FONT}`;
  ctx.fillStyle = '#9ec4d3';
  ctx.fillText('draft.ts  ·  example only', 52, 78);
  ctx.font = '30px ui-monospace, Menlo, Consolas, monospace';
  const lines: Array<[string, string, string]> = [
    ['01', '#58d9ee', 'const response = await solve(problem);'],
    ['02', '#8ee5b8', 'if (response.success) {'],
    ['03', fixed ? '#84f2c2' : '#ffb49a', fixed ? '  return response.answer;' : '  return response.anser;'],
    ['04', '#8ee5b8', '}'],
  ];
  lines.forEach(([n, color, text], i) => {
    const y = 160 + i * 66;
    ctx.fillStyle = '#58d9ee';
    ctx.fillText(n, 52, y);
    ctx.fillStyle = i === 2 ? color : '#d8e6ec';
    ctx.fillText(text, 112, y);
  });
  ctx.font = '600 30px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = fixed ? '#6ef2c8' : '#ff927a';
  ctx.fillText(fixed ? '✓ fixed · back in your flow' : '⨯ property does not exist', 52, 470);
}

// Scene 05: she looks only after a click. A framed view of "your screen" with a consent button below it.
export function ScreenFrame(shared: Shared & { progress: { current: number } }) {
  const group = useRef<THREE.Group>(null);
  const screenMat = useRef<THREE.MeshBasicMaterial>(null);
  const chipMat = useRef<THREE.MeshBasicMaterial>(null);
  const scan = useRef<THREE.Mesh>(null);
  const scanMat = useRef<THREE.MeshBasicMaterial>(null);
  const bracketMats = useRef<THREE.MeshBasicMaterial[]>([]);
  const textures = useMemo(() => ({
    stuck: makeCanvasTexture(1024, 580, (ctx, w, h) => drawScreen(ctx, w, h, false)),
    fixed: makeCanvasTexture(1024, 580, (ctx, w, h) => drawScreen(ctx, w, h, true)),
    chipA: makeCanvasTexture(640, 150, (ctx, w, h) => {
      drawGlassCard(ctx, w, h, '#58c8ff', 44);
      ctx.fillStyle = '#58c8ff';
      roundRectPath(ctx, 28, 34, 240, 82, 38);
      ctx.fill();
      ctx.fillStyle = '#04202e';
      ctx.font = `700 33px ${CARD_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('Allow one look', 148, 87);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#c3dbe5';
      ctx.font = `400 28px ${CARD_FONT}`;
      ctx.fillText('You click. She looks once.', 298, 83);
    }),
    chipB: makeCanvasTexture(640, 150, (ctx, w, h) => {
      drawGlassCard(ctx, w, h, '#62d9be', 44);
      ctx.fillStyle = '#62d9be';
      ctx.font = `700 38px ${CARD_FONT}`;
      ctx.fillText('✓', 40, 90);
      ctx.fillStyle = '#f3fbff';
      ctx.font = `600 32px ${CARD_FONT}`;
      ctx.fillText('One look, then closed', 96, 78);
      ctx.fillStyle = '#c3dbe5';
      ctx.font = `400 26px ${CARD_FONT}`;
      ctx.fillText('The image is never saved on disk.', 96, 116);
    }),
  }), []);
  useDispose(Object.values(textures));
  usePop(group, 'screen', shared);
  const state = useRef('');
  useFrame(frame => {
    const w = shared.weights.current.screen;
    const fixed = shared.progress.current > 0.665;
    const key = fixed ? 'fixed' : 'stuck';
    if (state.current !== key) {
      state.current = key;
      if (screenMat.current) { screenMat.current.map = fixed ? textures.fixed : textures.stuck; screenMat.current.needsUpdate = true; }
      if (chipMat.current) { chipMat.current.map = fixed ? textures.chipB : textures.chipA; chipMat.current.needsUpdate = true; }
    }
    fadeMaterial(screenMat.current, w);
    fadeMaterial(chipMat.current, w);
    bracketMats.current.forEach(m => fadeMaterial(m, w));
    // One slow scan line sweeps the frame, then rests.
    const u = shared.reduced ? 1 : (frame.clock.elapsedTime % 5) / 5;
    const sweeping = u < 0.6 ? smoothstep(0, 0.1, u) * (1 - smoothstep(0.5, 0.6, u)) : 0;
    if (scan.current) scan.current.position.y = THREE.MathUtils.lerp(0.52, -0.52, clamp(u / 0.6));
    if (scanMat.current) scanMat.current.opacity = sweeping * 0.7 * w;
  });
  const corners: Array<[number, number]> = [[-1, 1], [1, 1], [-1, -1], [1, -1]];
  return (
    <group ref={group} position={[-1.0, 0.25, -0.35]} rotation={[0, 0.2, 0]} visible={false}>
      <mesh renderOrder={10}><planeGeometry args={[2.2, 1.245]} /><meshBasicMaterial ref={screenMat} map={textures.stuck} transparent depthWrite={false} toneMapped={false} /></mesh>
      {corners.map(([sx, sy], i) => (
        <group key={i} position={[sx * 1.16, sy * 0.68, 0.02]}>
          <mesh position={[-sx * 0.09, 0, 0]} renderOrder={11}><boxGeometry args={[0.2, 0.034, 0.02]} /><meshBasicMaterial ref={node => { if (node) bracketMats.current[i * 2] = node; }} color="#58c8ff" transparent toneMapped={false} /></mesh>
          <mesh position={[0, -sy * 0.09, 0]} renderOrder={11}><boxGeometry args={[0.034, 0.2, 0.02]} /><meshBasicMaterial ref={node => { if (node) bracketMats.current[i * 2 + 1] = node; }} color="#58c8ff" transparent toneMapped={false} /></mesh>
        </group>
      ))}
      <mesh ref={scan} position={[0, 0.5, 0.02]} renderOrder={12}><planeGeometry args={[2.1, 0.03]} /><meshBasicMaterial ref={scanMat} color="#8fe9ff" transparent opacity={0} depthWrite={false} toneMapped={false} /></mesh>
      <mesh position={[0.1, -0.98, 0.9]} rotation={[0, -0.1, 0]} renderOrder={13}><planeGeometry args={[1.6, 0.375]} /><meshBasicMaterial ref={chipMat} map={textures.chipA} transparent depthWrite={false} toneMapped={false} /></mesh>
    </group>
  );
}

// Scene 06: privacy. A padlock and the note that matters most: keys stay on her computer.
export function PrivacyLock(shared: Shared) {
  const group = useRef<THREE.Group>(null);
  const lock = useRef<THREE.Group>(null);
  const chipMat = useRef<THREE.MeshBasicMaterial>(null);
  const domeMat = useRef<THREE.MeshBasicMaterial>(null);
  const body = useMemo(() => makeToonMaterial(PALETTE.jacketTrim, { color: PALETTE.cyan, strength: 0.9 }), []);
  const shackle = useMemo(() => makeToonMaterial('#e6ecfa', { color: PALETTE.cyan, strength: 0.6 }), []);
  const chip = useMemo(() => makeCanvasTexture(640, 150, (ctx, w, h) => {
    drawGlassCard(ctx, w, h, '#ffc46b', 44);
    drawIcon(ctx, 'lock', 70, h / 2, 60, '#ffc46b');
    ctx.fillStyle = '#f3fbff';
    ctx.font = `600 34px ${CARD_FONT}`;
    ctx.fillText('Your keys stay', 130, 70);
    ctx.fillText('on your computer', 130, 112);
  }), []);
  useDispose([chip]);
  useEffect(() => () => { body.dispose(); shackle.dispose(); }, [body, shackle]);
  usePop(group, 'lock', shared);
  useFrame(state => {
    const w = shared.weights.current.lock;
    fadeMaterial(chipMat.current, w);
    fadeMaterial(domeMat.current, w * 0.12);
    if (lock.current) lock.current.rotation.y = shared.reduced ? -0.25 : Math.sin(state.clock.elapsedTime * 0.7) * 0.4;
  });
  return (
    <group ref={group} visible={false}>
      <mesh position={[0, 0.2, -0.5]}>
        <sphereGeometry args={[1.75, 32, 22]} />
        <meshBasicMaterial ref={domeMat} color={PALETTE.cyan} wireframe transparent opacity={0.1} depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={lock} position={[1.15, -0.2, 0.55]}>
        <mesh position={[0, 0.34, 0]} material={shackle}><torusGeometry args={[0.2, 0.055, 12, 32, Math.PI]} /></mesh>
        <RoundedBox args={[0.66, 0.52, 0.28]} radius={0.12} smoothness={4} material={body} />
        <mesh position={[0, 0.04, 0.145]}><circleGeometry args={[0.055, 20]} /><meshBasicMaterial color="#8fe9ff" toneMapped={false} /></mesh>
        <mesh position={[0, -0.05, 0.145]}><planeGeometry args={[0.03, 0.1]} /><meshBasicMaterial color="#8fe9ff" toneMapped={false} /></mesh>
      </group>
      <mesh position={[1.1, -0.92, 0.6]} rotation={[0, -0.12, 0]}><planeGeometry args={[1.5, 0.35]} /><meshBasicMaterial ref={chipMat} map={chip} transparent depthWrite={false} toneMapped={false} /></mesh>
    </group>
  );
}
