import { useCallback, useEffect, useState } from 'react';
import { Activity, Gauge, Keyboard, Layers, Loader2, Plug, Settings } from 'lucide-react';
import logo from '../assets/openhero68-logo.png';
import { BRAND } from '../brand';
import type { KeyboardDriver } from '../drivers/types';
import { AdvancedKeysPage } from './AdvancedKeysPage';
import { DevicePage } from './DevicePage';
import { PerformancePage } from './PerformancePage';
import { RemapPage } from './RemapPage';
import { driverConnection } from './store';
import { TravelPage } from './TravelPage';

type Page = 'performance' | 'remap' | 'advanced' | 'travel' | 'device';

/** Workspace for boards behind the driver layer (libhmk, RongYuan). */
export function DriverApp({ driver }: { driver: KeyboardDriver }) {
  const caps = driver.capabilities;
  const confirmable = driver as KeyboardDriver & { needsLayoutConfirmation?: boolean };
  const [page, setPage] = useState<Page>(
    confirmable.needsLayoutConfirmation ? 'device' : caps.actuation ? 'performance' : 'remap'
  );
  const [profile, setProfile] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [, setLayoutConfirmed] = useState(0);

  useEffect(() => {
    driver
      .getProfile()
      .then(setProfile)
      .catch(() => setProfile(0));
  }, [driver]);

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setStatus(null);
    try {
      await task();
      setStatus({ kind: 'ok', text: `${label.replace(/^Writing/, 'Saved')} — done.` });
      return true;
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const nav: Array<{ id: Page; label: string; icon: typeof Gauge; show: boolean }> = [
    { id: 'performance', label: 'Actuation & RT', icon: Gauge, show: caps.actuation },
    { id: 'remap', label: 'Key remap', icon: Keyboard, show: true },
    {
      id: 'advanced',
      label: 'Advanced keys',
      icon: Layers,
      show: caps.advancedKeys.length > 0 && !!driver.getAdvancedKeys
    },
    { id: 'travel', label: 'Live travel', icon: Activity, show: caps.travelStream },
    { id: 'device', label: 'Device', icon: Settings, show: true }
  ];

  return (
    <div className="drv-shell">
      <aside className="drv-sidebar">
        <div className="drv-brand">
          <img src={logo} alt="" />
          <strong>{BRAND.displayName}</strong>
        </div>
        <div className="drv-device">
          <span className="device-status-dot" aria-hidden="true" />
          <div>
            <b>{driver.info.name}</b>
            <small>
              {driver.id === 'libhmk' ? 'libhmk' : 'RongYuan'} · fw {driver.info.firmwareVersion}
            </small>
          </div>
        </div>
        <nav className="drv-nav">
          {nav
            .filter(n => n.show)
            .map(n => (
              <button
                type="button"
                key={n.id}
                className={`drv-nav-item${page === n.id ? ' is-active' : ''}`}
                onClick={() => setPage(n.id)}
                disabled={!!busy}
              >
                <n.icon size={18} />
                <span>{n.label}</span>
              </button>
            ))}
        </nav>
        <button
          type="button"
          className="ghost-button drv-disconnect"
          disabled={!!busy}
          onClick={() => void driverConnection.disconnect()}
        >
          <Plug size={16} /> Disconnect
        </button>
      </aside>
      <main className="drv-main">
        <header className="drv-topbar">
          <label className="drv-profile">
            Profile
            <select
              value={profile ?? 0}
              disabled={profile === null || !!busy}
              onChange={async e => {
                const next = Number(e.target.value);
                if (caps.actuationActiveProfileOnly) {
                  const setter = (
                    driver as KeyboardDriver & { setProfile?: (p: number) => Promise<void> }
                  ).setProfile;
                  if (setter && !(await run('Switching profile', () => setter.call(driver, next))))
                    return;
                }
                setProfile(next);
              }}
            >
              {Array.from({ length: caps.profiles }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
          <div className={`drv-status${status ? ` is-${status.kind}` : ''}`}>
            {busy ? (
              <>
                <Loader2 size={16} className="rotate" /> {busy}…
              </>
            ) : (
              status?.text
            )}
          </div>
        </header>
        <div className="drv-content">
          {profile === null ? (
            <div className="drv-notice">Connecting…</div>
          ) : page === 'performance' ? (
            <PerformancePage driver={driver} profile={profile} busy={!!busy} run={run} />
          ) : page === 'remap' ? (
            <RemapPage driver={driver} profile={profile} busy={!!busy} run={run} />
          ) : page === 'advanced' ? (
            <AdvancedKeysPage driver={driver} profile={profile} busy={!!busy} run={run} />
          ) : page === 'travel' ? (
            <TravelPage driver={driver} />
          ) : (
            <DevicePage
              driver={driver}
              busy={!!busy}
              run={run}
              onLayoutConfirmed={() => setLayoutConfirmed(n => n + 1)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
