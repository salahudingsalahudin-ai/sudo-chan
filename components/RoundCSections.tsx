'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import { content } from '@/content';
import type { BotMood } from '@/content';

const STUCK_AUTO_START_MS = 6_000;
const STUCK_OFFER_AFTER_SECONDS = 3;
const COUNT_ENDPOINT = '/api/waitlist';
const REVEAL_ROOT_MARGIN = '280px 0px';

export function LazySlot({ children, minHeight = 150 }: { children: ReactNode; minHeight?: number }) {
  const slot = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setMounted(true);
      observer.disconnect();
    }, { rootMargin: REVEAL_ROOT_MARGIN });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={slot} className="round-c-lazy-slot" style={{ minHeight }}>
    {mounted ? children : <span className="round-c-placeholder" aria-hidden="true" />}
  </div>;
}

function useReveal(onEnter: () => void) {
  const ref = useRef<HTMLElement>(null);
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

function WaitlistCount() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(COUNT_ENDPOINT, { method: 'GET', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Waitlist count request failed with status ${response.status}.`);
        const result: unknown = await response.json();
        if (typeof result !== 'object' || result === null || !('count' in result) || typeof result.count !== 'number' || !Number.isInteger(result.count) || result.count < 0) {
          throw new Error('Waitlist count response was invalid.');
        }
        setCount(result.count);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.warn(content.roundC.delights.counterUnavailable, error);
      });
    return () => controller.abort();
  }, []);
  if (count === null) return null;
  return <p className="round-c-count">{content.roundC.delights.counter}: <strong>{count.toLocaleString()}</strong></p>;
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
  const dayTitle = useTitleParallax(reducedMotion);
  const casesTitle = useTitleParallax(reducedMotion);
  const faqTitle = useTitleParallax(reducedMotion);

  return <div className={`round-c-sections${reducedMotion ? ' round-c-reduced-motion' : ''}`}>
    <section
      ref={day.ref}
      className={`round-c-section round-c-day${day.visible ? ' is-visible' : ''}`}
      aria-labelledby="round-c-day-title"
    >
      <div className="round-c-section-inner">
        <span className="round-c-eyebrow">{content.roundC.quietDay.number}</span>
        <h2 id="round-c-day-title" ref={dayTitle.title} onPointerMove={dayTitle.move} onPointerLeave={dayTitle.reset}>{content.roundC.quietDay.title}</h2>
        <p className="round-c-section-intro">{content.roundC.quietDay.description}</p>
        <LazySlot minHeight={240}>
          <div className="round-c-timeline" aria-label={content.roundC.quietDay.title}>
            {content.roundC.quietDay.moments.map((moment, index) => <article className="round-c-moment" key={moment.title}>
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
        <h2 id="round-c-cases-title" ref={casesTitle.title} onPointerMove={casesTitle.move} onPointerLeave={casesTitle.reset}>{content.roundC.useCases.title}</h2>
        <p className="round-c-section-intro">{content.roundC.useCases.description}</p>
        <LazySlot minHeight={220}>
          <div className="round-c-case-grid">
            {content.roundC.useCases.cards.map(card => <article className="round-c-case-card" key={card.title}>
              <span className="round-c-case-icon">{card.icon}</span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>)}
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
          <WaitlistCount/>
          <a className="round-c-join-button" href="#join">{content.roundC.delights.joinLink}</a>
        </LazySlot>
      </div>
    </section>
  </div>;
}
