import { describe, expect, it } from 'vitest';
import { GET } from '../app/api/download/route';

describe('GET /api/download', () => {
  it('redirects to Windows installer for platform=windows', async () => {
    const req = new Request('https://sudo-chan.vercel.app/api/download?platform=windows');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.com/salahudingsalahudin-ai/sudo-chan/releases/download/v0.1.0/Sudo-chan-0.1.0-win-x64.exe');
  });

  it('serves Windows web bootstrapper script for platform=windows-web', async () => {
    const req = new Request('https://sudo-chan.vercel.app/api/download?platform=windows-web');
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('Sudo-chan-Web-Installer.cmd');
    const body = await res.text();
    expect(body).toContain('SUDO-CHAN DESKTOP COMPANION SETUP');
    expect(body).toContain('Sudo-chan-0.1.0-win-x64.exe');
    expect(body).toContain('powershell');
  });

  it('redirects to macOS dmg for platform=macos', async () => {
    const req = new Request('https://sudo-chan.vercel.app/api/download?platform=macos');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.com/salahudingsalahudin-ai/sudo-chan/releases/download/v0.1.0/Sudo-chan-0.1.0-mac-arm64.dmg');
  });

  it('redirects to Linux deb for platform=linux-deb', async () => {
    const req = new Request('https://sudo-chan.vercel.app/api/download?platform=linux-deb');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.com/salahudingsalahudin-ai/sudo-chan/releases/download/v0.1.0/Sudo-chan-0.1.0-linux-amd64.deb');
  });

  it('redirects to Linux AppImage for platform=linux-appimage', async () => {
    const req = new Request('https://sudo-chan.vercel.app/api/download?platform=linux-appimage');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.com/salahudingsalahudin-ai/sudo-chan/releases/download/v0.1.0/Sudo-chan-0.1.0-linux-x86_64.AppImage');
  });

  it('redirects to SHA256SUMS for platform=checksums', async () => {
    const req = new Request('https://sudo-chan.vercel.app/api/download?platform=checksums');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.com/salahudingsalahudin-ai/sudo-chan/releases/download/v0.1.0/SHA256SUMS');
  });
});
