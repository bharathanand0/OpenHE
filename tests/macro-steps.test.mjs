import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rolldown } from 'rolldown'

async function bundle(path) {
  const build = await rolldown({ input: path, logLevel: 'silent' })
  try {
    const { output } = await build.generate({ format: 'esm' })
    return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
  } finally { await build.close() }
}
const { macroToSteps, macroAdvancedKey } = await bundle('src/driverApp/macroSteps.ts')

const def = (events, extra = {}) => ({ id: 'x', name: 'Test', events, playback: 'once', repeatCount: 1, ...extra })

test('library events become steps with the wait after each', () => {
  const { steps, unknown } = macroToSteps(def([
    { key: 'ControlLeft', type: 'down', delayMs: 0 },
    { key: 'KeyC', type: 'down', delayMs: 30 },
    { key: 'KeyC', type: 'up', delayMs: 50 },
    { key: 'ControlLeft', type: 'up', delayMs: 20000 }
  ]))
  assert.deepEqual(unknown, [])
  assert.deepEqual(steps, [
    { keycode: 0x10000, action: 'press', delayMs: 30 },
    { keycode: 6, action: 'press', delayMs: 50 },
    { keycode: 6, action: 'release', delayMs: 8191 },
    { keycode: 0x10000, action: 'release', delayMs: 0 }
  ])
})

test('an instant press and release is one tap; mouse buttons map', () => {
  const { steps } = macroToSteps(def([
    { key: 'KeyA', type: 'down', delayMs: 0 },
    { key: 'KeyA', type: 'up', delayMs: 0 },
    { key: 'MouseKey1', type: 'down', delayMs: 10 },
    { key: 'MouseKey1', type: 'up', delayMs: 40 }
  ]))
  assert.deepEqual(steps, [
    { keycode: 4, action: 'tap', delayMs: 10 },
    { keycode: 0x01020100, action: 'press', delayMs: 40 },
    { keycode: 0x01020100, action: 'release', delayMs: 0 }
  ])
})

test('unknown keys are left out but their wait is kept', () => {
  const { steps, unknown } = macroToSteps(def([
    { key: 'KeyA', type: 'down', delayMs: 0 },
    { key: 'Bogus', type: 'down', delayMs: 10 },
    { key: 'KeyA', type: 'up', delayMs: 15 }
  ]))
  assert.deepEqual(unknown, ['Bogus'])
  assert.deepEqual(steps, [
    { keycode: 4, action: 'press', delayMs: 25 },
    { keycode: 4, action: 'release', delayMs: 0 }
  ])
})

test('playback and repeat carry over', () => {
  const ak = macroAdvancedKey(def([], { playback: 'repeat', repeatCount: 7 }), 1, 9)
  assert.equal(ak.mode, 'repeat')
  assert.equal(ak.repeat, 7)
  assert.equal(ak.name, 'Test')
  assert.equal(ak.layer, 1)
  assert.equal(ak.key, 9)
})

test('macros read back from the board get their library name', async () => {
  const { nameMacros } = await bundle('src/driverApp/macroSteps.ts')
  const lib = def([{ key: 'KeyA', type: 'down', delayMs: 0 }, { key: 'KeyA', type: 'up', delayMs: 0 }])
  const steps = macroToSteps(lib).steps
  const [named, other] = nameMacros([
    { kind: 'macro', layer: 0, key: 1, steps, mode: 'once', repeat: 1 },
    { kind: 'macro', layer: 0, key: 2, steps: [], mode: 'once', repeat: 1 }
  ], [lib])
  assert.equal(named.name, 'Test')
  assert.equal(other.name, undefined)
})
