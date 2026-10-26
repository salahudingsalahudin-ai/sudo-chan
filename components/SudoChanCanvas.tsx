'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { Environment, Float, Lightformer, RoundedBox, Sparkles } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { BotMood } from '@/content';
import {
  BLINK_CLOSE_DURATION_MS,
  BLINK_OPEN_DURATION_MS,
  EYE_BLINK_DAMPING,
  HAPPY_MOUTH_COLOR,
  HAPPY_MOUTH_GLOW,
  OUCH_BLINK_CLOSE_DURATION_MS,
  OUCH_BLINK_OPEN_DURATION_MS,
  USE_REAL_MODEL,
} from './sudoChanConfig';
import { SudoGlasses3D } from './SudoGlasses';

type EyeSide=0|1;
export type BotInteractions={
  reducedMotion:boolean;
  mood:BotMood|null;
  sleeping:boolean;
  redness:number;
  sleepingRef:MutableRefObject<boolean>;
  rednessRef:MutableRefObject<number>;
  happyUntilRef:MutableRefObject<number>;
  eyeBlinksRef:MutableRefObject<[number,number]>;
  eyeBlinkDirectionsRef:MutableRefObject<[number,number]>;
  eyeBlinkDurationsRef:MutableRefObject<[number,number]>;
  onWelcome:()=>void;
  onEyeHover:(side:EyeSide)=>boolean;
  onEyeClick:(side:EyeSide)=>void;
};
type SceneProps={progress:{current:number};pointer:{current:{x:number;y:number;vx:number;vy:number}};interactions:BotInteractions;quietDayActive:boolean;quietDayMoment:number|null};
const clamp=(n:number,a=0,b=1)=>Math.min(b,Math.max(a,n));
const smoothstep=(edge0:number,edge1:number,x:number)=>{const t=clamp((x-edge0)/Math.max(1e-5,edge1-edge0),0,1);return t*t*(3-2*t)};
const quintic=(t:number)=>t*t*t*(t*(t*6-15)+10);

const SCENE_CENTERS=[0.02,0.177,0.335,0.494,0.652,0.811,0.975] as const;
type SceneKeyframe={side:number;y:number;scale:number;rotY:number;rotX:number;camZ:number};
const SCENE_KEYFRAMES:readonly SceneKeyframe[]=[
  {side:1.04,y:0.02,scale:0.96,rotY:-0.24,rotX:0.00,camZ:7.00}, // 01 — HELLO (text left -> bot right)
  {side:-0.98,y:0.04,scale:1.04,rotY:0.28,rotX:-0.02,camZ:6.65}, // 02 — A CLOSER LOOK (text right -> bot left)
  {side:1.02,y:0.24,scale:0.90,rotY:-0.26,rotX:0.03,camZ:6.90}, // 03 — HER INSTINCTS (text left -> bot right)
  {side:-0.98,y:-0.02,scale:0.88,rotY:0.36,rotX:0.02,camZ:7.00}, // 04 — MADE OF MOMENTS (text right -> bot left, exploded)
  {side:1.02,y:0.34,scale:0.86,rotY:-0.24,rotX:0.08,camZ:7.00}, // 05 — IN THE FLOW (text left -> bot right above laptop)
  {side:-0.98,y:0.02,scale:0.92,rotY:0.24,rotX:0.00,camZ:6.95}, // 06 — YOURS, ALWAYS (text right -> bot left with shield)
  {side:1.04,y:0.04,scale:0.96,rotY:-0.22,rotX:0.00,camZ:7.05}, // 07 — UNTIL THEN (text left -> bot right)
];

function sampleJourneyPose(p:number){
  if(p<=SCENE_CENTERS[0])return {...SCENE_KEYFRAMES[0],arc:0};
  const last=SCENE_CENTERS.length-1;
  if(p>=SCENE_CENTERS[last])return {...SCENE_KEYFRAMES[last],arc:0};
  let idx=0;
  for(let i=0;i<last;i++){
    if(p>=SCENE_CENTERS[i]&&p<=SCENE_CENTERS[i+1]){idx=i;break;}
  }
  const span=SCENE_CENTERS[idx+1]-SCENE_CENTERS[idx];
  const rawT=clamp((p-SCENE_CENTERS[idx])/Math.max(1e-5,span),0,1);
  // Hold steady near each section center, then glide with a C2 quintic curve between sections
  const plateauT=rawT<0.16?0:rawT>0.84?1:(rawT-0.16)/0.68;
  const u=quintic(plateauT);
  const a=SCENE_KEYFRAMES[idx],b=SCENE_KEYFRAMES[idx+1];
  const arc=Math.sin(u*Math.PI);
  return {
    side:THREE.MathUtils.lerp(a.side,b.side,u),
    y:THREE.MathUtils.lerp(a.y,b.y,u)+arc*0.11,
    scale:THREE.MathUtils.lerp(a.scale,b.scale,u)-arc*0.03,
    rotY:THREE.MathUtils.lerp(a.rotY,b.rotY,u),
    rotX:THREE.MathUtils.lerp(a.rotX,b.rotX,u),
    camZ:THREE.MathUtils.lerp(a.camZ,b.camZ,u)+arc*0.14,
    arc,
  };
}

