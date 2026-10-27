'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type * as THREE from 'three';
import { USE_REAL_MODEL } from '../sudoChanConfig';

// Optional: if public/models/sudo-chan.glb exists and USE_REAL_MODEL is on, show it instead of the procedural character.
// The loader is imported on demand, so it costs nothing while the flag is off (the default).
export default function GlbBot({ fallback }: { fallback: ReactNode }) {
  const [model, setModel] = useState<THREE.Group | null>(null);
  useEffect(() => {
    if (!USE_REAL_MODEL) return;
    let active = true;
    const warn = (error: unknown) => { if (active) console.warn('Optional Sudo-chan model could not be loaded; using the procedural character.', error); };
    fetch('/api/sudo-chan-model')
      .then(response => (response.status === 204 ? null : response.ok ? response.arrayBuffer() : Promise.reject(new Error(`Model request failed with status ${response.status}`))))
      .then(async buffer => {
        if (!active || !buffer) return;
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        new GLTFLoader().parse(buffer, '/', gltf => { if (active) setModel(gltf.scene); }, warn);
      })
      .catch(warn);
    return () => { active = false; };
  }, []);
  const clone = useMemo(() => (model ? model.clone(true) : null), [model]);
  if (!clone) return <>{fallback}</>;
  return <primitive object={clone} />;
}
