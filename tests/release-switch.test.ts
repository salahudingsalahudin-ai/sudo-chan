import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as published from '../content';

const source = readFileSync(join(__dirname, '..', 'content.ts'), 'utf8');

// The same content file with the one constant flipped, to prove what the site says in the "live" state.
async function loadWithFlag(value: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'content-flag-'));
  const file = join(dir, 'content.ts');
  writeFileSync(file, source.replace(/export const RELEASE_PUBLISHED: boolean = (true|false);/, `export const RELEASE_PUBLISHED: boolean = ${value};`));
  return (await import(/* @vite-ignore */ file)) as typeof published;
}

const everyString = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(everyString) : value && typeof value === 'object' ? Object.values(value).flatMap(everyString) : [];

describe('RELEASE_PUBLISHED switch', () => {
  it('is defined in exactly one place and is a plain boolean constant', () => {
    expect(source.match(/RELEASE_PUBLISHED: boolean = /g)).toHaveLength(1);
    expect(typeof published.RELEASE_PUBLISHED).toBe('boolean');
  });

  it('ships OFF: Coming soon, waitlist wording, no download claim', async () => {
    const off = await loadWithFlag(false);
    expect(off.content.comingSoon.badge).toBe('Coming soon');
    expect(off.content.comingSoon.cta).toBe('Join the waitlist');
    expect(off.content.scenes[6].label).toBe('WAITLIST');
    expect(off.content.footer).toMatch(/Coming soon/);
    expect(JSON.stringify(off.content)).toMatch(/no download link/i);
  });

  it('when ON: an honest Download section, Windows and macOS marked not built, no leftover "not released" claims', async () => {
    const on = await loadWithFlag(true);
    expect(on.RELEASE_PUBLISHED).toBe(true);
    expect(on.content.comingSoon.cta).toBe('Download');
    expect(on.content.scenes[6].label).toBe('DOWNLOAD');
    const statuses = Object.fromEntries(on.content.download.platforms.map(p => [p.name, p.status]));
    expect(statuses['Linux (x86-64)']).toBe('Available');
    expect(statuses.Windows).toBe('Not built yet');
    expect(statuses.macOS).toBe('Not built yet');
    expect(on.content.download.verifyCommand).toContain('sha256sum -c SHA256SUMS');
    expect(on.content.download.earlyNote).toMatch(/early version/i);
    expect(on.RELEASES_LATEST_URL).toBe('https://github.com/salahudingsalahudin-ai/sudo-chan/releases/latest');
    const text = everyString(on.content.scenes).concat(everyString(on.content.comingSoon), on.content.footer, on.content.siteDescription, on.content.privacyPage.plannedNotice);
    const stale = text.filter(line => /coming soon|not released|no download|not out yet/i.test(line));
    expect(stale).toEqual([]);
  });
});
