import * as THREE from 'three';

// Palette. The listening/speaking colours match the glow on the desktop companion (green = listening, violet = speaking).
export const PALETTE = {
  skin: '#f9d9cc',
  skinShade: '#f0bfc0',
  hair: '#33337f',
  hairLight: '#5a5fd0',
  jacket: '#eef1fb',
  jacketTrim: '#2b3170',
  outline: '#151a3d',
  cyan: '#38e8ff',
  idle: '#52d6e8',
  listening: '#62d9be',
  speaking: '#9678ff',
  blush: '#ff8fb0',
} as const;

let gradient: THREE.DataTexture | null = null;
// Three flat tones give the cel-shaded anime look without any texture download.
export function getToonGradient() {
  if (gradient) return gradient;
  const data = new Uint8Array([120, 120, 120, 255, 205, 205, 205, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

export type RimOptions = { color?: THREE.ColorRepresentation; power?: number; strength?: number };

// Toon material with a soft fresnel rim light added in the fragment shader.
export function makeToonMaterial(color: THREE.ColorRepresentation, rim: RimOptions = {}) {
  const material = new THREE.MeshToonMaterial({ color, gradientMap: getToonGradient() });
  const uniforms = {
    uRimColor: { value: new THREE.Color(rim.color ?? PALETTE.cyan) },
    uRimPow: { value: rim.power ?? 2.4 },
    uRimStrength: { value: rim.strength ?? 0.7 },
  };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uRimColor;\nuniform float uRimPow;\nuniform float uRimStrength;\nvoid main() {')
      .replace(
        '#include <opaque_fragment>',
        'float rimF = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), uRimPow);\noutgoingLight += uRimColor * rimF * uRimStrength;\n#include <opaque_fragment>',
      );
  };
  material.customProgramCacheKey = () => 'sudo-toon-rim';
  return material;
}

let irisTexture: THREE.CanvasTexture | null = null;
// Anime-style iris: dark rim, deep teal body, bright cyan glow low in the eye.
export function getIrisTexture() {
  if (irisTexture) return irisTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const base = ctx.createLinearGradient(0, 0, 0, size);
    base.addColorStop(0, '#171b52');
    base.addColorStop(0.5, '#2a56b8');
    base.addColorStop(1, '#4ee6f0');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    const glow = ctx.createRadialGradient(size / 2, size * 0.82, 2, size / 2, size * 0.82, size * 0.5);
    glow.addColorStop(0, 'rgba(210,255,255,.95)');
    glow.addColorStop(1, 'rgba(210,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
    const ring = ctx.createRadialGradient(size / 2, size / 2, size * 0.34, size / 2, size / 2, size * 0.5);
    ring.addColorStop(0, 'rgba(10,14,50,0)');
    ring.addColorStop(1, 'rgba(10,14,50,.85)');
    ctx.fillStyle = ring;
    ctx.fillRect(0, 0, size, size);
  }
  irisTexture = new THREE.CanvasTexture(canvas);
  irisTexture.colorSpace = THREE.SRGBColorSpace;
  return irisTexture;
}
