'use client';

import { Component, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import dynamic from 'next/dynamic';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from '@studio-freight/lenis';
import { useReducedMotion } from 'framer-motion';
import { content } from '@/content';

type SceneProps={progress:{current:number};pointer:{current:{x:number;y:number;vx:number;vy:number}}};
const SudoChanCanvas=dynamic(()=>import('./SudoChanCanvas'),{ssr:false});
const clamp=(n:number,a=0,b=1)=>Math.min(b,Math.max(a,n));

function CustomCursor(){
  const core=useRef<HTMLSpanElement>(null),lens=useRef<HTMLSpanElement>(null),ring=useRef<HTMLSpanElement>(null);const [click,setClick]=useState(0);
  useEffect(()=>{if(matchMedia('(pointer:coarse)').matches||matchMedia('(prefers-reduced-motion: reduce)').matches)return;let frame=0,x=-100,y=-100,tx=-100,ty=-100;let activeTarget:HTMLElement|null=null;const clearMagnet=()=>{if(activeTarget){activeTarget.style.removeProperty('--magnet-x');activeTarget.style.removeProperty('--magnet-y');activeTarget.classList.remove('magnetic-target');activeTarget=null}};
    const move=(e:PointerEvent)=>{tx=e.clientX;ty=e.clientY;const stage=document.querySelector<HTMLElement>('.scene-stage');stage?.style.setProperty('--cursor-x',`${e.clientX}px`);stage?.style.setProperty('--cursor-y',`${e.clientY}px`);if(e.pointerType!=='mouse')return;const element=e.target instanceof Element?e.target.closest<HTMLElement>('a,button,input'):null;if(element!==activeTarget){clearMagnet();activeTarget=element;if(activeTarget)activeTarget.classList.add('magnetic-target')}if(activeTarget){const rect=activeTarget.getBoundingClientRect();activeTarget.style.setProperty('--magnet-x',`${clamp((e.clientX-rect.left-rect.width/2)*.18,-9,9)}px`);activeTarget.style.setProperty('--magnet-y',`${clamp((e.clientY-rect.top-rect.height/2)*.18,-9,9)}px`)}ring.current?.classList.toggle('is-active',Boolean(element))};
    const down=(e:PointerEvent)=>{if(e.pointerType==='mouse')setClick(v=>v+1)};const tick=()=>{x+=(tx-x)*.19;y+=(ty-y)*.19;for(const node of [core.current,lens.current,ring.current])if(node){node.style.left=`${x}px`;node.style.top=`${y}px`}frame=requestAnimationFrame(tick)};
    window.addEventListener('pointermove',move,{passive:true});window.addEventListener('pointerdown',down);frame=requestAnimationFrame(tick);return()=>{cancelAnimationFrame(frame);clearMagnet();window.removeEventListener('pointermove',move);window.removeEventListener('pointerdown',down)}
  },[]);return <><span ref={core} className="cursor-core"/><span ref={lens} key={click} className="cursor-lens"/><span ref={ring} className="cursor-magnet"/></>
}

function CursorTrail(){
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{const element=canvas.current;if(!element||matchMedia('(pointer:coarse)').matches||matchMedia('(prefers-reduced-motion: reduce)').matches)return;const context=element.getContext('2d');if(!context)return;let width=0,height=0,dpr=1,frame=0,lastTime=performance.now(),lastX=-1,lastY=-1;const particles:{x:number;y:number;vx:number;vy:number;life:number;max:number;size:number;color:string;angle:number}[]=[];const ripples:{x:number;y:number;age:number}[]=[];
    const resize=()=>{dpr=Math.min(devicePixelRatio||1,1.5);width=innerWidth;height=innerHeight;element.width=Math.round(width*dpr);element.height=Math.round(height*dpr);element.style.width=`${width}px`;element.style.height=`${height}px`;context.setTransform(dpr,0,0,dpr,0,0)};
    const move=(e:PointerEvent)=>{if(e.pointerType!=='mouse')return;if(lastX>=0){const dx=e.clientX-lastX,dy=e.clientY-lastY,distance=Math.hypot(dx,dy),count=Math.min(4,Math.floor(distance/7));for(let i=0;i<count;i++){const t=(i+1)/(count+1);particles.push({x:lastX+dx*t,y:lastY+dy*t,vx:-dx*.018+(Math.random()-.5)*22,vy:-dy*.018-8-Math.random()*12,life:.35+Math.random()*.28,max:.63,size:2+Math.random()*3,color:Math.random()>.24?'56,232,255':'255,145,181',angle:Math.random()*Math.PI})}if(particles.length>54)particles.splice(0,particles.length-54)}lastX=e.clientX;lastY=e.clientY};
    const click=(e:PointerEvent)=>{if(e.pointerType==='mouse')ripples.push({x:e.clientX,y:e.clientY,age:0})};
    const draw=(now:number)=>{const dt=Math.min(.04,(now-lastTime)/1000);lastTime=now;if(particles.length||ripples.length){context.clearRect(0,0,width,height);context.globalCompositeOperation='lighter';for(let i=particles.length-1;i>=0;i--){const p=particles[i];p.life-=dt;if(p.life<=0){particles.splice(i,1);continue}p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=9*dt;p.angle+=dt*1.2;context.save();context.translate(p.x,p.y);context.rotate(p.angle);context.globalAlpha=Math.min(1,p.life/p.max)*.72;context.fillStyle=`rgba(${p.color},.92)`;context.shadowBlur=12;context.shadowColor=`rgba(${p.color},.8)`;context.beginPath();context.ellipse(0,0,p.size*.58,p.size*1.35,0,0,Math.PI*2);context.fill();context.restore()}for(let i=ripples.length-1;i>=0;i--){const r=ripples[i];r.age+=dt;if(r.age>.62){ripples.splice(i,1);continue}context.beginPath();context.arc(r.x,r.y,r.age*43,0,Math.PI*2);context.strokeStyle=`rgba(56,232,255,${(1-r.age/.62)*.35})`;context.lineWidth=1;context.stroke()}context.globalCompositeOperation='source-over'}frame=requestAnimationFrame(draw)};
    resize();window.addEventListener('resize',resize);window.addEventListener('pointermove',move,{passive:true});window.addEventListener('pointerdown',click);frame=requestAnimationFrame(draw);return()=>{cancelAnimationFrame(frame);window.removeEventListener('resize',resize);window.removeEventListener('pointermove',move);window.removeEventListener('pointerdown',click)}
  },[]);return <canvas ref={canvas} className="cursor-trail" aria-hidden="true"/>
}

