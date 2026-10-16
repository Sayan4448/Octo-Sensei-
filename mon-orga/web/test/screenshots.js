// Regenerates the README screenshots: node test/screenshots.js  (needs playwright)
const path = require('path')
const serve = require('./serve.js')
let playwright
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { playwright = require(p); break } catch (e) { /* next */ } }
const out = path.join(__dirname, '..', '..', 'docs')
const NOW = new Date('2026-10-16T09:30:00+02:00') // a Friday morning
const day = n => { const d = new Date(2026, 9, 16 + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
const t0 = NOW.getTime()
const demo = {
  tasks: [
    { id: 't1', text: 'Payer la cantine', due: day(-1), remind: [0], list: 'Maison' },
    { id: 't2', text: 'Médicament', due: day(1) + 'T08:00', remind: [0], repeat: 'daily', important: true, loud: true },
    { id: 't3', text: 'Appeler le garage', due: day(0) + 'T14:00', remind: [0, 30], list: 'Voiture' },
    { id: 't4', text: 'Réviser le contrôle de maths', due: day(3), remind: [0], list: 'École', steps: [{ text: 'Chapitre 4', done: true }, { text: 'Exercices p. 52', done: true }, { text: 'Fiche de révision', done: false }, { text: 'Refaire le contrôle blanc', done: false }] },
    { id: 't5', text: 'Sortir les poubelles', due: day(4) + 'T19:00', remind: [0], repeat: 'weekly:2', list: 'Maison' },
    { id: 't6', text: 'Acheter des piles pour la manette 🎮' },
    { id: 't7', text: 'Ranger le linge', done: true, doneAt: t0 - 3600000 },
  ],
  notes: [
    { id: 'n1', text: 'Courses\n- [x] Lait\n- [ ] Pain\n- [ ] Tomates\n- [x] Céréales', pinned: true, updatedAt: t0 - 7200000 },
    { id: 'n2', text: 'Idées cadeaux #anniv\nLéa : un jeu de société\nMamie : un cadre photo', updatedAt: t0 - 86400000 },
    { id: 'n3', text: 'Wi-Fi chez papi\nRéseau : Livebox-42\nMot de passe sur le frigo 😄', updatedAt: t0 - 3 * 86400000 },
    { id: 'n4', text: 'Recette des crêpes\n250 g de farine, 4 œufs, 50 cl de lait\nhttps://www.marmiton.org', updatedAt: t0 - 5 * 86400000 },
  ],
  events: [
    { id: 'e1', text: 'Dentiste', day: day(0), time: '16:30', end: '17:00', place: 'Cabinet du Dr Martin', remind: [60] },
    { id: 'e2', text: 'Foot', day: day(-2), time: '18:00', end: '19:30', repeat: 'weekly', remind: [30], list: 'Sport' },
    { id: 'e3', text: 'Anniversaire de Léa 🎂', day: day(5), time: null, repeat: 'yearly', remind: [0, 1440] },
    { id: 'e4', text: 'Vacances', day: day(8), endDay: day(15), time: null, remind: [] },
  ],
  history: [1, 2, 3, 4, 5].map(i => (t0 - i * 86400000) + ':h' + i).concat([(t0 - 3600000) + ':t7']),
}
;(async () => {
  const server = await serve(0)
  const url = 'http://127.0.0.1:' + server.address().port + '/index.html'
  const browser = await playwright.chromium.launch({ args: ['--lang=fr-FR'], env: Object.assign({}, process.env, { LANG: 'fr_FR.UTF-8', LANGUAGE: 'fr' }) }) // date fields in French format
  async function shot(name, { width, height, dark, setup }) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'fr-FR', timezoneId: 'Europe/Paris', colorScheme: dark ? 'dark' : 'light' })
    await ctx.addInitScript(d => {
      localStorage.setItem('mon-orga-doc', JSON.stringify(d))
      localStorage.setItem('mon-orga-settings', JSON.stringify({ welcomed: true }))
    }, demo)
    const page = await ctx.newPage()
    await page.clock.setFixedTime(NOW)
    await page.goto(url)
    await page.waitForSelector('#main')
    if (setup) await setup(page)
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(out, name) })
    await ctx.close()
  }
  const phone = { width: 390, height: 844 }
  await shot('phone-tasks.png', phone)
  await shot('phone-editor.png', Object.assign({}, phone, { setup: p => p.click('.row.task:has-text("Réviser") .body') }))
  await shot('phone-agenda-dark.png', Object.assign({}, phone, { dark: true, setup: p => p.click('#nav [data-tab="agenda"]') }))
  await shot('phone-notes.png', Object.assign({}, phone, { setup: p => p.click('#nav [data-tab="notes"]') }))
  await shot('pc.png', { width: 1280, height: 800, setup: p => p.click('.row.task:has-text("Appeler le garage") .body') })
  await browser.close(); server.close()
  console.log('screenshots in', out)
})().catch(e => { console.error(e); process.exit(1) })
