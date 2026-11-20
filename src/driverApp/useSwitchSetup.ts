/**
 * The board's per-key switches as OpenAula switch options, shared by the
 * Switch Selector and the actuation pages (so the travel picture shows the
 * selected key's switch).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SWITCH_IMAGES,
  setRuntimeSwitchOptions,
  type SwitchOption,
  type SwitchTone
} from '../app/switchAssets';
import type { KeyboardDriver, SwitchSetup } from '../drivers/types';
import type { HeroDeviceModelId } from '../keyboard/devices';

/** OpenAula photo to borrow for each OpenHE switch. */
const PHOTO: Record<string, SwitchTone> = {
  generic: 'black' as SwitchTone,
  'gravastar-ufo': 'clear' as SwitchTone,
  'skyloong-crystal-blue': 'blue' as SwitchTone,
  unset: 'white' as SwitchTone
};
const FALLBACK_PHOTOS = ['white', 'black', 'blue', 'clear', 'uranus', 'jade-pro'] as SwitchTone[];
const ACCENT: Record<string, string> = {
  generic: '#5b6268',
  'gravastar-ufo': '#c9b6ff',
  'skyloong-crystal-blue': '#4aa8ff',
  unset: '#9ba3a8'
};

export const switchOptionId = (catalogId: string) => `drv:${catalogId}` as SwitchTone;
export const catalogIdOf = (optionId: string) => optionId.replace(/^drv:/, '');

export function useSwitchSetup(driver: KeyboardDriver, model: HeroDeviceModelId) {
  const catalog = useMemo(() => driver.switchCatalog?.() ?? [], [driver]);
  const [saved, setSaved] = useState<SwitchSetup | null>(null);
  const [draft, setDraft] = useState<SwitchSetup | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: SwitchOption[] = useMemo(
    () =>
      catalog.map((c, i) => {
        const photo = PHOTO[c.id] ?? FALLBACK_PHOTOS[i % FALLBACK_PHOTOS.length];
        const tuning = draft?.tuning[c.id];
        const travel = tuning?.travelMm ?? c.travelMm;
        return {
          id: switchOptionId(c.id),
          name: c.name,
          fullName: c.name,
          brand: c.brand,
          accent: ACCENT[c.id] ?? '#9ba3a8',
          note: c.tunable
            ? `${travel.toFixed(2)} mm travel`
            : c.id === 'unset'
              ? 'Left as it is'
              : '',
          travelMm: travel,
          ...SWITCH_IMAGES[photo]
        };
      }),
    [catalog, draft]
  );

  // OpenAula's Switch Selector lists switchOptionsForModel(model)
  useEffect(() => {
    setRuntimeSwitchOptions(model, options);
  }, [model, options]);
  useEffect(() => () => setRuntimeSwitchOptions(null), []);

  const reload = useCallback(() => {
    if (!driver.getSwitchSetup || !catalog.length) return;
    setError(null);
    driver
      .getSwitchSetup()
      .then(s => {
        setSaved(s);
        setDraft(structuredClone(s));
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [driver, catalog.length]);
  useEffect(reload, [reload]);

  const optionOfKey = useCallback(
    (index: number): SwitchOption | undefined => {
      const id = draft?.keySwitch[index];
      return id ? options.find(o => o.id === switchOptionId(id)) : undefined;
    },
    [draft, options]
  );

  return {
    available: catalog.length > 0 && !!driver.setSwitchSetup,
    catalog,
    options,
    saved,
    draft,
    setDraft,
    setSaved,
    error,
    reload,
    optionOfKey,
    dirty: !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved)
  };
}

export type SwitchSetupState = ReturnType<typeof useSwitchSetup>;
