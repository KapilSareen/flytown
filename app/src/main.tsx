import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Boot-failure overlay: if anything throws before the HUD can render (blocked workers,
// WebGL unavailable, a sandboxed host), say so on screen instead of leaving a blank page.
function showFatal(msg: string) {
  let el = document.getElementById('fatal');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'fatal';
    el.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;z-index:99999;max-height:40vh;overflow:auto;margin:0;padding:12px 14px;border-radius:12px;background:#2a1414;color:#ffd7d7;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap';
    document.body.appendChild(el);
  }
  el.textContent += (el.textContent ? '\n' : '') + msg;
}
window.addEventListener('error', e => showFatal(`error: ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => showFatal(`unhandled: ${String((e.reason && (e.reason.stack || e.reason.message)) || e.reason)}`));

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (err) {
  showFatal(`boot: ${String(err)}`);
}
