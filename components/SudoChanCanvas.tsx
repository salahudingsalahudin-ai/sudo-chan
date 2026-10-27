'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { Sparkles } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject, ReactNode } from 'react';
import * as THREE from 'three';
import type { BotMood } from '@/content';
import { isLowPower, sampleJourneyPose, sampleStoryWeights, sampleVoiceDemo, smoothstep, stageDepth } from '@/lib/heroScene';
import type { StoryWeights, VoiceDemo } from '@/lib/heroScene';
import CompanionBot from './three/CompanionBot';
import FloatingCards from './three/FloatingCards';
import GlbBot from './three/GlbBot';
import ListeningRing from './three/ListeningRing';
import { ApprovalCard, PrivacyLock, ScreenFrame, WakeChip } from './three/StoryProps';

type EyeSide = 0 | 1;
export type BotInteractions = {
  reducedMotion: boolean;
  mood: BotMood | null;
  sleeping: boolean;
  redness: number;
  sleepingRef: MutableRefObject<boolean>;
  rednessRef: MutableRefObject<number>;
  happyUntilRef: MutableRefObject<number>;
  eyeBlinksRef: MutableRefObject<[number, number]>;
  eyeBlinkDirectionsRef: MutableRefObject<[number, number]>;
  eyeBlinkDurationsRef: MutableRefObject<[number, number]>;
  onWelcome: () => void;
  onEyeHover: (side: EyeSide) => boolean;
  onEyeClick: (side: EyeSide) => void;
};

type Progress = { current: number };
type Pointer = { current: { x: number; y: number; vx: number; vy: number } };
type SceneProps = {
  progress: Progress;
  pointer: Pointer;
  interactions: BotInteractions;
  quietDayActive: boolean;
  quietDayMoment: number | null;
};

const ZERO_WEIGHTS: StoryWeights = { cards: 0, voice: 0, approval: 0, screen: 0, lock: 0 };

// Writes the made-up listening/speaking demo (and the scroll-story weights) into refs once per frame, before anything reads them.
function StoryClock({ progress, voice, weights, reduced, quiet, mobile }: { progress: Progress; voice: MutableRefObject<VoiceDemo>; weights: MutableRefObject<StoryWeights>; reduced: boolean; quiet: boolean; mobile: MutableRefObject<boolean> }) {
  const smooth = useRef(progress.current ?? 0);
  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    smooth.current = THREE.MathUtils.damp(smooth.current, progress.current ?? 0, 6.5, dt);
    mobile.current = state.size.width < 768;
    const w = quiet ? ZERO_WEIGHTS : sampleStoryWeights(smooth.current);
    weights.current = w;
    const demo = sampleVoiceDemo(state.clock.elapsedTime, reduced);
    // In the voice scene she is shown listening, whatever the idle cycle is doing.
    const forced = w.voice;
    const wobble = 0.3 + 0.25 * Math.sin(state.clock.elapsedTime * 7.3) * Math.sin(state.clock.elapsedTime * 2.9);
    const listen = Math.max(demo.listen, forced * 0.9);
    voice.current = {
      mode: demo.speak > 0.5 ? 'speaking' : listen > 0.5 ? 'listening' : 'idle',
      listen,
      speak: demo.speak,
      level: reduced ? 0 : Math.max(demo.level, forced * wobble),
    };
  });
  return null;
}

