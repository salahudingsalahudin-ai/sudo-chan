'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { Environment, Float, Lightformer, RoundedBox, Sparkles } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
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

type EyeSide=0|1;
export type BotInteractions={
  reducedMotion:boolean;
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
type SceneProps={progress:{current:number};pointer:{current:{x:number;y:number;vx:number;vy:number}};interactions:BotInteractions};
const clamp=(n:number,a=0,b=1)=>Math.min(b,Math.max(a,n));

function Orb({color,scale=1}:{color:THREE.ColorRepresentation;scale?:number}){
  const ref=useRef<THREE.Mesh>(null);const material=useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({clock})=>{if(ref.current)ref.current.rotation.y=clock.elapsedTime*.24;if(material.current)material.current.emissiveIntensity=2.4+Math.sin(clock.elapsedTime*2.2)*.45});
  return <group scale={scale}><mesh ref={ref}><icosahedronGeometry args={[.36,5]}/><meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.5} roughness={.12} metalness={.18}/></mesh><mesh scale={1.36}><sphereGeometry args={[.38,24,24]}/><meshBasicMaterial color={color} transparent opacity={.1} depthWrite={false}/></mesh></group>
}

function FallbackBot({progress,pointer,interactions}:SceneProps){
  const root=useRef<THREE.Group>(null),head=useRef<THREE.Group>(null),eyes=useRef<THREE.Group>(null),pupils=useRef<THREE.Group>(null),halo=useRef<THREE.Mesh>(null),eyeL=useRef<THREE.Mesh>(null),eyeR=useRef<THREE.Mesh>(null),mouth=useRef<THREE.Mesh>(null);
  const shell=useRef<THREE.Group>(null),visor=useRef<THREE.Group>(null),core=useRef<THREE.Group>(null),sensor=useRef<THREE.Group>(null);const blink=useRef(0);const nextBlink=useRef(3);const moodColor=useRef(new THREE.Color('#38e8ff'));const eyeWhite=new THREE.Color('#b9fbff'),eyeRed=new THREE.Color('#ff4d62');
  useFrame((state,dt)=>{
    const p=progress.current??0;const ptr=pointer.current;const targetX=ptr.x*.42,targetY=ptr.y*.34;
    if(head.current){head.current.rotation.y=THREE.MathUtils.damp(head.current.rotation.y,targetX,3.8,dt);head.current.rotation.x=THREE.MathUtils.damp(head.current.rotation.x,targetY,3.8,dt)}
    if(eyes.current){eyes.current.position.x=THREE.MathUtils.damp(eyes.current.position.x,ptr.x*.018,7,dt);eyes.current.position.y=THREE.MathUtils.damp(eyes.current.position.y,-ptr.y*.014,7,dt)}
    if(pupils.current){pupils.current.position.x=THREE.MathUtils.damp(pupils.current.position.x,ptr.x*.065,9,dt);pupils.current.position.y=THREE.MathUtils.damp(pupils.current.position.y,-ptr.y*.045,9,dt)}
    if(halo.current)halo.current.rotation.z=state.clock.elapsedTime*.16+targetX*.3;
    const happy=performance.now()<interactions.happyUntilRef.current;const mood=p>.63&&p<.77||happy?'happy':p>.28&&p<.48?'curious':p>.48&&p<.62?'worried':'calm';const hex=mood==='happy'?'#62f0ce':mood==='worried'?'#ff9c86':'#38e8ff';moodColor.current.lerp(new THREE.Color(hex),Math.min(1,dt*2.5));if(mouth.current){mouth.current.rotation.z=happy?Math.PI:0;const material=mouth.current.material as THREE.MeshStandardMaterial;material.color.set(happy?HAPPY_MOUTH_COLOR:'#6aefff');material.emissive.set(happy?HAPPY_MOUTH_GLOW:'#000000');material.emissiveIntensity=happy?2.5:0}
    if(core.current){const orb=core.current.children[0]?.children[0] as THREE.Mesh|undefined;const mat=orb?.material as THREE.MeshStandardMaterial|undefined;if(mat){mat.color.copy(moodColor.current);mat.emissive.copy(moodColor.current)}}
    if(state.clock.elapsedTime>nextBlink.current){blink.current=1;nextBlink.current=state.clock.elapsedTime+2.3+Math.random()*4.8}
    blink.current=THREE.MathUtils.damp(blink.current,0,EYE_BLINK_DAMPING,dt);const eyeMeshes=[eyeL.current,eyeR.current];for(let side=0;side<2;side++){const sideIndex=side as EyeSide;const amount=interactions.eyeBlinksRef.current[side];if(!interactions.reducedMotion&&!interactions.sleeping&&interactions.eyeBlinkDirectionsRef.current[side]!==0){const closing=interactions.eyeBlinkDirectionsRef.current[side]===1;const duration=interactions.eyeBlinkDurationsRef.current[side];const next=amount+(closing?1:-1)*(dt*1000)/duration;interactions.eyeBlinksRef.current[side]=THREE.MathUtils.clamp(next,0,1);if(next>=1)interactions.eyeBlinkDirectionsRef.current[side]=-1;if(next<=0)interactions.eyeBlinkDirectionsRef.current[side]=0}const eyeScale=interactions.sleeping?0:1-Math.max(blink.current,interactions.eyeBlinksRef.current[side])*.98;const eyeMesh=eyeMeshes[side];if(eyeMesh){eyeMesh.scale.y=eyeScale;const material=eyeMesh.material as THREE.MeshBasicMaterial;material.color.copy(eyeWhite).lerp(eyeRed,interactions.rednessRef.current)}}
    if(pupils.current)pupils.current.scale.y=interactions.sleeping?0:1-Math.max(blink.current,interactions.eyeBlinksRef.current[0],interactions.eyeBlinksRef.current[1])*.98;
    const assemble=clamp(p/.09);const exploded=clamp((p-.49)/.06)*(1-clamp((p-.59)/.07));const enter=THREE.MathUtils.lerp(7.2,.48,clamp((p-.18)/.12));const inside=THREE.MathUtils.lerp(.48,3.65,clamp((p-.30)/.07));const z=p<.30?enter:inside;
    if(root.current){root.current.position.y=Math.sin(state.clock.elapsedTime*.75)*.035;root.current.rotation.y=THREE.MathUtils.damp(root.current.rotation.y,exploded*.72,2,dt);root.current.scale.setScalar(THREE.MathUtils.damp(root.current.scale.x,THREE.MathUtils.lerp(1,.82,clamp((p-.28)/.15)),4,dt));}
    if(shell.current){shell.current.position.y=THREE.MathUtils.lerp(1.25,0,assemble)+exploded*.6;shell.current.position.z=exploded*.16}
    if(head.current){head.current.position.y=THREE.MathUtils.lerp(.6,.35,assemble)+exploded*.82;head.current.position.z=exploded*.08}
    if(visor.current){visor.current.position.y=exploded*.12;visor.current.position.z=exploded*.72}
    if(core.current){core.current.position.y=-.08-exploded*.92;core.current.position.z=exploded*.2}
    if(sensor.current)sensor.current.position.y=1.28+exploded*1.45;
    const cameraZ=p>.76?THREE.MathUtils.lerp(3.65,7.2,clamp((p-.76)/.2)):z;state.camera.position.z=THREE.MathUtils.damp(state.camera.position.z,cameraZ,2.7,dt);state.camera.position.x=THREE.MathUtils.damp(state.camera.position.x,pointer.current.x*.11,2,dt);state.camera.position.y=THREE.MathUtils.damp(state.camera.position.y,.15+pointer.current.y*.1,2,dt);state.camera.lookAt(0,.15,0);
  });
  return <group ref={root}>
    <group ref={shell}>
      <RoundedBox args={[1.42,1.66,.9]} radius={.48} smoothness={8} position={[0,-.18,0]} castShadow receiveShadow onClick={event=>{event.stopPropagation();interactions.onWelcome()}}><meshPhysicalMaterial color="#f9f9fb" roughness={.18} metalness={.08} clearcoat={.95} clearcoatRoughness={.12}/></RoundedBox>
      <RoundedBox args={[1.12,.19,.72]} radius={.09} smoothness={6} position={[0,-.92,.12]}><meshPhysicalMaterial color="#dfe3e9" roughness={.22} metalness={.15}/></RoundedBox>
      <mesh position={[0,-.34,.463]}><torusGeometry args={[.34,.014,12,64]}/><meshBasicMaterial color="#b9c4d0"/></mesh>
    </group>
    <group ref={head}>
      <mesh castShadow onClick={event=>{event.stopPropagation();interactions.onWelcome()}}><sphereGeometry args={[.86,48,40]}/><meshPhysicalMaterial color="#f7f7fa" roughness={.17} metalness={.07} clearcoat={1} clearcoatRoughness={.1}/></mesh>
      <mesh position={[-.8,-.04,0]} rotation={[0,0,.12]}><capsuleGeometry args={[.105,.31,6,12]}/><meshPhysicalMaterial color="#c7cbd4" roughness={.25} metalness={.2}/></mesh><mesh position={[.8,-.04,0]} rotation={[0,0,-.12]}><capsuleGeometry args={[.105,.31,6,12]}/><meshPhysicalMaterial color="#c7cbd4" roughness={.25} metalness={.2}/></mesh>
    </group>
    <group ref={visor}>
      <mesh position={[0,.36,.67]} scale={[1,.52,.18]} onClick={event=>{event.stopPropagation();interactions.onWelcome()}}><sphereGeometry args={[1,48,24]}/><meshPhysicalMaterial color="#0b1721" roughness={.16} metalness={.22} clearcoat={1} clearcoatRoughness={.08} transmission={.14}/></mesh>
      <group ref={eyes} position={[0,.39,.835]}>
        <mesh position={[-.28,0,.025]} onPointerOver={()=>interactions.onEyeHover(0)} onPointerEnter={()=>{document.body.style.cursor='pointer'}} onPointerLeave={()=>{document.body.style.cursor=''}} onClick={event=>{event.stopPropagation();interactions.onEyeClick(0)}}><sphereGeometry args={[.15,16,12]}/><meshBasicMaterial transparent opacity={0} depthWrite={false}/></mesh><mesh position={[.28,0,.025]} onPointerOver={()=>interactions.onEyeHover(1)} onPointerEnter={()=>{document.body.style.cursor='pointer'}} onPointerLeave={()=>{document.body.style.cursor=''}} onClick={event=>{event.stopPropagation();interactions.onEyeClick(1)}}><sphereGeometry args={[.15,16,12]}/><meshBasicMaterial transparent opacity={0} depthWrite={false}/></mesh>
        <mesh ref={eyeL} position={[-.28,0,0]}><sphereGeometry args={[.105,24,24]}/><meshBasicMaterial color="#b9fbff"/></mesh><mesh ref={eyeR} position={[.28,0,0]}><sphereGeometry args={[.105,24,24]}/><meshBasicMaterial color="#b9fbff"/></mesh>
        <group ref={pupils}>
          <mesh position={[-.28,0,.078]}><sphereGeometry args={[.05,20,20]}/><meshStandardMaterial color="#138ca3" emissive="#23e2f5" emissiveIntensity={1.1} roughness={.18}/></mesh><mesh position={[.28,0,.078]}><sphereGeometry args={[.05,20,20]}/><meshStandardMaterial color="#138ca3" emissive="#23e2f5" emissiveIntensity={1.1} roughness={.18}/></mesh>
          <mesh position={[-.28,0,.118]}><sphereGeometry args={[.025,16,16]}/><meshBasicMaterial color="#03131c"/></mesh><mesh position={[.28,0,.118]}><sphereGeometry args={[.025,16,16]}/><meshBasicMaterial color="#03131c"/></mesh>
          <mesh position={[-.295,.022,.14]}><sphereGeometry args={[.012,12,12]}/><meshBasicMaterial color="#fff"/></mesh><mesh position={[.265,.022,.14]}><sphereGeometry args={[.012,12,12]}/><meshBasicMaterial color="#fff"/></mesh>
        </group>
        <mesh ref={mouth} position={[0,-.16,.045]} scale={[1.25,1.1,1]}><torusGeometry args={[.075,.017,8,32,Math.PI]}/><meshStandardMaterial color="#6aefff" emissive="#000000" roughness={.5}/></mesh>
      </group>
      <mesh position={[0,.86,.08]}><torusGeometry args={[.32,.012,8,48]}/><meshBasicMaterial color="#7ff6ff" transparent opacity={.8}/></mesh>
    </group>
    <group ref={core} position={[0,-.08,.49]}><Orb color="#38e8ff" scale={.83}/></group>
    <group ref={sensor} position={[0,1.28,0]}><mesh><sphereGeometry args={[.075,20,20]}/><meshStandardMaterial color="#46eaff" emissive="#38e8ff" emissiveIntensity={3}/></mesh><mesh position={[0,.08,0]}><torusGeometry args={[.095,.012,8,32]}/><meshBasicMaterial color="#78f6ff"/></mesh></group>
    <mesh ref={halo} position={[0,1.38,0]} rotation={[Math.PI/2.65,0,0]}><torusGeometry args={[1.05,.012,8,96]}/><meshBasicMaterial color="#7ceefa" transparent opacity={.56}/></mesh>
  </group>
}

