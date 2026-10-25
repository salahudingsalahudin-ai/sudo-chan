'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import dynamic from 'next/dynamic';
import { content } from '@/content';
import { characters, creatures, colors, densities, defaults, plainName, rasterize, readPicture, restoreSettings, samplePixels, storageKey, type Settings, type Shape } from '@/lib/particlePortrait';
import styles from './MakeHerYours.module.css';

const ParticlePortrait = dynamic(() => import('./ParticlePortrait'), { ssr: false });
const copy = content.personalize;
function StaticPortrait({ points, settings }: { points: Float32Array; settings: Settings }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, 512, 512); ctx.fillStyle = colors[settings.color]; ctx.globalAlpha = Math.min(1, .35 + settings.glow * .2);
    for (let i = 0; i < densities[settings.density] * 3; i += 3) {
      ctx.beginPath(); ctx.arc(256 + points[i] * 122, 256 - points[i + 1] * 122, .75 + settings.glow * .35, 0, Math.PI * 2); ctx.fill();
    }
  }, [points, settings.color, settings.glow, settings.density]);
  return <canvas ref={canvas} width={512} height={512} data-renderer="static" aria-hidden="true" />;
}
function ShapeRadio({ value, choose, pill = false }: { value: string; choose: (shape: Shape) => void; pill?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = characters.indexOf(value as Shape);
  return <div className={pill ? styles.pill : styles.options} role="radiogroup" aria-label={copy.character} style={{ '--selected': Math.max(0, selected) } as CSSProperties} data-has-selection={selected >= 0}>
    {pill && <span className={styles.highlight} aria-hidden="true" />}
    {characters.map((shape, i) => <button key={shape} ref={element => { refs.current[i] = element; }} type="button" role="radio" aria-checked={value === shape} tabIndex={i === Math.max(0, selected) ? 0 : -1} onClick={() => choose(shape)} onKeyDown={event => {
      let next = i;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (i + 1) % 3;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (i + 2) % 3;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = 2;
      else return;
      event.preventDefault(); choose(characters[next]); refs.current[next]?.focus();
    }}>{copy.shapes[shape]}</button>)}
  </div>;
}
export default function MakeHerYours({ active, onActiveChange }: { active: boolean; onActiveChange: (active: boolean) => void }) {
  const section = useRef<HTMLElement>(null), dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLButtonElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<Settings>(defaults());
  const [ready, setReady] = useState(false), [still, setStill] = useState(true), [open, setOpen] = useState(false);
  const [picture, setPicture] = useState<ImageData | null>(null), [points, setPoints] = useState<Float32Array | null>(null);
  const [message, setMessage] = useState('');
  const weak = useRef(false), uploadVersion = useRef(0), shapeCache = useRef(new Map<Shape, Promise<ImageData>>());
  const patch = useCallback((value: Partial<Settings>) => setSettings(previous => ({ ...previous, ...value })), []);
  const choose = (shape: Shape) => { uploadVersion.current++; setPicture(null); setMessage(''); patch({ shape }); };
  const lowerDensity = useCallback((density: Settings['density']) => patch({ density }), [patch]);
  const fallback = useCallback(() => setStill(true), []);
  useEffect(() => {
    weak.current = (navigator.hardwareConcurrency || 2) <= 4;
    const motion = matchMedia('(prefers-reduced-motion: reduce)'), touch = matchMedia('(pointer: coarse)');
    const preference = () => setStill(motion.matches || (touch.matches && weak.current)); preference();
    motion.addEventListener('change', preference); touch.addEventListener('change', preference);
    let restored = defaults(weak.current);
    try { restored = restoreSettings(JSON.parse(localStorage.getItem(storageKey) || 'null'), weak.current); } catch { /* Storage may be disabled or malformed. */ }
    if (weak.current) restored.density = 'low';
    setSettings(restored); setReady(true);
    return () => { motion.removeEventListener('change', preference); touch.removeEventListener('change', preference); uploadVersion.current++; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Personalization also works without storage. */ }
  }, [settings, ready]);
  useEffect(() => {
    if (!section.current) return;
    const observer = new IntersectionObserver(([entry]) => onActiveChange(entry.isIntersecting), { rootMargin: '120px 0px' });
    observer.observe(section.current);
    return () => { observer.disconnect(); onActiveChange(false); };
  }, [onActiveChange]);
  useEffect(() => {
    if (!active || !ready) return;
    let cancelled = false;
    const update = async () => {
      if (!shapeCache.current.has(settings.shape)) shapeCache.current.set(settings.shape, rasterize(settings.shape));
      const source = picture || await shapeCache.current.get(settings.shape)!;
      const result = samplePixels(source, 14000, picture ? settings.threshold : 90, Boolean(picture));
      if (!cancelled) {
        setPoints(result);
        if (!result) setMessage(copy.emptyError);
        else if (picture) setMessage(copy.uploadReady);
      }
    };
    update().catch(() => { if (!cancelled) setMessage(copy.decodeError); });
    return () => { cancelled = true; };
  }, [active, ready, settings.shape, settings.threshold, picture]);
  const close = () => { dialog.current?.close(); setOpen(false); requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })); };
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  const reset = () => {
    uploadVersion.current++; setPicture(null); setMessage(''); setSettings(defaults(weak.current));
    if (fileInput.current) fileInput.current.value = '';
  };
  const label = picture ? copy.picture : copy.shapes[settings.shape];
  return <section id="make-her-yours" className={styles.section} ref={section} aria-labelledby="personalize-heading" data-panel-open={open} data-shape={picture ? 'picture' : settings.shape}>
    <div className={styles.layout}>
      <div className={styles.copy}>
        <p className={styles.eyebrow}>{copy.eyebrow}</p>
        <h2 id="personalize-heading">{copy.heading}</h2>
        <p className={styles.subline}>{copy.subline}</p>
        <button ref={opener} type="button" className={styles.openButton} aria-haspopup="dialog" aria-expanded={open} aria-controls="personalize-panel" onClick={() => setOpen(true)}>{copy.open}<span aria-hidden="true">↗</span></button>
        <p className={styles.notice}>{copy.notice}</p>
      </div>
      <div className={styles.preview}>
        <div className={styles.figure} role="img" aria-label={(still ? copy.staticLabel : copy.animatedLabel).replace('{shape}', label)}>
          {points && (active && !still ? <ParticlePortrait points={points} settings={settings} onFallback={fallback} onDensity={lowerDensity} /> : <StaticPortrait points={points} settings={settings} />)}
          <span className={styles.orbit} aria-hidden="true" />
        </div>
        <ShapeRadio value={picture ? 'picture' : settings.shape} choose={choose} pill />
        <p className={styles.greeting}>{copy.greeting.replace('{name}', settings.name.trim() || copy.defaultName)}</p>
        {still && <p className={styles.staticNote}>{copy.staticNote}</p>}
      </div>
    </div>
    <p className={styles.srOnly} aria-live="polite" aria-atomic="true">{copy.changed.replace('{shape}', label)}</p>
    <dialog ref={dialog} id="personalize-panel" className={styles.panel} aria-labelledby="personalize-panel-title" onCancel={event => { event.preventDefault(); close(); }} onClose={() => setOpen(false)} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled])'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }} data-lenis-prevent>
      <div className={styles.panelHeader}><h3 id="personalize-panel-title">{copy.panelTitle}</h3><button type="button" aria-label={copy.close} onClick={close}>×</button></div>
      <div className={styles.panelBody}>
        <fieldset><legend>{copy.character}</legend><ShapeRadio value={picture ? 'picture' : settings.shape} choose={choose} /></fieldset>
        <fieldset><legend>{copy.creature}</legend><div className={styles.creatures}>{creatures.map(shape => <button key={shape} type="button" aria-pressed={!picture && settings.shape === shape} onClick={() => choose(shape)}>{copy.shapes[shape]}</button>)}</div></fieldset>
        <div className={styles.upload}>
          <label htmlFor="portrait-picture">{copy.upload}</label>
          <input ref={fileInput} id="portrait-picture" type="file" accept="image/png,image/jpeg" aria-describedby="portrait-upload-note portrait-session-note" onChange={async event => {
            const file = event.target.files?.[0]; if (!file) return;
            const version = ++uploadVersion.current;
            if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) { setMessage(copy.uploadError); event.target.value = ''; return; }
            try { const data = await readPicture(file); if (version === uploadVersion.current) { setPicture(data); setMessage(copy.uploadReady); } }
            catch { if (version === uploadVersion.current) setMessage(copy.decodeError); }
          }} />
          <p id="portrait-upload-note">{copy.uploadNote}</p><p id="portrait-session-note">{copy.sessionNote}</p>
          {message && <p role="status">{message}</p>}
          {picture && <label className={styles.slider}>{copy.threshold}<output>{settings.threshold}</output><input type="range" min="0" max="250" value={settings.threshold} onChange={event => patch({ threshold: Number(event.target.value) })} /></label>}
        </div>
        <fieldset><legend>{copy.color}</legend><div className={styles.colors}>{(Object.keys(colors) as Settings['color'][]).map(color => <button key={color} type="button" aria-pressed={settings.color === color} onClick={() => patch({ color })}><i style={{ background: colors[color] }} aria-hidden="true" />{copy.colors[color]}</button>)}</div></fieldset>
        <label className={styles.slider}>{copy.glow}<output>{settings.glow.toFixed(1)}</output><input type="range" min="0.3" max="2" step="0.1" value={settings.glow} onChange={event => patch({ glow: Number(event.target.value) })} /></label>
        <fieldset><legend>{copy.density}</legend><div className={styles.options}>{(Object.keys(densities) as Settings['density'][]).map(density => <button key={density} type="button" aria-pressed={settings.density === density} onClick={() => patch({ density })}>{copy.densities[density]}</button>)}</div><p>{copy.densityNote}</p></fieldset>
        <label className={styles.name}>{copy.name}<input type="text" maxLength={20} value={settings.name} onChange={event => patch({ name: plainName(event.target.value) })} aria-describedby="portrait-name-hint" autoComplete="off" /><span id="portrait-name-hint">{copy.nameHint}</span></label>
        <button type="button" className={styles.reset} onClick={reset}>{copy.reset}</button>
      </div>
    </dialog>
  </section>;
}
