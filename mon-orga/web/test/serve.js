// Tiny static server for the UI tests: node test/serve.js [port]
const http = require('http'); const fs = require('fs'); const path = require('path')
const root = path.join(__dirname, '..', 'src')
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' }
function start(port) {
  return new Promise(res => {
    const server = http.createServer((req, resp) => {
      const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html')
      if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { resp.writeHead(404); return resp.end() }
      resp.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(resp)
    })
    server.listen(port || 0, '127.0.0.1', () => res(server))
  })
}
module.exports = start
if (require.main === module) start(+process.argv[2] || 8123).then(s => console.log('http://127.0.0.1:' + s.address().port))