function getSideOffset(viewportWidth:number,mobile:boolean){
  if(mobile)return 0;
  return THREE.MathUtils.clamp(viewportWidth*0.255,1.45,2.12);
}

function Orb({color,scale=1}:{color:THREE.ColorRepresentation;scale?:number}){
  const ref=useRef<THREE.Mesh>(null);const material=useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({clock})=>{if(ref.current)ref.current.rotation.y=clock.elapsedTime*.24;if(material.current)material.current.emissiveIntensity=2.4+Math.sin(clock.elapsedTime*2.2)*.45});
  return <group scale={scale}><mesh ref={ref}><icosahedronGeometry args={[.36,5]}/><meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.5} roughness={.12} metalness={.18}/></mesh><mesh scale={1.36}><sphereGeometry args={[.38,24,24]}/><meshBasicMaterial color={color} transparent opacity={.1} depthWrite={false}/></mesh></group>
}

function FallbackBot({progress,pointer,interactions,quietDayActive,quietDayMoment}:SceneProps){
  const root=useRef<THREE.Group>(null),head=useRef<THREE.Group>(null),eyes=useRef<THREE.Group>(null),pupils=useRef<THREE.Group>(null),halo=useRef<THREE.Mesh>(null),eyeL=useRef<THREE.Mesh>(null),eyeR=useRef<THREE.Mesh>(null),mouth=useRef<THREE.Mesh>(null);
  const shell=useRef<THREE.Group>(null),visor=useRef<THREE.Group>(null),core=useRef<THREE.Group>(null),sensor=useRef<THREE.Group>(null);
  const blink=useRef(0);const nextBlink=useRef(3);const smoothP=useRef(progress.current??0);const explodedAmt=useRef(0);
  const moodColor=useRef(new THREE.Color('#38e8ff')),mouthColor=useRef(new THREE.Color('#6aefff')),mouthGlow=useRef(new THREE.Color('#000000'));
  const eyeWhite=new THREE.Color('#b9fbff'),eyeRed=new THREE.Color('#ff4d62');
  useFrame((state,dt)=>{
    const safeDt=Math.min(dt,0.05);
    smoothP.current=THREE.MathUtils.damp(smoothP.current,progress.current??0,6.5,safeDt);
    const p=smoothP.current;
    const ptr=pointer.current;
    const targetX=ptr.x*.34,targetY=ptr.y*.26;
    if(head.current){
      head.current.rotation.y=THREE.MathUtils.damp(head.current.rotation.y,targetX,5.2,safeDt);
      head.current.rotation.x=THREE.MathUtils.damp(head.current.rotation.x,targetY,5.2,safeDt);
    }
    if(visor.current&&head.current){
      visor.current.rotation.y=head.current.rotation.y;
      visor.current.rotation.x=head.current.rotation.x;
    }
    if(eyes.current){
      eyes.current.position.x=THREE.MathUtils.damp(eyes.current.position.x,ptr.x*.018,7.5,safeDt);
      eyes.current.position.y=THREE.MathUtils.damp(eyes.current.position.y,.02-ptr.y*.014,7.5,safeDt);
    }
    if(pupils.current){
      pupils.current.position.x=THREE.MathUtils.damp(pupils.current.position.x,ptr.x*.058,9.5,safeDt);
      pupils.current.position.y=THREE.MathUtils.damp(pupils.current.position.y,-ptr.y*.042,9.5,safeDt);
    }
    if(halo.current)halo.current.rotation.z=state.clock.elapsedTime*.16+targetX*.3;
    const happy=performance.now()<interactions.happyUntilRef.current||interactions.mood==='Happy';
    const mood=interactions.mood?.toLowerCase()??(p>.60&&p<.74||happy?'happy':p>.26&&p<.44?'curious':p>.44&&p<.58?'worried':'calm');
    const hex=mood==='happy'?'#62f0ce':mood==='worried'?'#ff9c86':mood==='curious'?'#b58cff':'#38e8ff';
    moodColor.current.lerp(new THREE.Color(hex),Math.min(1,safeDt*3));
    if(mouth.current){
      mouth.current.rotation.z=THREE.MathUtils.damp(mouth.current.rotation.z,happy?Math.PI:0,7,safeDt);
      const material=mouth.current.material as THREE.MeshStandardMaterial;
      mouthColor.current.lerp(new THREE.Color(happy?HAPPY_MOUTH_COLOR:'#6aefff'),Math.min(1,safeDt*5));
      mouthGlow.current.lerp(new THREE.Color(happy?HAPPY_MOUTH_GLOW:'#000000'),Math.min(1,safeDt*5));
      material.color.copy(mouthColor.current);
      material.emissive.copy(mouthGlow.current);
      material.emissiveIntensity=THREE.MathUtils.damp(material.emissiveIntensity,happy?2.5:0,7,safeDt);
    }
    if(core.current){
      const orb=core.current.children[0]?.children[0] as THREE.Mesh|undefined;
      const mat=orb?.material as THREE.MeshStandardMaterial|undefined;
      if(mat){mat.color.copy(moodColor.current);mat.emissive.copy(moodColor.current)}
    }
    if(state.clock.elapsedTime>nextBlink.current){blink.current=1;nextBlink.current=state.clock.elapsedTime+2.3+Math.random()*4.8}
    blink.current=THREE.MathUtils.damp(blink.current,0,EYE_BLINK_DAMPING,safeDt);
    const eyeMeshes=[eyeL.current,eyeR.current];
    for(let side=0;side<2;side++){
      const amount=interactions.eyeBlinksRef.current[side];
      if(!interactions.reducedMotion&&!interactions.sleeping&&interactions.eyeBlinkDirectionsRef.current[side]!==0){
        const closing=interactions.eyeBlinkDirectionsRef.current[side]===1;
        const duration=interactions.eyeBlinkDurationsRef.current[side];
        const next=amount+(closing?1:-1)*(safeDt*1000)/duration;
        interactions.eyeBlinksRef.current[side]=THREE.MathUtils.clamp(next,0,1);
        if(next>=1)interactions.eyeBlinkDirectionsRef.current[side]=-1;
        if(next<=0)interactions.eyeBlinkDirectionsRef.current[side]=0;
      }
      const eyeScale=interactions.sleeping?0:1-Math.max(blink.current,interactions.eyeBlinksRef.current[side])*.98;
      const eyeMesh=eyeMeshes[side];
      if(eyeMesh){
        eyeMesh.scale.y=eyeScale;
        const material=eyeMesh.material as THREE.MeshBasicMaterial;
        material.color.copy(eyeWhite).lerp(eyeRed,interactions.rednessRef.current);
      }
    }
    if(pupils.current)pupils.current.scale.y=interactions.sleeping?0:1-Math.max(blink.current,interactions.eyeBlinksRef.current[0],interactions.eyeBlinksRef.current[1])*.98;

    const explodeTarget=smoothstep(0.42,0.465,p)*(1-smoothstep(0.525,0.57,p));
    explodedAmt.current=THREE.MathUtils.damp(explodedAmt.current,quietDayActive?0:explodeTarget,5.8,safeDt);
    const exploded=explodedAmt.current;

    const mobile=state.size.width<768;
    const sideOffset=getSideOffset(state.viewport.width,mobile);
    const pose=sampleJourneyPose(p);
    const bob=Math.sin(state.clock.elapsedTime*.85)*.035;

    if(root.current){
      const desiredX=quietDayActive?(mobile?.32:1.48):(mobile?0:pose.side*sideOffset);
      const desiredY=quietDayActive?(mobile?-.25:0):(mobile?1.22+bob:pose.y+bob);
      const desiredZ=quietDayActive?0:-pose.arc*.22;
      const desiredScale=quietDayActive?(mobile?.72:.95):(mobile?.72:pose.scale);
      const desiredRotY=quietDayActive?-0.22:(mobile?0:pose.rotY+exploded*.28);
      const desiredRotX=quietDayActive?0:(mobile?0.04:pose.rotX);

      root.current.position.x=THREE.MathUtils.damp(root.current.position.x,desiredX,5.4,safeDt);
      root.current.position.y=THREE.MathUtils.damp(root.current.position.y,desiredY,5.4,safeDt);
      root.current.position.z=THREE.MathUtils.damp(root.current.position.z,desiredZ,5.4,safeDt);
      root.current.rotation.y=THREE.MathUtils.damp(root.current.rotation.y,desiredRotY,5.0,safeDt);
      root.current.rotation.x=THREE.MathUtils.damp(root.current.rotation.x,desiredRotX,5.0,safeDt);
      root.current.scale.setScalar(THREE.MathUtils.damp(root.current.scale.x,desiredScale,5.4,safeDt));
    }
    if(shell.current){
      shell.current.position.y=-exploded*.26;
      shell.current.position.z=-exploded*.10;
    }
    if(head.current){
      head.current.position.y=.36+exploded*.34;
      head.current.position.z=-exploded*.04;
    }
    if(visor.current){
      visor.current.position.y=.36+exploded*.34;
      visor.current.position.z=exploded*.38;
    }
    if(core.current){
      core.current.position.y=-.08-exploded*.24;
      core.current.position.z=.49+exploded*.28;
    }
    if(sensor.current)sensor.current.position.y=1.26+exploded*.62;

    const cameraZ=quietDayActive?(mobile?6.3:6.1):(mobile?7.1:pose.camZ);
    state.camera.position.z=THREE.MathUtils.damp(state.camera.position.z,cameraZ,4.8,safeDt);
    state.camera.position.x=THREE.MathUtils.damp(state.camera.position.x,pointer.current.x*.08,3.6,safeDt);
    state.camera.position.y=THREE.MathUtils.damp(state.camera.position.y,.12+pointer.current.y*.07,3.6,safeDt);
    state.camera.lookAt(0,.12,0);
  });
  return <group ref={root}>
    <mesh position={[0,0,-.55]} visible={quietDayActive&&quietDayMoment===3}><torusGeometry args={[1.78,.022,12,96]}/><meshBasicMaterial color="#38e8ff" toneMapped={false} transparent opacity={.85} depthWrite={false}/></mesh>
    <group ref={shell}>
      <RoundedBox args={[1.42,1.66,.9]} radius={.48} smoothness={8} position={[0,-.18,0]} castShadow receiveShadow onClick={event=>{event.stopPropagation();interactions.onWelcome()}}><meshPhysicalMaterial color="#f6f8fb" roughness={.22} metalness={.06} clearcoat={.65} clearcoatRoughness={.22} envMapIntensity={.65}/></RoundedBox>
      <RoundedBox args={[1.12,.19,.72]} radius={.09} smoothness={6} position={[0,-.92,.12]}><meshPhysicalMaterial color="#dfe4ec" roughness={.26} metalness={.14} envMapIntensity={.55}/></RoundedBox>
      <mesh position={[0,-.34,.463]}><torusGeometry args={[.34,.014,12,64]}/><meshBasicMaterial color="#9adbe8"/></mesh>
    </group>
    <group ref={head} position={[0,.36,0]}>
      <mesh castShadow onClick={event=>{event.stopPropagation();interactions.onWelcome()}}><sphereGeometry args={[.81,64,48]}/><meshPhysicalMaterial color="#f7f9fc" roughness={.2} metalness={.05} clearcoat={.7} clearcoatRoughness={.2} envMapIntensity={.65}/></mesh>
      <mesh position={[-.8,-.04,0]} rotation={[0,0,.12]}><capsuleGeometry args={[.105,.31,6,12]}/><meshPhysicalMaterial color="#c8d0da" roughness={.28} metalness={.18} envMapIntensity={.5}/></mesh><mesh position={[.8,-.04,0]} rotation={[0,0,-.12]}><capsuleGeometry args={[.105,.31,6,12]}/><meshPhysicalMaterial color="#c8d0da" roughness={.28} metalness={.18} envMapIntensity={.5}/></mesh>
    </group>
    <group ref={visor} position={[0,.36,0]}>
      <mesh position={[0,0,.72]} scale={[.91,.48,.22]} onClick={event=>{event.stopPropagation();interactions.onWelcome()}}><sphereGeometry args={[1,48,32]}/><meshStandardMaterial color="#050c14" emissive="#041522" emissiveIntensity={.32} roughness={.45} metalness={.08} envMapIntensity={.18}/></mesh>
      <mesh position={[0,0,.84]} scale={[.86,.43,1]}><torusGeometry args={[.96,.012,12,64]}/><meshBasicMaterial color="#38e8ff" transparent opacity={.26}/></mesh>
      <group ref={eyes} position={[0,.02,.935]}>
        <mesh position={[-.27,0,.025]} onPointerOver={()=>interactions.onEyeHover(0)} onPointerEnter={()=>{document.body.style.cursor='pointer'}} onPointerLeave={()=>{document.body.style.cursor=''}} onClick={event=>{event.stopPropagation();interactions.onEyeClick(0)}}><sphereGeometry args={[.15,16,12]}/><meshBasicMaterial transparent opacity={0} depthWrite={false}/></mesh><mesh position={[.27,0,.025]} onPointerOver={()=>interactions.onEyeHover(1)} onPointerEnter={()=>{document.body.style.cursor='pointer'}} onPointerLeave={()=>{document.body.style.cursor=''}} onClick={event=>{event.stopPropagation();interactions.onEyeClick(1)}}><sphereGeometry args={[.15,16,12]}/><meshBasicMaterial transparent opacity={0} depthWrite={false}/></mesh>
        <mesh ref={eyeL} position={[-.27,0,0]}><sphereGeometry args={[.098,24,24]}/><meshBasicMaterial color="#b9fbff"/></mesh><mesh ref={eyeR} position={[.27,0,0]}><sphereGeometry args={[.098,24,24]}/><meshBasicMaterial color="#b9fbff"/></mesh>
        <group ref={pupils}>
          <mesh position={[-.27,0,.072]}><sphereGeometry args={[.048,20,20]}/><meshStandardMaterial color="#138ca3" emissive="#23e2f5" emissiveIntensity={1.25} roughness={.2}/></mesh><mesh position={[.27,0,.072]}><sphereGeometry args={[.048,20,20]}/><meshStandardMaterial color="#138ca3" emissive="#23e2f5" emissiveIntensity={1.25} roughness={.2}/></mesh>
          <mesh position={[-.27,0,.11]}><sphereGeometry args={[.024,16,16]}/><meshBasicMaterial color="#03131c"/></mesh><mesh position={[.27,0,.11]}><sphereGeometry args={[.024,16,16]}/><meshBasicMaterial color="#03131c"/></mesh>
          <mesh position={[-.285,.02,.13]}><sphereGeometry args={[.011,12,12]}/><meshBasicMaterial color="#fff"/></mesh><mesh position={[.255,.02,.13]}><sphereGeometry args={[.011,12,12]}/><meshBasicMaterial color="#fff"/></mesh>
        </group>
        <mesh ref={mouth} position={[0,-.15,.038]} scale={[1.22,1.08,1]}><torusGeometry args={[.072,.016,8,32,Math.PI]}/><meshStandardMaterial color="#6aefff" emissive="#000000" roughness={.45}/></mesh>
      </group>
      <SudoGlasses3D />
      <mesh position={[0,.49,.08]}><torusGeometry args={[.32,.012,8,48]}/><meshBasicMaterial color="#7ff6ff" transparent opacity={.8}/></mesh>
    </group>
    <group ref={core} position={[0,-.08,.49]}><Orb color="#38e8ff" scale={.83}/></group>
    <group ref={sensor} position={[0,1.26,0]}><mesh><sphereGeometry args={[.075,20,20]}/><meshStandardMaterial color="#46eaff" emissive="#38e8ff" emissiveIntensity={3}/></mesh><mesh position={[0,.08,0]}><torusGeometry args={[.095,.012,8,32]}/><meshBasicMaterial color="#78f6ff"/></mesh></group>
    <mesh ref={halo} position={[0,1.38,0]} rotation={[Math.PI/2.65,0,0]}><torusGeometry args={[1.05,.012,8,96]}/><meshBasicMaterial color="#7ceefa" transparent opacity={.56}/></mesh>
  </group>
}

