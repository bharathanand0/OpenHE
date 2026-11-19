import { useEffect, useMemo, useState } from 'react';
import { RangeControl } from '../app/components/RangeControl';
import { Toggle } from '../app/components/Toggle';
import { formatMillimeters } from '../app/helpers';
import type { KeyActuation, KeyboardDriver } from '../drivers/types';
import { BoardView, nextSelection } from './BoardView';

type Field = 'actuationMm' | 'rtPressMm' | 'rtReleaseMm' | 'releaseMm' | 'bottomDeadzoneMm';

/** Actuation point, rapid trigger, release point and dead zone per key. */
export function PerformancePage({
  driver,
  profile,
  busy,
  run
}: {
  driver: KeyboardDriver;
  profile: number;
  busy: boolean;
  run: (label: string, task: () => Promise<void>) => Promise<boolean>;
}) {
  const caps = driver.capabilities;
  const [saved, setSaved] = useState<KeyActuation[] | null>(null);
  const [draft, setDraft] = useState<KeyActuation[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSaved(null);
    setDraft(null);
    setLoadError(null);
    driver
      .getActuation(profile)
      .then(a => {
        if (!live) return;
        setSaved(a);
        setDraft(a.map(k => ({ ...k })));
      })
      .catch(err => live && setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [driver, profile]);

  const targets = useMemo(
    () => (selected.size ? [...selected] : driver.layout.keys.map(k => k.index)),
    [selected, driver.layout.keys]
  );

  const dirty = useMemo(
    () =>
      !!draft && !!saved && draft.some((k, i) => JSON.stringify(k) !== JSON.stringify(saved[i])),
    [draft, saved]
  );

  if (loadError) return <div className="drv-notice is-error">{loadError}</div>;
  if (!draft) return <div className="drv-notice">Reading switch settings…</div>;

  const values = (f: Field) => targets.map(i => draft[i]?.[f] ?? 0);
  const shared = (f: Field) => {
    const v = values(f);
    return { value: v[0] ?? 0, mixed: v.some(x => Math.abs(x - v[0]) > 1e-6) };
  };
  const rtOn = targets.map(i => (draft[i]?.rtPressMm ?? 0) > 0);
  const rtMixed = rtOn.some(v => v !== rtOn[0]);
  const continuous = targets.map(i => draft[i]?.continuous ?? false);

  const update = (fn: (k: KeyActuation) => KeyActuation) =>
    setDraft(d => (d ? d.map((k, i) => (targets.includes(i) ? fn(k) : k)) : d));

  const step = Math.max(caps.travelStepMm, 0.01);
  const travel = caps.ranges?.actuation ?? { min: step, max: caps.travelMm };
  const rt = caps.ranges?.rapidTrigger ?? { min: step, max: Math.min(2.5, caps.travelMm) };
  const dead = caps.ranges?.deadzone ?? { min: 0, max: Math.min(1.5, caps.travelMm) };
  const readOnly = !caps.writable.actuation;

  const slider = (label: string, f: Field, range: { min: number; max: number }, hint?: string) => {
    const s = shared(f);
    return (
      <div className="drv-field">
        <div className="drv-field-head">
          <span>{label}</span>
          {hint && <small>{hint}</small>}
        </div>
        <RangeControl
          value={s.value}
          min={range.min}
          max={range.max}
          step={step}
          suffix="mm"
          mixed={s.mixed}
          disabled={readOnly || busy}
          onChange={v => update(k => ({ ...k, [f]: v }))}
        />
      </div>
    );
  };

  return (
    <div className="drv-page">
      <BoardView
        layout={driver.layout}
        selected={selected}
        onKeyClick={(i, e) => setSelected(prev => nextSelection(prev, i, e))}
        render={i => (
          <>
            <small>{driver.layout.keys[i]?.label}</small>
            <b>{formatMillimeters(draft[i]?.actuationMm ?? 0)}</b>
            {(draft[i]?.rtPressMm ?? 0) > 0 && <em>RT</em>}
          </>
        )}
      />
      <div className="drv-toolbar">
        <span>
          {selected.size
            ? `${selected.size} key${selected.size === 1 ? '' : 's'} selected`
            : 'All keys'}{' '}
          · Shift-click to pick several
        </span>
        <span className="drv-toolbar-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => setSelected(new Set(driver.layout.keys.map(k => k.index)))}
          >
            Select all
          </button>
          <button type="button" className="ghost-button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </span>
      </div>
      {readOnly && (
        <div className="drv-notice">
          This board's switch settings can be read but not written yet: writes are enabled only for
          firmware lines whose write path has been verified.
        </div>
      )}
      <div className="drv-panels">
        <section className="drv-panel">
          <h3>Actuation</h3>
          {slider(
            'Actuation point',
            'actuationMm',
            travel,
            'How far the key travels before it registers'
          )}
          {caps.releasePoint &&
            slider('Release point', 'releaseMm', travel, 'Used when rapid trigger is off')}
          {caps.bottomDeadzone && slider('Bottom dead zone', 'bottomDeadzoneMm', dead)}
        </section>
        {caps.rapidTrigger && (
          <section className="drv-panel">
            <h3>
              Rapid trigger
              <Toggle
                label="Rapid trigger"
                checked={rtOn[0] ?? false}
                mixed={rtMixed}
                disabled={readOnly || busy}
                onChange={on =>
                  update(k =>
                    on
                      ? { ...k, rtPressMm: k.rtPressMm || 0.3, rtReleaseMm: k.rtReleaseMm || 0.3 }
                      : { ...k, rtPressMm: 0, rtReleaseMm: 0, continuous: false }
                  )
                }
              />
            </h3>
            {rtOn.some(Boolean) ? (
              <>
                {slider('Press sensitivity', 'rtPressMm', rt)}
                {caps.rapidTriggerSplit && slider('Release sensitivity', 'rtReleaseMm', rt)}
                {caps.continuousRapidTrigger && (
                  <div className="drv-field drv-field-row">
                    <span>Continuous (resets only at full release)</span>
                    <Toggle
                      label="Continuous rapid trigger"
                      checked={continuous[0] ?? false}
                      mixed={continuous.some(v => v !== continuous[0])}
                      disabled={readOnly || busy}
                      onChange={on => update(k => ({ ...k, continuous: on }))}
                    />
                  </div>
                )}
              </>
            ) : (
              <p className="drv-muted">Off for the selected keys.</p>
            )}
          </section>
        )}
      </div>
      <div className="drv-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!dirty || busy}
          onClick={() => setDraft(saved!.map(k => ({ ...k })))}
        >
          Discard
        </button>
        <button
          type="button"
          className="ghost-button apply-button"
          disabled={!dirty || busy || readOnly}
          onClick={async () => {
            const next = draft;
            const ok = await run('Writing switch settings', () =>
              driver.setActuation(profile, next)
            );
            if (ok) setSaved(next.map(k => ({ ...k })));
          }}
        >
          Save to keyboard
        </button>
      </div>
    </div>
  );
}