function Loader(){const [ready,setReady]=useState(false);useEffect(()=>{const t=setTimeout(()=>setReady(true),800);return()=>clearTimeout(t)},[]);return !ready?<div className="brand-loader"><span className="loader-mark">S</span><span>SUDO-CHAN</span><i/></div>:null}

class WebGLBoundary extends Component<{fallback:ReactNode;children:ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true}}render(){return this.state.failed?this.props.fallback:this.props.children}}
function StaticBot({trackPointer=true}:{trackPointer?:boolean}){
  const [look,setLook]=useState({x:0,y:0});
  useEffect(()=>{if(!trackPointer)return;const move=(e:PointerEvent)=>setLook({x:(e.clientX/innerWidth-.5)*2,y:(e.clientY/innerHeight-.5)*2});window.addEventListener('pointermove',move,{passive:true});return()=>window.removeEventListener('pointermove',move)},[trackPointer]);
  const orb:React.CSSProperties={position:'absolute',left:'50%',transform:'translateX(-50%)',borderRadius:'50%',border:'1px solid #21d4e94a',boxShadow:'0 0 70px #38e8ff26'};
  const eye:React.CSSProperties={position:'relative',display:'grid',placeItems:'center',width:15,height:19,borderRadius:'50%',background:'radial-gradient(ellipse at 35% 35%,#fff,#b9fbff 50%,#43ddec)',boxShadow:'0 0 15px #38e8ff'};
  const pupil:React.CSSProperties={position:'absolute',left:'50%',top:'50%',width:7,height:9,borderRadius:'50%',background:'#06131d',transform:`translate(calc(-50% + ${look.x*3.1}px),calc(-50% + ${look.y*2.5}px))`,boxShadow:'0 0 5px #35eaff'};
  return <div aria-hidden="true" style={{position:'absolute',inset:0,display:'grid',placeItems:'center',overflow:'hidden'}}><div style={{position:'relative',width:250,height:300,transform:`translateY(-3vh) rotateX(${-look.y*6}deg) rotateY(${look.x*9}deg)`,transition:trackPointer?'transform .16s ease-out':'none'}}>
    <span style={{...orb,top:16,width:226,height:226}}/><span style={{position:'absolute',left:'50%',top:20,width:1,height:45,background:'linear-gradient(#38e8ff,transparent)'}}/><span style={{position:'absolute',left:'50%',top:14,width:6,height:6,borderRadius:'50%',background:'#38e8ff',boxShadow:'0 0 18px #38e8ff'}}/>
    <div style={{position:'absolute',left:49,top:48,width:152,height:142,borderRadius:'48% 48% 44% 44%',background:'linear-gradient(145deg,#fff,#d5d9e1 75%,#b8bec8)',boxShadow:'0 25px 70px #11243625,inset -10px -10px 22px #7c849222'}}/>
    <div style={{position:'absolute',left:64,top:104,width:122,height:47,borderRadius:24,background:'linear-gradient(135deg,#0a131d,#111f2a)',border:'1px solid #9cecf452',display:'flex',justifyContent:'space-evenly',alignItems:'center',boxShadow:'0 0 23px #38e8ff28'}}><i style={eye}><b style={pupil}/></i><i style={eye}><b style={pupil}/></i></div>
    <div style={{position:'absolute',left:78,top:177,width:94,height:82,borderRadius:'22px 22px 36px 36px',background:'linear-gradient(145deg,#f9f9fb,#c5cad3)',boxShadow:'inset -9px -9px 16px #72798722'}}/><div style={{position:'absolute',left:113,top:194,width:25,height:25,borderRadius:'50%',background:'radial-gradient(circle at 35% 30%,#e3ffff,#38e8ff 42%,#058da7)',boxShadow:'0 0 30px #38e8ff8a'}}/>
    <span style={{...orb,top:22,width:236,height:195,borderTopColor:'#8ff7ff99',transform:'translateX(-50%) rotate(-22deg)'}}/><span style={{position:'absolute',left:65,bottom:18,width:120,height:16,borderRadius:'50%',background:'#38e8ff15',filter:'blur(8px)'}}/>
  </div></div>
}