function BotModel({progress,pointer,interactions}:SceneProps){
  const [model,setModel]=useState<THREE.Group|null>(null);
  useEffect(()=>{if(!USE_REAL_MODEL)return;let active=true;const loader=new GLTFLoader();fetch('/api/sudo-chan-model').then(response=>response.status===204?null:response.ok?response.arrayBuffer():Promise.reject(new Error(`Model request failed with status ${response.status}`))).then(buffer=>{if(!active||!buffer)return;loader.parse(buffer,'/',gltf=>{if(active)setModel(gltf.scene)},error=>{if(active)console.warn('Optional Sudo-chan model could not be loaded; using the procedural bot.',error)})}).catch(error=>{if(active)console.warn('Optional Sudo-chan model could not be loaded; using the procedural bot.',error)});return()=>{active=false}},[]);
  if(!model)return <FallbackBot progress={progress} pointer={pointer} interactions={interactions}/>;
  return <GLBBot model={model} progress={progress} pointer={pointer}/>;
}
function GLBBot({model,progress,pointer}:{model:THREE.Group;progress:SceneProps['progress'];pointer:SceneProps['pointer']}){const ref=useRef<THREE.Group>(null);const clone=useMemo(()=>model.clone(true),[model]);useFrame((_,dt)=>{if(!ref.current)return;const p=progress.current;ref.current.rotation.y=THREE.MathUtils.damp(ref.current.rotation.y,pointer.current.x*.25,3,dt);ref.current.position.y=Math.sin(performance.now()*.0008)*.04;ref.current.scale.setScalar(1+Math.sin(p*Math.PI)*.08)});return <group ref={ref}><primitive object={clone}/></group>}

