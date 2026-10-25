import { describe, expect, it } from 'vitest';
import { defaults, plainName, restoreSettings, samplePixels } from '../lib/particlePortrait';

const pixels = (values: number[], width: number, height: number) => ({ data: new Uint8ClampedArray(values), width, height }) as ImageData;
describe('local portrait preferences and sampling', () => {
  it('rejects malformed settings and inherited property names', () => {
    expect(restoreSettings(null, true)).toEqual(defaults(true));
    expect(restoreSettings({ shape: '__proto__', color: 'constructor', density: 'no', glow: Infinity, threshold: NaN })).toEqual(defaults());
    expect(restoreSettings({ shape: 'fox', glow: 42, threshold: -10, name: '<b>Nova</b>' })).toMatchObject({ shape: 'fox', glow: 2, threshold: 0, name: 'bNova/b' });
    expect(plainName('😀'.repeat(30))).toBe('😀'.repeat(20));
  });
  it('samples transparent dark silhouettes by alpha and opaque pictures by brightness', () => {
    const alpha = pixels([0,0,0,255, 0,0,0,0], 2, 1);
    const points = samplePixels(alpha, 14000, 90, true)!;
    expect(points.length).toBe(42000);
    for (let i = 0; i < points.length; i += 3) expect(points[i]).toBeLessThan(0);
    expect(samplePixels(alpha, 6000, 90, false)).toBeNull();
    const opaque = pixels([0,0,0,255, 255,255,255,255], 2, 1);
    const bright = samplePixels(opaque, 6000, 90, true)!;
    for (let i = 0; i < bright.length; i += 3) expect(bright[i]).toBeGreaterThanOrEqual(0);
  });
  it('handles empty masks, keeps aspect ratio, and generates repeatable finite targets', () => {
    expect(samplePixels(pixels([0,0,0,0], 1, 1), 14000)).toBeNull();
    const wide = pixels([255,255,255,255,255,255,255,255], 2, 1);
    const points = samplePixels(wide, 6000)!;
    expect(points).toEqual(samplePixels(wide, 6000));
    for (let i = 0; i < points.length; i += 3) {
      expect(Number.isFinite(points[i])).toBe(true);
      expect(Math.abs(points[i + 1])).toBeLessThanOrEqual(.875);
      expect(Math.abs(points[i + 2])).toBeLessThanOrEqual(.12);
    }
  });
});
