import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'

async function bundle(path) {
  const build = await rolldown({ input: path })
  try {
    const { output } = await build.generate({ format: 'esm' })
    return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
  } finally { await build.close() }
}

const { LibhmkDriver, layoutFromMetadata } = await bundle('src/drivers/libhmk/driver.ts')
const kc = await bundle('src/drivers/libhmk/keycodes.ts')
const ui = await bundle('src/drivers/keycodes.ts')

const metadataJson = readFileSync('tests/fixtures/libhmk-gk68-metadata.json')
const metadata = JSON.parse(metadataJson)

/**
 * A libhmk board in software, following src/commands.c of firmware 0x0108:
 * same struct layouts, same COMMAND_VERIFY checks, same staged-write rules.
 */
function fakeLibhmk(md = metadata) {
  const gz = gzipSync(Buffer.from(JSON.stringify(md)))
  const N = md.numKeys, P = md.numProfiles, L = md.numLayers
  const dks = md.numDynamicKeystrokeMaxBindings
  const akSize = 3 + Math.max(3, 2 * dks + 1, 5)
  const profiles = Array.from({ length: P }, () => ({
    keymap: Array.from({ length: L }, () => new Uint8Array(N)),
    actuation: new Uint8Array(N * 4).map((_, i) => (i % 4 === 0 ? 128 : 0)),
    advanced: new Uint8Array(akSize * md.numAdvancedKeys)
  }))
  const staged = { id: 0, profile: 0, offset: 0, buf: new Uint8Array(akSize) }
  const log = []
  const handle = req => {
    const cmd = req[0]
    const out = new Uint8Array(64)
    out[0] = cmd
    const fail = () => { out[0] = 0xff; return out }
    const p = profiles[req[1]]
    switch (cmd) {
      case 0: out[1] = 0x08; out[2] = 0x01; break
      case 8: out[1] = 2; break
      case 13: {
        const off = req[1] | (req[2] << 8) | (req[3] << 16) | (req[4] << 24)
        if (off >= gz.length) return fail()
        const len = gz.length - off
        out.set([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, len >>> 24], 1)
        out.set(gz.subarray(off, off + Math.min(59, len)), 5)
        break
      }
      case 14: out.set(Buffer.from('GK68-TEST'), 1); break
      case 5: {
        const off = req[1]; if (off >= N) return fail()
        for (let i = 0; i < 21 && off + i < N; i++) {
          const v = 2600 + off + i; out[1 + i * 3] = v & 0xff; out[2 + i * 3] = v >> 8; out[3 + i * 3] = (off + i) % 256
        }
        break
      }
      case 128: {
        const [, prof, layer, off] = req
        if (prof >= P || layer >= L || off >= N) return fail()
        out.set(profiles[prof].keymap[layer].subarray(off, off + 63), 1)
        break
      }
      case 129: {
        const [, prof, layer, off, len] = req
        if (prof >= P || layer >= L || off >= N || len > 59 || len > N - off) return fail()
        profiles[prof].keymap[layer].set(req.subarray(5, 5 + len), off)
        break
      }
      case 130: {
        const [, prof, off] = req
        if (prof >= P || off >= N) return fail()
        out.set(p.actuation.subarray(off * 4, (off + 15) * 4), 1)
        break
      }
      case 131: {
        const [, prof, off, len] = req
        if (prof >= P || off >= N || len > 15 || len > N - off) return fail()
        profiles[prof].actuation.set(req.subarray(4, 4 + len * 4), off * 4)
        break
      }
      case 132: {
        if (req[1] >= P) return fail()
        const off = req[2] | (req[3] << 8)
        if (off >= p.advanced.length) return fail()
        const len = Math.min(62, p.advanced.length - off)
        out[1] = len
        out.set(p.advanced.subarray(off, off + len), 2)
        break
      }
      case 133: {
        const prof = req[1]; if (prof >= P) return fail()
        const off = req[2] | (req[3] << 8), len = req[4]
        const field = profiles[prof].advanced
        if (off + len > field.length || len > 59 || len === 0) return fail()
        if (off % akSize === 0) Object.assign(staged, { id: 1, profile: prof, offset: off })
        if (staged.id !== 1 || staged.offset !== off || staged.profile !== prof) return fail()
        for (let i = 0; i < len;) {
          const cur = staged.offset % akSize
          const w = Math.min(len - i, akSize - cur)
          staged.buf.set(req.subarray(5 + i, 5 + i + w), cur)
          if (len - i >= akSize - cur) field.set(staged.buf, staged.offset - cur)
          staged.offset += w; i += w
        }
        break
      }
      case 4: log.push('recalibrate'); break
      default: return fail()
    }
    return out
  }
  const transport = {
    sent: 0,
    async exchange(report) {
      assert.equal(report.length, 64)
      this.sent++
      return handle(report)
    },
    async close() {}
  }
  return { transport, profiles, log, akSize }
}

