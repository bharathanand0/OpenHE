import { useEffect, useMemo, useRef, useState } from 'react';
import { Gamepad2, RotateCw } from 'lucide-react';
import { Toggle } from '../app/components/Toggle';
import type {
  CurvePoint,
  DeviceOptions,
  GamepadButton,
  GamepadConfig,
  KeyboardDriver
} from '../drivers/types';
import { BoardView, nextSelection } from './BoardView';
import { SaveBar } from './SaveBar';

const GROUPS: Array<{ label: string; buttons: Array<[GamepadButton, string]> }> = [
  {
    label: 'Face',
    buttons: [
      ['a', 'A'],
      ['b', 'B'],
      ['x', 'X'],
      ['y', 'Y']
    ]
  },
  {
    label: 'D-pad',
    buttons: [
      ['dpadUp', '↑'],
      ['dpadDown', '↓'],
      ['dpadLeft', '←'],
      ['dpadRight', '→']
    ]
  },
  {
    label: 'Left stick',
    buttons: [
      ['leftStickUp', 'LS ↑'],
      ['leftStickDown', 'LS ↓'],
      ['leftStickLeft', 'LS ←'],
      ['leftStickRight', 'LS →'],
      ['leftStickClick', 'L3']
    ]
  },
  {
    label: 'Right stick',
    buttons: [
      ['rightStickUp', 'RS ↑'],
      ['rightStickDown', 'RS ↓'],
      ['rightStickLeft', 'RS ←'],
      ['rightStickRight', 'RS →'],
      ['rightStickClick', 'R3']
    ]
  },
  {
    label: 'Shoulders and triggers',
    buttons: [
      ['leftBumper', 'LB'],
      ['rightBumper', 'RB'],
      ['leftTrigger', 'LT'],
      ['rightTrigger', 'RT']
    ]
  },
  {
    label: 'Menu',
    buttons: [
      ['start', 'Start'],
      ['back', 'Back'],
      ['home', 'Home']
    ]
  }
];
const SHORT = new Map<GamepadButton, string>(GROUPS.flatMap(g => g.buttons));
const ANALOG = new Set<GamepadButton>([
  'leftStickUp',
  'leftStickDown',
  'leftStickLeft',
  'leftStickRight',
  'rightStickUp',
  'rightStickDown',
  'rightStickLeft',
  'rightStickRight',
  'leftTrigger',
  'rightTrigger'
]);

/** Four-point presets as fractions of full travel -> output. */
const PRESETS: Record<string, Array<[number, number]>> = {
  Default: [
    [4 / 255, 20 / 255],
    [85 / 255, 95 / 255],
    [165 / 255, 170 / 255],
    [1, 1]
  ],
  Linear: [
    [0.02, 0],
    [0.35, 0.35],
    [0.7, 0.7],
    [1, 1]
  ],
  Aggressive: [
    [0.02, 0.1],
    [0.2, 0.6],
    [0.5, 0.9],
    [0.85, 1]
  ],
  Smooth: [
    [0.05, 0],
    [0.45, 0.2],
    [0.75, 0.55],
    [1, 1]
  ],
  'Short throw': [
    [0.02, 0],
    [0.2, 0.4],
    [0.4, 0.8],
    [0.6, 1]
  ]
};

const W = 320;
const H = 250;
const px = (f: number) => 30 + f * 270;
const py = (o: number) => 220 - o * 200;

