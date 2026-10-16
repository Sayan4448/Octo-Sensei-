// Talks to the phone ("Open Mon Orga on the PC" switch): finds it on the Wi-Fi, then merges data with it.
// Plain Node (http, os), so it is tested without Electron.
const http = require('http')
const os = require('os')

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
        if (res.statusCode !== 200) return reject(Object.assign(new Error('HTTP ' + res.statusCode), { code: 'unreachable' }))
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

const ping = (address, timeout) => request(address, '/api/ping', undefined, timeout || 900).then(r => (r && r.app === 'mon-orga' ? r : null))
const state = (address, code) => request(address, '/api/state?k=' + encodeURIComponent(code))
const sync = (address, code, doc) => request(address, '/api/sync?k=' + encodeURIComponent(code), doc, 15000)

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

module.exports = { PORT, normalizeAddress, codeFrom, ping, state, sync, scan, request }
