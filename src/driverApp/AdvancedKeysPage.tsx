import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { RangeControl } from '../app/components/RangeControl';
import { Toggle } from '../app/components/Toggle';
import type { UiKeycode } from '../drivers/keycodes';
import type { AdvancedKey, AdvancedKeyKind, DksAction, KeyboardDriver } from '../drivers/types';
import { BoardView } from './BoardView';
import { KeycodePicker } from './KeycodePicker';
import { keyLabel } from './RemapPage';

type EditableKind = Exclude<AdvancedKeyKind, 'macro'>;

const KINDS: Record<EditableKind, { title: string; short: string; blurb: string }> = {
  nullBind: {
    title: 'Null bind (SOCD)',
    short: 'NB',
    blurb:
      'Two keys that cancel each other, like A and D for strafing. Pick which one wins when both are down.'
  },
  dynamicKeystroke: {
    title: 'Dynamic keystroke',
    short: 'DKS',
    blurb: 'Up to four keycodes, each pressed, tapped or released at four points of one keystroke.'
  },
  tapHold: {
    title: 'Tap-hold',
    short: 'TH',
    blurb: 'One keycode on a tap, another while held (e.g. Esc on tap, Ctrl on hold).'
  },
  toggle: {
    title: 'Toggle',
    short: 'TG',
    blurb:
      'A tap latches the key down, the next tap releases it. Held longer, it acts as a normal key.'
  }
};

const NB_BEHAVIORS: Array<{
  value: Extract<AdvancedKey, { kind: 'nullBind' }>['behavior'];
  label: string;
}> = [
  { value: 'last', label: 'Last pressed wins' },
  { value: 'primary', label: 'First key wins' },
  { value: 'secondary', label: 'Second key wins' },
  { value: 'neutral', label: 'Neither (both released)' },
  { value: 'distance', label: 'Deeper press wins' }
];

const DKS_STAGES = ['Press', 'Bottom out', 'Release from bottom', 'Release'] as const;
const DKS_CYCLE: DksAction[] = ['hold', 'press', 'tap', 'release'];
const DKS_LABEL: Record<DksAction, string> = {
  hold: '—',
  press: 'Press',
  tap: 'Tap',
  release: 'Release'
};

function fresh(
  kind: EditableKind,
  layer: number,
  key: number,
  bindings: number,
  travelMm: number
): AdvancedKey {
  switch (kind) {
    case 'nullBind':
      return { kind, layer, key, secondaryKey: key, behavior: 'last', bottomOutMm: 0 };
    case 'dynamicKeystroke':
      return {
        kind,
        layer,
        key,
        keycodes: Array(bindings).fill(0),
        actions: Array.from(
          { length: bindings },
          () => ['hold', 'hold', 'hold', 'hold'] as [DksAction, DksAction, DksAction, DksAction]
        ),
        bottomOutMm: Math.round(travelMm * 0.85 * 10) / 10
      };
    case 'tapHold':
      return { kind, layer, key, tap: 0, hold: 0, tappingTermMs: 200, holdOnOtherKeyPress: false };
    case 'toggle':
      return { kind, layer, key, keycode: 0, tappingTermMs: 200 };
  }
}

/** Keys an advanced key occupies on its layer. */
function keysOf(ak: AdvancedKey): number[] {
  return ak.kind === 'nullBind' ? [ak.key, ak.secondaryKey] : [ak.key];
}

/** What is wrong with an entry, or null. */
function problem(ak: AdvancedKey, all: readonly AdvancedKey[], self: number): string | null {
  if (ak.kind === 'nullBind' && ak.secondaryKey === ak.key) return 'Pick a second key.';
  if (ak.kind === 'dynamicKeystroke' && !ak.keycodes.some(k => k !== 0))
    return 'Bind at least one keycode.';
  if (ak.kind === 'tapHold' && (ak.tap === 0 || ak.hold === 0))
    return 'Pick both a tap and a hold keycode.';
  if (ak.kind === 'toggle' && ak.keycode === 0) return 'Pick a keycode.';
  const mine = keysOf(ak);
  const clash = all.some(
    (o, i) => i !== self && o.layer === ak.layer && keysOf(o).some(k => mine.includes(k))
  );
  return clash ? 'Another advanced key already uses this key on this layer.' : null;
}