const usb = { vendorId: 0x3151, productId: 0x5030, productName: 'GK68' }

test('connect reads version, serial and the gzipped metadata', async () => {
  const { transport } = fakeLibhmk()
  const d = await LibhmkDriver.connect(transport, usb)
  assert.equal(d.info.name, 'GK68')
  assert.equal(d.info.firmwareVersion, '1.8')
  assert.equal(d.info.serial, 'GK68-TEST')
  assert.equal(d.capabilities.profiles, 4)
  assert.equal(d.capabilities.layers, 4)
  assert.equal(d.capabilities.maxAdvancedKeys, 32)
  assert.deepEqual(d.capabilities.pollingRates, [8000, 1000])
  assert.equal(d.layout.keys.length, 68)
})

test('layout comes from the metadata, legends from the default keymap', () => {
  const layout = layoutFromMetadata(metadata)
  const byIndex = i => layout.keys.find(k => k.index === i)
  assert.equal(byIndex(0).label, 'Esc')
  assert.equal(byIndex(13).label, 'Bksp')
  assert.equal(byIndex(13).w, 2)
  assert.equal(byIndex(14).x, 15) // Ins after 13 1U keys + 2U backspace
  assert.equal(byIndex(61).label, 'Space')
  assert.equal(byIndex(61).w, 6.25)
  assert.equal(byIndex(63).label, 'Fn') // MO(1)
  assert.equal(layout.width, 16)
  assert.equal(layout.height, 5)
})

test('keymap round-trips through the board in UI keycodes', async () => {
  const { transport, profiles } = fakeLibhmk()
  const d = await LibhmkDriver.connect(transport, usb)
  const def = d.defaultKeymap(0)
  assert.equal(def.length, 68)
  assert.equal(def[0], 0x29) // Esc as HID usage
  assert.equal(def[16], 0x14) // Q
  assert.equal(def[63], ui.uiMomentaryLayer(1))
  await d.setKeymap(1, 0, def)
  assert.equal(profiles[1].keymap[0][0], 0x27) // libhmk KC_ESCAPE
  assert.equal(profiles[1].keymap[0][63], 0xc1) // MO(1)
  assert.deepEqual(await d.getKeymap(1, 0), def)

  const fn = d.defaultKeymap(1)
  assert.equal(fn[52], ui.uiConsumer(0xea)) // Fn+, = volume down
  assert.equal(fn[16], ui.uiNative(0x01)) // transparent stays native
  await d.setKeymap(0, 1, fn)
  assert.deepEqual(await d.getKeymap(0, 1), fn)
})

test('keycodes the board cannot express are refused before anything is written', async () => {
  const { transport, profiles } = fakeLibhmk()
  const d = await LibhmkDriver.connect(transport, usb)
  const map = d.defaultKeymap(0)
  map[5] = 0x10600 // Ctrl+C combo, libhmk has no combos
  await assert.rejects(d.setKeymap(0, 0, map), /not available on libhmk/)
  assert.equal(profiles[0].keymap[0][0], 0)
})

test('actuation converts between millimetres and 0..255 units', async () => {
  const { transport, profiles } = fakeLibhmk()
  const d = await LibhmkDriver.connect(transport, usb)
  const before = await d.getActuation(0)
  assert.equal(before.length, 68)
  assert.ok(Math.abs(before[0].actuationMm - 2.008) < 0.01)
  const next = before.map((a, i) => ({ ...a, actuationMm: i === 40 ? 0.4 : 1.2, rtPressMm: 0.1, rtReleaseMm: 0.15, continuous: i === 40 }))
  await d.setActuation(2, next)
  const raw = profiles[2].actuation
  assert.deepEqual([...raw.subarray(40 * 4, 41 * 4)], [26, 6, 10, 1])
  assert.deepEqual([...raw.subarray(0, 4)], [77, 6, 10, 0])
  const back = await d.getActuation(2)
  assert.ok(Math.abs(back[40].actuationMm - 0.4) < d.capabilities.travelStepMm)
  assert.equal(back[40].continuous, true)
})

