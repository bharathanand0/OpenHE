/**
 * OpenAula library macros (key-name events with a delay before each) as
 * driver macro steps (keycode actions with a delay after each).
 */

import catalog from '../protocol/hero68/macroCatalog.json';
import { uiHid, uiMouseButton, type UiKeycode } from '../drivers/keycodes';
import type { AdvancedKey, MacroStep } from '../drivers/types';
import type { MacroDefinition } from '../state/macros';

/** Longest delay one step stores (13 bits on OpenHE firmware). */
export const MACRO_STEP_MAX_DELAY_MS = 8191;

const MOUSE: Record<string, number> = {
  MouseKey0: 1,
  MouseKey1: 2,
  MouseKey2: 3,
  MouseKey3: 4,
  MouseKey4: 5
};
const USAGE = new Map(catalog.map(a => [a.name, a.value]));

export function macroKeycode(name: string): UiKeycode | null {
  if (name in MOUSE) return uiMouseButton(MOUSE[name]);
  const usage = USAGE.get(name);
  return usage ? uiHid(usage) : null;
}

/** Steps for a library macro; keys the board cannot send are reported. */
export function macroToSteps(macro: MacroDefinition): { steps: MacroStep[]; unknown: string[] } {
  const steps: MacroStep[] = [];
  const unknown: string[] = [];
  const events = macro.events;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const keycode = macroKeycode(ev.key);
    const wait = Math.min(Math.max(events[i + 1]?.delayMs ?? 0, 0), MACRO_STEP_MAX_DELAY_MS);
    if (keycode === null) {
      if (!unknown.includes(ev.key)) unknown.push(ev.key);
      // keep the timing: fold the wait into the previous step
      if (steps.length) {
        const prev = steps[steps.length - 1];
        prev.delayMs = Math.min(prev.delayMs + wait, MACRO_STEP_MAX_DELAY_MS);
      }
      continue;
    }
    const prev = steps[steps.length - 1];
    // a press released straight away is one tap step
    if (
      ev.type === 'up' &&
      prev?.action === 'press' &&
      prev.keycode === keycode &&
      prev.delayMs === 0
    ) {
      prev.action = 'tap';
      prev.delayMs = wait;
      continue;
    }
    steps.push({ keycode, action: ev.type === 'down' ? 'press' : 'release', delayMs: wait });
  }
  return { steps, unknown };
}

export function macroAdvancedKey(
  macro: MacroDefinition,
  layer: number,
  key: number
): Extract<AdvancedKey, { kind: 'macro' }> {
  return {
    kind: 'macro',
    layer,
    key,
    steps: macroToSteps(macro).steps,
    mode: macro.playback,
    repeat: Math.min(Math.max(macro.repeatCount, 1), 255),
    name: macro.name
  };
}

/** Name a macro read from the board after the library macro with the same steps. */
export function nameMacros(
  keys: AdvancedKey[],
  library: readonly MacroDefinition[]
): AdvancedKey[] {
  if (!library.length) return keys;
  const bySteps = new Map(library.map(m => [JSON.stringify(macroToSteps(m).steps), m.name]));
  return keys.map(ak =>
    ak.kind === 'macro' && !ak.name
      ? { ...ak, name: bySteps.get(JSON.stringify(ak.steps)) ?? ak.name }
      : ak
  );
}
