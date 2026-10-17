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
      assert.match(await page.textContent('.banner.next'), /Prochain : Rappeler Julie · 10:30 \(dans 1 h\)/)
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
      await page.click('h2.sec [data-act="fab"]')
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
    await t.test('progress survives a restart, an undone tick does not count', async () => {
      await page.click('#nav [data-tab="plus"]')
      const total = async () => +(await page.textContent('.stats div:nth-child(4) b'))
      assert.equal(await total(), 1) // Médicament (the undone "Appeler le garage" is not counted)
      await page.click('#nav [data-tab="agenda"]')
      await page.fill('#addInput', 'Dentiste mardi 14h'); await page.press('#addInput', 'Enter')
      assert.ok(await page.$('.row.event[data-day="2026-10-20"]:has-text("Dentiste")'))
      assert.match(await page.textContent('.row.event[data-day="2026-10-20"]:has-text("Dentiste") .when'), /14:00/)
    })
    await t.test('no raw translation key on screen', async () => {
      const keys = await page.evaluate(() => Object.keys(window.I18N.fr).filter(k => k.length > 4 && /[A-Z_]/.test(k)))
      for (const tab of ['tasks', 'notes', 'agenda', 'plus']) {
        await page.click('#nav [data-tab="' + tab + '"]')
        const text = await page.textContent('body')
        assert.deepEqual(keys.filter(k => new RegExp('(^|[^A-Za-z0-9_])' + k + '($|[^A-Za-z0-9_])').test(text)), [], tab)
      }
      await page.click('#nav [data-tab="tasks"]')
      await page.click('.row.task:has-text("Sortir les poubelles") .body')
      await page.selectOption('[data-f="repeatKind"]', 'nth')
      const text = await page.textContent('#sheet')
      assert.deepEqual(keys.filter(k => text.indexOf(k) >= 0), [], 'editor')
      assert.match(text, /3e|1er|2e|dernier/)
      await page.click('[data-act="close"]')
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

test('the 5.1 tools: long press, imports, repeats, backups', { skip: !playwright && 'playwright is not installed' }, async t => {
  const server = await serve(0)
  const url = 'http://127.0.0.1:' + server.address().port + '/index.html'
  const browser = await playwright.chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, locale: 'fr-FR', timezoneId: 'Europe/Paris', hasTouch: true })
  const t0 = NOW.getTime(); const old = t0 - 40 * 86400000
  await ctx.addInitScript(([t0, old]) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    const tasks = Array.from({ length: 10 }, (_, i) => ({ id: 'old' + i, text: 'Ancienne ' + i, createdAt: old, updatedAt: old }))
    tasks.push({ id: 'p', text: 'Piscine', due: '2026-10-16T18:00', remind: [0], createdAt: old, updatedAt: old })
    localStorage.setItem('mon-orga-doc', JSON.stringify({ tasks: tasks, history: [(t0 - 86400000) + ':p'] }))
    localStorage.setItem('mon-orga-settings', JSON.stringify({ welcomed: true, news: 99 }))
  }, [t0, old])
  const page = await ctx.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.clock.setFixedTime(NOW)
  try {
    await page.goto(url); await page.waitForSelector('#addInput')
    await t.test('no backup for 40 days: a reminder, "later" hides it', async () => {
      assert.match(await page.textContent('.warn-banner'), /sauvegard/i)
      await page.click('.warn-banner [data-act="backup-later"]')
      assert.equal(await page.$('.warn-banner'), null)
    })
    await t.test('long press on a task moves it in one gesture', async () => {
      const body = '.row.task:has-text("Piscine") .body'
      await page.dispatchEvent(body, 'pointerdown', { button: 0, pointerType: 'touch', clientX: 100, clientY: 300 })
      await page.waitForSelector('.menu-item') // after about half a second
      await page.dispatchEvent(body, 'pointerup', { button: 0, pointerType: 'touch' })
      await page.dispatchEvent('.scrim', 'click') // the click of the release does not close the menu
      assert.ok(await page.$('.menu-item'))
      await page.click('.dlg-actions button') // Annuler
      assert.equal(await page.$('#sheet:not([hidden])'), null)
      await page.click(body, { button: 'right' })
      await page.click('.menu-item:has-text("+2 jours")')
      assert.match(await page.textContent('.row.task:has-text("Piscine")'), /18:00/)
      assert.match(await page.textContent('.row.task:has-text("Piscine")'), /Dimanche|dim/i)
    })
    await t.test('repeats: every 3 months, the 1st Monday, 3 h after the tick', async () => {
      await page.click('.row.task:has-text("Piscine") .body')
      await page.selectOption('[data-f="repeatKind"]', 'months')
      assert.equal(await page.inputValue('[data-f="repeatN"]'), '3')
      await page.selectOption('[data-f="repeatKind"]', 'nth')
      await page.selectOption('[data-f="nthK"]', '1'); await page.selectOption('[data-f="nthD"]', '1')
      assert.equal(await page.inputValue('[data-f="dueDay"]'), '2026-11-02') // moved to the first 1st Monday
      await page.click('[data-act="close"]')
      assert.match(await page.textContent('.row.task:has-text("Piscine")'), /Le 1er lundi du mois/)
      await page.click('.row.task:has-text("Piscine") .body')
      await page.selectOption('[data-f="repeatKind"]', 'hours')
      await page.check('[data-f="repeatAfter"]')
      await page.click('[data-act="due-time"][data-v="12:00"]')
      await page.click('[data-act="time-step"][data-v="15"]')
      assert.equal(await page.inputValue('[data-f="dueTime"]'), '12:15')
      await page.fill('.step-new', '')
      await page.focus('.step-new')
      await page.evaluate(() => { const e = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); e.clipboardData.setData('text', '- Maillot\n- Bonnet\n- Serviette'); document.querySelector('.step-new').dispatchEvent(e) })
      assert.equal(await page.$$eval('.steps li', els => els.length), 3)
      await page.click('[data-act="close"]')
      assert.match(await page.textContent('.row.task:has-text("Piscine")'), /après la coche/)
    })
    await t.test('a calendar file and a picture shared by another app', async () => {
      const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:club\r\nSUMMARY:Entraînement\r\nDTSTART:20261020T180000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR'
      await page.evaluate(text => window.app.action({ type: 'ics', text: text }), ics)
      assert.match(await page.textContent('#snack'), /1 ajoutés, 0 mis à jour/)
      await page.evaluate(text => window.app.action({ type: 'ics', text: text }), ics)
      assert.match(await page.textContent('#snack'), /0 ajoutés, 0 mis à jour/) // no duplicate
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      await page.evaluate(src => window.app.action({ type: 'image', src: src, text: 'Ticket de caisse' }), png)
      await page.waitForSelector('#sheet .photos img')
      await page.click('[data-act="close"]')
    })
    await t.test('a backup file: replace puts back exactly its content, undo too', async () => {
      await page.click('#nav [data-tab="plus"]')
      const file = { tasks: [{ id: 'b1', text: 'Depuis la sauvegarde', updatedAt: t0 - 1000 }], notes: [], events: [], settings: { evening: '18:00' } }
      const chooser = page.waitForEvent('filechooser')
      await page.click('[data-act="import-json"]')
      await (await chooser).setFiles({ name: 'mon-orga.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) })
      await page.click('.dlg-actions button:has-text("Remplacer")')
      await page.click('.dlg-actions button:has-text("Oui")') // its settings too
      await page.click('#nav [data-tab="tasks"]')
      assert.deepEqual(await page.$$eval('#main .row.task .title', els => els.map(e => e.textContent)), ['Depuis la sauvegarde'])
      await page.click('#nav [data-tab="plus"]')
      assert.equal(await page.inputValue('select[data-set="evening"]'), '"18:00"')
    })
    await t.test('a text file becomes one note per block', async () => {
      const chooser = page.waitForEvent('filechooser')
      await page.click('[data-act="import-json"]')
      await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Recette\nfarine\n———\nCodes\nwifi 1234\n\n\n\nIdées\ncadeau') })
      await page.click('.dlg-actions button:has-text("3 notes")')
      await page.click('#nav [data-tab="notes"]')
      assert.equal(await page.$$eval('.card.note', els => els.length), 3) // "replace" took the picture note away
    })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close(); server.close()
  }
})

