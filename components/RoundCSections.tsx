'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { content } from '@/content';
import type { BotMood } from '@/content';

const STUCK_AUTO_START_MS = 6_000;
const STUCK_OFFER_AFTER_SECONDS = 3;
const REVEAL_ROOT_MARGIN = '280px 0px';
const STORY_MOUNT_ROOT_MARGIN = '2400px 0px';
const STORY_SCROLL_VIEWPORTS = 3.5;
const STORY_ENTRANCE_DURATION = 1.25;
const STORY_STEP_DURATION = 0.9;
const STORY_PANEL_EXIT_DURATION = 0.45;
const STORY_PANEL_ENTER_DURATION = 0.65;
const STORY_ICON_DRAW_DURATION = 0.72;
const STORY_PANEL_COLOR_TOKENS = [
  '--color-section-one',
  '--color-section-two',
  '--color-section-three',
  '--color-section-four',
] as const;
const CARD_REVEAL_DURATION = 0.8;
const CARD_REVEAL_STAGGER = 0.15;
const SCENE_LOOP_DURATION_MS = 5_600;

export function LazySlot({ children, minHeight = 150, onMount, rootMargin = REVEAL_ROOT_MARGIN }: { children: ReactNode; minHeight?: number; onMount?: () => void; rootMargin?: string }) {
  const slot = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setMounted(true);
      onMount?.();
      observer.disconnect();
    }, { rootMargin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMount, rootMargin]);

  return <div ref={slot} className="round-c-lazy-slot" style={{ minHeight }}>
    {mounted ? children : <span className="round-c-placeholder" aria-hidden="true" />}
  </div>;
}

function useReveal(onEnter: () => void) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      onEnter();
    }, { rootMargin: '-30% 0px -30% 0px', threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onEnter]);

  return { ref, visible };
}

function useTitleParallax(reducedMotion: boolean) {
  const title = useRef<HTMLHeadingElement>(null);
  const move = useCallback((event: PointerEvent<HTMLHeadingElement>) => {
    if (reducedMotion || event.pointerType !== 'mouse') return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    event.currentTarget.style.transform = `translate3d(${x * 5}px, ${y * 4}px, 0)`;
  }, [reducedMotion]);
  const reset = useCallback(() => {
    if (title.current) title.current.style.transform = '';
  }, []);
  return { title, move, reset };
}

export function MoodPicker({
  selected,
  onMoodChange,
}: {
  selected: BotMood | null;
  onMoodChange: (mood: BotMood) => void;
}) {
  const moods = content.roundC.moods;
  const activeMood = moods.options.find(option => option.name === selected) ?? moods.options[0];
  return <div className="round-c-moods" aria-label={moods.title}>
    <h2>{moods.title}</h2>
    <p>{moods.description}</p>
    <div className="round-c-mood-buttons" role="group" aria-label={moods.title}>
      {moods.options.map(option => <button
        key={option.name}
        type="button"
        aria-pressed={selected === option.name}
        onClick={() => onMoodChange(option.name)}
      >{option.name}</button>)}
    </div>
    <p className="round-c-mood-description" aria-live="polite">{activeMood.description}</p>
  </div>;
}

