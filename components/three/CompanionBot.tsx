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
import { PALETTE, getIrisTexture, makeToonMaterial } from './toon';

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

// Mesh with a dark inverted-hull outline: the cheap trick behind most anime-style 3D.
function Outlined({ geometry, material, outline, hull = 0.04, ...rest }: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  outline: THREE.Material;
  hull?: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number] | number;
  onClick?: (event: { stopPropagation: () => void }) => void;
}) {
  const { onClick, ...transform } = rest;
  return (
    <group {...transform}>
      <mesh geometry={geometry} material={material} onClick={onClick} />
      <mesh geometry={geometry} material={outline} scale={1 + hull} />
    </group>
  );
}

export default function CompanionBot({ pointer, interactions, voice, progress }: Props) {
  const head = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const eyeContent = useRef<Array<THREE.Group | null>>([null, null]);
  const irises = useRef<Array<THREE.Group | null>>([null, null]);
  const sclera = useRef<Array<THREE.MeshBasicMaterial | null>>([null, null]);
  const brows = useRef<Array<THREE.Mesh | null>>([null, null]);
  const smile = useRef<THREE.Mesh>(null);
  const smileMat = useRef<THREE.MeshBasicMaterial>(null);
  const openMouth = useRef<THREE.Mesh>(null);
  const blush = useRef<Array<THREE.MeshBasicMaterial | null>>([null, null]);
  const ahoge = useRef<THREE.Group>(null);
  const locks = useRef<Array<THREE.Group | null>>([null, null]);
  const arms = useRef<Array<THREE.Group | null>>([null, null]);
  const leds = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const blink = useRef(0);
  const nextBlink = useRef(2.4);
  const happyAmt = useRef(0);
  const mouthOpen = useRef(0);
  const ledColor = useRef(new THREE.Color(PALETTE.idle));
  const target = useRef(new THREE.Color());
  const scratch = useMemo(() => ({ white: new THREE.Color('#ffffff'), red: new THREE.Color('#ff6b7e') }), []);

  const kit = useMemo(() => {
    const rim = { color: PALETTE.cyan, power: 2.2, strength: 0.75 };
    return {
      skin: makeToonMaterial(PALETTE.skin, { ...rim, strength: 0.45 }),
      hair: Object.assign(makeToonMaterial(PALETTE.hair, rim), { side: THREE.DoubleSide }),
      hairLight: makeToonMaterial(PALETTE.hairLight, rim),
      jacket: makeToonMaterial(PALETTE.jacket, { ...rim, strength: 0.6 }),
      trim: makeToonMaterial(PALETTE.jacketTrim, rim),
      outline: new THREE.MeshBasicMaterial({ color: PALETTE.outline, side: THREE.BackSide }),
      ink: new THREE.MeshBasicMaterial({ color: PALETTE.outline }),
      iris: new THREE.MeshBasicMaterial({ map: getIrisTexture(), toneMapped: false }),
      geo: {
        face: new THREE.SphereGeometry(0.7, 48, 36),
        hairBack: new THREE.SphereGeometry(0.8, 40, 28, Math.PI - 0.34, Math.PI + 0.68, 0, 2.35),
        hairCap: new THREE.SphereGeometry(0.79, 40, 20, 0, Math.PI * 2, 0, 1.08),
        bang: new THREE.ConeGeometry(0.1, 0.44, 8, 1),
        lock: new THREE.CapsuleGeometry(0.1, 0.5, 6, 10),
        cup: new THREE.CylinderGeometry(0.2, 0.2, 0.14, 24),
        torso: new THREE.CapsuleGeometry(0.42, 0.34, 8, 24),
        sleeve: new THREE.CapsuleGeometry(0.13, 0.26, 6, 12),
        hand: new THREE.SphereGeometry(0.11, 16, 12),
        ahoge: new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.05, 0.2, 0), new THREE.Vector3(-0.07, 0.38, 0), new THREE.Vector3(0.08, 0.54, 0)]),
          24, 0.02, 8, false,
        ),
      },
    };
  }, []);

  useEffect(() => () => {
    Object.values(kit.geo).forEach(g => g.dispose());
    [kit.skin, kit.hair, kit.hairLight, kit.jacket, kit.trim, kit.outline, kit.ink, kit.iris].forEach(m => m.dispose());
  }, [kit]);

  const led = (index: number) => (node: THREE.MeshBasicMaterial | null) => { leds.current[index] = node; };
  const poke = (event: { stopPropagation: () => void }) => { event.stopPropagation(); interactions.onWelcome(); };

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

    // Pointer-follow: the head turns a little, the irises turn more.
    const gx = reduced ? 0 : ptr.x;
    const gy = reduced ? 0 : ptr.y;
    const tilt = moodKey === 'curious' ? 0.1 : 0;
    if (head.current) {
      head.current.rotation.y = THREE.MathUtils.damp(head.current.rotation.y, gx * 0.34, 5, dt);
      head.current.rotation.x = THREE.MathUtils.damp(head.current.rotation.x, gy * 0.2 + (sleeping ? 0.28 : 0), 5, dt);
      head.current.rotation.z = THREE.MathUtils.damp(head.current.rotation.z, tilt + v.listen * 0.05 + (sleeping ? 0.08 : 0), 4, dt);
      head.current.position.y = 0.62 + (reduced ? 0 : Math.sin(t * 1.5) * 0.012 + v.level * 0.014);
    }
    if (torso.current) {
      const breathe = reduced ? 0 : Math.sin(t * 1.5) * 0.012;
      torso.current.scale.set(1 - breathe * 0.5, 1 + breathe, 1);
    }

    // Blink: random auto blink + the interaction blinks (hover/click) coming from the page.
    if (!reduced && t > nextBlink.current) { blink.current = 1; nextBlink.current = t + 2.4 + Math.random() * 4.2; }
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
      const squint = happyAmt.current * 0.16;
      const eye = eyeContent.current[side];
      if (eye) eye.scale.y = Math.max(0.06, 1 - closed * 0.94 - squint);
      const iris = irises.current[side];
      if (iris) {
        iris.position.x = THREE.MathUtils.damp(iris.position.x, gx * 0.034, 9, dt);
        iris.position.y = THREE.MathUtils.damp(iris.position.y, -gy * 0.026, 9, dt);
      }
      const white = sclera.current[side];
      if (white) white.color.copy(scratch.white).lerp(scratch.red, interactions.rednessRef.current);
      const brow = brows.current[side];
      if (brow) {
        const dir = side === 0 ? 1 : -1;
        const worried = moodKey === 'worried' ? 0.32 : 0;
        const curious = moodKey === 'curious' && side === 1 ? 0.035 : 0;
        brow.rotation.z = THREE.MathUtils.damp(brow.rotation.z, dir * (0.06 + worried) - dir * happyAmt.current * 0.05, 6, dt);
        brow.position.y = THREE.MathUtils.damp(brow.position.y, 0.275 + curious + happyAmt.current * 0.015, 6, dt);
      }
      const cheek = blush.current[side];
      if (cheek) cheek.opacity = THREE.MathUtils.damp(cheek.opacity, 0.32 + happyAmt.current * 0.4 + (interactions.redness * 0.15), 5, dt);
    }

    // Mouth: smile arc at rest, open ellipse while she "talks".
    const speakTarget = sleeping ? 0 : v.speak > 0.05 ? clamp(v.level * 1.25) : 0;
    mouthOpen.current = THREE.MathUtils.damp(mouthOpen.current, speakTarget, 18, dt);
    if (openMouth.current) {
      const open = mouthOpen.current;
      openMouth.current.visible = open > 0.06;
      openMouth.current.scale.set(0.055 + open * 0.035, 0.012 + open * 0.06, 1);
    }
    if (smile.current && smileMat.current) {
      const widen = 1 + happyAmt.current * 0.5;
      smile.current.visible = mouthOpen.current <= 0.06;
      smile.current.scale.set(widen, 1 + happyAmt.current * 0.8 - (moodKey === 'worried' ? 1.9 : 0), 1);
      smile.current.position.y = moodKey === 'worried' ? -0.02 : 0;
    }

    // Hair and ahoge sway, arms: gentle idle, right hand waves when she is happy.
    if (ahoge.current) ahoge.current.rotation.z = reduced ? 0 : Math.sin(t * 1.3) * 0.08 + Math.sin(t * 2.6) * 0.03 + v.level * 0.1;
    locks.current.forEach((lock, i) => {
      if (lock) lock.rotation.z = (i === 0 ? 1 : -1) * (0.08 + (reduced ? 0 : Math.sin(t * 1.1 + i) * 0.03)) + gx * 0.05;
    });
    const wave = happyAmt.current * (reduced ? 0 : 1);
    if (arms.current[1]) arms.current[1]!.rotation.z = THREE.MathUtils.lerp(0.28, 2.35 + Math.sin(t * 8) * 0.28, wave);
    if (arms.current[0]) arms.current[0]!.rotation.z = -0.28 - (reduced ? 0 : Math.sin(t * 1.5) * 0.03);

    // Status lights: mood colour at rest, green while listening, violet while speaking (same as the desktop glow).
    target.current.set(MOOD_COLORS[moodKey] ?? PALETTE.idle);
    if (v.listen > 0.02) target.current.lerp(new THREE.Color(PALETTE.listening), v.listen);
    if (v.speak > 0.02) target.current.lerp(new THREE.Color(PALETTE.speaking), v.speak);
    ledColor.current.lerp(target.current, Math.min(1, dt * 5));
    const pulse = 1.4 + v.level * 1.8 + (reduced ? 0 : Math.sin(t * 2.2) * 0.18);
    leds.current.forEach(m => { if (m) m.color.copy(ledColor.current).multiplyScalar(pulse); });
  });

  const eyeX = [-0.29, 0.29];
  return (
    <group>
      {/* Body */}
      <group ref={torso} position={[0, -0.5, 0]}>
        <Outlined geometry={kit.geo.torso} material={kit.jacket} outline={kit.outline} hull={0.06} scale={[1.02, 1, 0.72]} onClick={poke} />
        <mesh position={[0, -0.33, 0.01]} scale={[1, 0.18, 0.74]} material={kit.trim}><torusGeometry args={[0.43, 0.09, 10, 36]} /></mesh>
        <mesh position={[0, 0.3, 0.02]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.8]} material={kit.trim}><torusGeometry args={[0.2, 0.05, 10, 32]} /></mesh>
        <mesh position={[0, -0.04, 0.3]}><sphereGeometry args={[0.075, 16, 16]} /><meshBasicMaterial ref={led(0)} toneMapped={false} color={PALETTE.idle} /></mesh>
        <mesh position={[0, -0.04, 0.29]}><torusGeometry args={[0.12, 0.012, 8, 32]} /><meshBasicMaterial ref={led(1)} toneMapped={false} color={PALETTE.idle} transparent opacity={0.8} /></mesh>
        {[0, 1].map(side => (
          <group key={side} ref={node => { arms.current[side] = node; }} position={[side === 0 ? -0.5 : 0.5, 0.18, 0.02]}>
            <Outlined geometry={kit.geo.sleeve} material={kit.jacket} outline={kit.outline} hull={0.1} position={[0, -0.2, 0]} />
            <Outlined geometry={kit.geo.hand} material={kit.skin} outline={kit.outline} hull={0.12} position={[0, -0.42, 0]} />
          </group>
        ))}
      </group>

      {/* Head */}
      <group ref={head} position={[0, 0.62, 0]}>
        <Outlined geometry={kit.geo.face} material={kit.skin} outline={kit.outline} hull={0.035} scale={[1.08, 0.98, 0.96]} onClick={poke} />
        <mesh geometry={kit.geo.hairBack} material={kit.hair} position={[0, 0.07, -0.06]} scale={[1.06, 1.02, 1]} />
        <mesh geometry={kit.geo.hairBack} material={kit.outline} position={[0, 0.07, -0.06]} scale={[1.1, 1.06, 1.04]} />
        <group position={[0, 0.07, -0.02]} rotation={[0.22, 0, 0]}>
          <mesh geometry={kit.geo.hairCap} material={kit.hair} onClick={poke} />
          <mesh geometry={kit.geo.hairCap} material={kit.outline} scale={1.045} />
        </group>
        {/* Fringe */}
        {[-0.54, -0.36, -0.18, 0, 0.18, 0.36, 0.54].map((x, i) => (
          <mesh
            key={x}
            geometry={kit.geo.bang}
            material={i % 3 === 1 ? kit.hairLight : kit.hair}
            position={[x * 1.02, 0.4 - Math.abs(x) * 0.12, Math.sqrt(Math.max(0.1, 0.624 - 0.109 - x * x * 1.04)) + 0.05]}
            rotation={[Math.PI - 0.12, x * -0.25, x * 0.5]}
            scale={[1, i % 2 ? 0.88 : 1, 0.5]}
          />
        ))}
        {/* Side locks */}
        {[0, 1].map(side => (
          <group key={side} ref={node => { locks.current[side] = node; }} position={[side === 0 ? -0.78 : 0.78, 0.1, 0.1]}>
            <Outlined geometry={kit.geo.lock} material={kit.hair} outline={kit.outline} hull={0.1} position={[0, -0.3, 0]} />
            <mesh position={[0, -0.64, 0]} material={kit.hairLight}><sphereGeometry args={[0.085, 12, 10]} /></mesh>
          </group>
        ))}
        {/* Ahoge: a single hair strand with a status light on the tip */}
        <group ref={ahoge} position={[0, 0.84, 0.02]}>
          <mesh geometry={kit.geo.ahoge} material={kit.hair} />
          <mesh position={[0.08, 0.57, 0]}><sphereGeometry args={[0.06, 14, 12]} /><meshBasicMaterial ref={led(2)} toneMapped={false} color={PALETTE.idle} /></mesh>
        </group>
        {/* Headphones */}
        <mesh position={[0, 0.04, 0]} rotation={[0, 0, 0]} material={kit.jacket}><torusGeometry args={[0.9, 0.03, 8, 48, Math.PI]} /></mesh>
        {[-1, 1].map(s => (
          <group key={s} position={[s * 0.84, -0.02, 0]}>
            <Outlined geometry={kit.geo.cup} material={kit.jacket} outline={kit.outline} hull={0.1} rotation={[0, 0, Math.PI / 2]} />
            <mesh position={[s * 0.08, 0, 0]} rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[0.12, 0.018, 8, 32]} /><meshBasicMaterial ref={led(3 + (s + 1) / 2)} toneMapped={false} color={PALETTE.idle} /></mesh>
          </group>
        ))}
        {/* Hair clip: a little ">_" prompt */}
        <group position={[-0.46, 0.5, 0.56]} rotation={[0, -0.5, 0.18]}>
          <mesh position={[0, 0.03, 0]} rotation={[0, 0, 0.7]}><boxGeometry args={[0.13, 0.028, 0.03]} /><meshBasicMaterial ref={led(5)} toneMapped={false} color={PALETTE.idle} /></mesh>
          <mesh position={[0, -0.03, 0]} rotation={[0, 0, -0.7]}><boxGeometry args={[0.13, 0.028, 0.03]} /><meshBasicMaterial ref={led(6)} toneMapped={false} color={PALETTE.idle} /></mesh>
          <mesh position={[0.11, -0.065, 0]}><boxGeometry args={[0.1, 0.026, 0.03]} /><meshBasicMaterial ref={led(7)} toneMapped={false} color={PALETTE.idle} /></mesh>
        </group>

        {/* Face */}
        {eyeX.map((x, side) => (
          <group key={side} position={[x, 0.17, 0.627]} rotation={[0, side === 0 ? -0.26 : 0.26, 0]}>
            <group ref={node => { eyeContent.current[side] = node; }}>
              <mesh position={[0, -0.2, 0]} scale={[0.17, 0.205, 1]}>
                <circleGeometry args={[1, 32]} />
                <meshBasicMaterial ref={node => { sclera.current[side] = node; }} color="#ffffff" toneMapped={false} />
              </mesh>
              <group ref={node => { irises.current[side] = node; }} position={[0, -0.2, 0.004]}>
                <mesh scale={[0.135, 0.17, 1]} material={kit.iris}><circleGeometry args={[1, 32]} /></mesh>
                <mesh position={[0, 0, 0.003]} scale={[0.06, 0.085, 1]} material={kit.ink}><circleGeometry args={[1, 24]} /></mesh>
                <mesh position={[-0.045, 0.06, 0.006]}><circleGeometry args={[0.04, 16]} /><meshBasicMaterial color="#ffffff" toneMapped={false} /></mesh>
                <mesh position={[0.04, -0.06, 0.006]}><circleGeometry args={[0.02, 12]} /><meshBasicMaterial color="#e8ffff" toneMapped={false} /></mesh>
              </group>
              {/* Click targets for the eye hover/click playfulness */}
              <mesh
                position={[0, -0.2, 0.03]}
                onPointerOver={() => interactions.onEyeHover(side as 0 | 1)}
                onPointerEnter={() => { document.body.style.cursor = 'pointer'; }}
                onPointerLeave={() => { document.body.style.cursor = ''; }}
                onClick={event => { event.stopPropagation(); interactions.onEyeClick(side as 0 | 1); }}
              >
                <circleGeometry args={[0.2, 12]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            </group>
            {/* Upper lid line with a small lash wing */}
            <mesh position={[0, -0.2, 0.012]} rotation={[0, 0, 0.126]} scale={[1, 1.1, 1]} material={kit.ink}><torusGeometry args={[0.185, 0.017, 6, 28, Math.PI * 0.92]} /></mesh>
            <mesh position={[(side === 0 ? -1 : 1) * 0.2, -0.12, 0.012]} rotation={[0, 0, (side === 0 ? 1 : -1) * 0.55]} material={kit.ink}><boxGeometry args={[0.08, 0.02, 0.01]} /></mesh>
          </group>
        ))}
        {eyeX.map((x, side) => (
          <mesh key={side} ref={node => { brows.current[side] = node; }} position={[x * 1.04, 0.275, 0.64]} rotation={[0, side === 0 ? -0.3 : 0.3, 0]} material={kit.hair}>
            <capsuleGeometry args={[0.012, 0.11, 4, 8]} />
          </mesh>
        ))}
        {eyeX.map((x, side) => (
          <mesh key={side} position={[x * 1.5, -0.09, 0.52]} rotation={[0, side === 0 ? -0.8 : 0.8, 0]} scale={[1.4, 0.8, 1]}>
            <circleGeometry args={[0.07, 16]} />
            <meshBasicMaterial ref={node => { blush.current[side] = node; }} color={PALETTE.blush} transparent opacity={0.35} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
        <group position={[0, -0.25, 0.618]}>
          <mesh ref={smile} rotation={[0, 0, Math.PI]}><torusGeometry args={[0.05, 0.011, 6, 20, Math.PI]} /><meshBasicMaterial ref={smileMat} color={PALETTE.outline} toneMapped={false} /></mesh>
          <mesh ref={openMouth} visible={false} position={[0, -0.01, 0.002]} scale={[0.06, 0.02, 1]}>
            <circleGeometry args={[1, 20]} />
            <meshBasicMaterial color="#7a2646" toneMapped={false} />
          </mesh>
        </group>
      </group>
    </group>
  );
}