function BotModel({progress,pointer,interactions,quietDayActive,quietDayMoment}:SceneProps){
  const [model,setModel]=useState<THREE.Group|null>(null);
  useEffect(()=>{if(!USE_REAL_MODEL)return;let active=true;const loader=new GLTFLoader();fetch('/api/sudo-chan-model').then(response=>response.status===204?null:response.ok?response.arrayBuffer():Promise.reject(new Error(`Model request failed with status ${response.status}`))).then(buffer=>{if(!active||!buffer)return;loader.parse(buffer,'/',gltf=>{if(active)setModel(gltf.scene)},error=>{if(active)console.warn('Optional Sudo-chan model could not be loaded; using the procedural bot.',error)})}).catch(error=>{if(active)console.warn('Optional Sudo-chan model could not be loaded; using the procedural bot.',error)});return()=>{active=false}},[]);
  if(!model)return <FallbackBot progress={progress} pointer={pointer} interactions={interactions} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment}/>;
  return <GLBBot model={model} progress={progress} pointer={pointer} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment}/>;
}
function GLBBot({model,progress,pointer,quietDayActive,quietDayMoment}:{model:THREE.Group;progress:SceneProps['progress'];pointer:SceneProps['pointer'];quietDayActive:boolean;quietDayMoment:number|null}){const ref=useRef<THREE.Group>(null);const smoothP=useRef(progress.current??0);const clone=useMemo(()=>model.clone(true),[model]);const {camera}=useThree();useFrame((state,dt)=>{if(!ref.current)return;const safeDt=Math.min(dt,0.05);smoothP.current=THREE.MathUtils.damp(smoothP.current,progress.current??0,6.5,safeDt);const p=smoothP.current;const mobile=state.size.width<768;const sideOffset=getSideOffset(state.viewport.width,mobile);const pose=sampleJourneyPose(p);const bob=Math.sin(performance.now()*.0008)*.035;const desiredX=quietDayActive?(mobile?.32:1.48):(mobile?0:pose.side*sideOffset);const desiredY=quietDayActive?(mobile?-.25:0):(mobile?1.22+bob:pose.y+bob);const desiredScale=quietDayActive?(mobile?.72:.95):(mobile?.72:pose.scale);ref.current.rotation.y=THREE.MathUtils.damp(ref.current.rotation.y,(mobile?0:pose.rotY)+pointer.current.x*.22,4.8,safeDt);ref.current.position.y=THREE.MathUtils.damp(ref.current.position.y,desiredY,5.2,safeDt);ref.current.position.x=THREE.MathUtils.damp(ref.current.position.x,desiredX,5.2,safeDt);ref.current.scale.setScalar(THREE.MathUtils.damp(ref.current.scale.x,desiredScale,5.2,safeDt));camera.position.z=THREE.MathUtils.damp(camera.position.z,quietDayActive?(mobile?6.3:6.1):(mobile?7.1:pose.camZ),4.8,safeDt);camera.lookAt(0,.12,0)});return <group ref={ref}><mesh position={[0,0,-.55]} visible={quietDayActive&&quietDayMoment===3}><torusGeometry args={[1.78,.022,12,96]}/><meshBasicMaterial color="#38e8ff" toneMapped={false} transparent opacity={.85} depthWrite={false}/></mesh><primitive object={clone}/></group>}

