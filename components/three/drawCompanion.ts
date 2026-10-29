// Sudo-chan Canvas Drawing Engine:
// 100% pixel-perfect vector representation of the desktop companion bot (Bot.tsx).
// Supports both Light and Dark themes, eye tracking, blinking, sleeping, live speech,
// signature white smart glasses, and cybernetic lighting.

export type DrawCompanionOptions = {
  theme?: 'light' | 'dark';
  eyeShiftX?: number; // -1 to 1
  eyeShiftY?: number; // -1 to 1
  blink?: number; // 0 (open) to 1 (closed)
  sleeping?: boolean;
  happy?: boolean;
  mood?: string;
  isSpeaking?: boolean;
  voiceActive?: boolean;
  voiceLevel?: number; // 0 to 1
  redness?: number; // 0 to 1
};

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawDesktopCompanion(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opts: DrawCompanionOptions = {},
) {
  const {
    theme = 'dark',
    eyeShiftX = 0,
    eyeShiftY = 0,
    blink = 0,
    sleeping = false,
    happy = false,
    mood = 'calm',
    isSpeaking = false,
    voiceActive = false,
    voiceLevel = 0,
    redness = 0,
  } = opts;

  ctx.save();
  ctx.clearRect(0, 0, width, height);

  // Base canvas coordinate space matches the desktop SVG viewBox: 0 0 220 230
  const scaleX = width / 220;
  const scaleY = height / 230;
  ctx.scale(scaleX, scaleY);

  const isDark = theme === 'dark';

  // 1. Ambient Cybernetic Halo
  const haloGrad = ctx.createRadialGradient(110, 120, 0, 110, 120, 108);
  if (isDark) {
    haloGrad.addColorStop(0, 'rgba(56, 232, 255, 0.38)');
    haloGrad.addColorStop(0.55, 'rgba(56, 232, 255, 0.12)');
    haloGrad.addColorStop(1, 'rgba(56, 232, 255, 0)');
  } else {
    haloGrad.addColorStop(0, 'rgba(157, 235, 240, 0.28)');
    haloGrad.addColorStop(0.7, 'rgba(164, 234, 241, 0.08)');
    haloGrad.addColorStop(1, 'rgba(164, 234, 241, 0)');
  }
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.ellipse(110, 120, 109, 105, 0, 0, Math.PI * 2);
  ctx.fill();

  // 2. Ground Shadow
  ctx.fillStyle = isDark ? 'rgba(5, 18, 28, 0.45)' : 'rgba(129, 169, 182, 0.18)';
  ctx.beginPath();
  ctx.ellipse(110, 213, 48, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // 3. Floating Orbital Ring & Satellite Bead
  ctx.save();
  ctx.translate(110, 108);
  ctx.rotate((-24 * Math.PI) / 180);
  ctx.strokeStyle = isDark ? 'rgba(149, 220, 228, 0.65)' : 'rgba(149, 220, 228, 0.45)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, 91, 75, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Satellite Dot
  ctx.fillStyle = '#67d6df';
  if (isDark) {
    ctx.shadowColor = '#38e8ff';
    ctx.shadowBlur = 8;
  }
  ctx.beginPath();
  ctx.arc(184, 66, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // 4. Top Antenna
  ctx.strokeStyle = '#b1cfd7';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(110, 41);
  ctx.lineTo(110, 24);
  ctx.stroke();

  // Antenna Bulb & Sonic Glow
  const isAntennaActive = voiceActive || isSpeaking || voiceLevel > 0.05;
  const bulbRadius = isAntennaActive ? 7.5 : 5.5;
  const bulbColor = isAntennaActive ? '#38bdf8' : '#88e4eb';

  if (isAntennaActive) {
    // Sonic wave rings
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(110, 21, 11, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.arc(110, 21, 16.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Glowing antenna bulb
  ctx.fillStyle = bulbColor;
  ctx.shadowColor = '#38bdf8';
  ctx.shadowBlur = isDark ? 14 : 8;
  ctx.beginPath();
  ctx.arc(110, 21, bulbRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Bulb sparkle
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(109, 19.5, 1.8, 0, Math.PI * 2);
  ctx.fill();

  // 4-point antenna spark icon
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(110, 17);
  ctx.lineTo(111.2, 19.8);
  ctx.lineTo(114, 21);
  ctx.lineTo(111.2, 22.2);
  ctx.lineTo(110, 25);
  ctx.lineTo(108.8, 22.2);
  ctx.lineTo(106, 21);
  ctx.lineTo(108.8, 19.8);
  ctx.closePath();
  ctx.fill();

  // 5. Robot Body Shell Gradient (Soft porcelain)
  const shellGrad = ctx.createLinearGradient(56, 35, 178, 200);
  shellGrad.addColorStop(0, '#ffffff');
  shellGrad.addColorStop(0.47, isDark ? '#f4f9fb' : '#f9fcfd');
  shellGrad.addColorStop(1, isDark ? '#b8d3dc' : '#c9dae1');

  // Main drop shadow for body
  ctx.shadowColor = isDark ? 'rgba(0, 0, 0, 0.4)' : 'rgba(72, 107, 128, 0.18)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 8;

  // Lower Body Shell
  const bodyPath = new Path2D(
    'M80 151 C81 139 139 139 140 151 L146 177 C148 200 132 210 110 210 C88 210 72 200 74 177 L80 151 Z',
  );
  ctx.fillStyle = shellGrad;
  ctx.fill(bodyPath);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.2;
  ctx.stroke(bodyPath);

  // Arm Nubs
  const armsPath = new Path2D(
    'M73 162 C56 159 52 174 59 183 C62 186 68 184 74 179 M147 162 C164 159 168 174 161 183 C158 186 152 184 146 179',
  );
  ctx.fillStyle = shellGrad;
  ctx.fill(armsPath);

  // Reset shadow for inner gadget details
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Smartwatch Gadget on Right Hand
  ctx.fillStyle = '#f8fafc';
  ctx.strokeStyle = '#94d3dd';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(160, 174, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#132731';
  ctx.beginPath();
  ctx.arc(160, 174, 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#72d3bf';
  ctx.beginPath();
  ctx.arc(160, 174, 1.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#9ef1e0';
  ctx.lineWidth = 0.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(160, 171.2);
  ctx.lineTo(160, 172.2);
  ctx.moveTo(160, 175.8);
  ctx.lineTo(160, 176.8);
  ctx.moveTo(157.2, 174);
  ctx.lineTo(158.2, 174);
  ctx.moveTo(161.8, 174);
  ctx.lineTo(162.8, 174);
  ctx.stroke();

  // Chest Power Core (Heart)
  ctx.fillStyle = '#e2f1f2';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(110, 177, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Core Cyan Gradient
  const coreGrad = ctx.createRadialGradient(110, 177, 0, 110, 177, 8);
  coreGrad.addColorStop(0, '#efffff');
  coreGrad.addColorStop(0.48, '#82eef2');
  coreGrad.addColorStop(1, '#30b8c9');

  if (isDark || isAntennaActive) {
    ctx.shadowColor = '#38e8ff';
    ctx.shadowBlur = 10;
  }
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(110, 177, 7.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // 6. Pearly White Head Shell
  ctx.shadowColor = isDark ? 'rgba(0, 0, 0, 0.45)' : 'rgba(72, 107, 128, 0.16)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 8;

  ctx.fillStyle = shellGrad;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, 45, 41, 130, 121, 55);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Forehead Specular Shine Arc
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(56, 73);
  ctx.bezierCurveTo(62, 57, 79, 49, 95, 49);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 7. Dark Obsidian Visor Screen (PROMINENT & GLOSSY)
  const visorGrad = ctx.createLinearGradient(63, 78, 166, 132);
  visorGrad.addColorStop(0, '#213c49');
  visorGrad.addColorStop(0.52, '#11232e');
  visorGrad.addColorStop(1, '#0a1721');

  ctx.fillStyle = visorGrad;
  ctx.strokeStyle = '#88bbc7';
  ctx.lineWidth = 1.6;
  roundRectPath(ctx, 51, 83, 118, 57, 27);
  ctx.fill();
  ctx.stroke();

  // Visor Inner Glass Highlight Line
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.8;
  ctx.globalAlpha = 0.11;
  ctx.beginPath();
  ctx.moveTo(65, 92);
  ctx.bezierCurveTo(87, 85, 114, 85, 147, 91);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 8. Eyes (Inside Visor)
  const shiftX = Math.max(-5, Math.min(5, eyeShiftX * 5));
  const shiftY = Math.max(-3.5, Math.min(3.5, eyeShiftY * 3.5));
  const isClosed = sleeping || blink > 0.85;

  if (isClosed) {
    // Cute Curved Closed Sleeping / Blinking Arcs
    ctx.strokeStyle = '#9cf3ec';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(78, 111);
    ctx.quadraticCurveTo(87, 119, 96, 111);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(124, 111);
    ctx.quadraticCurveTo(133, 119, 142, 111);
    ctx.stroke();
  } else {
    const scaleY = Math.max(0.12, 1 - blink * 0.88);

    // Left Eye
    ctx.save();
    ctx.translate(87 + shiftX, 110 + shiftY);
    ctx.scale(1, scaleY);
    // Outer cyan sclera
    ctx.fillStyle = '#9af6f3';
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    // Inner dark pupil
    ctx.fillStyle = '#174951';
    ctx.beginPath();
    ctx.ellipse(2, 1, 4, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    // Primary white sparkle
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-2, -5, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Right Eye
    ctx.save();
    ctx.translate(133 + shiftX, 110 + shiftY);
    ctx.scale(1, scaleY);
    // Outer cyan sclera
    ctx.fillStyle = '#9af6f3';
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    // Inner dark pupil
    ctx.fillStyle = '#174951';
    ctx.beginPath();
    ctx.ellipse(2, 1, 4, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    // Primary white sparkle
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-2, -5, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 9. Sudo-chan Signature Cute Round Smart Glasses (Framing Eyes Over Visor)
  ctx.save();
  ctx.shadowColor = '#38e8ff';
  ctx.shadowBlur = isDark ? 6 : 3;
  ctx.shadowOffsetY = 0.8;

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Left Lens
  roundRectPath(ctx, 72.5, 93.5, 29, 33, 12);
  ctx.stroke();

  // Right Lens
  roundRectPath(ctx, 118.5, 93.5, 29, 33, 12);
  ctx.stroke();

  // Arched Nose Bridge
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(101.5, 109);
  ctx.bezierCurveTo(105.5, 105.5, 114.5, 105.5, 118.5, 109);
  ctx.stroke();

  // Side Temples
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(72.5, 108.5);
  ctx.bezierCurveTo(65, 107.5, 57.5, 106, 52, 104.5);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(147.5, 108.5);
  ctx.bezierCurveTo(155, 107.5, 162.5, 106, 168, 104.5);
  ctx.stroke();

  // Lens Sheen Arc Highlights
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(76.5, 102.5);
  ctx.bezierCurveTo(77.5, 97.5, 83, 95.5, 87.5, 95.5);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(122.5, 102.5);
  ctx.bezierCurveTo(123.5, 97.5, 129, 95.5, 133.5, 95.5);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(94.5, 98, 0.9, 0, Math.PI * 2);
  ctx.arc(140.5, 98, 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 10. Mouth (Smile or Talking Plasma Light)
  if (isSpeaking) {
    // Talking Plasma Light
    const mouthScale = 1 + voiceLevel * 0.4;
    ctx.save();
    ctx.translate(110, 130);
    ctx.scale(mouthScale, 0.5 + voiceLevel * 0.8);

    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = '#0284c7';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.ellipse(0, 0, 12, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(0, 0, 5, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else {
    // Cute Cyan Smile Arc
    ctx.strokeStyle = '#9cf3ec';
    ctx.lineWidth = happy ? 2.8 : 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (happy) {
      ctx.moveTo(99, 127);
      ctx.quadraticCurveTo(110, 138, 121, 127);
    } else if (mood === 'worried') {
      ctx.moveTo(102, 133);
      ctx.quadraticCurveTo(110, 128, 118, 133);
    } else {
      ctx.moveTo(102, 130);
      ctx.quadraticCurveTo(110, 136, 118, 130);
    }
    ctx.stroke();
  }

  // 11. Soft Pink Blush Cheeks
  ctx.fillStyle = '#eab7ce';
  ctx.globalAlpha = happy ? 0.75 : 0.45 + redness * 0.25;
  ctx.beginPath();
  ctx.ellipse(67, 123, 5, 2.5, 0, 0, Math.PI * 2);
  ctx.ellipse(153, 123, 5, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
}
