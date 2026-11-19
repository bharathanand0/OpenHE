import { useEffect, useRef, useState } from 'react';
import { formatMillimeters } from '../app/helpers';
import type { KeyboardDriver } from '../drivers/types';
import { BoardView } from './BoardView';

/** Live key travel: polled where the board answers snapshots, streamed where it pushes. */
export function TravelPage({ driver }: { driver: KeyboardDriver }) {
  const [travel, setTravel] = useState<Map<number, { mm: number; raw?: number }>>(new Map());
  const [peak, setPeak] = useState<Map<number, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const pending = useRef(new Map<number, { mm: number; raw?: number }>());

  useEffect(() => {
    let live = true;
    let stop: (() => Promise<void>) | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (!pending.current.size) return;
      const batch = pending.current;
      pending.current = new Map();
      setTravel(prev => new Map([...prev, ...batch]));
      setPeak(prev => {
        const next = new Map(prev);
        for (const [i, v] of batch) next.set(i, Math.max(next.get(i) ?? 0, v.mm));
        return next;
      });
    };
    const push = (samples: Array<{ index: number; travelMm: number; raw?: number }>) => {
      for (const s of samples) pending.current.set(s.index, { mm: s.travelMm, raw: s.raw });
      if (!frame) frame = requestAnimationFrame(flush);
    };
    (async () => {
      try {
        if (driver.readTravel) {
          while (live) {
            push(await driver.readTravel());
            await new Promise(r => setTimeout(r, 30));
          }
        } else if (driver.subscribeTravel) {
          stop = await driver.subscribeTravel(push);
          if (!live) await stop();
        } else {
          setError('This board does not report live travel.');
        }
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
      if (frame) cancelAnimationFrame(frame);
      void stop?.();
    };
  }, [driver]);

  const full = driver.capabilities.travelMm;
  return (
    <div className="drv-page">
      {error && <div className="drv-notice is-error">{error}</div>}
      <BoardView
        layout={driver.layout}
        fill={i => (travel.get(i)?.mm ?? 0) / full}
        render={i => {
          const t = travel.get(i);
          return (
            <>
              <small>{driver.layout.keys[i]?.label}</small>
              <b>{showRaw && t?.raw !== undefined ? t.raw : formatMillimeters(t?.mm ?? 0)}</b>
              {(peak.get(i) ?? 0) > 0 && <em>max {formatMillimeters(peak.get(i) ?? 0)}</em>}
            </>
          );
        }}
      />
      <div className="drv-toolbar">
        <span className="drv-muted">
          {driver.readTravel
            ? 'Polled from the keyboard.'
            : 'Streamed by the keyboard (cable only); a key held still sends nothing.'}
        </span>
        <span className="drv-toolbar-actions">
          <button type="button" className="ghost-button" onClick={() => setShowRaw(v => !v)}>
            {showRaw ? 'Show millimetres' : 'Show raw values'}
          </button>
          <button type="button" className="ghost-button" onClick={() => setPeak(new Map())}>
            Reset max
          </button>
        </span>
      </div>
    </div>
  );
}
