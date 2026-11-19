import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { rolldown } from 'rolldown'

async function bundle(path) {
  const build = await rolldown({ input: path })
  try {
    const { output } = await build.generate({ format: 'esm' })
    return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
  } finally { await build.close() }
}

const { RongyuanDriver } = await bundle('src/drivers/rongyuan/driver.ts')
const { Wire } = await bundle('src/drivers/rongyuan/wire.ts')
const proto = await bundle('src/drivers/rongyuan/protocol.ts')
const ui = await bundle('src/drivers/keycodes.ts')

const devices = JSON.parse(readFileSync('src/drivers/rongyuan/data/devices.json'))
const layoutFile = name => JSON.parse(readFileSync(`src/drivers/rongyuan/data/layouts/${name}.json`))
const deps = {
  findSpec: async id => devices.find(d => d.id === id) ?? null,
  loadLayout: async name => { try { return layoutFile(name) } catch { return null } },
}

const checksumOk = buf => {
  let s = 0
  for (let i = 0; i < 7; i++) s += buf[i]
  return buf[7] === 0xff - (s & 0xff)
}

/**
 * A gen2 board in software, following sharkfin's docs/PROTOCOL.md: 0x8F
 * identify with the revision at 7..8, 0x80 answering zeros by cable, keymap
 * pages on 0x8A/0x90, single-slot writes on 0x0A/0x10, switch columns on
 * 0xE5/0x65 (u16 travel columns, byte columns), 0x1B stream flag.
 */
function fakeGen2({ id, revision = 0x0309, layout, profiles = 4 }) {
  const wide = new Set([0, 1, 2, 3, 4, 6])
  const blank = () => new Uint8Array(512)
  const keymaps = Array.from({ length: profiles }, () => [blank(), blank(), blank(), blank()])
  const fn = Array.from({ length: profiles }, blank)
  // factory keymap from the layout's own entries, slot = matrixIndex or position
  layout.keys.forEach((k, i) => {
    const slot = k.matrixIndex ?? i + 1
    const e = k.matrixEntry ?? [0, 0, 4 + (i % 26), 0]
    for (const km of keymaps) km[0].set(e, slot * 4)
  })
  const defaults = { 0: 200, 1: 280, 2: 50, 3: 50, 4: 50, 5: 0, 6: 30, 7: 0, 9: 255 }
  const columns = Array.from({ length: profiles }, () => {
    const m = new Map()
    for (const [c, v] of Object.entries(defaults)) m.set(Number(c), new Array(128).fill(v))
    return m
  })
  const state = { profile: 0, stream: 0, commits: 0, writes: [], bad: 0 }
  let reply = new Uint8Array(64)
  const colBytes = (p, col) => {
    const vals = columns[p].get(col)
    if (wide.has(col)) return Uint8Array.from(vals.flatMap(v => [v & 0xff, v >> 8]))
    return Uint8Array.from(vals)
  }
  const setColBytes = (p, col, offset, bytes) => {
    const vals = columns[p].get(col)
    bytes.forEach((b, i) => {
      const o = offset + i
      if (wide.has(col)) {
        const s = o >> 1
        if (s >= 128) return
        vals[s] = o & 1 ? (vals[s] & 0xff) | (b << 8) : (vals[s] & 0xff00) | b
      } else if (o < 128) vals[o] = b
    })
  }
  const handle = req => {
    if (!checksumOk(req)) { state.bad++; return }
    const out = new Uint8Array(64)
    const op = req[0]
    switch (op) {
      case 0x8f:
        out[0] = 0x8f; out.set([id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, id >>> 24], 1)
        out[7] = revision & 0xff; out[8] = revision >> 8
        break
      case 0x80: out[0] = 0x80; break
      case 0x84: out[0] = 0x84; out[1] = state.profile; break
      case 0x04: state.profile = req[1]; state.writes.push(['profile', req[1]]); out[0] = 0x04; break
      case 0x8a: out.set(keymaps[req[1]][req[4]].subarray(req[3] * 64, req[3] * 64 + 64)); break
      case 0x90: out.set(fn[req[2]].subarray(req[4] * 64, req[4] * 64 + 64)); break
      case 0x0a:
        keymaps[req[1]][req[6]].set(req.subarray(8, 12), req[2] * 4)
        state.writes.push(['key', req[1], req[2], [...req.subarray(8, 12)]])
        break
      case 0x10:
        fn[req[2]].set(req.subarray(8, 12), req[3] * 4)
        state.writes.push(['fn', req[2], req[3]])
        break
      case 0xe5: out.set(colBytes(state.profile, req[1]).subarray(req[3] * 64, req[3] * 64 + 64)); break
      case 0x65: {
        const [, col, bulk, at, last] = req
        if (bulk) setColBytes(state.profile, col, at * 56, req.subarray(8, 8 + 56))
        else setColBytes(state.profile, col, at * (wide.has(col) ? 2 : 1), req.subarray(8, wide.has(col) ? 10 : 9))
        state.writes.push(['col', col, bulk, at, last])
        if (last) state.commits++
        break
      }
      case 0x1b: state.stream = req[1]; break
      default: out[0] = op
    }
    reply = out
  }
  const node = {
    async sendFeature(buf) { assert.equal(buf.length, 64); handle(buf) },
    async receiveFeature() { return reply },
  }
  return { node, state, keymaps, fn, columns }
}

