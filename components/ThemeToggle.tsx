'use client';

import { useEffect, useState } from 'react';
import { content } from '@/content';

type Theme = 'light' | 'dark';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);

  const toggleTheme = () => {
    const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    setTheme(nextTheme);
    window.dispatchEvent(new Event('sudo-chan-theme-change'));
    try {
      window.localStorage.setItem('sudo-chan-theme', nextTheme);
    } catch {
      // The selected theme still applies for this page if storage is unavailable.
    }
  };

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={theme === 'dark' ? content.theme.darkModeLabel : content.theme.lightModeLabel}
      aria-pressed={theme === 'dark'}
      onClick={toggleTheme}
    >
      {theme === 'dark'
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.2A8.5 8.5 0 0 1 8.8 3.8 8.5 8.5 0 1 0 20.2 15.2Z"/></svg>}
      <span>{content.theme.toggleLabel}</span>
    </button>
  );
}
