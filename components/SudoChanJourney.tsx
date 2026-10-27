'use client';

import { Fragment, Component, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';
import dynamic from 'next/dynamic';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from '@studio-freight/lenis';
import { useReducedMotion } from 'framer-motion';
import { content } from '@/content';
import type { BotMood } from '@/content';
import type { BotInteractions } from './SudoChanCanvas';
import RoundCSections, { LazySlot, MoodPicker, StuckDetectorPreview } from './RoundCSections';
import WaitlistCount, { refreshWaitlistCount } from './WaitlistCount';
import ThemeToggle from './ThemeToggle';
import TrustPanel from './TrustPanel';
import CompanionSvg from './CompanionSvg';
import { chooseRenderer } from '@/lib/heroScene';
import {
  BLINK_CLOSE_DURATION_MS,
  BLINK_OPEN_DURATION_MS,
  DEBUG_EYE_CLICKS,
  EYE_HOVER_THROTTLE_MS,
  EYE_REDNESS_CLICK_LIMIT,
  OUCH_BLINK_CLOSE_DURATION_MS,
  OUCH_BLINK_OPEN_DURATION_MS,
  OUCH_BUBBLE_DURATION_MS,
  OUCH_EVERY_N_CLICKS,
  REDNESS_DECAY_INTERVAL_MS,
  REDNESS_DECAY_PER_INTERVAL,
  SLEEP_DURATION_MS,
  WELCOME_DURATION_MS,
  WELCOME_LINES,
} from './sudoChanConfig';

type SceneProps={progress:{current:number};pointer:{current:{x:number;y:number;vx:number;vy:number}}};
const SudoChanCanvas=dynamic(()=>import('./SudoChanCanvas'),{ssr:false});
const clamp=(n:number,a=0,b=1)=>Math.min(b,Math.max(a,n));

function CustomCursor(){
  const core=useRef<HTMLSpanElement>(null),ring=useRef<HTMLSpanElement>(null);
  useEffect(()=>{
    if(matchMedia('(pointer:coarse)').matches||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    let activeTarget:HTMLElement|null=null;
    const clearMagnet=()=>{
      if(!activeTarget)return;
      activeTarget.style.removeProperty('--magnet-x');
      activeTarget.style.removeProperty('--magnet-y');
      activeTarget.classList.remove('magnetic-target');
      activeTarget=null;
    };
    const move=(e:PointerEvent)=>{
      if(e.pointerType!=='mouse')return;
      const position=`translate3d(${e.clientX}px,${e.clientY}px,0) translate(-50%,-50%)`;
      if(core.current)core.current.style.transform=position;
      if(ring.current)ring.current.style.transform=position;
      const element=e.target instanceof Element?e.target.closest<HTMLElement>('a,button,input'):null;
      if(element!==activeTarget){
        clearMagnet();
        activeTarget=element;
        if(activeTarget)activeTarget.classList.add('magnetic-target');
      }
      if(activeTarget){
        const rect=activeTarget.getBoundingClientRect();
        activeTarget.style.setProperty('--magnet-x',`${clamp((e.clientX-rect.left-rect.width/2)*.02,-1,1)}px`);
        activeTarget.style.setProperty('--magnet-y',`${clamp((e.clientY-rect.top-rect.height/2)*.02,-1,1)}px`);
      }
      ring.current?.classList.toggle('is-active',Boolean(element));
    };
    const down=(e:PointerEvent)=>{if(e.pointerType==='mouse')ring.current?.classList.add('is-pressed')};
    const up=()=>ring.current?.classList.remove('is-pressed');
    window.addEventListener('pointermove',move,{passive:true});window.addEventListener('pointerdown',down);window.addEventListener('pointerup',up);return()=>{clearMagnet();window.removeEventListener('pointermove',move);window.removeEventListener('pointerdown',down);window.removeEventListener('pointerup',up)}
  },[]);return <><span ref={core} className="cursor-core"/><span ref={ring} className="cursor-magnet"/></>
}

function CursorTrail(){
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{const element=canvas.current;if(!element||matchMedia('(pointer:coarse)').matches||matchMedia('(prefers-reduced-motion: reduce)').matches)return;const context=element.getContext('2d');if(!context)return;let width=0,height=0,dpr=1,frame=0,lastTime=performance.now(),lastX=-1,lastY=-1;const particles:{x:number;y:number;vx:number;vy:number;life:number;max:number;size:number;color:string;angle:number}[]=[];const ripples:{x:number;y:number;age:number}[]=[];
    const resize=()=>{dpr=Math.min(devicePixelRatio||1,1.5);width=innerWidth;height=innerHeight;element.width=Math.round(width*dpr);element.height=Math.round(height*dpr);element.style.width=`${width}px`;element.style.height=`${height}px`;context.setTransform(dpr,0,0,dpr,0,0)};
    const move=(e:PointerEvent)=>{if(e.pointerType!=='mouse')return;if(lastX>=0){const dx=e.clientX-lastX,dy=e.clientY-lastY,distance=Math.hypot(dx,dy),count=Math.min(4,Math.floor(distance/7));for(let i=0;i<count;i++){const t=(i+1)/(count+1);particles.push({x:lastX+dx*t,y:lastY+dy*t,vx:-dx*.018+(Math.random()-.5)*22,vy:-dy*.018-8-Math.random()*12,life:.35+Math.random()*.28,max:.63,size:2+Math.random()*3,color:Math.random()>.24?'56,232,255':'255,145,181',angle:Math.random()*Math.PI})}if(particles.length>54)particles.splice(0,particles.length-54)}lastX=e.clientX;lastY=e.clientY};
    const click=(e:PointerEvent)=>{if(e.pointerType==='mouse')ripples.push({x:e.clientX,y:e.clientY,age:0})};
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(draw)};
    const draw=(now:number)=>{frame=0;const dt=Math.min(.04,(now-lastTime)/1000);lastTime=now;if(particles.length||ripples.length){context.clearRect(0,0,width,height);context.globalCompositeOperation='lighter';for(let i=particles.length-1;i>=0;i--){const p=particles[i];p.life-=dt;if(p.life<=0){particles.splice(i,1);continue}p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=9*dt;p.angle+=dt*1.2;context.save();context.translate(p.x,p.y);context.rotate(p.angle);context.globalAlpha=Math.min(1,p.life/p.max)*.72;context.fillStyle=`rgba(${p.color},.92)`;context.shadowBlur=12;context.shadowColor=`rgba(${p.color},.8)`;context.beginPath();context.ellipse(0,0,p.size*.58,p.size*1.35,0,0,Math.PI*2);context.fill();context.restore()}for(let i=ripples.length-1;i>=0;i--){const r=ripples[i];r.age+=dt;if(r.age>.62){ripples.splice(i,1);continue}context.beginPath();context.arc(r.x,r.y,r.age*43,0,Math.PI*2);context.strokeStyle=`rgba(56,232,255,${(1-r.age/.62)*.35})`;context.lineWidth=1;context.stroke()}context.globalCompositeOperation='source-over';if(particles.length||ripples.length)schedule()}else context.clearRect(0,0,width,height)};
    const onMove=(e:PointerEvent)=>{move(e);schedule()};
    const onClick=(e:PointerEvent)=>{click(e);schedule()};
    resize();window.addEventListener('resize',resize);window.addEventListener('pointermove',onMove,{passive:true});window.addEventListener('pointerdown',onClick);return()=>{if(frame)cancelAnimationFrame(frame);window.removeEventListener('resize',resize);window.removeEventListener('pointermove',onMove);window.removeEventListener('pointerdown',onClick)}
  },[]);return <canvas ref={canvas} className="cursor-trail" aria-hidden="true"/>
}

