const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'); const os = require('os'); const path = require('path')
const rules = require('../rules.js')

// Rings an item, then every re-ring it asks for, as main.js's tick does: minutes of each re-ring after the first ring.
function chain(kind, settings) {
  const local = { snoozes: {}, nags: {} }; const T = Date.UTC(2026, 9, 16, 8); const out = []
  rules.nag([{ id: 'x', kind }], local, settings, T)
  for (let i = 0; i < 100 && local.snoozes.x; i++) {
    const at = local.snoozes.x; delete local.snoozes.x; out.push((at - T) / 60000)
    rules.nag([{ id: 'x', kind, snoozed: true }], local, settings, at)
  }
  return { out, nags: local.nags }
}

test('a reminder rings again until answered, events too: 10 min apart, 3 times by default', () => {
  assert.deepEqual(chain('event', {}).out, [10, 20, 30])
  assert.deepEqual(chain('event', {}).nags, {})
  assert.deepEqual(chain('task', { nag: 5, nagTimes: 2 }).out, [5, 10])
  assert.deepEqual(chain('task', { nag: 0 }).out, [])
})

test('nagTimes 0 (until answered): 3 quick re-rings, then hourly, never past 24 h after the first ring', () => {
  const { out, nags } = chain('event', { nag: 10, nagTimes: 0 })
  assert.deepEqual(out.slice(0, 5), [10, 20, 30, 90, 150])
  assert.equal(out[out.length - 1], 1410) // the next one, at 1470 min, would be past 24 h
  assert.deepEqual(nags, {})
})

test('an item ticked or changed after it rang is answered: no more re-rings', () => {
  const local = { snoozes: { a: 9, b: 9, c: 9 }, nags: { a: { n: 0, first: 100 }, b: { n: 1, first: 100 }, c: { n: 0, first: 100 } } }
  const items = { a: { id: 'a', updatedAt: 50 }, b: { id: 'b', updatedAt: 150 }, c: { id: 'c', done: true, updatedAt: 50 } }
  rules.answered(local, id => items[id])
  assert.deepEqual([Object.keys(local.nags), Object.keys(local.snoozes)], [['a'], ['a']])
})

test('a fresh ring of the same item starts the count over, even from a 5.0 counter', () => {
  const local = { snoozes: {}, nags: { x: { n: 2, first: 500 } } }
  rules.nag([{ id: 'x', kind: 'task' }], local, {}, 1000)
  assert.deepEqual(local.nags.x, { n: 0, first: 1000 })
  assert.equal(local.snoozes.x, 1000 + 10 * 60000)
  local.nags.x = 2 // 5.0 kept a bare count
  rules.nag([{ id: 'x', kind: 'task', snoozed: true }], local, {}, 2000)
  assert.deepEqual(local.nags.x, { n: 0, first: 2000 })
})

test('quiet hours, across midnight or not, off when empty', () => {
  assert.ok(rules.quiet('22:00', '07:00', '23:30'))
  assert.ok(rules.quiet('22:00', '07:00', '06:59'))
  assert.ok(!rules.quiet('22:00', '07:00', '07:00'))
  assert.ok(!rules.quiet('22:00', '07:00', '12:00'))
  assert.ok(rules.quiet('13:00', '14:00', '13:30'))
  assert.ok(!rules.quiet('13:00', '14:00', '14:30'))
  assert.ok(!rules.quiet('', '07:00', '03:00'))
  assert.ok(!rules.quiet(undefined, undefined, '03:00'))
})

test('daily backup: one file a day, the 14 newest kept, other files left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-orga-backup-'))
  try {
    for (let d = 1; d <= 20; d++) fs.writeFileSync(path.join(dir, 'mon-orga-2026-09-' + String(d).padStart(2, '0') + '.json'), '{}')
    const others = ['mon-orga.json', 'notes.txt', 'mon-orga-2026-01-01.json.bak']
    others.forEach(f => fs.writeFileSync(path.join(dir, f), 'keep'))
    rules.backup(dir, '2026-10-16', { tasks: [{ id: 'a' }], history: ['5:a', '6:a:x'], settings: { sober: true } })
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'mon-orga-2026-10-16.json'), 'utf8'))
    assert.deepEqual(saved, { tasks: [{ id: 'a' }], history: ['5:a', '6:a:x'], settings: { sober: true } })
    const kept = Array.from({ length: 13 }, (_, i) => 'mon-orga-2026-09-' + String(i + 8).padStart(2, '0') + '.json').concat('mon-orga-2026-10-16.json')
    assert.deepEqual(fs.readdirSync(dir).sort(), kept.concat(others).sort())
    assert.throws(() => rules.backup(path.join(dir, 'unplugged'), '2026-10-17', {})) // main.js logs it and keeps `last`
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
