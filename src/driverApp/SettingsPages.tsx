import { useEffect, useState } from 'react';
import { Toggle } from '../app/components/Toggle';
import type { CalibrationSettings, DeviceOptions, KeyboardDriver } from '../drivers/types';

type Run = (label: string, task: () => Promise<void>) => Promise<boolean>;

function Hero({ title, text }: { title: string; text: string }) {
  return (
    <div className="settings-hero general-settings-hero">
      <div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Section({
  title,
  text,
  hint,
  first,
  toggle,
  children
}: {
  title: string;
  text?: string;
  hint?: string;
  first?: boolean;
  toggle?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`device-setting-section${first ? ' first' : ''}${toggle ? ' toggle-setting-section' : ''}`}
    >
      <div className="device-setting-copy">
        <h2>{title}</h2>
        {text && <p>{text}</p>}
        {hint && <p className="device-setting-hint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** Polling rate, gamepad interface and advanced-key timing. */
export function GeneralSettingsPage({
  driver,
  profile,
  busy,
  run
}: {
  driver: KeyboardDriver;
  profile: number;
  busy: boolean;
  run: Run;
}) {
  const [options, setOptions] = useState<DeviceOptions | null>(null);
  const [tick, setTick] = useState<number | null>(null);
  const [reconnect, setReconnect] = useState(false);

  useEffect(() => {
    driver
      .getOptions?.()
      .then(setOptions)
      .catch(() => setOptions({}));
  }, [driver]);
  useEffect(() => {
    driver
      .getTickRate?.(profile)
      .then(setTick)
      .catch(() => setTick(null));
  }, [driver, profile]);

  const setOpt = async (patch: DeviceOptions, label: string) => {
    if (await run(label, () => driver.setOptions!(patch))) {
      setOptions(o => ({ ...o, ...patch }));
      setReconnect(true);
    }
  };
  const nothing = !driver.setOptions && !driver.setTickRate;

  return (
    <div className="page settings-page general-device-settings page-enter">
      <Hero
        title="General Settings"
        text={`Device-wide settings for ${driver.info.name}, read from the keyboard.`}
      />
      <div className="general-settings-stack">
        <div className="wooting-settings-card">
          {nothing && (
            <Section
              first
              title="Nothing to set"
              text="This keyboard has no device-wide settings OpenHE can change yet."
            />
          )}
          {options?.highPollingRate !== undefined && (
            <Section
              first
              title="Polling rate"
              text="How often the keyboard reports to the computer over the cable."
              hint="Takes effect after the keyboard reconnects."
            >
              <div className="device-option-list polling-options">
                {[
                  [true, '8000 Hz', 'Lowest latency'],
                  [false, '1000 Hz', 'Most compatible']
                ].map(([on, label, note]) => (
                  <button
                    type="button"
                    key={String(on)}
                    className={`device-option-row ${options.highPollingRate === on ? 'is-selected' : ''}`}
                    disabled={busy}
                    onClick={() =>
                      setOpt({ highPollingRate: on as boolean }, 'Setting the polling rate')
                    }
                  >
                    <span className="device-radio-dot" aria-hidden="true" />
                    <span>{label as string}</span>
                    <small>{note as string}</small>
                  </button>
                ))}
              </div>
            </Section>
          )}
          {options?.xinput !== undefined && (
            <Section
              toggle
              title="Gamepad interface"
              text="Adds an Xbox (XInput) controller interface; map keys to it on the Gamepad page."
              hint="Takes effect after the keyboard reconnects."
            >
              <Toggle
                label="Gamepad interface"
                checked={options.xinput}
                disabled={busy}
                onChange={on =>
                  setOpt({ xinput: on }, on ? 'Turning the gamepad on' : 'Turning the gamepad off')
                }
              />
            </Section>
          )}
          {tick !== null && driver.setTickRate && (
            <Section
              title="Advanced key timing"
              text={`Tick rate for profile ${profile + 1}: how many key-scan ticks advanced-key presses and taps wait before they are sent, which is also how long a tap is held. Lower is faster; some games miss very short taps.`}
              hint="Default: 30."
            >
              <span className="drv-term">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={tick}
                  disabled={busy}
                  onChange={e => setTick(Number(e.target.value))}
                />
                <b>{tick}</b>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => run('Saving tick rate', () => driver.setTickRate!(profile, tick))}
                >
                  Apply
                </button>
              </span>
            </Section>
          )}
          {reconnect && driver.reboot && (
            <Section
              toggle
              title="Restart to apply"
              text="Interface and polling changes apply once the keyboard reconnects."
            >
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => run('Restarting the keyboard', () => driver.reboot!())}
              >
                Restart keyboard
              </button>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Reset or copy on-board profiles. */
export function ProfilesSettingsPage({
  driver,
  profile,
  busy,
  run
}: {
  driver: KeyboardDriver;
  profile: number;
  busy: boolean;
  run: Run;
}) {
  const n = driver.capabilities.profiles;
  const [from, setFrom] = useState(profile === 0 ? Math.min(1, n - 1) : 0);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="page settings-page page-enter">
      <Hero
        title="Profiles"
        text={`${driver.info.name} keeps ${n} profiles on the keyboard. These act on profile ${profile + 1}, the one picked in the sidebar.`}
      />
      <div className="general-settings-stack">
        <div className="wooting-settings-card">
          {driver.duplicateProfile && n > 1 && (
            <Section
              first
              title={`Copy into profile ${profile + 1}`}
              text="Replaces everything in this profile (keymap, actuation, advanced keys, gamepad) with another profile's."
            >
              <span className="drv-term">
                <select
                  className="drv-select"
                  value={from}
                  onChange={e => setFrom(Number(e.target.value))}
                >
                  {Array.from({ length: n }, (_, i) =>
                    i === profile ? null : (
                      <option key={i} value={i}>
                        From profile {i + 1}
                      </option>
                    )
                  )}
                </select>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    run(`Copying profile ${from + 1}`, () =>
                      driver.duplicateProfile!(profile, from)
                    )
                  }
                >
                  Copy
                </button>
              </span>
            </Section>
          )}
          {driver.resetProfile && (
            <Section
              title={`Reset profile ${profile + 1}`}
              text="Back to the keyboard's defaults for this profile only. Other profiles are not touched."
            >
              {confirm ? (
                <span className="drv-toolbar-actions">
                  <button type="button" className="ghost-button" onClick={() => setConfirm(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="secondary-button is-danger"
                    disabled={busy}
                    onClick={async () => {
                      setConfirm(false);
                      await run(`Resetting profile ${profile + 1}`, () =>
                        driver.resetProfile!(profile)
                      );
                    }}
                  >
                    Reset profile {profile + 1}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setConfirm(true)}
                >
                  Reset…
                </button>
              )}
            </Section>
          )}
          {!driver.resetProfile && !driver.duplicateProfile && (
            <Section
              first
              title="Nothing to manage"
              text="This keyboard does not expose profile copy or reset."
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Calibration starting values, learned values, recalibrate. */
export function CalibrationSettingsPage({
  driver,
  busy,
  run
}: {
  driver: KeyboardDriver;
  busy: boolean;
  run: Run;
}) {
  const [cal, setCal] = useState<CalibrationSettings | null>(null);
  const [savedCal, setSavedCal] = useState<CalibrationSettings | null>(null);
  useEffect(() => {
    driver
      .getCalibration?.()
      .then(c => {
        setCal(c);
        setSavedCal(c);
      })
      .catch(() => setCal(null));
  }, [driver]);
  const num = (label: string, key: keyof CalibrationSettings, hint: string) =>
    cal && (
      <label className="drv-cal-field">
        <span>{label}</span>
        <input
          type="number"
          min={0}
          max={65535}
          value={cal[key]}
          disabled={busy}
          onChange={e => setCal({ ...cal, [key]: Number(e.target.value) })}
        />
        <small>{hint}</small>
      </label>
    );
  return (
    <div className="page settings-page page-enter">
      <Hero
        title="Calibration"
        text="How the keyboard learns each switch's rest and bottom-out positions."
      />
      <div className="general-settings-stack">
        <div className="wooting-settings-card">
          {driver.recalibrate && (
            <Section
              first
              title="Recalibrate"
              text="Takes every key's rest position again and forgets the bottom-out positions learned so far. Release every key first, then press each key all the way down once."
            >
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => run('Recalibrating', () => driver.recalibrate!())}
              >
                Recalibrate now
              </button>
            </Section>
          )}
          {driver.saveCalibration && (
            <Section
              title="Keep learned bottom-out positions"
              text="Saves the bottom-out positions learned since the last recalibration, so keys are accurate right after a restart."
            >
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => run('Saving calibration', () => driver.saveCalibration!())}
              >
                Save current positions
              </button>
            </Section>
          )}
          {cal && driver.setCalibration && (
            <Section
              title="Starting values"
              text="Raw sensor values used before a key has been calibrated, and after a recalibration."
              hint="Raise the bottom-out threshold if keys register full travel too early after a recalibration; lower it if they never reach the bottom."
            >
              <div className="drv-cal-grid">
                {num(
                  'Initial rest value',
                  'initialRest',
                  'Set above the real rest reading so calibration settles on the real one.'
                )}
                {num(
                  'Initial bottom-out threshold',
                  'initialBottomOutThreshold',
                  'Raw change from rest that counts as fully pressed.'
                )}
              </div>
              <span className="drv-toolbar-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busy || JSON.stringify(cal) === JSON.stringify(savedCal)}
                  onClick={() => setCal(savedCal)}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || JSON.stringify(cal) === JSON.stringify(savedCal)}
                  onClick={async () => {
                    if (await run('Saving starting values', () => driver.setCalibration!(cal)))
                      setSavedCal(cal);
                  }}
                >
                  Save
                </button>
              </span>
            </Section>
          )}
          {!driver.recalibrate && !driver.setCalibration && (
            <Section
              first
              title="Not available"
              text="This keyboard calibrates itself; there is nothing to set here."
            />
          )}
        </div>
      </div>
    </div>
  );
}