function Loader(){const [ready,setReady]=useState(false);useEffect(()=>{const t=setTimeout(()=>setReady(true),800);return()=>clearTimeout(t)},[]);return !ready?<div className="brand-loader"><span className="loader-mark">S</span><span>SUDO-CHAN</span><i/></div>:null}

class WebGLBoundary extends Component<{fallback:ReactNode;children:ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true}}render(){return this.state.failed?this.props.fallback:this.props.children}}
function StaticBot({trackPointer=true,interactions,happy=false,heroActive=false,sceneSide='right',quietDayActive=false,quietDayMoment=null}:{trackPointer?:boolean;interactions:BotInteractions;happy?:boolean;heroActive?:boolean;sceneSide?:'left'|'right';quietDayActive?:boolean;quietDayMoment?:number|null}){
  const head=useRef<HTMLDivElement>(null),pupils=useRef<Array<SVGGElement|null>>([]),eyeNodes=useRef<Array<SVGGElement|null>>([]),eyeTimers=useRef<number[]>([]);
  useEffect(()=>()=>eyeTimers.current.forEach(timer=>window.clearTimeout(timer)),[]);
  useEffect(()=>{if(!trackPointer)return;const move=(e:PointerEvent)=>{const x=(e.clientX/innerWidth-.5)*2,y=(e.clientY/innerHeight-.5)*2;if(head.current)head.current.style.setProperty('--bot-tilt',`rotateX(${-y*6}deg) rotateY(${x*9}deg)`);for(const pupil of pupils.current)if(pupil)pupil.style.transform=`translate(${x*3.1}px,${y*2.5}px)`};window.addEventListener('pointermove',move,{passive:true});return()=>window.removeEventListener('pointermove',move)},[trackPointer]);
  const blinkEye=(side:0|1,fast=false)=>{const node=eyeNodes.current[side];if(!node||interactions.reducedMotion)return;window.clearTimeout(eyeTimers.current[side]);node.style.transition=`transform ${fast?OUCH_BLINK_CLOSE_DURATION_MS:BLINK_CLOSE_DURATION_MS}ms ease-in`;node.style.transform='scaleY(.06)';eyeTimers.current[side]=window.setTimeout(()=>{node.style.transition=`transform ${fast?OUCH_BLINK_OPEN_DURATION_MS:BLINK_OPEN_DURATION_MS}ms ease-out`;node.style.transform=interactions.sleepingRef.current?'scaleY(.06)':''},fast?OUCH_BLINK_OPEN_DURATION_MS:BLINK_OPEN_DURATION_MS)};
  const activateEye=(side:0|1)=>{if(interactions.onEyeHover(side))blinkEye(side)};
  const activateEyeClick=(event:MouseEvent<SVGElement>,side:0|1)=>{event.stopPropagation();const asleep=interactions.sleepingRef.current;interactions.onEyeClick(side);if(!asleep)blinkEye(side,true)};
  const staticMood=interactions.mood?.toLowerCase()??'calm';
  return <div className="static-bot" data-mood={staticMood} data-hero-active={heroActive} data-scene-side={sceneSide} role="button" tabIndex={0} aria-label="Sudo-chan. Press Enter or Space to say hello." onClick={interactions.onWelcome} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();interactions.onWelcome()}}} style={{position:'absolute',inset:0,display:'grid',placeItems:'center',overflow:'hidden',cursor:'pointer',touchAction:'pan-y'}}><div ref={head} className="static-bot-head" style={{position:'relative',width:250,height:300,pointerEvents:'none'}}>
    <CompanionSvg eyeNodes={eyeNodes} pupils={pupils} redness={interactions.redness} sleeping={interactions.sleeping} reducedMotion={interactions.reducedMotion} happy={happy||interactions.mood==='Happy'} mood={staticMood} onEyeEnter={activateEye} onEyeClick={activateEyeClick}/>
    {quietDayActive&&quietDayMoment===3&&<span className="quiet-day-bot-shield" aria-hidden="true"/>}
  </div></div>
}