test('advanced keys survive the staged write protocol', async () => {
  const { transport, profiles, akSize } = fakeLibhmk()
  const d = await LibhmkDriver.connect(transport, usb)
  assert.equal(akSize, 12)
  const keys = [
    { kind: 'nullBind', layer: 0, key: 31, secondaryKey: 33, behavior: 'last', bottomOutMm: 0 },
    { kind: 'tapHold', layer: 0, key: 30, tap: 0x29, hold: 0x10000, tappingTermMs: 200, holdOnOtherKeyPress: true },
    { kind: 'toggle', layer: 1, key: 2, keycode: 0x1e, tappingTermMs: 180 },
    {
      kind: 'dynamicKeystroke', layer: 0, key: 16, keycodes: [0x14, 0x1a, 0, 0],
      actions: [['press', 'hold', 'release', 'tap'], ['tap', 'tap', 'tap', 'tap'], ['hold', 'hold', 'hold', 'hold'], ['hold', 'hold', 'hold', 'hold']],
      bottomOutMm: 3.5
    },
    { kind: 'macro', layer: 0, key: 5, macro: 3 }
  ]
  await d.setAdvancedKeys(3, keys)
  // the whole 32-entry table was written (staging must commit every item)
  assert.equal(profiles[3].advanced[1 * akSize + 2], 3) // tap-hold type
  const back = await d.getAdvancedKeys(3)
  assert.equal(back.length, 5)
  assert.deepEqual(back[0], keys[0])
  assert.deepEqual(back[1], keys[1])
  assert.deepEqual(back[2], keys[2])
  assert.deepEqual(back[3].actions, keys[3].actions)
  assert.deepEqual(back[3].keycodes, keys[3].keycodes)
  assert.ok(Math.abs(back[3].bottomOutMm - 3.5) < 0.02)
  assert.deepEqual(back[4], keys[4])
  await assert.rejects(d.setAdvancedKeys(0, Array(33).fill(keys[0])), /at most 32/)
})

test('travel readout pages through every key', async () => {
  const { transport, log } = fakeLibhmk()
  const d = await LibhmkDriver.connect(transport, usb)
  const before = transport.sent
  const t = await d.readTravel()
  assert.equal(transport.sent - before, 4) // 68 keys / 21 per report
  assert.equal(t.length, 68)
  assert.equal(t[67].raw, 2600 + 67)
  assert.ok(Math.abs(t[67].travelMm - (67 * 4) / 255) < 1e-9)
  await d.recalibrate()
  assert.deepEqual(log, ['recalibrate'])
})

test('a rejected command surfaces as an error', async () => {
  const { transport } = fakeLibhmk()
  const d = await LibhmkDriver.connect(transport, usb)
  await assert.rejects(d.getKeymap(9, 0), /out of range/)
  await assert.rejects(d.getKeymap(0, 9), /rejected command 128/)
})

test('every libhmk keycode maps to a UI keycode and back', () => {
  for (let code = 0; code <= 0xd4; code++) {
    if (code > 0x9f && code < 0xc0) continue
    assert.equal(kc.uiToHmk(kc.hmkToUi(code)), code, `0x${code.toString(16)}`)
  }
  assert.equal(kc.hmkToUi(0x02), 0x04) // A
  assert.equal(kc.hmkToUi(0x64), 0x68) // F13
  assert.equal(kc.hmkToUi(0x7b), 0x10000) // LCtrl, as the remap catalog writes it
  assert.equal(kc.hmkToUi(0x82), 0x800000) // RGUI
  assert.equal(kc.uiToHmk(0xe1), 0x7c) // a raw HID modifier usage is still accepted
  assert.equal(kc.hmkToUi(0x9b), 0x01010100) // left mouse, as in the remap catalog
  assert.equal(kc.hmkCodeFromName('MO(2)'), 0xc2)
  assert.equal(kc.hmkCodeFromName('KC_RIGHT_ALT'), 0x81)
})
