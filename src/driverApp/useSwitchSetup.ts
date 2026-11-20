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
import type { KeyboardDriver, SwitchCatalogEntry, SwitchSetup } from '../drivers/types';
import ufoFront from '../assets/switches/ufo-front.webp';
import ufoTop from '../assets/switches/ufo-top.webp';
import crystalBlueFront from '../assets/switches/crystal-blue-front.webp';
import crystalBlueTop from '../assets/switches/crystal-blue-top.webp';
import ttcKomFront from '../assets/switches/ttc-kom-front.webp';
import ttcKomTop from '../assets/switches/ttc-kom-top.webp';
import type { HeroDeviceModelId } from '../keyboard/devices';

/** Pictures for OpenHE's own switches, recoloured from OpenAula's clear switch (scripts/switch-recolor.py). */
const OWN_IMAGES: Record<string, { front: string; top: string }> = {
  'gravastar-ufo': { front: ufoFront, top: ufoTop },
  'skyloong-crystal-blue': { front: crystalBlueFront, top: crystalBlueTop }
};
/** OpenAula pictures for the other OpenHE catalog entries. */
const PHOTO: Record<string, SwitchTone> = {
  generic: 'black' as SwitchTone,
  unset: 'white' as SwitchTone
};
/** Switches known by name (RongYuan's vendor lists). */
const BY_NAME: Array<[RegExp, { front?: string; top?: string }]> = [
  [/jade\s*(pro|gaming)/i, SWITCH_IMAGES['jade-pro' as SwitchTone] ?? {}],
  // TTC KOM is sold as "Magneto"; "Magneto PRO" is a different switch
  [/^\s*magneto\s*$/i, { front: ttcKomFront, top: ttcKomTop }]
];
const ACCENT: Record<string, string> = {
  generic: '#5b6268',
  'gravastar-ufo': '#8b5cf6',
  'skyloong-crystal-blue': '#5fd3bd',
  unset: '#9ba3a8'
};

function imagesFor(c: SwitchCatalogEntry) {
  if (OWN_IMAGES[c.id]) return OWN_IMAGES[c.id];
  if (PHOTO[c.id]) return SWITCH_IMAGES[PHOTO[c.id]] ?? {};
  const named = BY_NAME.find(([re]) => re.test(c.name))?.[1];
  // anything else: the plain clear switch
  return named ?? SWITCH_IMAGES['clear' as SwitchTone] ?? {};
}

const accentFor = (c: SwitchCatalogEntry) =>
  ACCENT[c.id] ??
  (/jade/i.test(c.name) ? '#3fbf8f' : /^\s*magneto\s*$/i.test(c.name) ? '#e0222c' : '#9ba3a8');

export const switchOptionId = (catalogId: string) => `drv:${catalogId}` as SwitchTone;
export const catalogIdOf = (optionId: string) => optionId.replace(/^drv:/, '');

export function useSwitchSetup(driver: KeyboardDriver, model: HeroDeviceModelId) {
  const catalog = useMemo(() => driver.switchCatalog?.() ?? [], [driver]);
  const [saved, setSaved] = useState<SwitchSetup | null>(null);
  const [draft, setDraft] = useState<SwitchSetup | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: SwitchOption[] = useMemo(
    () =>
      catalog.map(c => {
        const tuning = draft?.tuning[c.id];
        const travel = tuning?.travelMm ?? c.travelMm;
        return {
          id: switchOptionId(c.id),
          name: c.name,
          fullName: c.name,
          brand: c.brand,
          accent: accentFor(c),
          note: c.tunable
            ? `${travel.toFixed(2)} mm travel`
            : c.id === 'unset'
              ? 'Left as it is'
              : '',
          travelMm: travel,
          ...imagesFor(c)
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