function ChipTour({progress}:{progress:{current:number}}){
  const ref=useRef<THREE.Group>(null);
  const scaleRef=useRef(0);
  useFrame((state,dt)=>{
    const safeDt=Math.min(dt,0.05);
    const p=progress.current;
    const active=smoothstep(0.25,0.295,p)*(1-smoothstep(0.385,0.43,p));
    scaleRef.current=THREE.MathUtils.damp(scaleRef.current,active,6,safeDt);
    if(ref.current){
      const mobile=state.size.width<768;
      const sideOffset=getSideOffset(state.viewport.width,mobile);
      ref.current.visible=scaleRef.current>0.01;
      ref.current.position.x=THREE.MathUtils.damp(ref.current.position.x,mobile?0:sideOffset*1.02,5.4,safeDt);
      ref.current.position.y=THREE.MathUtils.damp(ref.current.position.y,mobile?0.18:-1.08,5.4,safeDt);
      ref.current.position.z=0.35;
      ref.current.scale.setScalar(scaleRef.current*(mobile?0.42:0.56));
      const target=clamp((p-.27)/.14);
      ref.current.rotation.y=THREE.MathUtils.damp(ref.current.rotation.y,-0.24+(target-.5)*.45,4,safeDt);
      ref.current.rotation.x=THREE.MathUtils.damp(ref.current.rotation.x,-.28,4,safeDt);
    }
  });
  const nodes=[[-.68,.3,0],[.68,.3,0],[-.68,-.42,0],[.68,-.42,0]] as const;
  return <group ref={ref} position={[1.8,-1.08,.35]}><RoundedBox args={[1.35,1.2,.12]} radius={.12} smoothness={5}><meshStandardMaterial color="#102536" metalness={.55} roughness={.28} emissive="#063b50" emissiveIntensity={.45}/></RoundedBox><mesh><boxGeometry args={[.66,.44,.17]}/><meshStandardMaterial color="#07111a" metalness={.7} roughness={.25} emissive="#10748a" emissiveIntensity={.65}/></mesh>{nodes.map(([x,y],i)=><group key={i} position={[x,y,.12]}><RoundedBox args={[.38,.24,.12]} radius={.045} smoothness={4}><meshStandardMaterial color={progress.current>.29+i*.028?'#56f0ff':'#17404f'} emissive="#18bfd9" emissiveIntensity={progress.current>.29+i*.028?1.8:.25} metalness={.4} roughness={.3}/></RoundedBox></group>)}</group>
}