function CurveEditor({
  curve,
  travelMm,
  disabled,
  onChange
}: {
  curve: CurvePoint[];
  travelMm: number;
  disabled: boolean;
  onChange: (next: CurvePoint[]) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const move = (index: number, f: number, o: number) => {
    const lo = index > 0 ? curve[index - 1].travelMm / travelMm : 0;
    const hi = index < curve.length - 1 ? curve[index + 1].travelMm / travelMm : 1;
    const x = Math.min(hi, Math.max(lo, f));
    const next = curve.map((p, i) =>
      i === index
        ? {
            travelMm: Math.round(x * travelMm * 100) / 100,
            output: Math.min(1, Math.max(0, Math.round(o * 100) / 100))
          }
        : p
    );
    onChange(next);
  };
  return (
    <svg
      ref={svg}
      className="gp-curve drv-curve"
      viewBox={`0 0 ${W} ${H}`}
      onPointerMove={e => {
        if (drag === null || !svg.current) return;
        const r = svg.current.getBoundingClientRect();
        const sx = ((e.clientX - r.left) / r.width) * W;
        const sy = ((e.clientY - r.top) / r.height) * H;
        move(drag, (sx - 30) / 270, (220 - sy) / 200);
      }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      {[0, 0.25, 0.5, 0.75, 1].map(n => (
        <g key={n}>
          <line x1={px(n)} x2={px(n)} y1="20" y2="220" />
          <line x1="30" x2="300" y1={py(n)} y2={py(n)} />
        </g>
      ))}
      <polygon
        points={
          `${px(curve[0].travelMm / travelMm)},220 ` +
          curve.map(p => `${px(p.travelMm / travelMm)},${py(p.output)}`).join(' ') +
          ` ${px(1)},${py(1)} ${px(1)},220`
        }
      />
      <polyline
        points={
          curve.map(p => `${px(p.travelMm / travelMm)},${py(p.output)}`).join(' ') +
          ` ${px(1)},${py(1)}`
        }
      />
      {curve.map((p, i) => (
        <circle
          key={i}
          role="slider"
          tabIndex={0}
          aria-label={`Curve point ${i + 1}`}
          aria-valuenow={Math.round(p.output * 100)}
          cx={px(p.travelMm / travelMm)}
          cy={py(p.output)}
          r={drag === i ? 8 : 6}
          onPointerDown={e => {
            if (disabled) return;
            (e.currentTarget as SVGCircleElement).setPointerCapture(e.pointerId);
            setDrag(i);
          }}
          onKeyDown={e => {
            const d = {
              ArrowRight: [0.01, 0],
              ArrowLeft: [-0.01, 0],
              ArrowUp: [0, 0.01],
              ArrowDown: [0, -0.01]
            }[e.key];
            if (!d || disabled) return;
            e.preventDefault();
            move(i, p.travelMm / travelMm + d[0], p.output + d[1]);
          }}
        />
      ))}
      <text x="30" y="244">
        0 mm
      </text>
      <text x="262" y="244">
        {travelMm.toFixed(1)} mm
      </text>
      <text x="2" y="24">
        100%
      </text>
    </svg>
  );
}

/** Live view of the first controller the browser sees (Gamepad API). */
function Tester() {
  const [pad, setPad] = useState<{ id: string; axes: number[]; buttons: number[] } | null>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const pads = navigator.getGamepads?.() ?? [];
      const p = [...pads].find(Boolean);
      setPad(p ? { id: p.id, axes: [...p.axes], buttons: p.buttons.map(b => b.value) } : null);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  if (!pad) {
    return (
      <p className="drv-muted">
        No controller seen yet. With the gamepad interface on and the keyboard reconnected, press
        any mapped key once so the browser picks it up.
      </p>
    );
  }
  const stick = (x: number, y: number, label: string) => (
    <div className="gp-stick">
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="46" />
        <circle cx={50 + x * 40} cy={50 + y * 40} r="9" className="drv-stick-dot" />
      </svg>
      <span>{label}</span>
    </div>
  );
  const trig = (v: number, label: string) => (
    <div className="drv-trigger">
      <span style={{ height: `${v * 100}%` }} />
      <small>{label}</small>
    </div>
  );
  const names = [
    'A',
    'B',
    'X',
    'Y',
    'LB',
    'RB',
    'LT',
    'RT',
    'Back',
    'Start',
    'L3',
    'R3',
    '↑',
    '↓',
    '←',
    '→',
    'Home'
  ];
  return (
    <>
      <small className="drv-muted">{pad.id}</small>
      <div className="gp-test-controls">
        {trig(pad.buttons[6] ?? 0, 'LT')}
        {stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0, 'Left stick')}
        {stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0, 'Right stick')}
        {trig(pad.buttons[7] ?? 0, 'RT')}
      </div>
      <div className="drv-pad-buttons">
        {names.map((n, i) =>
          i === 6 || i === 7 ? null : (
            <span key={n} className={(pad.buttons[i] ?? 0) > 0.5 ? 'is-on' : ''}>
              {n}
            </span>
          )
        )}
      </div>
    </>
  );
}

