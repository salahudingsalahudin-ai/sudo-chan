'use client';

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import type { BotMood } from '@/content';
import { clamp } from '@/lib/heroScene';
import type { VoiceDemo } from '@/lib/heroScene';
import { EYE_BLINK_DAMPING } from '../sudoChanConfig';
import type { BotInteractions } from '../SudoChanCanvas';
import { PALETTE, makeToonMaterial } from './toon';

type Pointer = { current: { x: number; y: number; vx: number; vy: number } };
type Props = {
  pointer: Pointer;
  interactions: BotInteractions;
  voice: MutableRefObject<VoiceDemo>;
  progress: { current: number };
};

const MOOD_COLORS: Record<string, string> = {
  calm: PALETTE.idle,
  curious: '#b58cff',
  worried: '#ff9c86',
  happy: '#62f0ce',
};

// Sudo-chan 3D Procedural Companion Robot:
// Pure white porcelain cybernetic bot with dark obsidian visor, glowing cyan eyes,
// signature white smart glasses, antenna orb, floating orbital ring, and chest power core.
// Exactly matching the iconic desktop companion.
export default function CompanionBot({ pointer, interactions, voice, progress }: Props) {
  const head = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const eyeContent = useRef<Array<THREE.Group | null>>([null, null]);
  const irises = useRef<Array<THREE.Group | null>>([null, null]);
  const sclera = useRef<Array<THREE.MeshBasicMaterial | null>>([null, null]);
  const closedEyes = useRef<Array<THREE.Group | null>>([null, null]);
  const smile = useRef<THREE.Mesh>(null);
  const smileMat = useRef<THREE.MeshBasicMaterial>(null);
  const openMouth = useRef<THREE.Mesh>(null);
  const openMouthMat = useRef<THREE.MeshBasicMaterial>(null);
  const blush = useRef<Array<THREE.MeshBasicMaterial | null>>([null, null]);
  const arms = useRef<Array<THREE.Group | null>>([null, null]);
  const antennaBulb = useRef<THREE.MeshBasicMaterial>(null);
  const antennaSpark = useRef<THREE.Mesh>(null);
  const sonicRing1 = useRef<THREE.Mesh>(null);
  const sonicRing2 = useRef<THREE.Mesh>(null);
  const coreGlow = useRef<THREE.MeshBasicMaterial>(null);
  const coreRing = useRef<THREE.Mesh>(null);
  const orbitRing = useRef<THREE.Group>(null);

  const blink = useRef(0);
  const nextBlink = useRef(2.4);
  const happyAmt = useRef(0);
  const mouthOpen = useRef(0);
  const ledColor = useRef(new THREE.Color(PALETTE.idle));
  const target = useRef(new THREE.Color());
  const scratch = useMemo(() => ({ white: new THREE.Color('#ffffff'), red: new THREE.Color('#ff6b7e') }), []);

  const kit = useMemo(() => {
    const rim = { color: '#88ebf2', power: 2.2, strength: 0.45 };
    return {
      shell: makeToonMaterial('#ffffff', rim),
      shellAccent: new THREE.MeshStandardMaterial({ color: '#f0f7fa', roughness: 0.18, metalness: 0.05 }),
      visor: new THREE.MeshPhysicalMaterial({
        color: '#11232e',
        roughness: 0.12,
        metalness: 0.18,
        clearcoat: 1.0,
        clearcoatRoughness: 0.1,
      }),
      visorRim: new THREE.MeshBasicMaterial({ color: '#88bbc7', transparent: true, opacity: 0.45 }),
      outline: new THREE.MeshBasicMaterial({ color: '#151a3d', side: THREE.BackSide }),
      glassesFrame: new THREE.MeshStandardMaterial({
        color: '#ffffff',
        roughness: 0.15,
        metalness: 0.08,
        emissive: '#c7f9ff',
        emissiveIntensity: 0.28,
      }),
      glassesLens: new THREE.MeshPhysicalMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0.14,
        transmission: 0.94,
        roughness: 0.06,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
      }),
      metal: new THREE.MeshStandardMaterial({ color: '#b1cfd7', roughness: 0.25, metalness: 0.65 }),
      watchCase: new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.2, metalness: 0.1 }),
      watchDial: new THREE.MeshBasicMaterial({ color: '#132731' }),
      watchAccent: new THREE.MeshBasicMaterial({ color: '#72d3bf' }),
      orbit: new THREE.MeshBasicMaterial({ color: '#95dce4', transparent: true, opacity: 0.4 }),
      satellite: new THREE.MeshBasicMaterial({ color: '#67d6df' }),
      ground: new THREE.MeshBasicMaterial({ color: '#81a9b6', transparent: true, opacity: 0.15 }),

      geo: {
        head: new THREE.SphereGeometry(0.72, 48, 36),
        // Visor: A sleek horizontal curved capsule spanning the front of the face
        visor: new THREE.CapsuleGeometry(0.24, 0.54, 16, 28),
        eyeOuter: new THREE.CircleGeometry(1, 32),
        eyePupil: new THREE.CircleGeometry(1, 24),
        eyeSparkle: new THREE.CircleGeometry(1, 16),
        closedEye: new THREE.TorusGeometry(0.1, 0.014, 8, 24, Math.PI),
        smile: new THREE.TorusGeometry(0.068, 0.012, 8, 24, Math.PI),
        openMouth: new THREE.CircleGeometry(1, 24),
        blush: new THREE.CircleGeometry(0.065, 16),
        stem: new THREE.CylinderGeometry(0.016, 0.016, 0.32, 16),
        bulb: new THREE.SphereGeometry(0.065, 20, 20),
        sonicRing1: new THREE.TorusGeometry(0.12, 0.008, 8, 32),
        sonicRing2: new THREE.TorusGeometry(0.18, 0.006, 8, 32),
        torso: new THREE.CapsuleGeometry(0.38, 0.3, 12, 28),
        arm: new THREE.CapsuleGeometry(0.08, 0.18, 8, 16),
        coreRing: new THREE.TorusGeometry(0.12, 0.016, 10, 32),
        coreBulb: new THREE.SphereGeometry(0.08, 20, 20),
        orbitRing: new THREE.TorusGeometry(1.36, 0.007, 8, 80),
        satellite: new THREE.SphereGeometry(0.034, 14, 14),
        ground: new THREE.CircleGeometry(0.58, 32),
      },
    };
  }, []);

  useEffect(() => () => {
    Object.values(kit.geo).forEach(g => g.dispose());
    [
      kit.shell,
      kit.shellAccent,
      kit.visor,
      kit.visorRim,
      kit.outline,
      kit.glassesFrame,
      kit.glassesLens,
      kit.metal,
      kit.watchCase,
      kit.watchDial,
      kit.watchAccent,
      kit.orbit,
      kit.satellite,
      kit.ground,
    ].forEach(m => m.dispose());
  }, [kit]);

  const poke = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    interactions.onWelcome();
  };

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const t = state.clock.elapsedTime;
    const ptr = pointer.current;
    const v = voice.current;
    const reduced = interactions.reducedMotion;
    const sleeping = interactions.sleeping;
    const happy = performance.now() < interactions.happyUntilRef.current || interactions.mood === 'Happy';
    const p = progress.current ?? 0;
    const mood = (interactions.mood ?? null) as BotMood | null;
    const moodKey = mood?.toLowerCase() ?? (happy ? 'happy' : p > 0.3 && p < 0.42 ? 'curious' : 'calm');
    happyAmt.current = THREE.MathUtils.damp(happyAmt.current, happy && !sleeping ? 1 : 0, 6, dt);

    // Pointer-follow: head rotates gently, eyes track more intensely
    const gx = reduced ? 0 : ptr.x;
    const gy = reduced ? 0 : ptr.y;
    const tilt = moodKey === 'curious' ? 0.08 : 0;
    if (head.current) {
      head.current.rotation.y = THREE.MathUtils.damp(head.current.rotation.y, gx * 0.32, 5, dt);
      head.current.rotation.x = THREE.MathUtils.damp(head.current.rotation.x, gy * 0.18 + (sleeping ? 0.25 : 0), 5, dt);
      head.current.rotation.z = THREE.MathUtils.damp(head.current.rotation.z, tilt + v.listen * 0.05 + (sleeping ? 0.06 : 0), 4, dt);
      head.current.position.y = 0.58 + (reduced ? 0 : Math.sin(t * 1.5) * 0.014 + v.level * 0.015);
    }
    if (torso.current) {
      const breathe = reduced ? 0 : Math.sin(t * 1.5) * 0.012;
      torso.current.scale.set(1 - breathe * 0.4, 1 + breathe, 1);
      torso.current.position.y = -0.42 + (reduced ? 0 : Math.sin(t * 1.5) * 0.006);
    }

    // Floating orbital ring gently rotates
    if (orbitRing.current && !reduced) {
      orbitRing.current.rotation.z = t * 0.15;
    }

    // Auto-blink + interaction blinks
    if (!reduced && t > nextBlink.current) {
      blink.current = 1;
      nextBlink.current = t + 2.5 + Math.random() * 4;
    }
    blink.current = THREE.MathUtils.damp(blink.current, 0, EYE_BLINK_DAMPING, dt);

    for (let side = 0; side < 2; side++) {
      const amount = interactions.eyeBlinksRef.current[side];
      if (!reduced && !sleeping && interactions.eyeBlinkDirectionsRef.current[side] !== 0) {
        const closing = interactions.eyeBlinkDirectionsRef.current[side] === 1;
        const next = amount + (closing ? 1 : -1) * (dt * 1000) / interactions.eyeBlinkDurationsRef.current[side];
        interactions.eyeBlinksRef.current[side] = clamp(next);
        if (next >= 1) interactions.eyeBlinkDirectionsRef.current[side] = -1;
        if (next <= 0) interactions.eyeBlinkDirectionsRef.current[side] = 0;
      }
      const closed = sleeping ? 1 : Math.max(blink.current, interactions.eyeBlinksRef.current[side]);
      const squint = happyAmt.current * 0.18;

      const eye = eyeContent.current[side];
      const closedEye = closedEyes.current[side];
      if (eye) {
        eye.visible = closed < 0.92;
        eye.scale.y = Math.max(0.06, 1 - closed * 0.94 - squint);
      }
      if (closedEye) {
        closedEye.visible = closed >= 0.92;
      }

      const iris = irises.current[side];
      if (iris) {
        iris.position.x = THREE.MathUtils.damp(iris.position.x, gx * 0.03, 9, dt);
        iris.position.y = THREE.MathUtils.damp(iris.position.y, -gy * 0.024, 9, dt);
      }

      const cheek = blush.current[side];
      if (cheek) {
        cheek.opacity = THREE.MathUtils.damp(cheek.opacity, 0.4 + happyAmt.current * 0.35 + (interactions.redness * 0.15), 5, dt);
      }
    }

    // Mouth animation: cute smile arc at rest, talking plasma oval while speaking
    const speakTarget = sleeping ? 0 : v.speak > 0.05 ? clamp(v.level * 1.35) : 0;
    mouthOpen.current = THREE.MathUtils.damp(mouthOpen.current, speakTarget, 18, dt);
    const isSpeaking = mouthOpen.current > 0.05;

    if (openMouth.current) {
      openMouth.current.visible = isSpeaking;
      openMouth.current.scale.set(0.055 + mouthOpen.current * 0.045, 0.015 + mouthOpen.current * 0.065, 1);
    }
    if (smile.current) {
      smile.current.visible = !isSpeaking;
      const widen = 1 + happyAmt.current * 0.45;
      smile.current.scale.set(widen, 1 + happyAmt.current * 0.6 - (moodKey === 'worried' ? 1.8 : 0), 1);
      smile.current.position.y = -0.15 + (moodKey === 'worried' ? -0.015 : 0);
    }

    // Arms: idle breathing sway, right arm waves when happy
    const wave = happyAmt.current * (reduced ? 0 : 1);
    if (arms.current[1]) {
      arms.current[1]!.rotation.z = THREE.MathUtils.lerp(0.24, 2.3 + Math.sin(t * 8) * 0.28, wave);
    }
    if (arms.current[0]) {
      arms.current[0]!.rotation.z = -0.24 - (reduced ? 0 : Math.sin(t * 1.5) * 0.03);
    }

    // Status colors & cybernetic light pulses
    target.current.set(MOOD_COLORS[moodKey] ?? PALETTE.idle);
    if (v.listen > 0.02) target.current.lerp(new THREE.Color(PALETTE.listening), v.listen);
    if (v.speak > 0.02) target.current.lerp(new THREE.Color(PALETTE.speaking), v.speak);
    ledColor.current.lerp(target.current, Math.min(1, dt * 5));

    const pulse = 1.8 + v.level * 1.5 + (reduced ? 0 : Math.sin(t * 2.2) * 0.15);
    if (antennaBulb.current) {
      antennaBulb.current.color.copy(ledColor.current).multiplyScalar(pulse);
    }
    if (coreGlow.current) {
      coreGlow.current.color.copy(ledColor.current).multiplyScalar(pulse * 0.95);
    }

    // Sonic rings on antenna during voice active
    const isVoiceActive = v.listen > 0.1 || v.speak > 0.1;
    if (sonicRing1.current) {
      sonicRing1.current.visible = isVoiceActive;
      if (isVoiceActive && !reduced) {
        const s = 1 + ((t * 2) % 1) * 0.6;
        sonicRing1.current.scale.set(s, s, s);
      }
    }
    if (sonicRing2.current) {
      sonicRing2.current.visible = isVoiceActive;
      if (isVoiceActive && !reduced) {
        const s = 1 + (((t * 2) + 0.5) % 1) * 0.6;
        sonicRing2.current.scale.set(s, s, s);
      }
    }
  });

  const eyeX = [-0.25, 0.25];

  return (
    <group>
      {/* Ground Shadow */}
      <mesh geometry={kit.geo.ground} material={kit.ground} position={[0, -0.98, 0]} rotation={[-Math.PI / 2, 0, 0]} />

      {/* Floating Cybernetic Orbital Ring */}
      <group ref={orbitRing} position={[0, 0.12, 0]} rotation={[-0.32, 0.12, -0.38]}>
        <mesh geometry={kit.geo.orbitRing} material={kit.orbit} />
        <mesh geometry={kit.geo.satellite} material={kit.satellite} position={[1.36, 0, 0]} />
      </group>

      {/* Torso & Arms */}
      <group ref={torso} position={[0, -0.42, 0]}>
        {/* Chubby White Robot Body Shell */}
        <mesh geometry={kit.geo.torso} material={kit.shell} scale={[1.05, 1, 0.82]} onClick={poke} />

        {/* Chest Power Core (Sudo-chan's Cybernetic Heart) */}
        <group position={[0, 0.02, 0.32]}>
          <mesh ref={coreRing} geometry={kit.geo.coreRing} material={kit.metal} scale={[0.9, 0.9, 0.9]} />
          <mesh geometry={kit.geo.coreBulb} position={[0, 0, -0.01]}>
            <meshBasicMaterial ref={coreGlow} color="#82eef2" toneMapped={false} />
          </mesh>
        </group>

        {/* Left Arm Nub */}
        <group ref={node => { arms.current[0] = node; }} position={[-0.46, 0.08, 0.02]}>
          <mesh geometry={kit.geo.arm} material={kit.shell} position={[0, -0.08, 0]} />
        </group>

        {/* Right Arm Nub with Smartwatch Gadget */}
        <group ref={node => { arms.current[1] = node; }} position={[0.46, 0.08, 0.02]}>
          <mesh geometry={kit.geo.arm} material={kit.shell} position={[0, -0.08, 0]} />
          {/* Smartwatch / Wrist Gadget */}
          <group position={[0.07, -0.12, 0.05]} rotation={[0, 0.6, 0.3]}>
            <mesh material={kit.watchCase}>
              <cylinderGeometry args={[0.045, 0.045, 0.02, 20]} />
            </mesh>
            <mesh position={[0, 0.011, 0]} rotation={[-Math.PI / 2, 0, 0]} material={kit.watchDial}>
              <circleGeometry args={[0.038, 20]} />
            </mesh>
            <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]} material={kit.watchAccent}>
              <circleGeometry args={[0.014, 16]} />
            </mesh>
          </group>
        </group>
      </group>

      {/* Head Group */}
      <group ref={head} position={[0, 0.58, 0]}>
        {/* Pearly White Porcelain Head Shell */}
        <mesh geometry={kit.geo.head} material={kit.shell} scale={[1.08, 0.98, 0.96]} onClick={poke} />

        {/* Sleek Forehead Specular Shine Arc */}
        <mesh position={[-0.26, 0.42, 0.48]} rotation={[0.5, 0.35, 0.2]}>
          <torusGeometry args={[0.42, 0.014, 8, 24, Math.PI * 0.32]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.65} />
        </mesh>

        {/* Top Cybernetic Antenna */}
        <group position={[0, 0.68, 0]}>
          <mesh geometry={kit.geo.stem} material={kit.metal} position={[0, 0.16, 0]} />
          <group position={[0, 0.34, 0]}>
            <mesh geometry={kit.geo.bulb}>
              <meshBasicMaterial ref={antennaBulb} color="#88e4eb" toneMapped={false} />
            </mesh>
            {/* White Sparkle on Antenna Bulb */}
            <mesh ref={antennaSpark} position={[0.035, 0.035, 0.05]}>
              <sphereGeometry args={[0.02, 12, 12]} />
              <meshBasicMaterial color="#ffffff" toneMapped={false} />
            </mesh>
            {/* Sonic Pulse Rings when Voice Active */}
            <mesh ref={sonicRing1} geometry={kit.geo.sonicRing1} visible={false} rotation={[Math.PI / 2, 0, 0]}>
              <meshBasicMaterial color="#38bdf8" transparent opacity={0.7} />
            </mesh>
            <mesh ref={sonicRing2} geometry={kit.geo.sonicRing2} visible={false} rotation={[Math.PI / 2, 0, 0]}>
              <meshBasicMaterial color="#0ea5e9" transparent opacity={0.4} />
            </mesh>
          </group>
        </group>

        {/* Dark Obsidian Visor Screen (Spanning across the face horizontally) */}
        <group position={[0, 0.03, 0.48]} rotation={[0, 0, Math.PI / 2]} scale={[1, 1, 0.48]}>
          <mesh geometry={kit.geo.visor} material={kit.visor} onClick={poke} />
          {/* Subtle Outer Visor Rim Accent */}
          <mesh geometry={kit.geo.visor} material={kit.visorRim} scale={[1.04, 1.03, 1.04]} />
        </group>

        {/* Eyes (Inside the Visor Screen) */}
        {eyeX.map((x, side) => (
          <group key={side} position={[x, 0.04, 0.64]}>
            {/* Open / Interactive Eye */}
            <group ref={node => { eyeContent.current[side] = node; }}>
              {/* Outer Cyan Glowing Sclera */}
              <mesh scale={[0.13, 0.18, 1]} position={[0, 0, 0]}>
                <circleGeometry args={[1, 32]} />
                <meshBasicMaterial
                  ref={node => { sclera.current[side] = node; }}
                  color="#9af6f3"
                  toneMapped={false}
                />
              </mesh>
              {/* Inner Dark Teal Pupil (Tracks Pointer) */}
              <group ref={node => { irises.current[side] = node; }} position={[0, 0, 0.003]}>
                <mesh scale={[0.07, 0.11, 1]}>
                  <circleGeometry args={[1, 24]} />
                  <meshBasicMaterial color="#174951" toneMapped={false} />
                </mesh>
                {/* Crisp White Primary Sparkle Highlight */}
                <mesh position={[-0.035, 0.045, 0.003]} scale={[0.034, 0.034, 1]}>
                  <circleGeometry args={[1, 16]} />
                  <meshBasicMaterial color="#ffffff" toneMapped={false} />
                </mesh>
                {/* Secondary Subtle Specular Glint */}
                <mesh position={[0.03, -0.04, 0.003]} scale={[0.016, 0.016, 1]}>
                  <circleGeometry args={[1, 12]} />
                  <meshBasicMaterial color="#e8ffff" toneMapped={false} />
                </mesh>
              </group>
              {/* Interactive Hover / Click hit plane */}
              <mesh
                position={[0, 0, 0.02]}
                onPointerOver={() => interactions.onEyeHover(side as 0 | 1)}
                onPointerEnter={() => { document.body.style.cursor = 'pointer'; }}
                onPointerLeave={() => { document.body.style.cursor = ''; }}
                onClick={event => { event.stopPropagation(); interactions.onEyeClick(side as 0 | 1); }}
              >
                <circleGeometry args={[0.2, 12]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            </group>

            {/* Closed Sleeping Eye Arc */}
            <group ref={node => { closedEyes.current[side] = node; }} visible={false} position={[0, -0.02, 0.004]}>
              <mesh geometry={kit.geo.closedEye}>
                <meshBasicMaterial color="#9cf3ec" toneMapped={false} />
              </mesh>
            </group>
          </group>
        ))}

        {/* Soft Pink Blush Spots on Visor Edges */}
        {eyeX.map((x, side) => (
          <mesh
            key={side}
            position={[x * 1.68, -0.07, 0.58]}
            rotation={[0, side === 0 ? -0.4 : 0.4, 0]}
            scale={[1.3, 0.75, 1]}
          >
            <circleGeometry args={[0.065, 16]} />
            <meshBasicMaterial
              ref={node => { blush.current[side] = node; }}
              color="#ff9aa8"
              transparent
              opacity={0.4}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        ))}

        {/* Mouth (Inside Lower Visor) */}
        <group position={[0, -0.15, 0.645]}>
          {/* Resting Cute Cyan Smile Arc */}
          <mesh ref={smile} geometry={kit.geo.smile} rotation={[0, 0, Math.PI]}>
            <meshBasicMaterial ref={smileMat} color="#9cf3ec" toneMapped={false} />
          </mesh>
          {/* Speaking Animated Glowing Plasma Oval */}
          <mesh ref={openMouth} geometry={kit.geo.openMouth} visible={false} scale={[0.06, 0.02, 1]}>
            <meshBasicMaterial ref={openMouthMat} color="#38bdf8" toneMapped={false} />
          </mesh>
        </group>

        {/* Sudo-chan Signature Cute Round Smart Glasses (Framing Eyes Over Visor) */}
        <group position={[0, 0.04, 0.655]}>
          {/* Left Frame */}
          <mesh position={[-0.25, 0, 0.015]}>
            <torusGeometry args={[0.165, 0.015, 16, 48]} />
            <primitive object={kit.glassesFrame} />
          </mesh>
          {/* Left Lens with subtle specular sheen */}
          <mesh position={[-0.25, 0, 0.012]}>
            <circleGeometry args={[0.16, 32]} />
            <primitive object={kit.glassesLens} />
          </mesh>

          {/* Right Frame */}
          <mesh position={[0.25, 0, 0.015]}>
            <torusGeometry args={[0.165, 0.015, 16, 48]} />
            <primitive object={kit.glassesFrame} />
          </mesh>
          {/* Right Lens with subtle specular sheen */}
          <mesh position={[0.25, 0, 0.012]}>
            <circleGeometry args={[0.16, 32]} />
            <primitive object={kit.glassesLens} />
          </mesh>

          {/* Arched Nose Bridge */}
          <mesh position={[0, 0.02, 0.015]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.012, 0.012, 0.17, 16]} />
            <primitive object={kit.glassesFrame} />
          </mesh>

          {/* Side Temples extending along the visor curvature */}
          <mesh position={[-0.43, 0.005, -0.16]} rotation={[0, 0.32, 0]}>
            <cylinderGeometry args={[0.01, 0.01, 0.38, 16]} />
            <primitive object={kit.glassesFrame} />
          </mesh>
          <mesh position={[0.43, 0.005, -0.16]} rotation={[0, -0.32, 0]}>
            <cylinderGeometry args={[0.01, 0.01, 0.38, 16]} />
            <primitive object={kit.glassesFrame} />
          </mesh>
        </group>
      </group>
    </group>
  );
}
