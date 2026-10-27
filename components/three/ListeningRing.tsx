'use client';

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { clamp } from '@/lib/heroScene';
import type { StoryWeights, VoiceDemo } from '@/lib/heroScene';
import { PALETTE } from './toon';

const BARS = 56;

function makeGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,255,255,.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// The glow ring behind her. Same colours as the desktop companion: green = listening, violet = speaking, soft teal = standby.
export default function ListeningRing({ voice, weights, reduced }: { voice: MutableRefObject<VoiceDemo>; weights: MutableRefObject<StoryWeights>; reduced: boolean }) {
  const bars = useRef<THREE.InstancedMesh>(null);
  const glow = useRef<THREE.Mesh>(null);
  const glowMat = useRef<THREE.MeshBasicMaterial>(null);
  const line = useRef<THREE.MeshBasicMaterial>(null);
  const ripples = useRef<Array<THREE.Mesh | null>>([null, null]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useRef(new THREE.Color(PALETTE.idle));
  const target = useMemo(() => new THREE.Color(), []);
  const listenColor = useMemo(() => new THREE.Color(PALETTE.listening), []);
  const speakColor = useMemo(() => new THREE.Color(PALETTE.speaking), []);
  const texture = useMemo(() => makeGlowTexture(), []);
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const t = state.clock.elapsedTime;
    const v = voice.current;
    const emphasis = weights.current.voice;
    target.set(PALETTE.idle).lerp(listenColor, v.listen).lerp(speakColor, v.speak);
    color.current.lerp(target, Math.min(1, dt * 6));
    const level = v.level;
    const radius = 1.32 + emphasis * 0.14;
    const mesh = bars.current;
    if (mesh) {
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2;
        const wave = 0.5 + 0.5 * Math.sin(a * 5 + t * 4.2) * Math.sin(a * 3 - t * 2.3 + 1.7);
        const len = 0.05 + (reduced ? 0 : (level * (0.34 + emphasis * 0.18) * (0.35 + wave) + (Math.sin(t * 1.4 + i * 0.7) * 0.5 + 0.5) * 0.018));
        const r = radius + len / 2;
        dummy.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
        dummy.rotation.set(0, 0, a + Math.PI / 2);
        dummy.scale.set(1, len, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.material as THREE.MeshBasicMaterial).color.copy(color.current).multiplyScalar(1.5);
    }
    if (glowMat.current) {
      glowMat.current.color.copy(color.current);
      glowMat.current.opacity = 0.2 + v.listen * 0.12 + v.speak * 0.14 + level * 0.2 + (reduced ? 0 : Math.sin(t * 1.2) * 0.02);
    }
    if (glow.current) glow.current.scale.setScalar(1 + level * 0.08);
    if (line.current) line.current.color.copy(color.current);
    ripples.current.forEach((ripple, i) => {
      if (!ripple) return;
      const phase = reduced ? 0 : ((t * 0.55 + i * 0.5) % 1);
      const active = v.listen > 0.3 ? 1 : 0;
      ripple.visible = active > 0 && !reduced;
      ripple.scale.setScalar(1 + phase * 0.35);
      const mat = ripple.material as THREE.MeshBasicMaterial;
      mat.color.copy(color.current);
      mat.opacity = clamp(1 - phase) * 0.45 * v.listen;
    });
  });

  return (
    <group position={[0, 0.25, -0.75]}>
      <mesh ref={glow} scale={1}>
        <planeGeometry args={[4.3, 4.3]} />
        <meshBasicMaterial ref={glowMat} map={texture} transparent opacity={0.25} depthWrite={false} toneMapped={false} color={PALETTE.idle} />
      </mesh>
      <mesh>
        <torusGeometry args={[1.26, 0.012, 6, 96]} />
        <meshBasicMaterial ref={line} transparent opacity={0.6} depthWrite={false} toneMapped={false} color={PALETTE.idle} />
      </mesh>
      {[0, 1].map(i => (
        <mesh key={i} ref={node => { ripples.current[i] = node; }} visible={false}>
          <torusGeometry args={[1.26, 0.01, 6, 96]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} toneMapped={false} color={PALETTE.listening} />
        </mesh>
      ))}
      <instancedMesh ref={bars} args={[undefined, undefined, BARS]} frustumCulled={false}>
        <boxGeometry args={[0.034, 1, 0.02]} />
        <meshBasicMaterial toneMapped={false} color={PALETTE.idle} />
      </instancedMesh>
    </group>
  );
}