// Moves the whole character (and everything attached to her) through the scroll story.
function Rig({ progress, pointer, interactions, quietDayActive, quietDayMoment, voice, weights, mobileRef, children }: SceneProps & { voice: MutableRefObject<VoiceDemo>; weights: MutableRefObject<StoryWeights>; mobileRef: MutableRefObject<boolean>; children: ReactNode }) {
  const root = useRef<THREE.Group>(null);
  const smooth = useRef(progress.current ?? 0);
  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    smooth.current = THREE.MathUtils.damp(smooth.current, progress.current ?? 0, 6.5, dt);
    const p = smooth.current;
    const mobile = mobileRef.current;
    const pose = sampleJourneyPose(p);
    const bob = interactions.reducedMotion ? 0 : Math.sin(state.clock.elapsedTime * 0.85) * 0.035;
    const viewW = state.viewport.width;
    const heroOnly = 1 - smoothstep(0.035, 0.085, p);
    let x = pose.side * viewW;
    let y = pose.y + bob;
    let scale = pose.scale;
    let rotY = pose.rotY;
    let rotX = pose.rotX;
    let camZ = pose.camZ;
    if (quietDayActive) {
      x = mobile ? 0.32 : viewW * 0.2;
      y = mobile ? -0.25 : 0;
      scale = mobile ? 0.72 : 0.95;
      rotY = -0.22;
      rotX = 0;
      camZ = mobile ? 6.3 : 6.1;
    } else if (mobile) {
      // Phones and narrow windows: she sits above the text and steps out of the way once the hero is over.
      x = 0;
      y = 1.0 + bob;
      scale = 0.6 * Math.max(heroOnly, 0.0001);
      rotY = 0;
      rotX = 0.04;
      camZ = 7.1;
    }
    const g = root.current;
    if (g) {
      g.position.x = THREE.MathUtils.damp(g.position.x, x, 5.2, dt);
      g.position.y = THREE.MathUtils.damp(g.position.y, y - 0.5 * scale, 5.2, dt);
      g.position.z = THREE.MathUtils.damp(g.position.z, quietDayActive ? 0 : -pose.arc * 0.2, 5.2, dt);
      g.rotation.y = THREE.MathUtils.damp(g.rotation.y, rotY, 4.6, dt);
      g.rotation.x = THREE.MathUtils.damp(g.rotation.x, rotX, 4.6, dt);
      g.scale.setScalar(THREE.MathUtils.damp(g.scale.x, scale, 5.2, dt));
      g.visible = g.scale.x > 0.01;
    }
    const cam = state.camera;
    cam.position.z = THREE.MathUtils.damp(cam.position.z, camZ, 4.6, dt);
    cam.position.x = THREE.MathUtils.damp(cam.position.x, pointer.current.x * 0.08, 3.6, dt);
    cam.position.y = THREE.MathUtils.damp(cam.position.y, 0.12 + pointer.current.y * 0.07, 3.6, dt);
    cam.lookAt(0, 0.12, 0);
  });
  return (
    <group ref={root}>
      <mesh position={[0, 0.5, -0.8]} visible={quietDayActive && quietDayMoment === 3}>
        <torusGeometry args={[1.9, 0.022, 12, 96]} />
        <meshBasicMaterial color="#38e8ff" toneMapped={false} transparent opacity={0.85} depthWrite={false} />
      </mesh>
      {children}
    </group>
  );
}

