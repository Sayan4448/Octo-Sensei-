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
