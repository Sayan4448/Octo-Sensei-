// A fake phone for the tests: the same API as the Android app's SyncServer.
const http = require('http')
const Store = require('../../web/src/store.js')
module.exports = function fakePhone(code, doc) {
  const phone = { doc: Store.normalize(doc || {}), calls: [] }
  phone.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    phone.calls.push(url.pathname)
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
    if (url.pathname === '/api/ping') return send(200, { app: 'mon-orga', name: 'Pixel test' })
    if (url.searchParams.get('k') !== code) return send(401, '"Code incorrect"')
    if (url.pathname === '/api/state') return send(200, phone.doc)
    if (url.pathname === '/api/sync') {
      phone.contentType = req.headers['content-type']
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => { phone.doc = Store.merge(phone.doc, JSON.parse(Buffer.concat(chunks).toString('utf8'))); send(200, phone.doc) })
      return
    }
    send(404, '{}')
  })
  return new Promise(r => phone.server.listen(0, '127.0.0.1', () => { phone.address = '127.0.0.1:' + phone.server.address().port; r(phone) }))
}
