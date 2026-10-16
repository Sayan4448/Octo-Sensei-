const test = require('node:test')
const assert = require('node:assert/strict')
const phone = require('../sync.js')
const fakePhone = require('./phone.js')

test('addresses and codes typed or pasted in any form', () => {
  assert.equal(phone.normalizeAddress('192.168.1.20'), '192.168.1.20:8080')
  assert.equal(phone.normalizeAddress(' http://192.168.1.20:8080/?k=123456 '), '192.168.1.20:8080')
  assert.equal(phone.normalizeAddress('10.0.0.5:9000'), '10.0.0.5:9000')
  assert.equal(phone.codeFrom('http://192.168.1.20:8080/?k=123456'), '123456')
  assert.equal(phone.normalizeAddress(''), null)
})

test('ping, wrong code, then a sync that merges both ways, accents included', async () => {
  const p = await fakePhone('123456', { tasks: [{ id: 'p', text: 'Sur le téléphone', updatedAt: 5 }] })
  try {
    assert.equal((await phone.ping(p.address)).name, 'Pixel test')
    await assert.rejects(phone.state(p.address, '000000'), e => e.code === 'badCode')
    const back = await phone.sync(p.address, '123456', { tasks: [{ id: 'c', text: 'Créée sur le PC', updatedAt: 6 }] })
    assert.deepEqual(back.tasks.map(t => t.text).sort(), ['Créée sur le PC', 'Sur le téléphone'])
    assert.match(p.contentType, /charset=utf-8/)
  } finally { p.server.close() }
})

test('sync v2: encrypted with a key from the code, the same bytes as Android', async () => {
  // The vector SyncTest.kt checks too: code 123456, iv 00..0B
  const env = phone.seal('123456', '{"ts":1,"nonce":"n","since":0,"doc":null}', Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))
  assert.equal(env.data, 'k2N/cPtqBlp8j++2mW4D0hFvwvpheU13FXyhu1hauM0re0F7cdSbkJIYKu8uOWLVnO6pibbPfzbM')
  assert.deepEqual(phone.open('123456', env), { ts: 1, nonce: 'n', since: 0, doc: null })
  assert.throws(() => phone.open('654321', env))
  const p = await fakePhone('123456', { notes: [{ id: 'n', text: 'Courses : lait', updatedAt: 300 }] })
  try {
    const back = await phone.sync(p.address, '123456', { notes: [{ id: 'n', text: 'Courses : pain', updatedAt: 200 }] }, 100)
    assert.deepEqual(back.notes.map(n => [n.id, n.text]), [['n', 'Courses : lait'], ['n-c200', 'Courses : pain']]) // both texts kept
    assert.ok(p.calls.includes('/api/v2/sync') && !p.calls.includes('/api/sync')) // the code never travelled
    await assert.rejects(phone.state(p.address, '000000'), e => e.code === 'badCode')
    p.old = true // a phone still on 5.1.0
    assert.equal((await phone.state(p.address, '123456')).notes.length, 2)
  } finally { p.server.close() }
})

test('an unreachable phone is reported as such', async () => {
  await assert.rejects(phone.ping('127.0.0.1:1', 300), e => e.code === 'unreachable')
})

test('scan finds a phone on the local network', async () => {
  const p = await fakePhone('123456')
  try {
    const port = +p.address.split(':')[1]
    // A fake "network card" whose /24 is 127.0.0.x: the scan probes 127.0.0.1, where the fake phone listens.
    const found = await phone.scan(port, { lo: [{ family: 'IPv4', internal: false, address: '10.0.0.200' }], fake: [{ family: 'IPv4', internal: false, address: '127.0.0.254' }] })
    assert.ok(found.some(f => f.address === '127.0.0.1:' + port && f.name === 'Pixel test'), JSON.stringify(found))
  } finally { p.server.close() }
})