function Laptop({progress}:{progress:{current:number}}){
  const group=useRef<THREE.Group>(null);
  const scaleRef=useRef(0);
  const [texture,setTexture]=useState<THREE.CanvasTexture|null>(null);
  const lastState=useRef('');
  useEffect(()=>{
    const canvas=document.createElement('canvas');
    canvas.width=1024;
    canvas.height=580;
    const map=new THREE.CanvasTexture(canvas);
    map.colorSpace=THREE.SRGBColorSpace;
    setTexture(map);
    return()=>map.dispose();
  },[]);
  useFrame((state,dt)=>{
    const safeDt=Math.min(dt,0.05);
    const p=progress.current;
    const active=smoothstep(0.565,0.61,p)*(1-smoothstep(0.70,0.745,p));
    scaleRef.current=THREE.MathUtils.damp(scaleRef.current,active,6,safeDt);
    if(group.current){
      const mobile=state.size.width<768;
      const sideOffset=getSideOffset(state.viewport.width,mobile);
      group.current.visible=scaleRef.current>0.01;
      group.current.position.x=THREE.MathUtils.damp(group.current.position.x,mobile?0:sideOffset*1.02,5.4,safeDt);
      group.current.position.y=THREE.MathUtils.damp(group.current.position.y,mobile?0.12:-1.18,5.4,safeDt);
      group.current.position.z=0.38;
      group.current.scale.setScalar(scaleRef.current*(mobile?0.38:0.54));
      group.current.rotation.x=THREE.MathUtils.damp(group.current.rotation.x,-.18,4,safeDt);
      group.current.rotation.y=THREE.MathUtils.damp(group.current.rotation.y,mobile?0:-.24,4,safeDt);
    }
    if(texture){
      const current=p>.665?'fixed':'stuck';
      if(lastState.current!==current){
        lastState.current=current;
        const canvas=texture.image as HTMLCanvasElement;
        const ctx=canvas.getContext('2d');
        if(!ctx)return;
        const grad=ctx.createLinearGradient(0,0,1024,580);
        grad.addColorStop(0,'#06131d');
        grad.addColorStop(1,'#0b2130');
        ctx.fillStyle=grad;
        ctx.fillRect(0,0,1024,580);
        ctx.strokeStyle='rgba(56,232,255,0.18)';
        ctx.lineWidth=2;
        ctx.strokeRect(18,18,988,544);
        ctx.font='600 22px monospace';
        ctx.fillStyle='#78a4b5';
        ctx.fillText('draft.ts  ·  sudo-chan companion lens',44,58);
        ctx.font='24px monospace';
        ctx.fillStyle='#58d9ee';
        ctx.fillText('01',45,135);
        ctx.fillStyle='#d8e6ec';
        ctx.fillText('const response = await solve(problem);',98,135);
        ctx.fillStyle='#8ee5b8';
        ctx.fillText('02',45,200);
        ctx.fillText('if (response.success) {',98,200);
        ctx.fillStyle=current==='fixed'?'#84f2c2':'#ffb49a';
        ctx.fillText(current==='fixed'?'  return response.answer;':'  return response.anser;',138,265);
        ctx.fillStyle=current==='fixed'?'#6ef2c8':'#ff927a';
        ctx.fillText(current==='fixed'?'✓ resolved · back in your flow':'⨯ TypeError · property does not exist',98,385);
        ctx.fillStyle='#45d8ed';
        ctx.fillText(current==='fixed'?'// clean pass':'// spotted repeated typo on line 03',98,445);
        texture.needsUpdate=true;
      }
    }
  });
  return <group ref={group} position={[1.8,-1.18,.38]} rotation={[-.18,-.24,0]}><RoundedBox args={[3.3,2,.12]} radius={.12} smoothness={5} position={[0,1.02,0]}><meshStandardMaterial color="#101820" metalness={.65} roughness={.25}/></RoundedBox><mesh position={[0,1.02,.07]}><planeGeometry args={[3.02,1.72]}/><meshBasicMaterial color="#06131c"/></mesh><mesh position={[0,1.03,.08]}><planeGeometry args={[2.8,1.52]}/><meshBasicMaterial map={texture??undefined} color="#ffffff"/></mesh><RoundedBox args={[3.6,.13,2.2]} radius={.09} smoothness={4} position={[0,-.04,.95]}><meshPhysicalMaterial color="#cbd2da" roughness={.26} metalness={.5}/></RoundedBox><mesh position={[0,.035,.85]}><planeGeometry args={[2.5,1.3]}/><meshStandardMaterial color="#bbc4ce" roughness={.28} metalness={.45}/></mesh></group>
}