function ChipTour({progress}:{progress:{current:number}}){const ref=useRef<THREE.Group>(null);useFrame((_,dt)=>{const p=progress.current;const target=clamp((p-.31)/.23);if(ref.current){ref.current.visible=p>.29&&p<.57;ref.current.rotation.y=THREE.MathUtils.damp(ref.current.rotation.y,(target-.5)*.65,2,dt);ref.current.rotation.x=THREE.MathUtils.damp(ref.current.rotation.x,.18,2,dt)}});const nodes=[[-.68,.3,0],[.68,.3,0],[-.68,-.42,0],[.68,-.42,0]] as const;return <group ref={ref} position={[0,.1,0]}><RoundedBox args={[1.35,1.2,.12]} radius={.12} smoothness={5}><meshStandardMaterial color="#132a3b" metalness={.55} roughness={.23} emissive="#063b50" emissiveIntensity={.4}/></RoundedBox><mesh><boxGeometry args={[.66,.44,.17]}/><meshStandardMaterial color="#07111a" metalness={.7} roughness={.22} emissive="#10748a" emissiveIntensity={.6}/></mesh>{nodes.map(([x,y],i)=><group key={i} position={[x,y,.12]}><RoundedBox args={[.38,.24,.12]} radius={.045} smoothness={4}><meshStandardMaterial color={progress.current>.32+i*.045?'#56f0ff':'#17404f'} emissive="#18bfd9" emissiveIntensity={progress.current>.32+i*.045?1.8:.25} metalness={.4} roughness={.3}/></RoundedBox></group>)}</group>}