function Waitlist(){
  const [email,setEmail]=useState('');
  const [loading,setLoading]=useState(false);
  const [notice,setNotice]=useState<{kind:'idle'|'success'|'duplicate'|'invalid'|'error';message:string}>({kind:'idle',message:''});
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

      setNotice({kind:'success',message:message||"You're on the list. We'll be in touch soon."});
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
  const helper=notice.kind==='idle'?'One thoughtful update when she’s ready. Unsubscribe any time.':notice.message;
  const complete=notice.kind==='success';
  return <form onSubmit={submit} className="waitlist glass-panel"><label htmlFor="waitlist-email">A note when it’s time</label><div className="waitlist-row"><input id="waitlist-email" value={email} onChange={e=>setEmail(e.target.value)} type="email" autoComplete="email" placeholder="you@example.com" required disabled={loading||complete}/><button type="submit" disabled={loading||complete}>{loading?'Adding you…':complete?'You’re on the list ✓':'Get early access ↗'}</button></div><small aria-live="polite" role={notice.kind==='error'||notice.kind==='invalid'?'alert':'status'} className={`form-message ${loading?'loading':notice.kind}`}>{loading?'Sending your signup…':helper}</small></form>
}
function PrivacyControls(){const [paused,setPaused]=useState(false);const [blocked,setBlocked]=useState(false);return <div className="privacy-controls"><button type="button" aria-pressed={paused} onClick={()=>setPaused(!paused)}><span className={`toggle ${paused?'':'on'}`}/>{paused?'Companion paused':'Pause companion'}</button><button type="button" aria-pressed={blocked} onClick={()=>setBlocked(!blocked)}><span className={`toggle ${blocked?'on':''}`}/>{blocked?'Apps blocked':'Block apps'}</button><p>{paused?'PAUSED · YOUR SPACE IS YOURS':blocked?'APP BLOCKLIST ACTIVE':'LOCAL FIRST · ON YOUR DEVICE'}</p></div>}