test('5.1.1: settings from 5.0 and 5.1, call and directions, priorities typed, archived lists, conflicts, progress picture', { skip: !playwright && 'playwright is not installed' }, async t => {
  const server = await serve(0)
  const url = 'http://127.0.0.1:' + server.address().port + '/index.html'
  const browser = await playwright.chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, locale: 'fr-FR', timezoneId: 'Europe/Paris', acceptDownloads: true })
  const t0 = NOW.getTime()
  await ctx.addInitScript(t0 => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('mon-orga-doc', JSON.stringify({
      tasks: [{ id: 'g', text: 'Rappeler le garage 06 12 34 56 78', due: '2026-10-16T14:00', place: '3 rue des Lilas', list: 'Voiture' }, { id: 'h', text: 'Ancien projet', list: 'Projet X' }],
      events: [{ id: 'd', text: 'Dentiste 04 72 00 00 00', day: '2026-10-16', time: '16:30', remind: [60] }, { id: 'o', text: 'Ophtalmo', day: '2026-11-03', time: '10:00', remind: [15] }],
      notes: [{ id: 'n', text: 'Courses', updatedAt: t0 }, { id: 'n-c1', text: 'Courses (autre)', conflictOf: 'n', updatedAt: t0 - 1 }],
      history: [(t0 - 86400000) + ':g'],
    }))
    localStorage.setItem('mon-orga-settings', JSON.stringify({ welcomed: true, news: 51, remindEvent: [15], nag: 0, summary: null, snooze: 10 })) // 5.0 then 5.1: the old values, news seen
  }, t0)
  const page = await ctx.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.clock.setFixedTime(NOW)
  try {
    await page.goto(url); await page.waitForSelector('#addInput')
    await t.test('coming from 5.0 through 5.1: the new defaults, said once, planned events too if asked', async () => {
      const text = await page.textContent('.dlg')
      assert.match(text, /5\.2[\s\S]*Nouveaux réglages par défaut[\s\S]*comme à un assistant/) // 5.1.1, then 5.2
      assert.doesNotMatch(text, /tous les 3 mois/) // the 5.1 list was already seen
      assert.ok(await page.$('.dlg .menu-item:has-text("Garder mes anciens réglages de rappel")')) // they may have been chosen on purpose
      await page.click('.dlg .menu-item:has-text("Appliquer aussi au rendez-vous déjà prévu")')
      const s = await page.evaluate(() => JSON.parse(localStorage.getItem('mon-orga-settings')))
      assert.deepEqual([s.remindEvent, s.nag, s.summary, s.news, s.before511], [[60, 1440], 10, '08:00', 53, null])
      const remind = id => page.evaluate(id => JSON.parse(localStorage.getItem('mon-orga-doc')).events.find(e => e.id === id).remind, id)
      assert.deepEqual([await remind('o'), await remind('d')], [[60, 1440], [60]]) // only the old default changes
    })
    await t.test('a number and a place: call and directions on the rows', async () => {
      assert.ok(await page.$('.row.task[data-id="g"] .call[data-href="tel:0612345678"]'))
      assert.match(await page.getAttribute('.row.task[data-id="g"] .route', 'data-href'), /maps.*3%20rue%20des%20Lilas/)
      await page.click('#nav [data-tab="agenda"]')
      assert.ok(await page.$('.row.event[data-id="d"] .call[data-href="tel:0472000000"]'))
    })
    await t.test('priority from the editor, sorted first', async () => {
      await page.click('#nav [data-tab="tasks"]')
      await page.click('.row.task[data-id="h"] .body')
      await page.click('[data-act="prio"][data-v="3"]')
      await page.click('[data-act="close"]')
      assert.match(await page.textContent('.row.task[data-id="h"]'), /!!!/)
    })
    await t.test('typed: the priority is kept, a number after the address stays in the title', async () => {
      await page.fill('#addInput', 'Relire la maquette !!! demain')
      await page.press('#addInput', 'Enter')
      assert.match(await page.textContent('.row.task:has-text("Relire la maquette")'), /!!!/)
      await page.fill('#addInput', 'Fuite demain 14h 3 bis avenue Foch 06.12.34.56.78')
      assert.match(await page.textContent('#addHint'), /3 bis avenue Foch/) // the place found, before saving
      await page.press('#addInput', 'Enter')
      const row = '.row.task:has-text("Fuite")'
      assert.ok(await page.$(row + ' .call[data-href="tel:0612345678"]'))
      assert.match(await page.getAttribute(row + ' .route', 'data-href'), /query=3%20bis%20avenue%20Foch$/)
    })
    await t.test('the assistant: a typed sentence goes to the agenda, the notes or a list', async () => {
      await page.fill('#addInput', "J'ai rendez-vous chez le dentiste jeudi à 14h30")
      assert.match(await page.textContent('#addHint'), /Dans l’agenda/) // said before saving
      await page.press('#addInput', 'Enter')
      assert.match(await page.textContent('#snack'), /Rendez-vous ajouté/)
      await page.fill('#addInput', 'Note que le code du portail est 1234')
      await page.press('#addInput', 'Enter')
      await page.fill('#addInput', 'Ajoute du lait à la liste des courses')
      assert.match(await page.textContent('#addHint'), /Courses/)
      await page.press('#addInput', 'Enter')
      const doc = await page.evaluate(() => JSON.parse(localStorage.getItem('mon-orga-doc')))
      assert.ok(doc.events.some(e => e.text === 'Dentiste' && e.day === '2026-10-22' && e.time === '14:30'))
      assert.ok(doc.notes.some(n => n.text === 'Le code du portail est 1234'))
      assert.ok(doc.tasks.some(x => x.text === 'Lait' && x.list === 'Courses'))
    })
    await t.test('an archived list leaves the screen and comes back', async () => {
      await page.click('#nav [data-tab="plus"]')
      await page.click('[data-act="list-archive"][data-v="Projet X"]')
      await page.click('#nav [data-tab="tasks"]')
      assert.equal(await page.$('.row.task[data-id="h"]'), null)
      await page.click('#nav [data-tab="plus"]')
      await page.click('[data-act="list-archive"][data-v="Projet X"]')
      await page.click('#nav [data-tab="tasks"]')
      assert.ok(await page.$('.row.task[data-id="h"]'))
    })
    await t.test('a sync conflict copy says what it is', async () => {
      await page.click('#nav [data-tab="notes"]')
      assert.match(await page.textContent('.card.note:has-text("Courses (autre)")'), /Conflit/)
    })
    await t.test('my progress as a picture', async () => {
      await page.click('#nav [data-tab="plus"]')
      const download = page.waitForEvent('download')
      await page.click('[data-act="share-progress"]')
      assert.equal((await download).suggestedFilename(), 'mon-orga-progres.png')
    })
    await t.test('Ctrl+Enter saves and closes an editor', async () => {
      await page.click('#nav [data-tab="tasks"]')
      await page.click('.row.task[data-id="g"] .body')
      await page.keyboard.press('Control+Enter')
      assert.equal(await page.$('#sheet:not([hidden])'), null)
    })
    await t.test('reminder settings chosen in 5.1 can be kept', async () => {
      const c2 = await browser.newContext({ viewport: { width: 412, height: 860 }, locale: 'fr-FR', timezoneId: 'Europe/Paris' })
      await c2.addInitScript(() => { if (!localStorage.getItem('mon-orga-settings')) localStorage.setItem('mon-orga-settings', JSON.stringify({ welcomed: true, news: 51, remindEvent: [15], nag: 0, summary: null })) })
      const p2 = await c2.newPage()
      await p2.clock.setFixedTime(NOW)
      await p2.goto(url)
      await p2.click('.dlg .menu-item:has-text("Garder mes anciens réglages de rappel")')
      const s = await p2.evaluate(() => JSON.parse(localStorage.getItem('mon-orga-settings')))
      assert.deepEqual([s.remindEvent, s.nag, s.summary, s.news], [[15], 0, null, 53])
      await c2.close()
    })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close(); server.close()
  }
})
