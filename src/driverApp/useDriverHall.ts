/**
 * Live key travel from a driver board in the shape of OpenAula's Hall stream
 * state, so OpenAula's Hall Stream page and the Actuation page's Visual
 * Feedback card can show it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HallStreamSample, HallStreamState } from '../protocol/hero68/hallStream';
import type { KeyboardDriver, TravelSample } from '../drivers/types';
import { keyIdOf } from './boardModel';

const IDLE: HallStreamState = {
  active: false,
  starting: false,
  recovering: false,
  source: 'direct-poll',
  error: null,
  sampleCount: 0,
  frameCount: 0,
  telemetryHz: null,
  samples: {},
  keyTelemetryHz: {}
};

/** Poll interval for boards that answer travel snapshots (OpenHE firmware). */
const POLL_MS = 16;

export function useDriverHall(
  driver: KeyboardDriver,
  /** Actuation point of key `index`, mm, to mark samples as pressed. */
  actuationOf: (index: number) => number | undefined
) {
  const [state, setState] = useState<HallStreamState>(IDLE);
  const run = useRef<{ stop: () => Promise<void> } | null>(null);
  const actuationRef = useRef(actuationOf);
  actuationRef.current = actuationOf;
  const frames = useRef<number[]>([]);

  const ingest = useCallback((batch: TravelSample[]) => {
    const now = performance.now();
    frames.current.push(now);
    while (frames.current.length > 1 && now - frames.current[0] > 1000) frames.current.shift();
    const hz =
      frames.current.length > 1
        ? ((frames.current.length - 1) * 1000) / (now - frames.current[0])
        : null;
    setState(prev => {
      const samples: Record<string, HallStreamSample> = { ...prev.samples };
      for (const s of batch) {
        const keyId = keyIdOf(s.index);
        const ap = actuationRef.current(s.index);
        samples[keyId] = {
          keyId,
          pos: s.index,
          distanceMm: s.travelMm,
          visualDistanceMm: s.travelMm,
          distanceUnits: Math.round(s.travelMm * 100),
          rawAdc: s.raw ?? 0,
          pressed: ap !== undefined && s.travelMm >= ap,
          releaseInferred: false,
          timestampMs: now
        };
      }
      return {
        ...prev,
        starting: false,
        active: true,
        error: null,
        frameCount: prev.frameCount + 1,
        sampleCount: prev.sampleCount + batch.length,
        telemetryHz: hz,
        samples
      };
    });
  }, []);

  const stop = useCallback(async () => {
    const r = run.current;
    run.current = null;
    await r?.stop();
    frames.current = [];
    setState(IDLE);
  }, []);

  const start = useCallback(async () => {
    if (run.current) return;
    setState({ ...IDLE, starting: true });
    try {
      if (driver.readTravel) {
        let live = true;
        const loop = async () => {
          while (live) {
            const t0 = performance.now();
            ingest(await driver.readTravel!());
            const wait = POLL_MS - (performance.now() - t0);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
          }
        };
        run.current = {
          stop: async () => {
            live = false;
          }
        };
        void loop().catch(err => {
          run.current = null;
          setState({ ...IDLE, error: err instanceof Error ? err.message : String(err) });
        });
      } else if (driver.subscribeTravel) {
        const unsubscribe = await driver.subscribeTravel(ingest);
        run.current = { stop: unsubscribe };
        setState(prev => ({ ...prev, starting: false, active: true }));
      } else {
        setState({ ...IDLE, error: 'This keyboard does not report live travel.' });
      }
    } catch (err) {
      run.current = null;
      setState({ ...IDLE, error: err instanceof Error ? err.message : String(err) });
    }
  }, [driver, ingest]);

  useEffect(
    () => () => {
      void run.current?.stop();
      run.current = null;
    },
    []
  );

  const toggle = useCallback(async () => {
    if (run.current) await stop();
    else await start();
  }, [start, stop]);

  return { state, start, stop, toggle };
}
