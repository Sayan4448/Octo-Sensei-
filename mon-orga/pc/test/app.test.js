// Starts the real PC app (needs a display: xvfb-run on Linux) and syncs it with a fake phone.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'); const os = require('os'); const path = require('path')
const fakePhone = require('./phone.js')
let playwright = null
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { playwright = require(p); break } catch (e) { /* next */ } }
let electronPath = null
try { electronPath = require('electron') } catch (e) { /* not installed */ }
const canRun = playwright && electronPath && fs.existsSync(electronPath) && (process.platform !== 'linux' || process.env.DISPLAY)

test('the PC app: add a task, connect to the phone, get its tasks', { skip: !canRun && 'needs playwright, electron and a display' }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-orga-'))
  const phone = await fakePhone('123456', { tasks: [{ id: 'p1', text: 'Venue du téléphone', updatedAt: 5 }] })
  const app = await playwright._electron.launch({ executablePath: electronPath, args: ['--no-sandbox', path.join(__dirname, '..')], env: Object.assign({}, process.env, { MON_ORGA_DATA: data, LANG: 'fr_FR.UTF-8' }) })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(8000)
    await page.waitForSelector('.dlg-actions button')
    await page.click('.dlg-actions button')
    await page.fill('#addInput', 'Réviser le contrôle demain 18h')
    await page.press('#addInput', 'Enter')
    await page.waitForFunction(() => document.querySelectorAll('#main .row.task').length === 1)
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'mon-orga.json'), 'utf8'))
    assert.equal(saved.tasks[0].text, 'Réviser le contrôle')
    assert.match(saved.tasks[0].due, /T18:00$/)
    await page.click('#nav [data-tab="plus"]')
    await page.fill('#syncAddr', phone.address)
    await page.fill('#syncCode', '123456')
    await page.click('[data-act="sync-connect"]')
    await page.click('#nav [data-tab="tasks"]')
    await page.waitForSelector('#main .row.task:has-text("Venue du téléphone")')
    assert.ok(phone.doc.tasks.some(t => t.text === 'Réviser le contrôle'))
    assert.equal(await page.title(), 'Mon Orga')
  } finally {
    await app.close(); phone.server.close()
    fs.rmSync(data, { recursive: true, force: true })
  }
})

// A fake AI service speaking the OpenAI chat API, as Ollama or Google AI Studio do.
function fakeAi(answer) {
  const ai = { calls: [] }
  ai.server = require('http').createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      ai.calls.push({ path: req.url, auth: req.headers.authorization || null, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'nomic-embed-text' }, { id: 'llama3.2:latest' }] }))
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer(body) } }] }))
    })
  })
  return new Promise(res => ai.server.listen(0, '127.0.0.1', () => { ai.url = 'http://127.0.0.1:' + ai.server.address().port + '/v1'; res(ai) }))
}

test('the PC app: the assistant tab talks to a local AI and files what it says', { skip: !canRun && 'needs playwright, electron and a display' }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-orga-'))
  const ai = await fakeAi(body => {
    const said = body.messages[body.messages.length - 1].content
    if (/dentiste/i.test(said)) return '```json\n{"reply": "C’est noté, bon courage chez le dentiste !", "add": [{"type": "event", "title": "Dentiste", "when": "mardi 14h", "date": "2026-10-21", "time": "14:00", "place": "", "repeat": ""}]}\n```'
    return '{"reply": "Tu as un dentiste mardi.", "add": []}'
  })
  const app = await playwright._electron.launch({ executablePath: electronPath, args: ['--no-sandbox', path.join(__dirname, '..')], env: Object.assign({}, process.env, { MON_ORGA_DATA: data, LANG: 'fr_FR.UTF-8' }) })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(8000)
    await page.waitForSelector('.dlg-actions button')
    await page.click('.dlg-actions button')
    await page.click('#nav [data-tab="ai"]')
    assert.equal(await page.$('#addInput:visible'), null) // nothing to type into before an AI is connected
    await page.selectOption('#aiProvider', 'other')
    await page.fill('#aiUrl', ai.url)
    await page.fill('#aiKey', 'sk-test-123')
    await page.click('[data-act="ai-connect"]')
    await page.waitForSelector('.msg.bot .chip') // the hello and its examples
    assert.match(await page.textContent('#subtitle'), /llama3\.2:latest/) // the chat model of the list, not the embedding one
    assert.deepEqual(ai.calls.map(c => [c.path, c.auth]), [['/v1/models', 'Bearer sk-test-123']])
    await page.fill('#addInput', 'J’ai dentiste mardi à 14h')
    await page.press('#addInput', 'Enter')
    await page.waitForSelector('.ai-item:has-text("Dentiste")')
    assert.match(await page.textContent('.msg.bot >> nth=-1'), /bon courage[\s\S]*Agenda/)
    const call = ai.calls[1]
    assert.equal(call.body.model, 'llama3.2:latest')
    assert.match(call.body.messages[0].content, /Always answer with exactly one JSON object/)
    assert.deepEqual(call.body.messages.slice(1), [{ role: 'user', content: 'J’ai dentiste mardi à 14h' }])
    const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'mon-orga.json'), 'utf8'))
    const ev = saved().events.find(e => e.text === 'Dentiste')
    assert.equal(ev.time, '14:00'); assert.equal(require('../../web/src/store.js').weekday(ev.day), 2) // "mardi": a Tuesday, whatever the model's date
    // the key stays with the PC app: not in the settings, nor in the page's saved data
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'local.json'), 'utf8')).aiKey, 'sk-test-123')
    assert.doesNotMatch(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'), /sk-test/)
    // a question: the conversation goes along, with the model's own answer
    await page.fill('#addInput', 'Et mardi ?'); await page.press('#addInput', 'Enter')
    await page.waitForSelector('.msg.bot:has-text("Tu as un dentiste mardi.")')
    assert.deepEqual(ai.calls[2].body.messages.slice(1).map(m => m.role), ['user', 'assistant', 'user'])
    // undo from the chat
    await page.click('.ai-item:has-text("Dentiste") [data-act="ai-undo"]')
    await page.waitForSelector('.ai-item.gone')
    assert.ok(saved().events.find(e => e.text === 'Dentiste').deleted)
  } finally {
    await app.close(); ai.server.close()
    fs.rmSync(data, { recursive: true, force: true })
  }
})
