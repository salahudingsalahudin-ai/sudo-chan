import * as THREE from 'three';

// Small 2D-canvas helpers so the 3D UI cards need no fonts, images or extra downloads.
export const CARD_FONT = 'system-ui, "Segoe UI", Arial, sans-serif';

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function makeCanvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, blur = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // ctx.filter is not available everywhere; without it the blurred twin is simply sharp.
    if (blur > 0 && 'filter' in ctx) ctx.filter = `blur(${blur}px)`;
    draw(ctx, width, height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function drawGlassCard(ctx: CanvasRenderingContext2D, w: number, h: number, accent: string, radius = 36) {
  roundRectPath(ctx, 6, 6, w - 12, h - 12, radius);
  const fill = ctx.createLinearGradient(0, 0, w, h);
  fill.addColorStop(0, 'rgba(15,30,46,.94)');
  fill.addColorStop(1, 'rgba(10,20,34,.94)');
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.85;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export type CardIcon = 'mic' | 'screen' | 'tools' | 'lock';

export function drawIcon(ctx: CanvasRenderingContext2D, icon: CardIcon, cx: number, cy: number, s: number, color: string) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = s * 0.09;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (icon === 'mic') {
    roundRectPath(ctx, -s * 0.2, -s * 0.5, s * 0.4, s * 0.62, s * 0.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -s * 0.02, s * 0.36, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, s * 0.34);
    ctx.lineTo(0, s * 0.5);
    ctx.stroke();
  } else if (icon === 'screen') {
    roundRectPath(ctx, -s * 0.5, -s * 0.36, s, s * 0.62, s * 0.08);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-s * 0.2, s * 0.42);
    ctx.lineTo(s * 0.2, s * 0.42);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -s * 0.05, s * 0.1, 0, Math.PI * 2);
    ctx.fill();
  } else if (icon === 'tools') {
    roundRectPath(ctx, -s * 0.44, -s * 0.4, s * 0.88, s * 0.8, s * 0.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-s * 0.2, 0.02 * s);
    ctx.lineTo(-s * 0.04, s * 0.18);
    ctx.lineTo(s * 0.22, -s * 0.14);
    ctx.stroke();
  } else {
    roundRectPath(ctx, -s * 0.34, -s * 0.06, s * 0.68, s * 0.5, s * 0.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -s * 0.08, s * 0.2, Math.PI, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, s * 0.18, s * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
