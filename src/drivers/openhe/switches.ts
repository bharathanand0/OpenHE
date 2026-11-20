/**
 * Switches the OpenHE firmware can be told about. The firmware stores only the
 * catalog id with each switch profile, so these ids are part of the protocol:
 * never renumber them, only add.
 *
 * Travel values are starting points; the Switch Selector lets you tune travel
 * and curve per switch, and the tuned values are what the board uses.
 */

import type { SwitchCatalogEntry } from '../types';

export type OpenHESwitch = SwitchCatalogEntry & { catalogId: number };

export const OPENHE_SWITCHES: readonly OpenHESwitch[] = [
  {
    catalogId: 0,
    id: 'generic',
    name: 'Generic magnetic',
    brand: 'Generic',
    travelMm: 4,
    tunable: true
  },
  {
    catalogId: 1,
    id: 'gravastar-ufo',
    name: 'Gravastar UFO',
    brand: 'Gravastar',
    travelMm: 4,
    tunable: true
  },
  {
    catalogId: 2,
    id: 'skyloong-crystal-blue',
    name: 'Skyloong Crystal Blue',
    brand: 'Skyloong',
    travelMm: 4,
    tunable: true
  }
];

export function switchByCatalogId(id: number): OpenHESwitch {
  return OPENHE_SWITCHES.find(s => s.catalogId === id) ?? OPENHE_SWITCHES[0];
}