function Laptop({progress}:{progress:{current:number}}){const group=useRef<THREE.Group>(null);const [texture,setTexture]=useState<THREE.CanvasTexture|null>(null);const lastState=useRef('');useEffect(()=>{const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=580;const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;setTexture(map);return()=>map.dispose()},[]);useFrame((_,dt)=>{const p=progress.current;if(group.current){group.current.visible=p>.55&&p<.78;group.current.rotation.x=THREE.MathUtils.damp(group.current.rotation.x,-.22,2,dt)}if(texture){const current=p>.68?'fixed':'stuck';if(lastState.current!==current){lastState.current=current;const canvas=texture.image as HTMLCanvasElement;const ctx=canvas.getContext('2d');if(!ctx)return;ctx.fillStyle='#07151e';ctx.fillRect(0,0,1024,580);ctx.font='24px monospace';ctx.fillStyle='#6d7f88';ctx.fillText('draft.ts     ·     sudo-chan notices a loop',42,54);ctx.fillStyle='#83edff';ctx.fillText('01',45,130);ctx.fillStyle='#c9d3d6';ctx.fillText('const response = await solve(problem);',95,130);ctx.fillStyle='#9ee5b2';ctx.fillText('02',45,195);ctx.fillText('if (response.success) {',95,195);ctx.fillStyle='#ffc5a5';ctx.fillText(current==='fixed'?'  return response.answer;':'  return response.anser;',135,260);ctx.fillStyle='#f5957c';ctx.fillText(current==='fixed'?'✓ fixed · one letter, back in flow':'TypeError · property does not exist',95,385);ctx.fillStyle='#45d8ed';ctx.fillText(current==='fixed'?'// that did it':'// hm. same error again.',95,445);texture.needsUpdate=true}}});return <group ref={group} position={[0,-1.32,.25]} rotation={[-.15,0,0]}><RoundedBox args={[3.3,2,.12]} radius={.12} smoothness={5} position={[0,1.02,0]}><meshStandardMaterial color="#101820" metalness={.65} roughness={.22}/></RoundedBox><mesh position={[0,1.02,.07]}><planeGeometry args={[3.02,1.72]}/><meshBasicMaterial color="#06131c"/></mesh><mesh position={[0,1.03,.08]}><planeGeometry args={[2.8,1.52]}/><meshBasicMaterial map={texture??undefined} color="#ffffff"/></mesh><RoundedBox args={[3.6,.13,2.2]} radius={.09} smoothness={4} position={[0,-.04,.95]}><meshPhysicalMaterial color="#cbd2da" roughness={.22} metalness={.55}/></RoundedBox><mesh position={[0,.035,.85]}><planeGeometry args={[2.5,1.3]}/><meshStandardMaterial color="#bbc4ce" roughness={.25} metalness={.5}/></mesh></group>}