function CursorDust({ pointer }: { pointer: Pointer }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const particles = useMemo(() => Array.from({ length: 20 }, (_, i) => ({ x: Math.sin(i * 45.17) * 0.13, y: Math.cos(i * 17.31) * 0.13, z: -0.6 - (i % 9) * 0.16, s: 0.018 + (i % 4) * 0.008 })), []);
  useFrame((_, dt) => {
    if (!ref.current) return;
    const p = pointer.current;
    const speed = Math.min(1, Math.hypot(p.vx, p.vy) * 3);
    particles.forEach((v, i) => {
      const lag = (i + 1) / particles.length;
      dummy.position.set(p.x * 2.8 - p.vx * lag * 1.3 + v.x, p.y * 1.9 - p.vy * lag * 1.1 + v.y, v.z);
      dummy.scale.setScalar(v.s * speed * (0.45 + Math.sin(performance.now() * 0.003 + i) * 0.3));
      dummy.updateMatrix();
      ref.current!.setMatrixAt(i, dummy.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
    pointer.current.vx *= Math.max(0, 1 - dt * 2);
    pointer.current.vy *= Math.max(0, 1 - dt * 2);
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, 20]}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial color="#72f3ff" transparent opacity={0.6} />
    </instancedMesh>
  );
}

function Scene({ progress, pointer, lowPower, interactions, quietDayActive, quietDayMoment }: SceneProps & { lowPower: boolean }) {
  const { scene } = useThree();
  const paper = useMemo(() => new THREE.Color(), []);
  const deep = useMemo(() => new THREE.Color(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const voice = useRef<VoiceDemo>({ mode: 'idle', listen: 0, speak: 0, level: 0 });
  const weights = useRef<StoryWeights>(ZERO_WEIGHTS);
  const mobileRef = useRef(false);
  const reduced = interactions.reducedMotion;

  useEffect(() => {
    const syncTheme = () => {
      const styles = getComputedStyle(document.documentElement);
      paper.set(styles.getPropertyValue('--color-journey').trim());
      deep.set(styles.getPropertyValue('--color-journey-deep').trim());
    };
    syncTheme();
    window.addEventListener('sudo-chan-theme-change', syncTheme);
    return () => window.removeEventListener('sudo-chan-theme-change', syncTheme);
  }, [paper, deep]);

  useFrame(() => {
    const p = progress.current;
    const inside = stageDepth(p);
    scene.background = quietDayActive ? color.set('#04101c') : color.copy(paper).lerp(deep, inside);
  });

  const shared = { weights, reduced, mobile: mobileRef };
  return (
    <>
      <StoryClock progress={progress} voice={voice} weights={weights} reduced={reduced} quiet={quietDayActive} mobile={mobileRef} />
      <ambientLight intensity={0.9} />
      <directionalLight position={[-3, 5, 6]} intensity={1.25} />
      <directionalLight position={[4, 2, 3]} intensity={0.35} color="#dbeaff" />
      <directionalLight position={[3, 3.5, -4]} intensity={0.6} color="#7ff3ff" />
      <Rig progress={progress} pointer={pointer} interactions={interactions} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment} voice={voice} weights={weights} mobileRef={mobileRef}>
        <ListeningRing voice={voice} weights={weights} reduced={reduced} />
        <GlbBot fallback={<CompanionBot pointer={pointer} interactions={interactions} voice={voice} progress={progress} />} />
        <FloatingCards weights={weights} reduced={reduced} />
        <WakeChip {...shared} />
        <ApprovalCard {...shared} />
        <ScreenFrame {...shared} progress={progress} />
        <PrivacyLock {...shared} />
      </Rig>
      <CursorDust pointer={pointer} />
      {!lowPower && <Sparkles count={26} scale={[11, 7, 6]} size={1.3} speed={0.14} opacity={0.2} color="#80edfa" />}
      {!lowPower && (
        <EffectComposer multisampling={0}>
          <Bloom intensity={0.45} luminanceThreshold={1.12} luminanceSmoothing={0.2} mipmapBlur />
          <Vignette eskil={false} offset={0.17} darkness={0.22} />
        </EffectComposer>
      )}
    </>
  );
}

type CanvasProps = SceneProps & { onReady: () => void; onFail?: () => void };

export default function SudoChanCanvas({ progress, pointer, interactions, quietDayActive, quietDayMoment, onReady, onFail }: CanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [lowPower, setLowPower] = useState(() => {
    const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    return isLowPower({ saveData: nav.connection?.saveData === true, hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory });
  });

  // Render only while visible: off-screen or in a hidden tab the loop is stopped completely.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let inView = true;
    const sync = () => setActive(inView && !document.hidden);
    const observer = new IntersectionObserver(entries => { inView = entries[0]?.isIntersecting === true; sync(); });
    observer.observe(element);
    document.addEventListener('visibilitychange', sync);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); interactions.onWelcome(); }
  };

  return (
    <div ref={container} className="sudo-chan-canvas" role="button" tabIndex={0} aria-label="Sudo-chan. Press Enter or Space to say hello." onKeyDown={onKeyDown}>
      <Canvas
        flat
        frameloop={active ? 'always' : 'never'}
        dpr={[1, lowPower ? 1.25 : 1.5]}
        camera={{ position: [0, 0.1, 7.2], fov: 34 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          if (gl.capabilities.maxTextureSize <= 4096) setLowPower(true);
          gl.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); onFail?.(); });
          onReady();
        }}
      >
        <Suspense fallback={null}>
          <Scene progress={progress} pointer={pointer} lowPower={lowPower} interactions={interactions} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment} />
        </Suspense>
      </Canvas>
    </div>
  );
}
