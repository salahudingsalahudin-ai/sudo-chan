'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { colors, densities, type Settings } from '@/lib/particlePortrait';

const vertexShader = `
  attribute vec3 target;
  uniform float morph;
  uniform float time;
  uniform float pixelRatio;
  uniform float glow;
  varying float light;
  void main() {
    float t = clamp(morph, 0., 1.);
    float eased = t * t * (3. - 2. * t);
    vec3 p = mix(position, target, eased);
    vec3 seed = vec3(sin(float(gl_VertexID)*12.9898), cos(float(gl_VertexID)*7.233), sin(float(gl_VertexID)*3.19));
    p += seed * sin(t * 3.14159265) * .25;
    p += vec3(sin(time*.55 + seed.x*6.), cos(time*.43 + seed.y*6.), sin(time*.6+seed.z*6.)) * .014;
    vec4 mv = modelViewMatrix * vec4(p, 1.);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp((2. + glow * 1.8) * pixelRatio * (4. / -mv.z), 1., 9.);
    light = (.65 + .15 * sin(time*1.4 + seed.x*3.)) * (1. + .4 * exp(-length(p.xy)*4.));
  }
`;
const fragmentShader = `
  uniform vec3 color;
  uniform float glow;
  varying float light;
  void main() {
    float r = length(gl_PointCoord - .5) * 2.;
    if (r > 1.) discard;
    float a = exp(-r*r*4.) * (1. - smoothstep(.7, 1., r));
    gl_FragColor = vec4(color, a * light * (.22 + glow*.2));
  }
`;

type Props = { points: Float32Array; settings: Settings; onFallback: () => void; onDensity: (density: Settings['density']) => void };
export default function ParticlePortrait({ points, settings, onFallback, onDensity }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ points, settings, onFallback, onDensity });
  latest.current = { points, settings, onFallback, onDensity };
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' }); }
    catch { latest.current.onFallback(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, .1, 20); camera.position.z = 5;
    const geometry = new THREE.BufferGeometry();
    const source = new Float32Array(latest.current.points);
    const destination = new Float32Array(source);
    geometry.setAttribute('position', new THREE.BufferAttribute(source, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('target', new THREE.BufferAttribute(destination, 3).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.ShaderMaterial({
      uniforms: { morph: { value: 1 }, time: { value: 0 }, pixelRatio: { value: renderer.getPixelRatio() }, glow: { value: 1 }, color: { value: new THREE.Color(colors.cyan) } },
      vertexShader, fragmentShader, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    const cloud = new THREE.Points(geometry, material); cloud.frustumCulled = false; scene.add(cloud);
    let currentPoints = latest.current.points, started = -1200, frame = 0, previous = 0, elapsed = 0;
    let count = 0, total = 0, slowTime = 0, warmup = 90;
    const pointer = { x: 0, y: 0 };
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      renderer.setSize(width, height); camera.aspect = width / Math.max(1, height);
      camera.position.z = Math.max(5, 4.6 / camera.aspect); camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const bounds = element.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width - .5) * .16;
      pointer.y = ((event.clientY - bounds.top) / bounds.height - .5) * .12;
    };
    element.addEventListener('pointermove', move);
    const leave = () => { pointer.x = pointer.y = 0; }; element.addEventListener('pointerleave', leave);
    const draw = (now: number) => {
      frame = 0;
      if (document.hidden) return;
      const dt = previous ? now - previous : 16.67; previous = now; elapsed += Math.min(dt, 50);
      const current = latest.current;
      if (currentPoints !== current.points) {
        const t = Math.min(1, Math.max(0, (now - started) / 1200)), ease = t * t * (3 - 2 * t);
        // Snapshot only when the target changes; the per-frame morph stays entirely on the GPU.
        for (let i = 0; i < source.length; i++) {
          const vertex = Math.floor(i / 3), axis = i % 3;
          const seed = axis === 0 ? Math.sin(vertex * 12.9898) : axis === 1 ? Math.cos(vertex * 7.233) : Math.sin(vertex * 3.19);
          source[i] += (destination[i] - source[i]) * ease + seed * Math.sin(t * Math.PI) * .25;
        }
        destination.set(current.points); currentPoints = current.points; started = now;
        geometry.attributes.position.needsUpdate = true; geometry.attributes.target.needsUpdate = true;
      }
      material.uniforms.morph.value = Math.min(1, (now - started) / 1200);
      material.uniforms.time.value = elapsed / 1000;
      material.uniforms.glow.value = current.settings.glow;
      material.uniforms.color.value.set(colors[current.settings.color]);
      geometry.setDrawRange(0, densities[current.settings.density]);
      cloud.rotation.y += (pointer.x - cloud.rotation.y) * .06;
      cloud.rotation.x += (pointer.y - cloud.rotation.x) * .06;
      renderer.render(scene, camera);
      if (warmup > 0) warmup--;
      else {
        total += dt; count++; slowTime = dt > 22 ? slowTime + dt : Math.max(0, slowTime - dt * 2);
        if (slowTime > 1800 && current.settings.density !== 'low') {
          current.onDensity(current.settings.density === 'high' ? 'medium' : 'low'); slowTime = 0;
        }
        if (count % 30 === 0) {
          element.dataset.averageFrameMs = (total / count).toFixed(2);
          element.dataset.drawCalls = String(renderer.info.render.calls);
          element.dataset.points = String(densities[current.settings.density]);
        }
      }
      frame = requestAnimationFrame(draw);
    };
    const visibility = () => {
      if (frame) cancelAnimationFrame(frame); frame = 0; previous = 0;
      if (!document.hidden) frame = requestAnimationFrame(draw);
    };
    const lost = (event: Event) => { event.preventDefault(); latest.current.onFallback(); };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    document.addEventListener('visibilitychange', visibility); visibility();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      element.removeEventListener('pointermove', move); element.removeEventListener('pointerleave', leave);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      geometry.dispose(); material.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, []);
  return <div ref={host} className="portrait-webgl" data-renderer="particles" />;
}
