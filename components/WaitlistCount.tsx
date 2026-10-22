'use client';

import { useEffect, useRef, useState } from 'react';
import { content } from '@/content';

const COUNT_ENDPOINT = '/api/waitlist';
const COUNT_REFRESH_EVENT = 'sudo-chan-waitlist-count-refresh';
const COUNT_ANIMATION_DURATION_MS = 900;

export function refreshWaitlistCount() {
  window.dispatchEvent(new Event(COUNT_REFRESH_EVENT));
}

export default function WaitlistCount() {
  const [count, setCount] = useState<number | null>(null);
  const [enteredView, setEnteredView] = useState(false);
  const counterSlot = useRef<HTMLDivElement>(null);
  const countElement = useRef<HTMLElement>(null);
  const displayedCount = useRef(0);

  useEffect(() => {
    let controller: AbortController | null = null;

    const fetchCount = async () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;

      try {
        const response = await fetch(COUNT_ENDPOINT, {
          method: 'GET',
          cache: 'no-store',
          signal: requestController.signal,
        });
        if (!response.ok) throw new Error(`Waitlist count request failed with status ${response.status}.`);

        const result: unknown = await response.json();
        if (typeof result !== 'object' || result === null || !('count' in result)
          || typeof result.count !== 'number' || !Number.isInteger(result.count) || result.count < 0) {
          throw new Error('Waitlist count response was invalid.');
        }

        setCount(result.count);
      } catch (error) {
        if (requestController.signal.aborted) return;
        console.warn(content.roundC.delights.counterUnavailable, error);
        setCount(null);
      }
    };

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setEnteredView(true);
      observer.disconnect();
    }, { threshold: 0.25 });

    if (counterSlot.current) observer.observe(counterSlot.current);
    window.addEventListener(COUNT_REFRESH_EVENT, fetchCount);
    void fetchCount();

    return () => {
      observer.disconnect();
      controller?.abort();
      window.removeEventListener(COUNT_REFRESH_EVENT, fetchCount);
    };
  }, []);

  useEffect(() => {
    if (count === null || !enteredView || !countElement.current) return;

    const element = countElement.current;
    const target = count;
    const start = displayedCount.current;
    const startTime = performance.now();
    let frame = 0;

    const render = (now: number) => {
      const progress = Math.min(1, (now - startTime) / COUNT_ANIMATION_DURATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(start + (target - start) * eased);
      element.textContent = value.toLocaleString();

      if (progress < 1) {
        frame = window.requestAnimationFrame(render);
      } else {
        displayedCount.current = target;
      }
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      displayedCount.current = target;
      element.textContent = target.toLocaleString();
    } else {
      frame = window.requestAnimationFrame(render);
    }

    return () => window.cancelAnimationFrame(frame);
  }, [count, enteredView]);

  return <div ref={counterSlot} className="waitlist-count-slot" aria-hidden={count === null}>
    {count !== null && <>
      <p className="round-c-count waitlist-count-top">
        <span className="waitlist-count-dot" aria-hidden="true"/>
        {count === 0
          ? content.roundC.delights.counterZero
          : <>{content.roundC.delights.counter}: <strong aria-hidden="true" ref={countElement}>0</strong></>}
      </p>
      <span className="round-c-sr-only" aria-live="polite" aria-atomic="true">
        {count === 0 ? content.roundC.delights.counterZero : `${content.roundC.delights.counter}: ${count.toLocaleString()}`}
      </span>
    </>}
  </div>;
}