function HoloShield({progress}:{progress:{current:number}}){
  const ref=useRef<THREE.Group>(null);
  const scaleRef=useRef(0);
  useFrame((state,dt)=>{
    if(!ref.current)return;
    const safeDt=Math.min(dt,0.05);
    const p=progress.current;
    const active=smoothstep(0.73,0.775,p)*(1-smoothstep(0.855,0.895,p));
    scaleRef.current=THREE.MathUtils.damp(scaleRef.current,active,5.5,safeDt);
    const mobile=state.size.width<768;
    const sideOffset=getSideOffset(state.viewport.width,mobile);
    ref.current.visible=scaleRef.current>0.01;
    ref.current.position.x=THREE.MathUtils.damp(ref.current.position.x,mobile?0:-sideOffset*0.98,5.4,safeDt);
    ref.current.position.y=THREE.MathUtils.damp(ref.current.position.y,mobile?1.22:0.06,5.4,safeDt);
    ref.current.scale.setScalar(scaleRef.current*(mobile?0.68:0.92));
    ref.current.rotation.y+=safeDt*0.22;
  });
  return <group ref={ref} position={[-1.8,.06,0]}>
    <mesh><sphereGeometry args={[1.68,36,24]}/><meshBasicMaterial color="#38e8ff" wireframe transparent opacity={.13} depthWrite={false}/></mesh>
    <mesh rotation={[Math.PI/3,0.3,0]}><torusGeometry args={[1.76,.014,12,96]}/><meshBasicMaterial color="#7cf5ff" transparent opacity={.42} depthWrite={false}/></mesh>
  </group>
}

