import { readFile, unlink } from 'node:fs/promises';
import { nativeImage } from 'electron';
import { portalScreenshot } from './portal-screenshot.ts';
import { isBlankFrame, MAX_IMAGE_WIDTH, targetSize, THUMBNAIL_WIDTH } from '../shared/screen-assist.ts';

export type CaptureResult =
  | { ok: true; dataUri: string; thumbnail: string; width: number; height: number }
  | { ok: false; reason: string };

/**
 * Capture the screen via the portal, downscale to ~1280 px wide JPEG, make a small thumbnail for the chat,
 * and delete the portal's PNG immediately. Nothing is written to disk by us and nothing is logged.
 */
export async function captureScreen(): Promise<CaptureResult> {
  const shot = await portalScreenshot();
  if (!shot.ok) return { ok: false, reason: shot.reason };
  let file: Buffer;
  try {
    file = await readFile(shot.path);
  } catch {
    return { ok: false, reason: 'read-failed' };
  } finally {
    await unlink(shot.path).catch(() => { /* already gone */ });
  }
  const image = nativeImage.createFromBuffer(file);
  const size = image.getSize();
  if (!size.width || !size.height) return { ok: false, reason: 'decode-failed' };
  const target = targetSize(size.width, size.height, MAX_IMAGE_WIDTH);
  const scaled = image.resize({ width: target.width, height: target.height, quality: 'good' });
  if (isBlankFrame(scaled.toBitmap())) return { ok: false, reason: 'blank-frame' };
  const thumb = image.resize({ width: THUMBNAIL_WIDTH, quality: 'good' });
  return {
    ok: true,
    dataUri: 'data:image/jpeg;base64,' + scaled.toJPEG(75).toString('base64'),
    thumbnail: 'data:image/jpeg;base64,' + thumb.toJPEG(60).toString('base64'),
    width: target.width,
    height: target.height,
  };
}