export function StuckDetectorPreview({
  onMoodChange,
  onSpeech,
}: {
  onMoodChange: (mood: BotMood) => void;
  onSpeech: (message: string) => void;
}) {
  const demo = content.roundC.stuckDetector;
  const [started, setStarted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [offer, setOffer] = useState(false);
  const [fixed, setFixed] = useState(false);
  const startedRef = useRef(false);
  const fixedRef = useRef(false);

  const start = useCallback(() => {
    if (startedRef.current || fixedRef.current) return;
    startedRef.current = true;
    setStarted(true);
    onMoodChange('Worried');
  }, [onMoodChange]);

  useEffect(() => {
    const timeout = window.setTimeout(start, STUCK_AUTO_START_MS);
    return () => window.clearTimeout(timeout);
  }, [start]);

  useEffect(() => {
    if (!started || fixed) return;
    const interval = window.setInterval(() => setSeconds(value => value + 1), 1_000);
    return () => window.clearInterval(interval);
  }, [fixed, started]);

  useEffect(() => {
    if (!started || fixed || seconds < STUCK_OFFER_AFTER_SECONDS || offer) return;
    setOffer(true);
    onSpeech(demo.offerBubble);
  }, [demo.offerBubble, fixed, offer, onSpeech, seconds, started]);

  const fixTypo = () => {
    if (fixedRef.current) return;
    fixedRef.current = true;
    setFixed(true);
    setOffer(false);
    onMoodChange('Happy');
    onSpeech(demo.fixedBubble);
  };

  return <div className="round-c-stuck-demo" aria-label={demo.preview}>
    <div className="round-c-stuck-header">
      <span>{demo.preview}</span>
      <span className="round-c-local-tag">{demo.localDemo}</span>
    </div>
    <p>{demo.description}</p>
    <div className="round-c-code-window" aria-label={demo.codeLabel}>
      <div className="round-c-code-title"><span/><span/><span/><b>{demo.codeLabel}</b></div>
      <pre><code><span className="round-c-code-muted">01</span> {demo.codeBefore}{'\n'}<span className="round-c-code-muted">02</span> <span className={fixed ? 'round-c-code-fixed' : 'round-c-code-typo'}>{fixed ? demo.fixed : demo.typo}</span></code></pre>
    </div>
    <div className="round-c-demo-controls">
      {!started && <button type="button" onClick={start}>{demo.start}</button>}
      {started && !fixed && <span className="round-c-timer" role="timer" aria-label={`${demo.elapsed}: ${seconds} ${demo.timerUnit}`}>
        {demo.waiting} <b>{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</b>
      </span>}
      {fixed && <span className="round-c-fixed-status" role="status">{demo.fixedStatus}</span>}
      {!started && <span className="round-c-not-started">{demo.notStarted}</span>}
    </div>
    {offer && !fixed && <div className="round-c-fix-bubble" role="status" aria-live="polite">
      <span>{demo.offerBubble}</span>
      <button type="button" onClick={fixTypo}>{demo.fix}</button>
    </div>}
  </div>;
}

function MomentIcon({ name }: { name: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return <svg viewBox="0 0 32 32" aria-hidden="true">
    {name === 'moon' && <path {...common} d="M23.5 21.2A11 11 0 0 1 10.8 8.5a11 11 0 1 0 12.7 12.7Z"/>}
    {name === 'spark' && <><path {...common} d="m16 3 2.6 9.4L28 16l-9.4 2.6L16 28l-2.6-9.4L4 16l9.4-3.6L16 3Z"/><path {...common} d="m25 3 .8 2.2L28 6l-2.2.8L25 9l-.8-2.2L22 6l2.2-.8L25 3Z"/></>}
    {name === 'arrow' && <><path {...common} d="M5 16h20M17 8l8 8-8 8"/><path {...common} d="M5 8v16"/></>}
    {name === 'lock' && <><rect {...common} x="6" y="13" width="20" height="15" rx="3"/><path {...common} d="M10 13V9a6 6 0 0 1 12 0v4"/><path {...common} d="M16 19v3"/></>}
  </svg>;
}

type BuilderCard = typeof content.roundC.useCases.cards[number];

function MiniScene({ card, reducedMotion }: { card: BuilderCard; reducedMotion: boolean }) {
  const [started, setStarted] = useState(false);
  const [visible, setVisible] = useState(false);
  const scene = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scene.current;
    if (!element) return;
    if (reducedMotion) {
      setVisible(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
      if (entry.isIntersecting) setStarted(true);
    }, { threshold: 0.15 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [reducedMotion]);

  const sceneClass = `round-c-mini-scene round-c-mini-${card.title.toLowerCase()}${started && !reducedMotion ? ' is-started' : ''}${visible && !reducedMotion ? ' is-visible' : ''}${reducedMotion ? ' is-static' : ''}`;

  return <div ref={scene} className={sceneClass} role="img" aria-label={card.sceneLabel}>
    <span className="round-c-preview-label">{card.preview}</span>
    <div className="round-c-mini-art" aria-hidden="true">
      {card.title === 'Coders' && <div className="round-c-mini-code">
        <span className="round-c-mini-line-number">01</span><span className="round-c-mini-code-line">{card.sceneLines?.[0]}</span>
        <span className="round-c-mini-line-number">02</span><span className="round-c-mini-code-line">{card.sceneLines?.[1]}</span>
        <span className="round-c-mini-line-number">03</span><span className="round-c-mini-code-line">{card.sceneLines?.[2]}</span>
        <span className="round-c-mini-line-number">04</span><span className="round-c-mini-code-line"><span className="round-c-code-error">{card.sceneLines?.[3]}</span><i className="round-c-mini-caret"/></span>
        <span className="round-c-mini-hint">{card.sceneHint}</span>
      </div>}
      {card.title === 'Designers' && <div className="round-c-mini-design">
        <svg viewBox="0 0 190 94" focusable="false">
          <path className="round-c-design-guide round-c-design-guide-v" d="M95 5v84"/>
          <path className="round-c-design-guide round-c-design-guide-h" d="M8 47h174"/>
          <rect className="round-c-design-frame" x="52" y="17" width="86" height="60" rx="5"/>
          <path className="round-c-design-detail" d="M63 29h27M63 38h53M63 55h19M63 64h39"/>
        </svg>
        <div className="round-c-color-dots"><i/><i/><i/></div>
        <span className="round-c-mini-hint">{card.sceneHint}</span>
      </div>}
      {card.title === 'Students' && <div className="round-c-mini-notes">
        <span className="round-c-note-line round-c-note-heading"/>
        {card.sceneNotes?.map((note, index) => <span className="round-c-note-row" key={note}>
          <i className="round-c-note-check"/>
          <b className={`round-c-note-text round-c-note-text-${index + 1}`}>{note}</b>
        </span>)}
        <span className="round-c-note-progress"><i/></span>
        <span className="round-c-mini-hint">{card.sceneHint}</span>
      </div>}
    </div>
  </div>;
}

export default function RoundCSections({
  onSectionChange,
  reducedMotion,
}: {
  onSectionChange: (section: number) => void;
  reducedMotion: boolean;
}) {
  const enterDay = useCallback(() => onSectionChange(8), [onSectionChange]);
  const enterUseCases = useCallback(() => onSectionChange(9), [onSectionChange]);
  const enterFaq = useCallback(() => onSectionChange(10), [onSectionChange]);
  const day = useReveal(enterDay);
  const useCases = useReveal(enterUseCases);
  const faq = useReveal(enterFaq);
  const dayTitle = useRef<HTMLHeadingElement>(null);
  const casesTitle = useRef<HTMLHeadingElement>(null);
  const faqTitle = useTitleParallax(reducedMotion);
  const storySection = useRef<HTMLElement | null>(null);
  const storyCards = useRef<Array<HTMLElement | null>>([]);
  const storyProgress = useRef<HTMLSpanElement>(null);
  const storyCounter = useRef<HTMLSpanElement>(null);
  const builderGrid = useRef<HTMLDivElement>(null);
  const builderCards = useRef<Array<HTMLDivElement | null>>([]);
  const [dayReady, setDayReady] = useState(false);
  const [buildersReady, setBuildersReady] = useState(false);
  const markDayReady = useCallback(() => setDayReady(true), []);
  const markBuildersReady = useCallback(() => setBuildersReady(true), []);
  const setStoryRef = useCallback((node: HTMLElement | null) => {
    day.ref.current = node;
    storySection.current = node;
  }, [day.ref]);

  useEffect(() => {
    if (!dayReady) return;
    gsap.registerPlugin(ScrollTrigger);
    const root = storySection.current?.parentElement;
    if (!root) return;
    let active = true;
    let media: gsap.MatchMedia | null = null;
    const refresh = () => { if (active) ScrollTrigger.refresh(); };
    const context = gsap.context(() => {
      media = gsap.matchMedia();
      media.add({
        desktop: '(min-width: 768px) and (pointer: fine)',
        mobile: '(max-width: 767px), (pointer: coarse)',
        reduced: '(prefers-reduced-motion: reduce)',
      }, conditions => {
        if (conditions.conditions?.reduced) return;

        const moments = storyCards.current.filter((card): card is HTMLElement => card !== null);
        const titleTweens = [dayTitle.current]
          .filter((title): title is HTMLHeadingElement => title !== null);

        titleTweens.forEach(title => gsap.fromTo(title,
          { opacity: 0.78, scale: 0.985 },
          {
            opacity: 1,
            scale: 1,
            ease: 'none',
            scrollTrigger: { trigger: title, start: 'top 88%', end: 'top 48%', scrub: true },
          },
        ));

        const section = storySection.current;
        if (!conditions.conditions?.desktop || !section) {
          const activateMoment = (current: number) => {
            moments.forEach((moment, index) => {
              moment.classList.toggle('is-active', index === current);
              if (index === current) moment.setAttribute('aria-current', 'step');
              else moment.removeAttribute('aria-current');
            });
            if (storyCounter.current) storyCounter.current.textContent = `${String(current + 1).padStart(2, '0')} / ${String(moments.length).padStart(2, '0')}`;
            if (storyProgress.current) storyProgress.current.style.transform = `scaleX(${(current + 1) / moments.length})`;
          };
          moments.forEach((moment, index) => {
            ScrollTrigger.create({
              trigger: moment,
              start: 'top center',
              end: 'bottom center',
              onEnter: () => activateMoment(index),
              onEnterBack: () => activateMoment(index),
            });
            gsap.fromTo(moment,
              { opacity: 0, y: 40, scale: 0.94 },
              {
                opacity: 1,
                y: 0,
                scale: 1,
                duration: CARD_REVEAL_DURATION,
                ease: 'power3.out',
                scrollTrigger: { trigger: moment, start: 'top 82%', once: true },
              },
            );
          });
          return;
        }

        section.dataset.storyPinned = 'true';
        gsap.set(moments, { opacity: 0, y: 40, scale: 0.94, zIndex: 1, transformOrigin: 'center center' });
        const storyStart = STORY_ENTRANCE_DURATION;
        const timeline = gsap.timeline({
          scrollTrigger: {
            trigger: storySection.current,
            start: 'top top',
            end: () => `+=${window.innerHeight * STORY_SCROLL_VIEWPORTS}`,
            pin: true,
            pinSpacing: true,
            scrub: 0.65,
            anticipatePin: 1,
            invalidateOnRefresh: true,
            onUpdate: self => {
              const elapsed = self.progress * (STORY_ENTRANCE_DURATION + STORY_STEP_DURATION * moments.length) - storyStart;
              const current = Math.max(0, Math.min(moments.length - 1, Math.floor(Math.max(0, elapsed) / STORY_STEP_DURATION)));
              if (storyCounter.current) storyCounter.current.textContent = `${String(current + 1).padStart(2, '0')} / ${String(moments.length).padStart(2, '0')}`;
              moments.forEach((moment, index) => {
                moment.classList.toggle('is-active', index === current);
                if (index === current) moment.setAttribute('aria-current', 'step');
                else moment.removeAttribute('aria-current');
              });
            },
          },
        });

        moments.forEach((moment, index) => {
          const at = storyStart + index * STORY_STEP_DURATION;
          if (index === 0) {
            timeline.fromTo(moment,
              { opacity: 0, y: 40, scale: 0.94 },
              { opacity: 1, y: 0, scale: 1, zIndex: 2, duration: STORY_ENTRANCE_DURATION, ease: 'power3.out' },
              0,
            );
          } else {
            timeline.to(moments[index - 1], {
              opacity: 0,
              y: -28,
              scale: 0.97,
              duration: STORY_PANEL_EXIT_DURATION,
              ease: 'power3.out',
            }, at);
            timeline.fromTo(moment,
              { opacity: 0, y: 40, scale: 0.94 },
              { opacity: 1, y: 0, scale: 1, zIndex: 2, duration: STORY_PANEL_ENTER_DURATION, ease: 'power3.out' },
              at,
            );
          }

          const token = STORY_PANEL_COLOR_TOKENS[index];
          if (token) timeline.to(section, {
            backgroundColor: () => getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
            duration: STORY_STEP_DURATION,
            ease: 'none',
          }, at);

          const strokes = moment.querySelectorAll<SVGGeometryElement>('svg path, svg rect');
          strokes.forEach(stroke => {
            const length = stroke.getTotalLength();
            timeline.fromTo(stroke,
              { strokeDasharray: length, strokeDashoffset: length },
              { strokeDasharray: length, strokeDashoffset: 0, duration: STORY_ICON_DRAW_DURATION, ease: 'power2.out' },
              at,
            );
          });
        });
        if (storyProgress.current) timeline.to(storyProgress.current, { scaleX: 1, duration: STORY_STEP_DURATION * moments.length, ease: 'none' }, storyStart);

        return () => {
          timeline.scrollTrigger?.kill();
          timeline.kill();
          delete section.dataset.storyPinned;
        };
      });

      window.addEventListener('load', refresh, { once: true });
      document.fonts?.ready.then(refresh);
      if (Array.from(document.images).every(image => image.complete)) refresh();
    }, root);
    return () => {
      active = false;
      window.removeEventListener('load', refresh);
      media?.revert();
      context.revert();
    };
  }, [dayTitle, dayReady, reducedMotion]);

  useEffect(() => {
    if (!buildersReady) return;
    gsap.registerPlugin(ScrollTrigger);
    const root = useCases.ref.current?.parentElement;
    if (!root) return;
    let active = true;
    let media: gsap.MatchMedia | null = null;
    const refresh = () => { if (active) ScrollTrigger.refresh(); };
    const context = gsap.context(() => {
      media = gsap.matchMedia();
      media.add({
        desktop: '(min-width: 768px) and (pointer: fine)',
        reduced: '(prefers-reduced-motion: reduce)',
      }, conditions => {
        if (conditions.conditions?.reduced) return;
        const cards = builderCards.current.filter((card): card is HTMLDivElement => card !== null);
        const title = casesTitle.current;
        if (title) gsap.fromTo(title,
          { opacity: 0.78, scale: 0.985 },
          {
            opacity: 1,
            scale: 1,
            ease: 'none',
            scrollTrigger: { trigger: title, start: 'top 88%', end: 'top 48%', scrub: true },
          },
        );

        if (!cards.length || !builderGrid.current) return;
        gsap.fromTo(cards,
          {
            opacity: 0,
            x: index => conditions.conditions?.desktop ? [-36, 0, 36][index] ?? 0 : 0,
            y: index => conditions.conditions?.desktop ? [0, 30, 0][index] ?? 0 : 30,
            scale: 0.94,
            rotationX: 3,
          },
          {
            opacity: 1,
            x: 0,
            y: 0,
            scale: 1,
            rotationX: 0,
            duration: CARD_REVEAL_DURATION,
            stagger: CARD_REVEAL_STAGGER,
            ease: 'power3.out',
            scrollTrigger: { trigger: builderGrid.current, start: 'top 82%', once: true },
            onStart: () => cards.forEach(card => card.classList.add('is-entering')),
            onComplete: () => cards.forEach(card => card.classList.remove('is-entering')),
          },
        );
      });

      window.addEventListener('load', refresh, { once: true });
      document.fonts?.ready.then(refresh);
      if (Array.from(document.images).every(image => image.complete)) refresh();
    }, root);
    return () => {
      active = false;
      window.removeEventListener('load', refresh);
      media?.revert();
      context.revert();
    };
  }, [buildersReady, casesTitle, reducedMotion, useCases.ref]);

  return <div className={`round-c-sections${reducedMotion ? ' round-c-reduced-motion' : ''}`}>
    <section
      ref={setStoryRef}
      data-story-section
      className={`round-c-section round-c-day${day.visible ? ' is-visible' : ''}`}
      aria-labelledby="round-c-day-title"
    >
      <div className="round-c-section-inner">
        <span className="round-c-eyebrow">{content.roundC.quietDay.number}</span>
        <h2 id="round-c-day-title" ref={dayTitle}>{content.roundC.quietDay.title}</h2>
        <p className="round-c-section-intro">{content.roundC.quietDay.description}</p>
        <div className="round-c-story-progress" aria-label={content.roundC.quietDay.progressLabel}>
          <span ref={storyProgress}/>
        </div>
        <div className="round-c-story-step" aria-live="polite">
          <span ref={storyCounter}>01 / 04</span>
          <span>{content.roundC.quietDay.stepLabel}</span>
        </div>
        <LazySlot minHeight={240} onMount={markDayReady} rootMargin={STORY_MOUNT_ROOT_MARGIN}>
          <div className="round-c-timeline" aria-label={content.roundC.quietDay.title}>
            {content.roundC.quietDay.moments.map((moment, index) =>             <article className="round-c-moment" key={moment.title} ref={node => { storyCards.current[index] = node }} aria-label={`${String(index + 1).padStart(2, '0')}. ${moment.title}`}>
              <span className="round-c-moment-icon"><MomentIcon name={moment.icon}/></span>
              <span className="round-c-moment-index">0{index + 1}</span>
              <h3>{moment.title}</h3>
              <p>{moment.body}</p>
            </article>)}
          </div>
        </LazySlot>
      </div>
    </section>

    <section
      ref={useCases.ref}
      className={`round-c-section round-c-use-cases${useCases.visible ? ' is-visible' : ''}`}
      aria-labelledby="round-c-cases-title"
    >
      <div className="round-c-section-inner">
        <span className="round-c-eyebrow">{content.roundC.useCases.number}</span>
        <h2 id="round-c-cases-title" ref={casesTitle}>{content.roundC.useCases.title}</h2>
        <p className="round-c-section-intro">{content.roundC.useCases.description}</p>
        <LazySlot minHeight={400} onMount={markBuildersReady}>
          <div className="round-c-case-grid" ref={builderGrid}>
            {content.roundC.useCases.cards.map((card, index) => <div
              className="round-c-card-reveal"
              key={card.title}
              ref={node => { builderCards.current[index] = node }}
            >
              <article
                className="round-c-case-card"
                onPointerMove={event => {
                  if (reducedMotion || event.pointerType !== 'mouse') return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const x = (event.clientX - rect.left) / rect.width - 0.5;
                  const y = (event.clientY - rect.top) / rect.height - 0.5;
                  event.currentTarget.style.willChange = 'transform';
                  event.currentTarget.style.setProperty('--tilt-x', `${-y * 12}deg`);
                  event.currentTarget.style.setProperty('--tilt-y', `${x * 12}deg`);
                  const icon = event.currentTarget.querySelector<HTMLElement>('.round-c-case-icon');
                  if (icon) {
                    icon.style.willChange = 'transform';
                    icon.style.transform = `translate3d(${x * 5}px,${y * 5}px,0)`;
                  }
                }}
                onPointerLeave={event => {
                  event.currentTarget.style.removeProperty('--tilt-x');
                  event.currentTarget.style.removeProperty('--tilt-y');
                  event.currentTarget.style.willChange = '';
                  const icon = event.currentTarget.querySelector<HTMLElement>('.round-c-case-icon');
                  if (icon) {
                    icon.style.transform = '';
                    icon.style.willChange = '';
                  }
                }}
              >
                <span className="round-c-case-icon">{card.icon}</span>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
                <MiniScene card={card} reducedMotion={reducedMotion}/>
              </article>
            </div>)}
          </div>
        </LazySlot>
      </div>
    </section>

    <section
      ref={faq.ref}
      className={`round-c-section round-c-faq${faq.visible ? ' is-visible' : ''}`}
      aria-labelledby="round-c-faq-title"
    >
      <div className="round-c-section-inner">
        <span className="round-c-eyebrow">{content.roundC.faq.number}</span>
        <h2 id="round-c-faq-title" ref={faqTitle.title} onPointerMove={faqTitle.move} onPointerLeave={faqTitle.reset}>{content.roundC.faq.title}</h2>
        <p className="round-c-section-intro">{content.roundC.faq.description}</p>
        <LazySlot minHeight={300}>
          <div className="round-c-faq-list">
            {content.roundC.faq.items.map((item, index) => <details className="round-c-faq-item" key={item.question} open={index === 0}>
              <summary>{item.question}<span aria-hidden="true">+</span></summary>
              <p>{item.answer}</p>
            </details>)}
          </div>
          <div className="round-c-marquee" aria-label={content.roundC.delights.words.join(' · ')}>
            <div className="round-c-marquee-track" aria-hidden="true">
              {[0, 1].map(copy => <span key={copy}>{content.roundC.delights.words.map(word => <b key={`${copy}-${word}`}>{word}<i>✳</i></b>)}</span>)}
            </div>
          </div>
          <a className="round-c-join-button" href="#join">{content.roundC.delights.joinLink}</a>
        </LazySlot>
      </div>
    </section>
  </div>;
}
