/**
 * Decodes a base64 data URI into bytes WITHOUT fetch(): the renderer CSP has `connect-src 'none'`,
 * which blocks fetch('data:...') and made every spoken reply silently fail to decode.
 */
export function dataUriToBytes(dataUri: string): Uint8Array | null {
  const marker = 'base64,';
  const at = dataUri.indexOf(marker);
  if (at < 0) return null;
  try {
    const binary = atob(dataUri.slice(at + marker.length));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
