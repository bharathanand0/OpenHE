import type { KeyboardDriver } from '../drivers/types';

const ISSUES = 'https://github.com/camaro2626/OpenHE/issues';

const TOPICS: Array<{ q: string; a: string; only?: KeyboardDriver['id'] }> = [
  {
    q: 'The keyboard does not show up when I click Connect',
    a: 'Use Chrome or Edge on a desktop and plug the keyboard in by cable. Close the vendor software, hmkconf, VIA or any other configurator first: only one app can own the settings channel. On Linux, the keyboard needs a udev rule before the browser may open it; replug after adding it.'
  },
  {
    q: 'My changes did nothing',
    a: 'Changes are kept as a draft until you press Save to keyboard in the top bar (or Ctrl+S). Switching profile in the sidebar with unsaved changes discards them.'
  },
  {
    q: 'What do actuation and rapid trigger mean?',
    a: 'Actuation is how far a key travels before it registers. With rapid trigger, a key releases as soon as it moves up by the release sensitivity and presses again as soon as it moves down by the press sensitivity, anywhere in its travel, which helps fast repeated taps and strafing.'
  },
  {
    q: 'What is a null bind (SOCD)?',
    a: 'Two keys that cancel each other, usually A and D. You choose which one wins when both are held: the last pressed, either key, neither, or the one pressed deeper.'
  },
  {
    q: 'The gamepad does not appear in games',
    a: 'Turn on the gamepad interface (Gamepad page or Settings), then restart or replug the keyboard: the controller interface is only added when the keyboard connects. Only the base layer drives the gamepad, and only over the cable.',
    only: 'openhe'
  },
  {
    q: 'Keys feel off after flashing or swapping switches',
    a: 'Use Settings > Calibration > Recalibrate with every key released, then press each key all the way down once.',
    only: 'openhe'
  },
  {
    q: 'Why are switch settings read-only on my board?',
    a: 'Switch settings are written only on RongYuan firmware lines whose write path has been verified (ry5088 and yc3121). Other boards can be read safely; writing them blind could change the wrong setting.',
    only: 'rongyuan'
  },
  {
    q: 'The picture of my keyboard looks wrong',
    a: 'For some RongYuan boards the picture is matched against the keyboard’s keymap. If it is wrong, do not confirm it on the Device page, and open an issue with the board name and firmware version shown in the sidebar.',
    only: 'rongyuan'
  }
];

export function HelpPage({ driver }: { driver: KeyboardDriver }) {
  return (
    <div className="page settings-page page-enter">
      <div className="settings-hero general-settings-hero">
        <div>
          <h1>Help</h1>
          <p>Common questions for {driver.info.name}.</p>
        </div>
      </div>
      <div className="general-settings-stack">
        <div className="wooting-settings-card">
          {TOPICS.filter(t => !t.only || t.only === driver.id).map((t, i) => (
            <div key={t.q} className={`device-setting-section${i === 0 ? ' first' : ''}`}>
              <div className="device-setting-copy">
                <h2>{t.q}</h2>
                <p>{t.a}</p>
              </div>
            </div>
          ))}
          <div className="device-setting-section">
            <div className="device-setting-copy">
              <h2>Still stuck, or something looks wrong?</h2>
              <p>
                Open an issue on <a href={ISSUES}>GitHub</a> with the keyboard name and firmware
                version ({driver.info.name}, {driver.info.firmwareVersion}) and what you saw.
                Reports from real boards are what makes OpenHE better.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