function fakeClock() {
  let t = 0
  return { slept: 0, now: () => t, async sleep(ms) { t += ms; this.slept += ms } }
}

const usb = { vendorId: 0x3151, productId: 0x5030, productName: 'RY' }

async function connect(opts) {
  const board = fakeGen2(opts)
  const clock = fakeClock()
  const wire = new Wire(board.node, clock)
  const driver = await RongyuanDriver.connect(wire, deps, usb)
  return { board, clock, driver }
}

test('checksums and column packets match sharkfin', () => {
  const g = proto.Columns.gen2(0x0309)
  const p = g.setOne(0, 5, true, 200)
  assert.deepEqual([...p.subarray(0, 5)], [0x65, 0, 0, 5, 1])
  assert.deepEqual([p[8], p[9]], [200, 0])
  assert.ok(checksumOk(p))
  assert.equal(g.setOne(0, 128, true, 1), null)
  const wide = g.setAll(0, new Array(128).fill(200), true)
  assert.equal(wide.length, 5)
  assert.ok(wide.slice(0, 4).every(x => x[4] === 0) && wide[4][4] === 1)
  assert.equal(g.setAll(7, new Array(128).fill(0x80), false).length, 3)
  assert.equal(proto.Columns.gen2(0x0507).unitMm, 0.005)
  assert.equal(proto.Columns.gen2(0x0200).unitMm, 0.1)
  // firmware clamps
  assert.equal(g.toWire(0, 0.05), 10)
  assert.equal(g.toWire(2, 0), 1)
  assert.equal(g.toWire(6, 9), 340)
  const y = proto.Columns.yc500()
  assert.equal(y.toMm(0, 18), 1.9)
  assert.equal(y.toMm(6, 33), 0.6)
  assert.equal(y.toWire(6, 0.6), 33)
  assert.equal(proto.parseTravelReport(5, Uint8Array.from([0x1b, 0x2a, 0x03, 7])).counts, 0x032a)
})

test('a registry board connects with its stored picture', async () => {
  const { driver } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  assert.equal(driver.family, 'gen2')
  assert.equal(driver.info.firmwareVersion, '3.09')
  assert.equal(driver.layout.source, 'registry')
  assert.equal(driver.layout.keys.length, 67)
  assert.equal(driver.needsLayoutConfirmation, false)
  assert.equal(driver.capabilities.writable.actuation, true)
  assert.equal(driver.capabilities.travelStepMm, 0.01)
  assert.ok(driver.layout.width > 14 && driver.layout.width < 17, `width ${driver.layout.width}`)
  assert.ok(driver.layout.height > 4.5 && driver.layout.height < 5.6, `height ${driver.layout.height}`)
})

test('keymap reads as UI keycodes and writes only changed slots', async () => {
  const file = layoutFile('Common68_ZAP68')
  const { driver, board } = await connect({ id: 2268, layout: file })
  const map = await driver.getKeymap(0, 0)
  const esc = file.keys.findIndex(k => k.matrixEntry?.join() === '0,0,41,0')
  assert.ok(esc >= 0)
  assert.equal(map[esc], 0x29)
  map[esc] = ui.uiConsumer(0xe9) // volume up
  await driver.setKeymap(0, 0, map)
  const keyWrites = board.state.writes.filter(w => w[0] === 'key')
  assert.equal(keyWrites.length, 1)
  assert.deepEqual(keyWrites[0][3], [3, 0, 0xe9, 0])
  assert.deepEqual(await driver.getKeymap(0, 0), map)
  // unknown entries round-trip untouched
  board.keymaps[0][0].set([9, 0, 2, 0], file.keys[3].matrixIndex * 4)
  const again = await driver.getKeymap(0, 0)
  assert.equal(again[3] >>> 24, 0x7f)
  await driver.setKeymap(0, 0, again)
  assert.equal(board.state.writes.filter(w => w[0] === 'key').length, 1)
  // Fn layer
  const fnMap = await driver.getKeymap(1, 1)
  fnMap[0] = 0x3a // F1
  await driver.setKeymap(1, 1, fnMap)
  assert.deepEqual(board.state.writes.at(-1), ['fn', 1, file.keys[0].matrixIndex])
})

