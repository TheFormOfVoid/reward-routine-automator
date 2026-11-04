import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts'
import { normalizeSettings, validateSettings } from '../src/shared/settings-validation.ts'

test('stored settings keep valid user preferences while invalid fields fall back individually', () => {
  const input = { theme: 'nord', startupEnabled: false, hiddenSections: null, minDelaySec: NaN, background: {}, searchesPerBatch: -1, quietHoursStart: 'not a time' }
  const normalized = normalizeSettings(input, DEFAULT_SETTINGS)
  assert.equal(normalized.theme, 'nord')
  assert.equal(normalized.startupEnabled, false)
  assert.deepEqual(normalized.hiddenSections, DEFAULT_SETTINGS.hiddenSections)
  assert.equal(normalized.searchesPerBatch, DEFAULT_SETTINGS.searchesPerBatch)
  assert.deepEqual(input.hiddenSections, null)
  assert.deepEqual(normalizeSettings(null, DEFAULT_SETTINGS), DEFAULT_SETTINGS)
})

test('strict validation rejects invalid patches, unknown steps and reversed pacing', () => {
  for (const invalid of [{ startupEnabled: 'yes' }, { startupOrder: ['bogus'] }, { popupHeight: 10 }, { minDelaySec: 20, maxDelaySec: 10 }]) assert.throws(() => validateSettings(invalid, DEFAULT_SETTINGS))
  assert.deepEqual(validateSettings({ theme: 'nord', unknownFuture: true }, DEFAULT_SETTINGS), { theme: 'nord' })
  assert.deepEqual(validateSettings({ quietHoursStart: '23:59', quietHoursEnd: '07:00' }, DEFAULT_SETTINGS), { quietHoursStart: '23:59', quietHoursEnd: '07:00' })
  const normalized = normalizeSettings({ minDelaySec: 30, maxDelaySec: 10 }, DEFAULT_SETTINGS)
  assert.ok(normalized.maxDelaySec >= normalized.minDelaySec)
})

test('navigation backgrounds default clear for legacy settings and retain independent saved choices', () => {
  const legacy = normalizeSettings({ theme: 'nord', tileBlur: 8 }, DEFAULT_SETTINGS)
  assert.equal(legacy.topBarBackground, false)
  assert.equal(legacy.bottomBarBackground, false)
  assert.equal(legacy.tileBlur, 8)
  for (const topBarBackground of [false, true]) {
    for (const bottomBarBackground of [false, true]) {
      const choices = { topBarBackground, bottomBarBackground }
      assert.deepEqual(validateSettings(choices, DEFAULT_SETTINGS), choices)
      const normalized = normalizeSettings(choices, DEFAULT_SETTINGS)
      assert.equal(normalized.topBarBackground, topBarBackground)
      assert.equal(normalized.bottomBarBackground, bottomBarBackground)
    }
  }
})

test('navigation backgrounds require booleans for writes and recover malformed saved fields individually', () => {
  for (const key of ['topBarBackground', 'bottomBarBackground'] as const) {
    for (const value of ['false', 'true', 0, 1, null, [], {}]) {
      assert.throws(() => validateSettings({ [key]: value }, DEFAULT_SETTINGS), new RegExp(`Invalid setting: ${key}`))
      const other = key === 'topBarBackground' ? 'bottomBarBackground' : 'topBarBackground'
      const normalized = normalizeSettings({ [key]: value, [other]: true }, DEFAULT_SETTINGS)
      assert.equal(normalized[key], false)
      assert.equal(normalized[other], true)
    }
  }
})
