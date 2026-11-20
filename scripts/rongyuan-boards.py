#!/usr/bin/env python3
"""Regenerate the RongYuan board data from a sharkfin checkout (GPL-3.0).

    python3 scripts/rongyuan-boards.py ../sharkfin

Writes src/drivers/rongyuan/data/devices.json (magnetic boards only, trimmed)
and light-layouts.json (the vendor light tables those boards name). The
LEDPARAM flag order follows sharkfin's registry: a hand record's
ledFlagsSwapped, else the board's firmware (led-flags.json), else the
vendor driver (led-flags.vendor.json); rainbow on 7 means swapped.
"""

import json
import sys
from pathlib import Path

SWAPPED_RAINBOW = 7


def main(sharkfin: Path) -> None:
    data = sharkfin / 'app/src-tauri/data'
    out = Path(__file__).resolve().parent.parent / 'src/drivers/rongyuan/data'
    devices = json.loads((data / 'devices.json').read_text())
    lights = json.loads((data / 'light-layouts.json').read_text())
    firmware = json.loads((data / 'led-flags.json').read_text())
    vendor = json.loads((data / 'led-flags.vendor.json').read_text())

    boards, used = [], set()
    for d in devices:
        if not d.get('magnetic'):
            continue
        rec = {k: d[k] for k in ('id', 'displayName', 'company', 'vendorId', 'productId',
                                 'internalName', 'keyLayout', 'profiles', 'family')}
        if d.get('switchTypes'):
            rec['switchTypes'] = d['switchTypes']
        if d.get('travel'):
            rec['travel'] = d['travel']
        if d.get('lightLayout') in lights:
            rec['light'] = d['lightLayout']
            used.add(d['lightLayout'])
        key = str(d['id'])
        flags = firmware.get(key) or vendor.get(key)
        if d.get('ledFlagsSwapped') or (flags and flags.get('rainbow') == SWAPPED_RAINBOW):
            rec['ledFlagsSwapped'] = True
        features = d.get('features', {})
        if features.get('sideLight'):
            rec['sideLight'] = True
        if features.get('debounce'):
            rec['debounce'] = True
        boards.append(rec)

    (out / 'devices.json').write_text(json.dumps(boards, separators=(',', ':')) + '\n')
    (out / 'light-layouts.json').write_text(
        json.dumps({k: lights[k] for k in sorted(used)}, separators=(',', ':')) + '\n')
    print(f'{len(boards)} boards, {len(used)} light tables')


if __name__ == '__main__':
    main(Path(sys.argv[1] if len(sys.argv) > 1 else '../sharkfin'))
