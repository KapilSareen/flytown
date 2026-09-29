// App: full-screen Pixi canvas (#world) driven by the world simulation, with the React HUD
// layered on top. World and renderer are started once and survive StrictMode re-mounts.
import { useEffect, useRef } from 'react';
import { startRenderer, type Renderer } from './render';
import { startWorld } from './world/world';
import HUD from './ui/HUD';

let boot: Promise<Renderer> | null = null;

function bootOnce(host: HTMLElement): Promise<Renderer> {
  if (!boot) {
    boot = startWorld().then(world => startRenderer(host, world));
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