export default function SudoChanJourney(){
  const journey=useRef<HTMLDivElement>(null);const progress=useRef(0);const pointer=useRef({x:0,y:0,vx:0,vy:0});const reduced=useReducedMotion();const [sceneIndex,setSceneIndex]=useState(0);const [loaded,setLoaded]=useState(false);const [canWebGL,setCanWebGL]=useState<boolean|null>(null);const [progressValue,setProgressValue]=useState(0);
  useEffect(()=>{if(matchMedia('(pointer:coarse)').matches){setCanWebGL(false);return}try{const canvas=document.createElement('canvas');const context=canvas.getContext('webgl2')||canvas.getContext('webgl');if(context){context.getExtension('WEBGL_lose_context')?.loseContext();setCanWebGL(true)}else setCanWebGL(false)}catch{setCanWebGL(false)}},[]);
  useEffect(()=>{gsap.registerPlugin(ScrollTrigger);const lenis=reduced?null:new Lenis({duration:1.1,easing:t=>Math.min(1,1.001-Math.pow(2,-10*t)),smoothWheel:true});let ticker:((time:number)=>void)|null=null;if(lenis){lenis.on('scroll',ScrollTrigger.update);ticker=(time:number)=>lenis.raf(time*1000);gsap.ticker.add(ticker);gsap.ticker.lagSmoothing(0)}const ctx=gsap.context(()=>{const root=journey.current;if(!root)return;ScrollTrigger.create({trigger:root,start:'top top',end:'bottom bottom',onUpdate:self=>{progress.current=reduced?0:self.progress;setProgressValue(Math.round(self.progress*100)/100);const next=Math.min(6,Math.floor(self.progress*7));setSceneIndex(v=>v===next?v:next)}});if(!reduced){gsap.to(root,{backgroundColor:'#04101c',ease:'none',scrollTrigger:{trigger:root,start:'18% top',end:'49% top',scrub:true}});gsap.to(root,{backgroundColor:'#f5f5f7',ease:'none',scrollTrigger:{trigger:root,start:'78% top',end:'96% top',scrub:true}})}},journey);const move=(e:PointerEvent)=>{const x=(e.clientX/innerWidth-.5)*2,y=(e.clientY/innerHeight-.5)*2;pointer.current.vx=x-pointer.current.x;pointer.current.vy=y-pointer.current.y;pointer.current.x=x;pointer.current.y=y};window.addEventListener('pointermove',move,{passive:true});return()=>{ctx.revert();if(ticker)gsap.ticker.remove(ticker);lenis?.destroy();window.removeEventListener('pointermove',move)}},[reduced]);
  return <main id="top" className={`journey ${reduced?'reduced-motion':''} ${!reduced&&sceneIndex>0&&sceneIndex<6?'is-dark-world':''}`} ref={journey}>
    <div className="scene-stage" aria-hidden="true">{reduced?<StaticBot trackPointer={false}/>:canWebGL===false?<StaticBot/>:canWebGL===true?<WebGLBoundary fallback={<StaticBot/>}><SudoChanCanvas progress={progress} pointer={pointer} onReady={()=>setLoaded(true)}/></WebGLBoundary>:null}<div className="stage-hud"/><div className="stage-vignette"/></div>
    <header className="site-nav"><a href="#top" className="wordmark"><span>S</span> {content.brand}</a><span className="nav-note">A QUIET KIND OF COMPANY</span><a className="nav-link" href="#join">Early access <i>↗</i></a></header>
    {!loaded&&<Loader/>}
    {content.scenes.map((item,i)=><section key={item.id} id={item.id==='join'?'join':item.id} className={`journey-scene scene-${item.id} ${sceneIndex===i?'is-current':''}`} aria-label={item.label}>
      <div className={`scene-copy ${i%2===0?'align-left':'align-right'}`}>
        <span className="scene-index"><i/>{item.number}</span><h1>{item.title.split('\n').map((line,j)=><span key={j}>{line}</span>)}</h1><p>{item.body}</p>
        {i===0&&<span className="intro-quote">“{content.intro.line}”</span>}
        {i===2&&<div className="feature-callouts">{content.core.map((c,n)=><div key={c.title} className={`callout callout-${n}`}><i>{String(n+1).padStart(2,'0')}</i><b>{c.title}</b><span>{c.body}</span></div>)}</div>}
        {i===3&&<div className="exploded-labels"><span>01 / SHELL</span><span>02 / VISOR</span><span>03 / CORE</span><span>04 / SENSORS</span></div>}
        {i===4&&<div className={`demo-status ${progressValue>.69?'resolved':''}`}><span/>{progressValue>.69?'Back in your flow':'Same error · 08:42'}</div>}
        {i===5&&<PrivacyControls/>}
        {i===6&&<Waitlist/>}
      </div>
      {i===0&&<a className="scroll-cue" href="#inside"><span>SCROLL TO EXPLORE</span><i>↓</i></a>}
      {i===6&&<footer className="site-footer"><span>© 2025 SUDO-CHAN</span><span>{content.footer}</span><a href="#top">BACK TO TOP ↑</a></footer>}
    </section>)}
    <CursorTrail/><CustomCursor/><div className="scroll-progress" style={{transform:`scaleX(${progressValue})`}}/><div className="scene-counter">{String(sceneIndex+1).padStart(2,'0')} <i>/</i> 07</div>
  </main>
}