function Waitlist(){
  const [email,setEmail]=useState('');
  const [loading,setLoading]=useState(false);
  const [done,setDone]=useState(false);
  const [notice,setNotice]=useState<{kind:'idle'|'success'|'duplicate'|'invalid'|'error';message:string}>({kind:'idle',message:''});
  useEffect(()=>{if(!done)return;const timeoutId=window.setTimeout(()=>setDone(false),3000);return()=>window.clearTimeout(timeoutId)},[done]);
  const submit=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    if(loading)return;
    setLoading(true);
    setNotice({kind:'idle',message:''});
    const controller=new AbortController();
    const timeoutId=window.setTimeout(()=>controller.abort(),10_000);
    try{
      const response=await fetch('/api/waitlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email}),signal:controller.signal});
      let result:{ok?:unknown;message?:unknown}|null=null;
      try{result=await response.json()}catch{result=null}

      const message=typeof result?.message==='string'?result.message:'';
      if(response.status===409){setNotice({kind:'duplicate',message:message||"You're already on the list."});return}
      if(response.status===400){setNotice({kind:'invalid',message:message||'Please enter a valid email address.'});return}
      if(!response.ok||result?.ok!==true){setNotice({kind:'error',message:message||"We couldn't add you right now. Please try again shortly."});return}

      setEmail('');
      setDone(true);
      setNotice({kind:'success',message:message||"You're on the list. We'll be in touch soon."});
      refreshWaitlistCount();
    }catch(error){
      if(error instanceof Error&&error.name==='AbortError'){
        setNotice({kind:'error',message:'This is taking longer than expected. Please try again.'});
      }else{
        setNotice({kind:'error',message:"We couldn't reach the server. Please try again."});
      }
    }finally{
      window.clearTimeout(timeoutId);
      setLoading(false);
    }
  };
  const helper=notice.kind==='idle'?'One email when she is ready. There is no download yet.':notice.message;
  return <form onSubmit={submit} className="waitlist glass-panel"><label htmlFor="waitlist-email">Coming soon · join the waitlist</label><div className="waitlist-row"><input id="waitlist-email" value={email} onChange={e=>setEmail(e.target.value)} type="email" autoComplete="email" placeholder="you@example.com" required disabled={loading||done}/><button type="submit" disabled={loading||done} aria-busy={loading} className={loading?'is-loading':''}>{loading?'Adding you…':done?'Done':'Join waitlist ↗'}</button></div><small aria-live="polite" role={notice.kind==='error'||notice.kind==='invalid'?'alert':'status'} className={`form-message ${loading?'loading':notice.kind}`}>{loading?'Sending your signup…':helper}</small><a className="waitlist-privacy-link" href="/privacy">{content.waitlistPrivacyLink}</a></form>
}

