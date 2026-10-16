// Drives the real page in Chromium: TZ=Europe/Paris node --test   (needs the playwright package; skipped without it)
const test = require('node:test')
const assert = require('node:assert/strict')
const serve = require('./serve.js')
let playwright = null
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { playwright = require(p); break } catch (e) { /* next */ } }
const NOW = new Date('2026-10-16T09:30:00+02:00') // a Friday morning

test('the interface, end to end', { skip: !playwright && 'playwright is not installed' }, async t => {
  const server = await serve(0)
  const url = 'http://127.0.0.1:' + server.address().port + '/index.html'
  const browser = await playwright.chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, locale: 'fr-FR', timezoneId: 'Europe/Paris' })
  const page = await ctx.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.clock.setFixedTime(NOW)
  const titles = () => page.$$eval('#main .row.task .title', els => els.map(e => e.textContent))
  const add = async text => { await page.fill('#addInput', text); await page.press('#addInput', 'Enter') }
  try {
    await page.goto(url)
    await t.test('first launch shows the welcome, once', async () => {
      await page.waitForSelector('.dlg')
      await page.click('.dlg-actions button')
      await page.reload(); await page.waitForSelector('#addInput')
      assert.equal(await page.$('.dlg'), null)
    })
    await t.test('typing a date files the task in the right section', async () => {
      await add('Sortir les poubelles mardi 19h')
      await add('Médicament tous les jours à 8h')
      await add('Appeler le garage')
      await add('Payer la cantine hier')
      assert.deepEqual(await page.$$eval('.sec', els => els.map(e => e.firstChild.textContent.trim())), ['Demain', '7 prochains jours', 'Sans date'])
      assert.ok((await titles()).indexOf('Payer la cantine hier') >= 0) // "hier" is not a future date: kept as text
      assert.match(await page.textContent('#snack'), /Ajoutée|Un rappel/)
    })
    await t.test('the "remind me?" chips date a task in one tap', async () => {
      await add('Rappeler Julie')
      await page.click('#snack button >> nth=0') // "Dans 1 h"
      const row = page.locator('.row.task', { hasText: 'Rappeler Julie' })
      assert.match(await row.textContent(), /Aujourd'hui 10:30/)
    })
    await t.test('ticking, undo, and a repeating task moving to its next date', async () => {
      await page.click('.row.task:has-text("Appeler le garage") .check')
      assert.ok(!(await titles()).includes('Appeler le garage'))
      await page.click('#snack button') // Annuler
      assert.ok((await titles()).includes('Appeler le garage'))
      await page.click('.row.task:has-text("Médicament") .check')
      assert.match(await page.textContent('.row.task:has-text("Médicament")'), /Dim\. 18 oct\.|Dimanche|Demain/)
    })
    await t.test('the editor: reminders, weekly days, steps, links', async () => {
      await page.click('.row.task:has-text("Sortir les poubelles") .body')
      await page.click('[data-act="remind"][data-v="60"]')
      await page.selectOption('[data-f="repeatKind"]', 'pick')
      await page.click('.wd-btn[data-v="5"]') // + Friday
      await page.fill('.step-new', 'Bac jaune'); await page.press('.step-new', 'Enter')
      await page.fill('[data-f="details"]', 'Mairie : 04 72 00 00 00 ou https://www.lyon.fr/dechets')
      assert.equal(await page.$$eval('.links .chip', els => els.length), 2)
      await page.click('[data-act="close"]')
      const row = await page.textContent('.row.task:has-text("Sortir les poubelles")')
      assert.match(row, /Chaque mar\., ven\./); assert.match(row, /0\/1/)
    })
    await t.test('search finds tasks, notes and events, accents or not', async () => {
      await page.click('#nav [data-tab="notes"]')
      await add('Idée : réunion école #parents')
      await page.click('[data-act="search-open"]')
      await page.fill('#search', 'ecole')
      assert.match(await page.textContent('#main'), /réunion école/)
      await page.click('[data-act="search-close"]')
    })
    await t.test('a checklist note ticks in reading mode', async () => {
      await page.click('[data-act="note-full"]')
      await page.fill('.note-text', 'Courses\n- [ ] Lait\n- [ ] Pain')
      await page.click('[data-act="close"]')
      await page.click('.card.note:has-text("Courses") .body')
      await page.click('.line.box >> nth=0 >> .check')
      await page.click('[data-act="close"]')
      assert.match(await page.textContent('.card.note:has-text("Courses")'), /1\/2/)
    })
    await t.test('agenda: a weekly event, one date removed', async () => {
      await page.click('#nav [data-tab="agenda"]')
      await page.click('#fab')
      await page.fill('.title-input', 'Foot')
      await page.selectOption('[data-f="repeatKind"]', 'weekly')
      await page.click('[data-act="close"]')
      await page.click('.day[data-day="2026-10-23"]')
      await page.click('.row.event[data-day="2026-10-23"]:has-text("Foot") .body')
      await page.click('[data-act="delete"]')
      await page.click('.dlg-actions button >> nth=2') // only this date
      assert.equal(await page.$('.row.event[data-day="2026-10-23"]'), null)
      assert.ok(await page.$('.row.event[data-day="2026-10-30"]:has-text("Foot")'))
    })
    await t.test('everything is still there after a restart', async () => {
      await page.reload(); await page.waitForSelector('#addInput')
      assert.ok((await titles()).includes('Sortir les poubelles'))
    })
    await t.test('English and sober mode', async () => {
      await page.click('#nav [data-tab="plus"]')
      await page.click(`[data-k="lang"][data-v='"en"']`)
      assert.equal(await page.textContent('#title'), 'More')
      await page.click('input[data-set="sober"]')
      await page.click('#nav [data-tab="tasks"]')
      assert.equal(await page.textContent('#title'), 'Tasks')
      await page.click('.row.task:has-text("Appeler le garage") .check')
      assert.doesNotMatch(await page.textContent('#snack'), /[\u{1F300}-\u{1FAFF}☀-➿]/u)
    })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close(); server.close()
  }
})
