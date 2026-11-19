/**
 * Which app the start screen hands over to when no driver board is
 * connected: the OpenHE landing, or the original AULA app. Remembered per
 * browser so AULA owners are not asked every visit.
 */

import { useSyncExternalStore } from 'react';
import { BRAND } from './brand';

export type AppMode = 'landing' | 'aula';

const KEY = `${BRAND.storagePrefix}.openhe.mode`;
const listeners = new Set<() => void>();

function read(): AppMode {
  try {
    return localStorage.getItem(KEY) === 'aula' ? 'aula' : 'landing';
  } catch {
    return 'landing';
  }
}

let mode: AppMode = read();

export const appMode = {
  get: () => mode,
  set(next: AppMode) {
    mode = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // private window or blocked storage: the choice lasts for this visit
    }
    for (const l of listeners) l();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};

export function useAppMode(): AppMode {
  return useSyncExternalStore(appMode.subscribe, appMode.get);
}