export default function SudoChanJourney(){
  const journey=useRef<HTMLDivElement>(null);const progress=useRef(0);const pointer=useRef({x:0,y:0,vx:0,vy:0});const progressBar=useRef<HTMLDivElement>(null);const demoStatus=useRef<HTMLDivElement>(null);const resolvedDemo=useRef(false);const sceneIndexRef=useRef(0);const chapterRef=useRef(1);const reducedPreference=useReducedMotion();const [hasMounted,setHasMounted]=useState(false);const reduced=hasMounted?reducedPreference:false;const [sceneIndex,setSceneIndex]=useState(0);const [chapter,setChapter]=useState(1);const [selectedMood,setSelectedMood]=useState<BotMood|null>(null);const [loaded,setLoaded]=useState(false);const [canWebGL,setCanWebGL]=useState<boolean|null>(null);const [quietDayActive,setQuietDayActive]=useState(false);const [quietDayMoment,setQuietDayMoment]=useState<number|null>(null);const [botSpeech,setBotSpeech]=useState('');const [botSleeping,setBotSleeping]=useState(false);const [botHappy,setBotHappy]=useState(false);const [eyeRedness,setEyeRedness]=useState(0);const [debugEyeClicks,setDebugEyeClicks]=useState(0);const sleepingRef=useRef(false);const rednessRef=useRef(0);const happyUntilRef=useRef(0);const eyeBlinksRef=useRef<[number,number]>([0,0]);const eyeBlinkDirectionsRef=useRef<[number,number]>([0,0]);const eyeBlinkDurationsRef=useRef<[number,number]>([BLINK_CLOSE_DURATION_MS,BLINK_CLOSE_DURATION_MS]);const eyeClickCount=useRef(0);const welcomeIndex=useRef(0);const lastEyeHover=useRef<[number,number]>([-Infinity,-Infinity]);const speechTimeout=useRef<number|null>(null);const happyTimeout=useRef<number|null>(null);const napTimeout=useRef<number|null>(null);const rednessInterval=useRef<number|null>(null);const currentYear = new Date().getFullYear();
  useEffect(()=>{setHasMounted(true)},[]);
  const showBotSpeech=useCallback((message:string,duration:number)=>{if(speechTimeout.current!==null)window.clearTimeout(speechTimeout.current);setBotSpeech(message);speechTimeout.current=window.setTimeout(()=>{setBotSpeech('');speechTimeout.current=null},duration)},[]);
  const onMoodChange=useCallback((mood:BotMood)=>setSelectedMood(mood),[]);
  const onQuietDayMoodChange=useCallback((mood:BotMood|null)=>setSelectedMood(mood),[]);
  const onQuietDayActiveChange=useCallback((active:boolean)=>setQuietDayActive(active),[]);
  const onQuietDayMomentChange=useCallback((moment:number|null)=>setQuietDayMoment(moment),[]);
  const onDemoSpeech=useCallback((message:string)=>showBotSpeech(message,WELCOME_DURATION_MS),[showBotSpeech]);
  const onSectionChange=useCallback((section:number)=>{if(chapterRef.current!==section){chapterRef.current=section;setChapter(section)}if(section>7)sceneIndexRef.current=-1},[]);
  const onWelcome=useCallback(()=>{if(sleepingRef.current)return;happyUntilRef.current=performance.now()+WELCOME_DURATION_MS;setBotHappy(true);if(happyTimeout.current!==null)window.clearTimeout(happyTimeout.current);happyTimeout.current=window.setTimeout(()=>{setBotHappy(false);happyTimeout.current=null},WELCOME_DURATION_MS);const message=WELCOME_LINES[welcomeIndex.current];welcomeIndex.current=(welcomeIndex.current+1)%WELCOME_LINES.length;showBotSpeech(message,WELCOME_DURATION_MS)},[showBotSpeech]);
  const onEyeHover=useCallback((side:0|1)=>{if(Boolean(reduced)||sleepingRef.current)return false;const now=performance.now();if(now-lastEyeHover.current[side]<EYE_HOVER_THROTTLE_MS)return false;lastEyeHover.current[side]=now;eyeBlinksRef.current[side]=0;eyeBlinkDirectionsRef.current[side]=1;eyeBlinkDurationsRef.current[side]=BLINK_CLOSE_DURATION_MS;return true},[reduced]);
  const onEyeClick=useCallback((side:0|1)=>{if(sleepingRef.current)return;eyeClickCount.current=Math.min(EYE_REDNESS_CLICK_LIMIT,eyeClickCount.current+1);if(DEBUG_EYE_CLICKS)setDebugEyeClicks(eyeClickCount.current);const nextRedness=Math.min(1,rednessRef.current+1/EYE_REDNESS_CLICK_LIMIT);rednessRef.current=nextRedness;setEyeRedness(nextRedness);if(!reduced){eyeBlinksRef.current[side]=0;eyeBlinkDirectionsRef.current[side]=1;eyeBlinkDurationsRef.current[side]=OUCH_BLINK_CLOSE_DURATION_MS}
    if(eyeClickCount.current>=EYE_REDNESS_CLICK_LIMIT){sleepingRef.current=true;setBotSleeping(true);setBotHappy(false);happyUntilRef.current=0;if(happyTimeout.current!==null){window.clearTimeout(happyTimeout.current);happyTimeout.current=null}showBotSpeech("Okay, okay... I'm taking a nap. Zzz",SLEEP_DURATION_MS);napTimeout.current=window.setTimeout(()=>{sleepingRef.current=false;setBotSleeping(false);eyeClickCount.current=0;if(DEBUG_EYE_CLICKS)setDebugEyeClicks(0);setBotSpeech('');speechTimeout.current=null;napTimeout.current=null;if(rednessInterval.current!==null)window.clearInterval(rednessInterval.current);rednessInterval.current=window.setInterval(()=>{const next=Math.max(0,rednessRef.current-REDNESS_DECAY_PER_INTERVAL);rednessRef.current=next;setEyeRedness(next);if(next===0&&rednessInterval.current!==null){window.clearInterval(rednessInterval.current);rednessInterval.current=null}},REDNESS_DECAY_INTERVAL_MS)},SLEEP_DURATION_MS);return}
    if(eyeClickCount.current%OUCH_EVERY_N_CLICKS===0)showBotSpeech('Ouch!',OUCH_BUBBLE_DURATION_MS)},[reduced,showBotSpeech]);
  const interactions:BotInteractions={reducedMotion:Boolean(reduced),mood:selectedMood,sleeping:botSleeping,redness:eyeRedness,sleepingRef,rednessRef,happyUntilRef,eyeBlinksRef,eyeBlinkDirectionsRef,eyeBlinkDurationsRef,onWelcome,onEyeHover,onEyeClick};
  useEffect(()=>()=>{if(speechTimeout.current!==null)window.clearTimeout(speechTimeout.current);if(happyTimeout.current!==null)window.clearTimeout(happyTimeout.current);if(napTimeout.current!==null)window.clearTimeout(napTimeout.current);if(rednessInterval.current!==null)window.clearInterval(rednessInterval.current)},[]);
  useEffect(()=>{const nav=navigator as Navigator&{deviceMemory?:number;connection?:{saveData?:boolean}};let webgl=false;try{const canvas=document.createElement('canvas');const context=canvas.getContext('webgl2')||canvas.getContext('webgl');if(context){context.getExtension('WEBGL_lose_context')?.loseContext();webgl=true}}catch{webgl=false}const renderer=chooseRenderer({coarsePointer:matchMedia('(pointer:coarse)').matches,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,saveData:nav.connection?.saveData===true,hardwareConcurrency:nav.hardwareConcurrency,deviceMemory:nav.deviceMemory,webgl});if(renderer==='css'){setCanWebGL(false);return}const start=()=>setCanWebGL(true);const idle=(window as Window&{requestIdleCallback?:(cb:()=>void,opts?:{timeout:number})=>number;cancelIdleCallback?:(id:number)=>void});if(idle.requestIdleCallback){const id=idle.requestIdleCallback(start,{timeout:900});return()=>idle.cancelIdleCallback?.(id)}const timer=window.setTimeout(start,250);return()=>window.clearTimeout(timer)},[]);
  useEffect(()=>{gsap.registerPlugin(ScrollTrigger);const lenis=reduced?null:new Lenis({duration:1.15,easing:t=>Math.min(1,1.001-Math.pow(2,-10*t)),smoothWheel:true});let ticker:((time:number)=>void)|null=null;if(lenis){lenis.on('scroll',ScrollTrigger.update);ticker=(time:number)=>lenis.raf(time*1000);gsap.ticker.add(ticker);gsap.ticker.lagSmoothing(0)}const ctx=gsap.context(()=>{const root=journey.current;if(!root)return;const boundaries=[0.098,0.256,0.415,0.573,0.732,0.890];ScrollTrigger.create({trigger:root,start:'top top',end:'bottom bottom',onUpdate:self=>{const value=clamp((self.scroll()-self.start)/Math.max(1,self.end-self.start));progress.current=reduced?0:value;root.classList.toggle('is-hero-active',value<.035);if(progressBar.current)progressBar.current.style.transform=`scaleX(${value})`;const resolved=value>.665;if(resolved!==resolvedDemo.current){resolvedDemo.current=resolved;demoStatus.current?.classList.toggle('resolved',resolved);const label=demoStatus.current?.querySelector('.demo-status-label');if(label)label.textContent=resolved?'Example · typo fixed':'Example · you clicked Allow'}let next=0;for(let i=0;i<boundaries.length;i++){if(value>=boundaries[i])next=i+1;else break;}if(sceneIndexRef.current!==next){sceneIndexRef.current=next;setSceneIndex(next);onSectionChange(next+1)}}});if(!reduced){gsap.to(root,{backgroundColor:()=>getComputedStyle(document.documentElement).getPropertyValue('--color-journey-deep').trim(),ease:'none',scrollTrigger:{trigger:root,start:'14% top',end:'46% top',scrub:true,invalidateOnRefresh:true}});gsap.to(root,{backgroundColor:()=>getComputedStyle(document.documentElement).getPropertyValue('--color-journey').trim(),ease:'none',scrollTrigger:{trigger:root,start:'79% top',end:'95% top',scrub:true,invalidateOnRefresh:true}})}},journey);const move=(e:PointerEvent)=>{const x=(e.clientX/innerWidth-.5)*2,y=(e.clientY/innerHeight-.5)*2;pointer.current.vx=x-pointer.current.x;pointer.current.vy=y-pointer.current.y;pointer.current.x=x;pointer.current.y=y};const syncThemeBackground=()=>{const root=journey.current;if(!root)return;const styles=getComputedStyle(document.documentElement);const pageColor=styles.getPropertyValue('--color-journey').trim();const deepColor=styles.getPropertyValue('--color-journey-deep').trim();const value=progress.current;const depth=value<.14?0:value<.46?(value-.14)/.32:value<.79?1:value<.95?1-(value-.79)/.16:0;gsap.set(root,{backgroundColor:gsap.utils.interpolate(pageColor,deepColor,depth)})};const onScrollTriggerRefresh=()=>window.requestAnimationFrame(syncThemeBackground);const refreshTheme=()=>{ScrollTrigger.refresh();syncThemeBackground()};ScrollTrigger.addEventListener('refresh',onScrollTriggerRefresh);window.addEventListener('pointermove',move,{passive:true});window.addEventListener('sudo-chan-theme-change',refreshTheme);return()=>{ScrollTrigger.removeEventListener('refresh',onScrollTriggerRefresh);ctx.revert();if(ticker)gsap.ticker.remove(ticker);lenis?.destroy();window.removeEventListener('pointermove',move);window.removeEventListener('sudo-chan-theme-change',refreshTheme)}},[onSectionChange,reduced]);
  const currentSceneSide=sceneIndex%2===0?'right':'left';
  return <><main id="top" className={`journey ${reduced?'reduced-motion':''} ${!reduced&&sceneIndex>0&&sceneIndex<6?'is-dark-world':''} ${sceneIndex===0?'is-hero-active':''}`} data-scene-side={currentSceneSide} ref={journey}>
    <a href="#page-content" className="skip-link">Skip to content</a>
    <div id="page-content" />
    <div className="scene-stage">{reduced?<StaticBot trackPointer={false} interactions={interactions} happy={botHappy} heroActive={sceneIndex===0} sceneSide={currentSceneSide} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment}/>:canWebGL===false?<StaticBot interactions={interactions} happy={botHappy} heroActive={sceneIndex===0} sceneSide={currentSceneSide} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment}/>:canWebGL===true?<WebGLBoundary fallback={<StaticBot interactions={interactions} happy={botHappy} heroActive={sceneIndex===0} sceneSide={currentSceneSide} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment}/>}><SudoChanCanvas progress={progress} pointer={pointer} interactions={interactions} quietDayActive={quietDayActive} quietDayMoment={quietDayMoment} onReady={()=>setLoaded(true)} onFail={()=>setCanWebGL(false)}/></WebGLBoundary>:null}{botSpeech&&<div className="bot-speech" role="status" aria-live="polite">{botSpeech}</div>}{DEBUG_EYE_CLICKS&&<div className="eye-click-debug" aria-live="polite">Eye clicks: {debugEyeClicks}/{EYE_REDNESS_CLICK_LIMIT} · redness: {Math.round(eyeRedness*100)}%</div>}<div className="stage-hud"/><div className="stage-vignette"/></div>
    <header className="site-nav"><a href="#top" className="wordmark"><span>S</span> {content.brand}</a><span className="nav-note">{content.comingSoon.badge.toUpperCase()}</span><div className="site-nav-actions"><ThemeToggle/><a className="nav-link" href="#join">{content.comingSoon.cta} <i>↗</i></a></div></header>
    {!loaded&&<Loader/>}
    {content.scenes.map((item,i)=>{
      const HeadingTag = i === 0 ? 'h1' : 'h2';
      return <Fragment key={item.id}><section id={item.id==='join'?'join':item.id} className={`journey-scene scene-${item.id} ${sceneIndex===i?'is-current':''}`} aria-label={item.label}>
        <div className={`scene-copy ${i%2===0?'align-left':'align-right'}`}>
          <span className="scene-index"><i/>{item.number}</span>
          <HeadingTag>{item.title.split('\n').map((line,j)=><span key={j}>{line}</span>)}</HeadingTag>
          <p>{item.body}</p>
          {i===0&&<div className="hero-cta"><span className="coming-soon-badge">{content.comingSoon.badge}</span><a className="hero-cta-link" href="#join">{content.comingSoon.cta} <i>↗</i></a></div>}
          {i===0&&<WaitlistCount/>}
          {i===0&&<span className="intro-quote">“{content.intro.line}”</span>}
          {i===0&&<MoodPicker selected={selectedMood} onMoodChange={onMoodChange}/>}
          {i===2&&<div className="feature-callouts">{content.core.map((c,n)=><div key={c.title} className={`callout callout-${n}`}><i>{String(n+1).padStart(2,'0')}</i><b>{c.title}</b><span>{c.body}</span></div>)}</div>}
          {i===3&&<ol className="approval-steps" aria-label="How approval works"><li><b>01</b> She proposes</li><li><b>02</b> She shows you</li><li><b>03</b> You click</li><li><b>04</b> Then it runs</li></ol>}
          {i===4&&<div className="demo-status" ref={demoStatus}><span/><span className="demo-status-label">Example · you clicked Allow</span></div>}
          {i===4&&<LazySlot minHeight={390}><StuckDetectorPreview onMoodChange={onMoodChange} onSpeech={onDemoSpeech}/></LazySlot>}
          {i===5&&<TrustPanel/>}
          {i===6&&<Waitlist/>}
        </div>
        {i===0&&<a className="scroll-cue" href={`#${content.scenes[1]?.id||'look'}`}><span>SCROLL TO EXPLORE</span><i>↓</i></a>}
        {i===6&&<footer className="site-footer"><span>© {currentYear} SUDO-CHAN</span><span>{content.footer}</span><a href="/privacy">{content.privacyPage.title}</a><a href="#top">BACK TO TOP ↑</a></footer>}
      </section></Fragment>;
    })}
    <CustomCursor/><div className="scroll-progress" ref={progressBar}/><div className="scene-counter">{String(chapter).padStart(2,'0')} <i>/</i> 10</div>
  </main><RoundCSections onSectionChange={onSectionChange} onMoodChange={onQuietDayMoodChange} onQuietDayActiveChange={onQuietDayActiveChange} onQuietDayMomentChange={onQuietDayMomentChange} reducedMotion={Boolean(reduced)}/></>
}