type Target =
  | { field: 'key' | 'secondaryKey' }
  | { field: 'keycode'; slot: 'tap' | 'hold' | 'toggle' | number };

export function AdvancedKeysPage({
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
  const kinds = caps.advancedKeys.filter((k): k is EditableKind => k !== 'macro');
  const [saved, setSaved] = useState<AdvancedKey[] | null>(null);
  const [draft, setDraft] = useState<AdvancedKey[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [target, setTarget] = useState<Target>({ field: 'key' });
  const [layer, setLayer] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSaved(null);
    setDraft(null);
    setEditing(null);
    setLoadError(null);
    driver
      .getAdvancedKeys?.(profile)
      .then(list => {
        if (!live) return;
        setSaved(list);
        setDraft(list.map(k => structuredClone(k)));
      })
      .catch(err => live && setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [driver, profile]);

  const dirty = useMemo(
    () => !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved]
  );
  const current = editing !== null ? draft?.[editing] : undefined;
  const label = (i: number) => driver.layout.keys[i]?.label || `Key ${i}`;

  if (!driver.getAdvancedKeys)
    return <div className="drv-notice">This board has no advanced keys.</div>;
  if (loadError) return <div className="drv-notice is-error">{loadError}</div>;
  if (!draft) return <div className="drv-notice">Reading advanced keys…</div>;

  const onLayer = draft.map((ak, i) => ({ ak, i })).filter(({ ak }) => ak.layer === layer);
  const badge = new Map<number, string>();
  for (const { ak } of onLayer) {
    const short = ak.kind === 'macro' ? 'M' : KINDS[ak.kind].short;
    for (const k of keysOf(ak)) badge.set(k, short);
  }
  const errors = draft.map((ak, i) => problem(ak, draft, i));
  const writable = caps.writable.advancedKeys;

  const update = (fn: (ak: AdvancedKey) => AdvancedKey) =>
    setDraft(d => (d && editing !== null ? d.map((ak, i) => (i === editing ? fn(ak) : ak)) : d));

  const add = (kind: EditableKind) => {
    const free = driver.layout.keys.find(k => !badge.has(k.index))?.index ?? 0;
    const next = fresh(kind, layer, free, caps.dynamicKeystrokeBindings, caps.travelMm);
    setDraft(d => (d ? [...d, next] : d));
    setEditing(draft.length);
    setTarget({ field: 'key' });
  };

  const onBoardClick = (index: number) => {
    if (!current) {
      const hit = onLayer.find(({ ak }) => keysOf(ak).includes(index));
      if (hit) {
        setEditing(hit.i);
        setTarget({ field: 'key' });
      }
      return;
    }
    if (target.field === 'key' || target.field === 'secondaryKey') {
      const field = target.field;
      update(ak => ({ ...ak, [field]: index }) as AdvancedKey);
      if (current.kind === 'nullBind' && field === 'key') setTarget({ field: 'secondaryKey' });
    }
  };

  const pickedKeycode = (v: UiKeycode) => {
    if (target.field !== 'keycode') return;
    const slot = target.slot;
    update(ak => {
      if (ak.kind === 'tapHold' && (slot === 'tap' || slot === 'hold')) return { ...ak, [slot]: v };
      if (ak.kind === 'toggle' && slot === 'toggle') return { ...ak, keycode: v };
      if (ak.kind === 'dynamicKeystroke' && typeof slot === 'number') {
        const keycodes = [...ak.keycodes];
        keycodes[slot] = v;
        return { ...ak, keycodes };
      }
      return ak;
    });
  };

  const keycodeButton = (
    slot: 'tap' | 'hold' | 'toggle' | number,
    value: UiKeycode,
    title: string
  ) => {
    const active = target.field === 'keycode' && target.slot === slot;
    return (
      <button
        type="button"
        className={`drv-slot${active ? ' is-active' : ''}`}
        onClick={() => setTarget({ field: 'keycode', slot })}
      >
        <small>{title}</small>
        <b>{value ? keyLabel(driver, value, false) : 'Pick…'}</b>
      </button>
    );
  };

  const keyButton = (field: 'key' | 'secondaryKey', value: number, title: string) => {
    const active = target.field === field;
    return (
      <button
        type="button"
        className={`drv-slot${active ? ' is-active' : ''}`}
        onClick={() => setTarget({ field })}
      >
        <small>{title}</small>
        <b>{label(value)}</b>
      </button>
    );
  };

  const highlighted = new Set<number>(current ? keysOf(current) : []);
  const step = Math.max(caps.travelStepMm, 0.05);

  return (
    <div className="drv-page">
      {caps.layers > 1 && (
        <div className="drv-tabs">
          {Array.from({ length: caps.layers }, (_, i) => (
            <button
              type="button"
              key={i}
              className={`drv-tab${i === layer ? ' is-active' : ''}`}
              onClick={() => {
                setLayer(i);
                setEditing(null);
              }}
            >
              {i === 0 ? 'Base layer' : `Layer ${i}`}
            </button>
          ))}
        </div>
      )}
      <BoardView
        layout={driver.layout}
        selected={highlighted}
        onKeyClick={onBoardClick}
        render={i => (
          <>
            <small>{driver.layout.keys[i]?.label}</small>
            {badge.has(i) && <em>{badge.get(i)}</em>}
          </>
        )}
      />
      <div className="drv-ak">
        <section className="drv-panel drv-ak-list">
          <h3>
            Advanced keys
            <small className="drv-muted">
              {draft.length} / {caps.maxAdvancedKeys}
            </small>
          </h3>
          {onLayer.length === 0 && <p className="drv-muted">None on this layer yet.</p>}
          {onLayer.map(({ ak, i }) => (
            <div
              key={i}
              className={`drv-ak-row${editing === i ? ' is-active' : ''}${errors[i] ? ' has-error' : ''}`}
            >
              <button
                type="button"
                className="drv-ak-row-main"
                onClick={() => setEditing(editing === i ? null : i)}
              >
                <b>{ak.kind === 'macro' ? 'Macro' : KINDS[ak.kind].title}</b>
                <small>
                  {keysOf(ak)
                    .filter((k, n, all) => all.indexOf(k) === n)
                    .map(label)
                    .join(' + ')}
                </small>
              </button>
              <button
                type="button"
                className="ghost-button"
                aria-label="Remove"
                onClick={() => {
                  setDraft(d => d && d.filter((_, j) => j !== i));
                  setEditing(null);
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <div className="drv-ak-add">
            {kinds.map(kind => (
              <button
                type="button"
                key={kind}
                className="secondary-button"
                disabled={draft.length >= caps.maxAdvancedKeys || busy}
                onClick={() => add(kind)}
              >
                <Plus size={14} /> {KINDS[kind].title}
              </button>
            ))}
          </div>
        </section>

        <section className="drv-panel drv-ak-editor">
          {!current ? (
            <p className="drv-muted">Add an advanced key, or click one on the board to edit it.</p>
          ) : current.kind === 'macro' ? (
            <p className="drv-muted">
              Macro {current.macro + 1} on {label(current.key)}. Macros cannot be edited here yet;
              it is kept as is.
            </p>
          ) : (
            <>
              <h3>{KINDS[current.kind].title}</h3>
              <p className="drv-muted">{KINDS[current.kind].blurb}</p>
              {editing !== null && errors[editing] && (
                <div className="drv-notice is-error">{errors[editing]}</div>
              )}

              {current.kind === 'nullBind' && (
                <>
                  <div className="drv-slots">
                    {keyButton('key', current.key, 'First key')}
                    {keyButton('secondaryKey', current.secondaryKey, 'Second key')}
                  </div>
                  <p className="drv-muted">Select a slot, then click the key on the board.</p>
                  <label className="drv-field">
                    <span>When both are down</span>
                    <select
                      className="drv-select"
                      value={current.behavior}
                      onChange={e =>
                        update(ak => ({
                          ...ak,
                          behavior: e.target.value as typeof current.behavior
                        }))
                      }
                    >
                      {NB_BEHAVIORS.map(b => (
                        <option key={b.value} value={b.value}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="drv-field drv-field-row">
                    <span>Both register when both are bottomed out</span>
                    <Toggle
                      label="Bottom-out override"
                      checked={current.bottomOutMm > 0}
                      onChange={on =>
                        update(ak => ({
                          ...ak,
                          bottomOutMm: on ? Math.round(caps.travelMm * 0.85 * 10) / 10 : 0
                        }))
                      }
                    />
                  </div>
                  {current.bottomOutMm > 0 && (
                    <RangeControl
                      value={current.bottomOutMm}
                      min={step}
                      max={caps.travelMm}
                      step={step}
                      suffix="mm"
                      onChange={v => update(ak => ({ ...ak, bottomOutMm: v }))}
                    />
                  )}
                </>
              )}

              {current.kind === 'dynamicKeystroke' && (
                <>
                  <div className="drv-slots">{keyButton('key', current.key, 'Key')}</div>
                  <div className="drv-dks">
                    <span />
                    {DKS_STAGES.map(s => (
                      <small key={s}>{s}</small>
                    ))}
                    {current.keycodes.map((kc, row) => (
                      <div className="drv-dks-row" key={row}>
                        {keycodeButton(row, kc, `Keycode ${row + 1}`)}
                        {current.actions[row].map((act, stage) => (
                          <button
                            type="button"
                            key={stage}
                            className={`drv-dks-cell is-${act}`}
                            disabled={!kc}
                            onClick={() =>
                              update(ak => {
                                if (ak.kind !== 'dynamicKeystroke') return ak;
                                const actions = ak.actions.map(a => [...a] as typeof a);
                                actions[row][stage] =
                                  DKS_CYCLE[(DKS_CYCLE.indexOf(act) + 1) % DKS_CYCLE.length];
                                return { ...ak, actions };
                              })
                            }
                          >
                            {DKS_LABEL[act]}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                  <p className="drv-muted">
                    Click a cell to cycle: — (no change), Press, Tap, Release.
                  </p>
                  <div className="drv-field">
                    <span>Bottom-out point</span>
                    <RangeControl
                      value={current.bottomOutMm}
                      min={step}
                      max={caps.travelMm}
                      step={step}
                      suffix="mm"
                      onChange={v => update(ak => ({ ...ak, bottomOutMm: v }))}
                    />
                  </div>
                </>
              )}

              {current.kind === 'tapHold' && (
                <>
                  <div className="drv-slots">
                    {keyButton('key', current.key, 'Key')}
                    {keycodeButton('tap', current.tap, 'On tap')}
                    {keycodeButton('hold', current.hold, 'On hold')}
                  </div>
                  <TermField
                    value={current.tappingTermMs}
                    onChange={v => update(ak => ({ ...ak, tappingTermMs: v }))}
                  />
                  <div className="drv-field drv-field-row">
                    <span>Hold as soon as another key is pressed</span>
                    <Toggle
                      label="Hold on other key press"
                      checked={current.holdOnOtherKeyPress}
                      onChange={on => update(ak => ({ ...ak, holdOnOtherKeyPress: on }))}
                    />
                  </div>
                </>
              )}

              {current.kind === 'toggle' && (
                <>
                  <div className="drv-slots">
                    {keyButton('key', current.key, 'Key')}
                    {keycodeButton('toggle', current.keycode, 'Keycode')}
                  </div>
                  <TermField
                    value={current.tappingTermMs}
                    onChange={v => update(ak => ({ ...ak, tappingTermMs: v }))}
                  />
                </>
              )}

              {target.field === 'keycode' && (
                <div className="drv-picker">
                  <KeycodePicker driver={driver} onPick={pickedKeycode} exclude={['mouse']} />
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {!writable && (
        <div className="drv-notice">This board's advanced keys can be read but not written.</div>
      )}
      <div className="drv-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!dirty || busy}
          onClick={() => {
            setDraft(saved!.map(k => structuredClone(k)));
            setEditing(null);
          }}
        >
          Discard
        </button>
        <button
          type="button"
          className="ghost-button apply-button"
          disabled={!dirty || busy || !writable || errors.some(Boolean)}
          title={errors.some(Boolean) ? 'Fix the highlighted advanced keys first' : undefined}
          onClick={async () => {
            const next = draft;
            const ok = await run('Writing advanced keys', () =>
              driver.setAdvancedKeys!(profile, next)
            );
            if (ok) setSaved(next.map(k => structuredClone(k)));
          }}
        >
          Save to keyboard
        </button>
      </div>
    </div>
  );
}

function TermField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className="drv-field">
      <span>Tapping term</span>
      <span className="drv-term">
        <input
          type="range"
          min={50}
          max={1000}
          step={10}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
        />
        <b>{value} ms</b>
      </span>
    </label>
  );
}
