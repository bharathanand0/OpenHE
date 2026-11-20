import { useEffect, useMemo, useState } from 'react';
import { RangeControl } from '../app/components/RangeControl';
import { Toggle } from '../app/components/Toggle';
import { formatMillimeters } from '../app/helpers';
import type { KeyActuation, KeyboardDriver } from '../drivers/types';
import { BoardView, nextSelection } from './BoardView';
import { SaveBar } from './SaveBar';

type Field = 'actuationMm' | 'rtPressMm' | 'rtReleaseMm' | 'releaseMm' | 'bottomDeadzoneMm';

export type ActuationDraft = {
  saved: KeyActuation[] | null;
  draft: KeyActuation[] | null;
  setDraft: React.Dispatch<React.SetStateAction<KeyActuation[] | null>>;
  markSaved: (next: KeyActuation[]) => void;
  selected: Set<number>;
  setSelected: React.Dispatch<React.SetStateAction<Set<number>>>;
  error: string | null;
  dirty: boolean;
};

/**
 * Actuation state shared by the Actuation Point and Rapid Trigger pages, so
 * switching between them keeps unsaved edits and the key selection.
 */
export function useActuationDraft(driver: KeyboardDriver, profile: number | null): ActuationDraft {
  const [saved, setSaved] = useState<KeyActuation[] | null>(null);
  const [draft, setDraft] = useState<KeyActuation[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profile === null || !driver.capabilities.actuation) return;
    let live = true;
    setSaved(null);
    setDraft(null);
    setError(null);
    driver
      .getActuation(profile)
      .then(a => {
        if (!live) return;
        setSaved(a);
        setDraft(a.map(k => ({ ...k })));
      })
      .catch(err => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [driver, profile]);

  const dirty = useMemo(
    () =>
      !!draft && !!saved && draft.some((k, i) => JSON.stringify(k) !== JSON.stringify(saved[i])),
    [draft, saved]
  );

  return {
    saved,
    draft,
    setDraft,
    markSaved: next => setSaved(next.map(k => ({ ...k }))),
    selected,
    setSelected,
    error,
    dirty
  };
}

/** Actuation Point page (`section="actuation"`) or Rapid Trigger page (`section="rapid"`). */
export function PerformancePage({
  driver,
  profile,
  section,
  state,
  busy,
  run
}: {
  driver: KeyboardDriver;
  profile: number;
  section: 'actuation' | 'rapid';
  state: ActuationDraft;
  busy: boolean;
  run: (label: string, task: () => Promise<void>) => Promise<boolean>;
}) {
  const caps = driver.capabilities;
  const { saved, draft, setDraft, selected, setSelected, dirty } = state;
  const [justSaved, setJustSaved] = useState(false);

  const targets = useMemo(
    () => (selected.size ? [...selected] : driver.layout.keys.map(k => k.index)),
    [selected, driver.layout.keys]
  );

  if (state.error) return <div className="drv-notice is-error">{state.error}</div>;
  if (!draft) return <div className="drv-notice">Reading switch settings…</div>;

  const values = (f: Field) => targets.map(i => draft[i]?.[f] ?? 0);
  const shared = (f: Field) => {
    const v = values(f);
    return { value: v[0] ?? 0, mixed: v.some(x => Math.abs(x - v[0]) > 1e-6) };
  };
  const rtOn = targets.map(i => (draft[i]?.rtPressMm ?? 0) > 0);
  const rtMixed = rtOn.some(v => v !== rtOn[0]);
  const continuous = targets.map(i => draft[i]?.continuous ?? false);

  const update = (fn: (k: KeyActuation) => KeyActuation) => {
    setJustSaved(false);
    setDraft(d => (d ? d.map((k, i) => (targets.includes(i) ? fn(k) : k)) : d));
  };

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

  const keyValue = (i: number) =>
    section === 'actuation' ? (
      <b>{formatMillimeters(draft[i]?.actuationMm ?? 0)}</b>
    ) : (draft[i]?.rtPressMm ?? 0) > 0 ? (
      <b>
        {formatMillimeters(draft[i].rtPressMm)}
        {caps.rapidTriggerSplit && draft[i].rtReleaseMm !== draft[i].rtPressMm
          ? `/${formatMillimeters(draft[i].rtReleaseMm)}`
          : ''}
      </b>
    ) : (
      <b className="drv-off">off</b>
    );

  return (
    <div className="drv-page">
      <BoardView
        layout={driver.layout}
        selected={selected}
        onKeyClick={(i, e) => setSelected(prev => nextSelection(prev, i, e))}
        render={i => (
          <>
            <small>{driver.layout.keys[i]?.label}</small>
            {keyValue(i)}
            {section === 'actuation' && (draft[i]?.rtPressMm ?? 0) > 0 && <em>RT</em>}
          </>
        )}
      />
      <div className="drv-toolbar">
        <span>
          {selected.size
            ? `${selected.size} key${selected.size === 1 ? '' : 's'} selected`
            : 'No keys selected: changes apply to all keys'}{' '}
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
        {section === 'actuation' ? (
          <>
            <section className="drv-panel">
              <h3>Actuation point</h3>
              {slider(
                'Actuation point',
                'actuationMm',
                travel,
                'How far the key travels before it registers'
              )}
            </section>
            {(caps.releasePoint || caps.bottomDeadzone) && (
              <section className="drv-panel">
                <h3>Release and dead zone</h3>
                {caps.releasePoint &&
                  slider('Release point', 'releaseMm', travel, 'Used when rapid trigger is off')}
                {caps.bottomDeadzone &&
                  slider(
                    'Bottom dead zone',
                    'bottomDeadzoneMm',
                    dead,
                    'Travel near the bottom that counts as fully pressed'
                  )}
              </section>
            )}
          </>
        ) : (
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
            <p className="drv-muted">
              With rapid trigger the key releases as soon as it moves up by the release sensitivity,
              and presses again as soon as it moves down by the press sensitivity, wherever it is in
              its travel.
            </p>
            {rtOn.some(Boolean) ? (
              <>
                {slider('Press sensitivity', 'rtPressMm', rt)}
                {caps.rapidTriggerSplit && slider('Release sensitivity', 'rtReleaseMm', rt)}
                {caps.continuousRapidTrigger && (
                  <div className="drv-field drv-field-row">
                    <span>
                      Continuous rapid trigger
                      <small className="drv-muted">
                        {' '}
                        Stays active until the key is fully released.
                      </small>
                    </span>
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
      <SaveBar
        dirty={dirty}
        busy={busy}
        saved={justSaved}
        canSave={!readOnly}
        title={readOnly ? 'This board is read-only for switch settings' : undefined}
        onDiscard={() => saved && setDraft(saved.map(k => ({ ...k })))}
        onSave={async () => {
          const next = draft;
          const ok = await run('Writing switch settings', () => driver.setActuation(profile, next));
          if (ok) {
            state.markSaved(next);
            setJustSaved(true);
          }
        }}
      />
    </div>
  );
}
