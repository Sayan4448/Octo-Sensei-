// Talks to the phone ("Open Mon Orga on the PC" switch): finds it on the Wi-Fi, then merges data with it.
// Plain Node (http, os, crypto), so it is tested without Electron.
const http = require('http')
const os = require('os')
const crypto = require('crypto')

const PORT = 8080

function request(address, path, body, timeout) {
  return new Promise((resolve, reject) => {
    const [host, port] = address.split(':')
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request({
      host, port: +port || PORT, path, method: data ? 'POST' : 'GET', timeout: timeout || 8000,
      // The phone decodes the body with this charset: without it accents would break.
      headers: data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length } : {},
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode === 401) return reject(Object.assign(new Error('badCode'), { code: 'badCode' }))
        if (res.statusCode !== 200) return reject(Object.assign(new Error('HTTP ' + res.statusCode), { code: 'unreachable', status: res.statusCode }))
        try { resolve(JSON.parse(text)) } catch (e) { reject(Object.assign(new Error('bad json'), { code: 'unreachable' })) }
      })
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'unreachable' })))
    req.on('error', e => reject(Object.assign(e, { code: e.code === 'badCode' ? 'badCode' : 'unreachable' })))
    if (data) req.write(data)
    req.end()
  })
}

// "192.168.1.20", "192.168.1.20:8080" or "http://192.168.1.20:8080/?k=123456" -> "192.168.1.20:8080"
function normalizeAddress(input) {
  const m = /^\s*(?:https?:\/\/)?([\w.-]+)(?::(\d+))?/.exec(String(input || ''))
  return m ? m[1] + ':' + (m[2] || PORT) : null
}
const codeFrom = input => { const m = /[?&]k=(\d{6})/.exec(String(input || '')); return m ? m[1] : null }

// Sync v2: the code never travels; both sides derive a key from it and the data goes encrypted (AES-256-GCM).
// The same envelope as Sync.kt: {v: 2, iv, data}, data = ciphertext + 16-byte tag, base64.
const keys = {}
const keyFor = code => keys[code] || (keys[code] = crypto.pbkdf2Sync(String(code), 'mon-orga-sync-v2', 100000, 32, 'sha256')) // slow on purpose: once per code
function seal(code, value, iv) {
  iv = iv || crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(code), iv)
  const data = Buffer.concat([c.update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'), c.final(), c.getAuthTag()])
  return { v: 2, iv: iv.toString('base64'), data: data.toString('base64') }
}
function open(code, env) { // throws when the code (so the key) is wrong or the data was changed
  const iv = Buffer.from(String(env && env.iv), 'base64'); const all = Buffer.from(String(env && env.data), 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(code), iv)
  d.setAuthTag(all.subarray(all.length - 16))
  return JSON.parse(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8'))
}
async function exchange(address, code, doc, since) {
  const asked = Date.now(); const pong = await ping(address, 3000).catch(() => null)
  if (!pong) throw Object.assign(new Error('unreachable'), { code: 'unreachable' })
  const skew = pong.now ? pong.now - Math.round((asked + Date.now()) / 2) : 0 // the phone refuses requests 2 min off its clock: use its time
  if (!(pong.v >= 2)) { // a phone still on 5.1.0: the old way, the code in the address
    return doc ? request(address, '/api/sync?k=' + encodeURIComponent(code), doc, 15000) : request(address, '/api/state?k=' + encodeURIComponent(code))
  }
  const env = await request(address, '/api/v2/sync', seal(code, { ts: Date.now() + skew, nonce: crypto.randomBytes(8).toString('hex'), since: since || 0, doc: doc || null }), 15000)
  try { return open(code, env).doc } catch (e) { throw Object.assign(new Error('badCode'), { code: 'badCode' }) }
}

const ping = (address, timeout) => request(address, '/api/ping', undefined, timeout || 900).then(r => (r && r.app === 'mon-orga' ? r : null))
const state = (address, code) => exchange(address, code, null, 0)
const sync = (address, code, doc, since) => exchange(address, code, doc, since)

// Every machine of the local /24 networks, 48 at a time.
async function scan(port, interfaces) {
  const nets = Object.values(interfaces || os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(i.address))
  const targets = []
  for (const n of nets) {
    const base = n.address.split('.').slice(0, 3).join('.')
    for (let i = 1; i < 255; i++) if (base + '.' + i !== n.address) targets.push(base + '.' + i + ':' + (port || PORT))
  }
  const found = []
  let next = 0
  async function worker() {
    while (next < targets.length) {
      const address = targets[next++]
      const r = await ping(address).catch(() => null)
      if (r) found.push({ address, name: r.name || address })
    }
  }
  await Promise.all(Array.from({ length: 48 }, worker))
  return found
}

module.exports = { PORT, normalizeAddress, codeFrom, ping, state, sync, scan, request, seal, open }