function HoloShield({progress}:{progress:{current:number}}){const ref=useRef<THREE.Mesh>(null);useFrame((_,dt)=>{if(!ref.current)return;const p=progress.current;ref.current.visible=p>.75&&p<.89;ref.current.scale.setScalar(THREE.MathUtils.damp(ref.current.scale.x,clamp((p-.75)/.035),3,dt));const m=ref.current.material as THREE.MeshBasicMaterial;m.opacity=.14+Math.sin(performance.now()*.0018)*.035});return <mesh ref={ref} position={[0,.05,0]}><sphereGeometry args={[1.88,48,32]}/><meshBasicMaterial color="#38e8ff" wireframe transparent opacity={.16} depthWrite={false}/></mesh>}

function CursorDust({pointer}:{pointer:SceneProps['pointer']}){const ref=useRef<THREE.InstancedMesh>(null);const dummy=useMemo(()=>new THREE.Object3D(),[]);const particles=useMemo(()=>Array.from({length:24},(_,i)=>({x:Math.sin(i*45.17)*.13,y:Math.cos(i*17.31)*.13,z:-.6-(i%9)*.16,s:.018+(i%4)*.008})),[]);useFrame((_,dt)=>{if(!ref.current)return;const p=pointer.current,speed=Math.min(1,Math.hypot(p.vx,p.vy)*3);particles.forEach((v,i)=>{const lag=(i+1)/24;dummy.position.set(p.x*2.8-p.vx*lag*1.3+v.x,p.y*1.9-p.vy*lag*1.1+v.y,v.z);const size=v.s*speed*(.45+Math.sin(performance.now()*.003+i)*.3);dummy.scale.setScalar(size);dummy.updateMatrix();ref.current!.setMatrixAt(i,dummy.matrix)});ref.current.instanceMatrix.needsUpdate=true;pointer.current.vx*=Math.max(0,1-dt*2);pointer.current.vy*=Math.max(0,1-dt*2)});return <instancedMesh ref={ref} args={[undefined,undefined,24]}><sphereGeometry args={[1,8,8]}/><meshBasicMaterial color="#72f3ff" transparent opacity={.65}/></instancedMesh>}

