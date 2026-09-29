// App: full-screen world canvas (#world) driven by the world simulation, with the React HUD
// layered on top. World and renderer are started once and survive StrictMode re-mounts.
// The Three.js renderer is the default; `?r=2d` falls back to the Pixi renderer.
import { useEffect, useRef } from 'react';
import { startWorld } from './world/world';
import HUD from './ui/HUD';

interface Started { destroy(): void }
let boot: Promise<Started> | null = null;

function bootOnce(host: HTMLElement): Promise<Started> {
  if (!boot) {
    const use2d = new URLSearchParams(location.search).get('r') === '2d';
    boot = startWorld().then(world =>
      use2d
        ? import('./render').then(m => m.startRenderer(host, world))
        : import('./render3d').then(m => m.startRenderer3D(host, world)),
    );
  }
  return boot;
}

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hostRef.current) void bootOnce(hostRef.current);
  }, []);
  return (
    <>
      <div id="world-host" ref={hostRef} />
      <HUD />
    </>
  );
}
