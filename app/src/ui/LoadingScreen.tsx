import { useStore } from '../store';
import { NeuronField } from './motion';

export function LoadingScreen() {
  const loading = useStore((s) => s.loading);
  const p = Math.max(0, Math.min(1, loading.progress));
  return (
    <div className="loading" role="status" aria-live="polite">
      <NeuronField className="field" />
      <div className="field-mask" />
      <div className="word">DROSOPOLIS</div>
      <div className="tag">a town of people with fly brains</div>
      <div className="phase">{loading.phase}</div>
      <div className="track"><i style={{ width: `${p * 100}%` }} /></div>
      <div className="pct num">{Math.round(p * 100)}%</div>
    </div>
  );
}