function CursorDust({pointer}:{pointer:SceneProps['pointer']}){const ref=useRef<THREE.InstancedMesh>(null);const dummy=useMemo(()=>new THREE.Object3D(),[]);const particles=useMemo(()=>Array.from({length:24},(_,i)=>({x:Math.sin(i*45.17)*.13,y:Math.cos(i*17.31)*.13,z:-.6-(i%9)*.16,s:.018+(i%4)*.008})),[]);useFrame((_,dt)=>{if(!ref.current)return;const p=pointer.current,speed=Math.min(1,Math.hypot(p.vx,p.vy)*3);particles.forEach((v,i)=>{const lag=(i+1)/24;dummy.position.set(p.x*2.8-p.vx*lag*1.3+v.x,p.y*1.9-p.vy*lag*1.1+v.y,v.z);const size=v.s*speed*(.45+Math.sin(performance.now()*.003+i)*.3);dummy.scale.setScalar(size);dummy.updateMatrix();ref.current!.setMatrixAt(i,dummy.matrix)});ref.current.instanceMatrix.needsUpdate=true;pointer.current.vx*=Math.max(0,1-dt*2);pointer.current.vy*=Math.max(0,1-dt*2)});return <instancedMesh ref={ref} args={[undefined,undefined,24]}><sphereGeometry args={[1,8,8]}/><meshBasicMaterial color="#72f3ff" transparent opacity={.65}/></instancedMesh>}