test('actuation: per-key path for one key, bulk columns for many', async () => {
  const { driver, board, clock } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  const a = await driver.getActuation(0)
  assert.equal(a.length, 67)
  assert.ok(Math.abs(a[0].actuationMm - 2.0) < 1e-9)
  assert.equal(a[0].rtPressMm, 0) // rapid trigger off
  assert.ok(Math.abs(a[0].releaseMm - 2.8) < 1e-9)

  a[5] = { ...a[5], actuationMm: 0.5, rtPressMm: 0.15, rtReleaseMm: 0.2 }
  await driver.setActuation(0, a)
  const slot5 = driver['slots'][5]
  const col = board.columns[0]
  assert.equal(col.get(0)[slot5], 50)
  assert.equal(col.get(2)[slot5], 15)
  assert.equal(col.get(3)[slot5], 20)
  assert.equal(col.get(7)[slot5], 0x80)
  assert.equal(board.state.writes.filter(w => w[0] === 'col').length, 6)
  assert.equal(board.state.commits, 1)

  const before = clock.slept
  const all = a.map(k => ({ ...k, actuationMm: 1.2 }))
  await driver.setActuation(0, all)
  assert.ok(clock.slept - before >= 10000, 'flash cooldown between batches')
  assert.equal(board.state.commits, 2)
  assert.ok(driver['slots'].every(s => col.get(0)[s] === 120))
  assert.equal(col.get(7)[slot5], 0x80, 'rapid trigger kept on the key that had it')
  const bulk = board.state.writes.filter(w => w[0] === 'col' && w[2] === 1)
  assert.equal(bulk.length, 5, 'only the travel column changed')
  assert.equal(board.state.bad, 0)
})

test('switch columns follow the active profile', async () => {
  const { driver, board } = await connect({ id: 2268, layout: layoutFile('Common68_ZAP68') })
  await driver.getActuation(2)
  assert.deepEqual(board.state.writes.filter(w => w[0] === 'profile'), [['profile', 2]])
  assert.equal(board.state.profile, 2)
})

test('a board whose picture names no slots is matched and must be confirmed', async () => {
  const file = layoutFile('Common68_K80X68')
  const { driver } = await connect({ id: 2255, layout: file })
  assert.equal(driver.layout.source, 'inferred')
  assert.ok(driver.matchRate > 0.9)
  assert.equal(driver.needsLayoutConfirmation, true)
  const map = await driver.getKeymap(0, 0)
  await assert.rejects(driver.setKeymap(0, 0, map), /Confirm/)
  driver.confirmLayout()
  await driver.setKeymap(0, 0, map)
})

test('a board with a cleared keymap falls back to a slot grid', async () => {
  const file = layoutFile('Common68_K80X68')
  const board = fakeGen2({ id: 2255, layout: file })
  for (const km of board.keymaps) km[0].fill(0)
  board.keymaps[0][0].set([0, 0, 4, 0], 10 * 4)
  const driver = await RongyuanDriver.connect(new Wire(board.node, fakeClock()), deps, usb)
  assert.equal(driver.layout.source, 'grid')
  assert.equal(driver.layout.keys.length, 1)
  assert.equal(driver.layout.keys[0].label, '10')
})

test('read-only lineages refuse switch writes', async () => {
  const other = devices.find(d => d.family === 'gen2' && !d.internalName.startsWith('ry5088_'))
  const { driver } = await connect({ id: other.id, layout: { keys: [] } })
  assert.equal(driver.capabilities.writable.actuation, false)
  const a = await driver.getActuation(0)
  await assert.rejects(driver.setActuation(0, a), /read but not written/)
})

test('unknown ids are reported, not guessed', async () => {
  const board = fakeGen2({ id: 99999999, layout: { keys: [] } })
  await assert.rejects(RongyuanDriver.connect(new Wire(board.node, fakeClock()), deps, usb), /not in the board list/)
})

test('keycode translation covers keys, combos, media, mouse and Fn', async () => {
  const k = await bundle('src/drivers/rongyuan/keycodes.ts')
  const n = new k.NativeEntries()
  const cases = [
    [[0, 0, 4, 0], 0x04],
    [[0, 0xe0, 6, 0], 0x10600],
    [[0, 0, 0xe0, 0], 0x10000],
    [[0, 0, 0xe6, 0], 0x400000],
    [[0, 0xe0, 0x29, 0xe1], 0x32900],
    [[3, 0, 0xe9, 0], ui.uiConsumer(0xe9)],
    [[3, 0, 0x8a, 1], ui.uiConsumer(0x18a)],
    [[1, 0, 240, 0], 0x01010100],
    [[10, 1, 0, 0], 0x0d000000],
    [[0, 0, 0, 0], 0],
  ]
  for (const [entry, value] of cases) {
    assert.equal(k.entryToUi(entry, n), value, entry.join())
    assert.deepEqual(k.uiToEntry(value, n), entry)
  }
  const macro = k.entryToUi([9, 0, 3, 0], n)
  assert.deepEqual(k.uiToEntry(macro, n), [9, 0, 3, 0])
})