function Scene({progress,pointer,lowPower,interactions}:{progress:SceneProps['progress'];pointer:SceneProps['pointer'];lowPower:boolean;interactions:BotInteractions}){const scene=useThree(s=>s.scene);const paper=useMemo(()=>new THREE.Color('#f5f5f7'),[]);const deep=useMemo(()=>new THREE.Color('#04101c'),[]);const color=useMemo(()=>new THREE.Color(),[]);useFrame(()=>{const p=progress.current;const inside=clamp((p-.2)/.2)*(1-clamp((p-.77)/.18));scene.background=color.copy(paper).lerp(deep,inside)});return <>
  <ambientLight intensity={.85}/><directionalLight position={[-4,7,8]} intensity={3.1} castShadow={!lowPower} shadow-mapSize={[1024,1024]}/><directionalLight position={[5,2,-3]} intensity={2.3} color="#b4f8ff"/><pointLight position={[0,1,2]} intensity={1.7} color="#c7faff"/>
  <Environment resolution={128} frames={1}><Lightformer form="rect" intensity={2.4} position={[-4,4,3]} rotation={[0,Math.PI/4,0]} scale={[6,4,1]}/><Lightformer form="rect" intensity={1.8} position={[4,2,-3]} rotation={[0,-Math.PI/3,0]} scale={[5,5,1]}/><Lightformer form="ring" intensity={1.1} position={[0,-2,1]} scale={[4,4,1]}/></Environment><Float speed={.8} rotationIntensity={.06} floatIntensity={.12}><BotModel progress={progress} pointer={pointer} interactions={interactions}/></Float><ChipTour progress={progress}/><Laptop progress={progress}/><HoloShield progress={progress}/><CursorDust pointer={pointer}/>
  {!lowPower&&<Sparkles count={36} scale={[11,7,7]} size={1.4} speed={.16} opacity={.22} color="#80edfa"/>}
  {!lowPower&&<EffectComposer multisampling={0}><Bloom intensity={.45} luminanceThreshold={.76} luminanceSmoothing={.24} mipmapBlur/><Vignette eskil={false} offset={.17} darkness={.3}/></EffectComposer>}
  </>}


export default function SudoChanCanvas({progress,pointer,interactions,onReady}:{progress:SceneProps['progress'];pointer:SceneProps['pointer'];interactions:BotInteractions;onReady:()=>void}) {
  const container=useRef<HTMLDivElement>(null);const [active,setActive]=useState(false);const [lowPower,setLowPower]=useState(false);
  useEffect(()=>{const element=container.current;if(!element)return;const updateVisibility=()=>setActive(element.isConnected&&!document.hidden&&element.getBoundingClientRect().bottom>0&&element.getBoundingClientRect().top<innerHeight);const observer=new IntersectionObserver(entries=>setActive(entries[0]?.isIntersecting===true&&!document.hidden));observer.observe(element);document.addEventListener('visibilitychange',updateVisibility);return()=>{observer.disconnect();document.removeEventListener('visibilitychange',updateVisibility)}},[]);
  const handleKeyDown=(event:ReactKeyboardEvent<HTMLDivElement>)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();interactions.onWelcome()}};
  return <div ref={container} className="sudo-chan-canvas" role="button" tabIndex={0} aria-label="Sudo-chan. Press Enter or Space to say hello." onKeyDown={handleKeyDown}><Canvas shadows={!lowPower} frameloop={active?'always':'never'} dpr={[1,1.5]} camera={{position:[0,.1,7.2],fov:34}} gl={{antialias:true,alpha:false,powerPreference:'high-performance'}} onCreated={({gl})=>{gl.outputColorSpace=THREE.SRGBColorSpace;const device=navigator as Navigator&{deviceMemory?:number;connection?:{saveData?:boolean}};setLowPower((device.hardwareConcurrency||8)<=4||(device.deviceMemory??8)<=4||device.connection?.saveData===true||gl.capabilities.maxTextureSize<=4096);onReady()}}><Suspense fallback={null}><Scene progress={progress} pointer={pointer} lowPower={lowPower} interactions={interactions}/></Suspense></Canvas></div>;
}
