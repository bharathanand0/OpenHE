import { useMemo, useState } from 'react';
import { REMAP_CATEGORIES } from '../protocol/hero68/remap';
import type { UiKeycode } from '../drivers/keycodes';
import type { KeyboardDriver } from '../drivers/types';

export type KeycodeGroup = {
  id: string;
  label: string;
  actions: Array<{ value: UiKeycode; label: string }>;
};

/** The shared catalog filtered to what the board can store, board-specific codes first. */
export function useKeycodeGroups(driver: KeyboardDriver): KeycodeGroup[] {
  return useMemo(() => {
    const supports = (v: UiKeycode) => driver.supportsKeycode?.(v) ?? true;
    const out: KeycodeGroup[] = REMAP_CATEGORIES.map(c => ({
      id: c.id,
      label: c.label,
      actions: c.actions
        .filter(a => supports(a.value))
        .map(a => ({ value: a.value, label: a.label }))
    })).filter(c => c.actions.length);
    const extra = driver.extraKeycodes?.() ?? [];
    if (extra.length) out.unshift({ id: 'board', label: 'This board', actions: extra });
    return out;
  }, [driver]);
}

/** Category tabs and a grid of keycodes. */
export function KeycodePicker({
  driver,
  value,
  onPick,
  disabled = false,
  exclude
}: {
  driver: KeyboardDriver;
  value?: UiKeycode;
  onPick: (value: UiKeycode) => void;
  disabled?: boolean;
  /** Group ids to leave out (e.g. 'mouse'). */
  exclude?: readonly string[];
}) {
  const all = useKeycodeGroups(driver);
  const groups = exclude ? all.filter(g => !exclude.includes(g.id)) : all;
  const [category, setCategory] = useState(
    () => groups.find(g => g.id === 'basic_key')?.id ?? groups[0]?.id ?? ''
  );
  const active = groups.find(g => g.id === category) ?? groups[0];
  return (
    <>
      <div className="drv-tabs drv-tabs-small">
        {groups.map(g => (
          <button
            type="button"
            key={g.id}
            className={`drv-tab${g.id === active?.id ? ' is-active' : ''}`}
            onClick={() => setCategory(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="drv-picker-grid">
        {active?.actions.map(a => (
          <button
            type="button"
            key={`${active.id}-${a.value}-${a.label}`}
            className={`drv-pick${value === a.value ? ' is-active' : ''}`}
            disabled={disabled}
            onClick={() => onPick(a.value)}
          >
            {a.label}
          </button>
        ))}
      </div>
    </>
  );
}
