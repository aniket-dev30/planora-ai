import { useEffect, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { formatElapsed } from '../lib/format';

type Props = {
  message: string;
  startedAt: number | null;
  onCancel: () => void;
};

const SLOW_AFTER_SECONDS = 45;
const VERY_SLOW_AFTER_SECONDS = 120;

/**
 * Waiting feedback for a long-running generation. It shows a real elapsed timer and the backend's
 * latest message; the "taking longer" notes are based purely on elapsed time and claim nothing about
 * what the model is doing. The ticking timer is hidden from screen readers; only message changes are announced.
 */
export function GenerationStatus({ message, startedAt, onCancel }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  const elapsed = startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000);
  const note = elapsed >= VERY_SLOW_AFTER_SECONDS
    ? 'This is taking longer than usual. The request is still running; you can keep waiting, or cancel and retry with a more focused request.'
    : elapsed >= SLOW_AFTER_SECONDS
      ? 'Detailed plans can take a few minutes. There is no need to submit again.'
      : '';

  return (
    <div className="generation-status">
      <LoaderCircle className="spin" size={20} aria-hidden="true" />
      <div className="generation-status-body">
        <p role="status">{message || 'Working on your plan…'}</p>
        {note ? <p className="muted" role="status">{note}</p> : null}
      </div>
      <span className="generation-timer" aria-hidden="true">{formatElapsed(elapsed)}</span>
      <button type="button" className="ghost-btn small" onClick={onCancel}><X size={14} aria-hidden="true" /> Cancel</button>
    </div>
  );
}