export function GamepadPage({
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
  const travelMm = driver.capabilities.travelMm;
  const [saved, setSaved] = useState<GamepadConfig | null>(null);
  const [draft, setDraft] = useState<GamepadConfig | null>(null);
  const [options, setOptions] = useState<DeviceOptions | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);

  useEffect(() => {
    let live = true;
    setSaved(null);
    setDraft(null);
    setError(null);
    Promise.all([driver.getGamepad!(profile), driver.getOptions?.() ?? Promise.resolve({})])
      .then(([gp, opts]) => {
        if (!live) return;
        setSaved(gp);
        setDraft(structuredClone(gp));
        setOptions(opts);
      })
      .catch(err => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [driver, profile]);

  const dirty = useMemo(
    () => !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved]
  );

  if (error) return <div className="drv-notice is-error">{error}</div>;
  if (!draft) return <div className="drv-notice">Reading gamepad settings…</div>;

  const assign = (b: GamepadButton) =>
    setDraft(d => (d ? { ...d, buttons: d.buttons.map((v, i) => (selected.has(i) ? b : v)) } : d));
  const mapped = draft.buttons.filter(b => b !== 'none').length;
  const xinput = options?.xinput;

  return (
    <div className="drv-page">
      <section className={`drv-banner${xinput ? ' is-on' : ''}`}>
        <Gamepad2 size={22} />
        <div>
          <b>Gamepad interface {xinput ? 'on' : 'off'}</b>
          <small>
            {xinput
              ? 'The keyboard also shows up as an Xbox (XInput) controller. Mapped keys on the base layer drive it, over the cable.'
              : 'Turn it on to make the keyboard show up as an Xbox (XInput) controller as well.'}
            {needsReconnect &&
              ' Reconnect the keyboard (or restart it) for the change to take effect.'}
          </small>
        </div>
        <span className="drv-toolbar-actions">
          {needsReconnect && driver.reboot && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => run('Restarting the keyboard', () => driver.reboot!())}
            >
              <RotateCw size={14} /> Restart keyboard
            </button>
          )}
          {xinput !== undefined && driver.setOptions && (
            <Toggle
              label="Gamepad interface"
              checked={xinput}
              disabled={busy}
              onChange={async on => {
                const ok = await run(
                  on ? 'Turning the gamepad on' : 'Turning the gamepad off',
                  () => driver.setOptions!({ xinput: on })
                );
                if (ok) {
                  setOptions(o => ({ ...o, xinput: on }));
                  setNeedsReconnect(true);
                }
              }}
            />
          )}
        </span>
      </section>

      <BoardView
        layout={driver.layout}
        selected={selected}
        onKeyClick={(i, e) => setSelected(prev => nextSelection(prev, i, e))}
        render={i => {
          const b = draft.buttons[i];
          return (
            <>
              <small>{driver.layout.keys[i]?.label}</small>
              {b !== 'none' && (
                <b className={ANALOG.has(b) ? 'drv-gp-analog' : 'drv-gp-digital'}>{SHORT.get(b)}</b>
              )}
            </>
          );
        }}
      />
      <div className="drv-toolbar">
        <span>
          {selected.size
            ? `${selected.size} key${selected.size === 1 ? '' : 's'} selected`
            : 'Pick keys on the board'}{' '}
          · {mapped} mapped
        </span>
        <span className="drv-toolbar-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={!selected.size}
            onClick={() => assign('none')}
          >
            Unmap
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              // WASD on the left stick, the common starting point
              const idx = (label: string) =>
                driver.layout.keys.find(k => k.label.toUpperCase() === label)?.index;
              const pairs: Array<[string, GamepadButton]> = [
                ['W', 'leftStickUp'],
                ['A', 'leftStickLeft'],
                ['S', 'leftStickDown'],
                ['D', 'leftStickRight']
              ];
              setDraft(d => {
                if (!d) return d;
                const buttons = [...d.buttons];
                for (const [l, b] of pairs) {
                  const i = idx(l);
                  if (i !== undefined) buttons[i] = b;
                }
                return { ...d, buttons };
              });
            }}
          >
            WASD → left stick
          </button>
        </span>
      </div>

      <div className="drv-picker">
        {GROUPS.map(g => (
          <div key={g.label} className="drv-gp-group">
            <small>{g.label}</small>
            <div className="drv-gp-buttons">
              {g.buttons.map(([b, label]) => (
                <button
                  type="button"
                  key={b}
                  className={`drv-pick${ANALOG.has(b) ? ' is-analog' : ''}`}
                  disabled={!selected.size || busy}
                  onClick={() => assign(b)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="drv-panels">
        <section className="drv-panel">
          <h3>Analog curve</h3>
          <p className="drv-muted">
            How far a key is pressed (across) sets how far the stick or trigger moves (up). Before
            the first point the output is zero; past the last point it is full.
          </p>
          <CurveEditor
            curve={draft.curve}
            travelMm={travelMm}
            disabled={busy}
            onChange={curve => setDraft(d => (d ? { ...d, curve } : d))}
          />
          <div className="gp-presets drv-presets">
            {Object.entries(PRESETS).map(([name, pts]) => (
              <button
                type="button"
                key={name}
                className="drv-preset"
                disabled={busy}
                onClick={() =>
                  setDraft(d =>
                    d
                      ? {
                          ...d,
                          curve: pts.map(([f, o]) => ({
                            travelMm: Math.round(f * travelMm * 100) / 100,
                            output: o
                          }))
                        }
                      : d
                  )
                }
              >
                <svg viewBox="0 0 60 44" aria-hidden="true">
                  <polyline
                    points={pts.map(([x, y]) => `${4 + 52 * x},${40 - 36 * y}`).join(' ')}
                  />
                </svg>
                {name}
              </button>
            ))}
          </div>
        </section>
        <section className="drv-panel">
          <h3>Behaviour</h3>
          {(
            [
              [
                'keyboardEnabled',
                'Keyboard keeps working',
                'Unmapped keys still type while the gamepad is on.'
              ],
              [
                'gamepadOverride',
                'Mapped keys only drive the gamepad',
                'A key mapped to a button stops sending its keyboard key.'
              ],
              [
                'squareJoystick',
                'Square stick',
                'Diagonals reach the corners instead of a circle.'
              ],
              [
                'snappyJoystick',
                'Snappy stick',
                'When opposite directions are both held, the deeper one wins instead of cancelling.'
              ]
            ] as const
          ).map(([key, label, hint]) => (
            <div key={key} className="drv-field drv-field-row">
              <span>
                {label}
                <small className="drv-muted"> {hint}</small>
              </span>
              <Toggle
                label={label}
                checked={draft[key]}
                disabled={busy}
                onChange={on => setDraft(d => (d ? { ...d, [key]: on } : d))}
              />
            </div>
          ))}
          <h3>Tester</h3>
          <Tester />
        </section>
      </div>

      <SaveBar
        dirty={dirty}
        busy={busy}
        onDiscard={() => saved && setDraft(structuredClone(saved))}
        onSave={async () => {
          const next = draft;
          const ok = await run('Writing gamepad settings', () => driver.setGamepad!(profile, next));
          if (ok) setSaved(structuredClone(next));
        }}
      />
    </div>
  );
}
