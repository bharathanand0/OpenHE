import { useEffect, useMemo, useState } from 'react';
import type { KeyActuation, KeyboardDriver } from '../drivers/types';

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