function Scene({progress,pointer,lowPower,interactions,quietDayActive,quietDayMoment}:{progress:SceneProps['progress'];pointer:SceneProps['pointer'];lowPower:boolean;interactions:BotInteractions;quietDayActive:boolean;quietDayMoment:number|null}){const {scene,gl}=useThree();const paper=useMemo(()=>new THREE.Color(),[]);const deep=useMemo(()=>new THREE.Color(),[]);const color=useMemo(()=>new THREE.Color(),[]);const originalExposure=useRef<number|null>(null);useEffect(()=>{if(originalExposure.current===null)originalExposure.current=gl.toneMappingExposure;gl.toneMappingExposure=quietDayActive?1.12:originalExposure.current;return()=>{if(originalExposure.current!==null)gl.toneMappingExposure=originalExposure.current}},[gl,quietDayActive]);useEffect(()=>{const syncTheme=()=>{const styles=getComputedStyle(document.documentElement);paper.set(styles.getPropertyValue('--color-journey').trim());deep.set(styles.getPropertyValue('--color-journey-deep').trim())};syncTheme();window.addEventListener('sudo-chan-theme-change',syncTheme);return()=>window.removeEventListener('sudo-chan-theme-change',syncTheme)},[paper,deep]);useFrame(()=>{const p=progress.current;const inside=clamp((p-.12)/.16)*(1-clamp((p-.82)/.14));scene.background=quietDayActive?color.set('#04101c'):color.copy(paper).lerp(deep,inside)});return <>
  <ambientLight intensity={quietDayActive?1.25:.95}/><directionalLight position={[-5,7,5]} intensity={2.4} castShadow={!lowPower} shadow-mapSize={[1024,1024]}/><directionalLight position={[6,3,-4]} intensity={2.1} color="#b4f8ff"/><pointLight position={[0,3.5,-2]} intensity={1.2} color="#c7faff"/><directionalLight position={[-4,5,4]} intensity={quietDayActive?3.2:0} color="#ffffff"/><directionalLight position={[4,2,-4]} intensity={quietDayActive?2.8:0} color="#38e8ff"/>
  <Environment resolution={128} frames={1}><Lightformer form="rect" intensity={1.6} position={[-6,5,-2]} rotation={[0,Math.PI/3,0]} scale={[6,4,1]}/><Lightformer form="rect" intensity={1.5} position={[6,3,-3]} rotation={[0,-Math.PI/3,0]} scale={[5,5,1]}/><Lightformer form="ring" intensity={.9} position={[0,5,-2]} scale={[4,4,1]}/></Environment><Float speed={.75} rotationIntensity={.04} floatIntensity={.09}><BotModel progress={progress} pointer={pointer} interactions={interactions} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment}/></Float><ChipTour progress={progress}/><Laptop progress={progress}/><HoloShield progress={progress}/><CursorDust pointer={pointer}/>
  {!lowPower&&<Sparkles count={36} scale={[11,7,7]} size={1.4} speed={.16} opacity={.22} color="#80edfa"/>}
  {!lowPower&&<EffectComposer multisampling={0}><Bloom intensity={.38} luminanceThreshold={.8} luminanceSmoothing={.28} mipmapBlur/><Vignette eskil={false} offset={.17} darkness={.28}/></EffectComposer>}
  </>}


export default function SudoChanCanvas({progress,pointer,interactions,quietDayActive,quietDayMoment,onReady}:{progress:SceneProps['progress'];pointer:SceneProps['pointer'];interactions:BotInteractions;quietDayActive:boolean;quietDayMoment:number|null;onReady:()=>void}) {
  const container=useRef<HTMLDivElement>(null);const [active,setActive]=useState(false);const [lowPower,setLowPower]=useState(false);
  useEffect(()=>{const element=container.current;if(!element)return;const updateVisibility=()=>setActive(element.isConnected&&!document.hidden&&element.getBoundingClientRect().bottom>0&&element.getBoundingClientRect().top<innerHeight);const observer=new IntersectionObserver(entries=>setActive(entries[0]?.isIntersecting===true&&!document.hidden));observer.observe(element);document.addEventListener('visibilitychange',updateVisibility);return()=>{observer.disconnect();document.removeEventListener('visibilitychange',updateVisibility)}},[]);
  const handleKeyDown=(event:ReactKeyboardEvent<HTMLDivElement>)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();interactions.onWelcome()}};
  return <div ref={container} className="sudo-chan-canvas" role="button" tabIndex={0} aria-label="Sudo-chan. Press Enter or Space to say hello." onKeyDown={handleKeyDown}><Canvas shadows={!lowPower} frameloop={active?'always':'never'} dpr={[1,1.5]} camera={{position:[0,.1,7.2],fov:34}} gl={{antialias:true,alpha:false,powerPreference:'high-performance'}} onCreated={({gl})=>{gl.outputColorSpace=THREE.SRGBColorSpace;const device=navigator as Navigator&{deviceMemory?:number;connection?:{saveData?:boolean}};setLowPower((device.hardwareConcurrency||8)<=4||(device.deviceMemory??8)<=4||device.connection?.saveData===true||gl.capabilities.maxTextureSize<=4096);onReady()}}><Suspense fallback={null}><Scene progress={progress} pointer={pointer} lowPower={lowPower} interactions={interactions} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment}/></Suspense></Canvas></div>;
}
