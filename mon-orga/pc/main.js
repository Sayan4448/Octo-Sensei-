// Mon Orga for Windows (and Linux): the same interface as the phone, data in a file on the PC,
// reminders as Windows notifications (the app stays near the clock), sync with the phone over Wi-Fi.
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, Tray, Menu, nativeTheme, protocol, net, powerMonitor, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const phone = require('./sync.js')
const rules = require('./rules.js')

const WEB = app.isPackaged ? path.join(__dirname, 'web') : path.join(__dirname, '..', 'web', 'src')
const Store = require(path.join(WEB, 'store.js'))
const HIDDEN = process.argv.includes('--hidden') // started with Windows: stay in the tray
const MISSED_WINDOW = 12 * 3600000

if (process.env.MON_ORGA_DATA) app.setPath('userData', process.env.MON_ORGA_DATA) // tests, or a copy on a USB key
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
if (!app.requestSingleInstanceLock()) app.quit()
app.setAppUserModelId('com.sayan.monorga')

// ---------- files ----------
const dir = () => app.getPath('userData')
const file = name => path.join(dir(), name)
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) } catch (e) {
    if (fs.existsSync(file(name))) try { fs.copyFileSync(file(name), file(name + '.unreadable')) } catch (e2) { /* keep going */ }
    return fallback
  }
}
function writeJson(name, value) { // write then rename: a crash never leaves half a file
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(file(name + '.tmp'), JSON.stringify(value))
  fs.renameSync(file(name + '.tmp'), file(name))
}
let doc = null; let settings = null; let local = null
function loadAll() {
  doc = Store.normalize(readJson('mon-orga.json', {}))
  settings = readJson('settings.json', {})
  local = Object.assign({ snoozes: {}, nags: {}, lastCheck: Date.now(), lastSummary: null, sync: null, backup: null }, readJson('local.json', {}))
}
function saveDoc(next) {
  doc = Store.purge(Store.normalize(next), Date.now())
  writeJson('mon-orga.json', doc)
  const backup = file('mon-orga.backup.json') // one copy a day, in case of a mistake
  try { if (!fs.existsSync(backup) || Date.now() - fs.statSync(backup).mtimeMs > 86400000) fs.copyFileSync(file('mon-orga.json'), backup) } catch (e) { /* not vital */ }
}
const saveLocal = () => writeJson('local.json', local)
function writeBackup(now) { // one copy a day in the folder chosen by the user (a USB key, a synced drive…); a failure is retried next tick
  try { rules.backup(local.backup.path, Store.today(now), Object.assign({}, doc, { settings })); local.backup.last = now } catch (e) { console.error('backup', e.message) }
}
const folderName = p => path.basename(p) || p // D:\ has no base name

// ---------- words ----------
const WORDS = {
  fr: { open: 'Ouvrir Mon Orga', newTask: 'Nouvelle tâche', syncNow: 'Synchroniser avec le téléphone', quit: 'Quitter', stillHere: 'Mon Orga reste actif près de l’horloge pour les rappels.',
    test: 'Rappel de test', testText: 'Les rappels fonctionnent ✓', testText_s: 'Les rappels fonctionnent.', focusDone: 'C’est la pause !', focusDone_s: 'Pause conseillée',
    focusText: '25 minutes de focus sur « {0} »', pauseDone: 'Pause terminée, on y retourne ?', pauseDone_s: 'Pause terminée', allDay: 'Journée',
    lateSince: 'En retard depuis {0}', missed: '{0} rappels manqués', summary: 'Ta journée : {0}', summary_s: 'Aujourd’hui : {0}',
    todo: '☐ {0}', todo_s: '• {0}', late: '⚠ {0}', late_s: '• {0} (en retard)', save: 'Enregistrer', importTitle: 'Importer' },
  en: { open: 'Open Mon Orga', newTask: 'New task', syncNow: 'Sync with the phone', quit: 'Quit', stillHere: 'Mon Orga keeps running near the clock for reminders.',
    test: 'Test reminder', testText: 'Reminders work ✓', testText_s: 'Reminders work.', focusDone: 'Break time!', focusDone_s: 'A break is advised',
    focusText: '25 minutes of focus on “{0}”', pauseDone: 'Break over, back to it?', pauseDone_s: 'Break over', allDay: 'All day',
    lateSince: 'Overdue since {0}', missed: '{0} missed reminders', summary: 'Your day: {0}', summary_s: 'Today: {0}',
    todo: '☐ {0}', todo_s: '• {0}', late: '⚠ {0}', late_s: '• {0} (overdue)', save: 'Save', importTitle: 'Import' },
}
function lang() { const l = settings && settings.lang; return l === 'fr' || l === 'en' ? l : (/^fr/i.test(app.getLocale()) ? 'fr' : 'en') }
function w(key, arg) {
  const words = WORDS[lang()]
  if (settings && settings.sober && words[key + '_s']) key += '_s' // sober mode: no emoji, no "tu"
  return (words[key] || key).split('{0}').join(arg === undefined ? '' : arg) // not replace(): a "$" in a task title stays as is
}
const timeText = ms => new Date(ms).toLocaleTimeString(lang() === 'fr' ? 'fr-FR' : undefined, { hour: '2-digit', minute: '2-digit' })

// ---------- window, tray ----------
let win = null; let tray = null; let quitting = false; let toldTray = false
function createWindow(show) {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 360, minHeight: 480, show: false, title: 'Mon Orga', autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141218' : '#FEF7FF',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  })
  win.removeMenu()
  win.loadURL('app://mon-orga/index.html')
  if (show) win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); openExternal(url) } })
  win.webContents.on('context-menu', (e, p) => { // copy / paste with the mouse
    const items = p.isEditable ? [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
      : p.selectionText ? [{ role: 'copy' }] : []
    if (items.length) Menu.buildFromTemplate(items).popup()
  })
  win.on('close', e => {
    if (quitting || settings.tray === false) return
    e.preventDefault(); win.hide()
    if (!toldTray) { toldTray = true; notify({ title: 'Mon Orga', body: w('stillHere') }) }
  })
}
function showWindow() { if (!win) createWindow(true); else { if (win.isMinimized()) win.restore(); win.show(); win.focus() } }
function sendAction(a) { showWindow(); const go = () => win.webContents.send('action', a); if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go); else go() }
function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 }))
    tray.setToolTip('Mon Orga')
    tray.on('click', showWindow)
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: w('open'), click: showWindow },
    { label: w('newTask'), click: () => sendAction({ type: 'add-task' }) },
    { label: w('syncNow'), enabled: !!local.sync, click: () => syncWithPhone() },
    { type: 'separator' },
    { label: w('quit'), click: () => { quitting = true; app.quit() } },
  ]))
}
function openExternal(url) { if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url) }

// ---------- reminders ----------
const shown = new Set() // keep notifications referenced, or their click is lost
function notify(o, onClick) {
  if (!Notification.isSupported()) return
  const silent = o.timeoutType !== 'never' && rules.quiet(settings.quietFrom, settings.quietTo, Store.hm(new Date())) // quiet hours: only loud ones sound
  const n = new Notification(Object.assign({ icon: path.join(__dirname, 'build', 'icon.png'), silent }, o))
  shown.add(n)
  n.on('click', () => { shown.delete(n); if (onClick) onClick(); else showWindow() })
  n.on('close', () => shown.delete(n))
  n.show()
}
function localState() { return { snoozes: local.snoozes, summary: settings.summary || null, focus: settings.focus || null } }
let timer = null
function schedule() {
  clearTimeout(timer)
  const now = Date.now()
  const next = Store.nextAlarm(doc, localState(), Math.max(local.lastCheck, now - MISSED_WINDOW))
  // At most an hour of sleep: the PC may have slept, or the clock changed.
  timer = setTimeout(tick, Math.max(0, Math.min(next === null ? Infinity : next - now, 3600000)))
}
function describe(a, item) {
  const task = a.kind === 'task'
  const allDay = task ? item.due && item.due.length === 10 : !item.time
  let when = allDay ? w('allDay') : task ? timeText(a.occurrence) : item.time // a re-ring keeps the event's own time
  if (!task && item.end) when += ' – ' + item.end
  if (task && a.occurrence < Date.now() - 60000) when = w('lateSince', when)
  return [when, task ? '' : item.place, item.details && item.details.split('\n')[0]].filter(Boolean).join(' · ')
}
function tick() {
  const now = Date.now()
  rules.answered(local, id => Store.find(doc, id)) // ticked or changed since it rang: answered
  const due = Store.alarms(doc, localState(), Math.max(local.lastCheck, now - MISSED_WINDOW), now)
  local.lastCheck = now
  Object.keys(local.snoozes).forEach(id => { if (local.snoozes[id] <= now) delete local.snoozes[id] })
  const rings = due.filter(a => a.kind === 'task' || a.kind === 'event').filter((a, i, all) => all.findIndex(b => b.id === a.id) === i)
  // Reminders due now ring one by one; a pile missed while the PC slept comes as one notification.
  const late = rings.filter(a => a.at < now - 120000)
  if (late.length > 3) notify({ title: w('missed', late.length), body: late.slice(0, 6).map(a => a.title).join('\n') })
  rings.filter(a => late.length <= 3 || a.at >= now - 120000).forEach(a => {
    const item = Store.find(doc, a.id); if (!item) return
    const loud = a.loud || !!settings.loudAll
    notify({ title: a.title, body: describe(a, item), urgency: loud || a.important ? 'critical' : 'normal', timeoutType: loud ? 'never' : 'default' },
      () => { delete local.snoozes[a.id]; delete local.nags[a.id]; saveLocal(); sendAction({ type: 'open', id: a.id }) }) // a click answers: no more re-rings
  })
  rules.nag(rings, local, settings, now)
  if (due.some(a => a.kind === 'summary')) summary(now)
  const focus = due.find(a => a.kind === 'focus')
  if (focus) notify(settings.focus && settings.focus.pause ? { title: w('pauseDone') } : { title: w('focusDone'), body: w('focusText', focus.title) })
  if (local.backup && Store.today(local.backup.last) !== Store.today(now)) writeBackup(now)
  saveLocal()
  schedule()
}
function summary(now) {
  const day = Store.today(now)
  if (local.lastSummary === day) return
  local.lastSummary = day
  const tasks = Store.live(doc.tasks).filter(t => !t.done && t.due && Store.dayOf(t.due) <= day)
  const events = Store.eventsOn(doc.events, day)
  const lines = tasks.map(t => w(Store.dayOf(t.due) < day ? 'late' : 'todo', t.text)).concat(events.map(e => '• ' + (e.time ? e.time + ' ' : '') + e.text))
  if (lines.length) notify({ title: w('summary', lines.length), body: lines.slice(0, 6).join('\n') })
}

// ---------- phone ----------
let syncing = null; let syncSoon = null
const status = { ok: false, error: null, last: 0 }
function changed() { if (win) win.webContents.send('changed') }
async function syncWithPhone() {
  if (!local.sync) return { ok: false }
  if (syncing) return syncing
  syncing = (async () => {
    try {
      const since = local.sync.last || 0 // a note changed on both sides since then keeps both texts
      const started = Date.now()
      const back = await phone.sync(local.sync.address, local.sync.code, doc, since, local.sync)
      const merged = Store.merge(doc, back, since)
      if (JSON.stringify(merged) !== JSON.stringify(doc)) { saveDoc(merged); schedule(); changed() }
      local.sync.last = started; saveLocal()
      Object.assign(status, { ok: true, error: null, last: Date.now() })
      return { ok: true }
    } catch (e) {
      Object.assign(status, { ok: false, error: e.code || 'unreachable' })
      return { ok: false, error: status.error }
    } finally { syncing = null }
  })()
  return syncing
}
setInterval(() => { if (local && local.sync) syncWithPhone() }, 15000)

// ---------- what the page can ask (window.desktop) ----------
ipcMain.on('version', e => { e.returnValue = app.getVersion() })
ipcMain.handle('load', () => doc)
ipcMain.handle('save', (e, incoming) => {
  saveDoc(Store.merge(doc, incoming))
  local.lastCheck = Math.max(local.lastCheck, Date.now() - 5 * 60000); saveLocal() // a task just dated in the past does not ring
  schedule()
  clearTimeout(syncSoon); syncSoon = setTimeout(syncWithPhone, 1500)
  return doc
})
ipcMain.handle('loadSettings', () => settings)
ipcMain.handle('saveSettings', (e, s) => {
  settings = s || {}; writeJson('settings.json', settings)
  app.setLoginItemSettings({ openAtLogin: !!settings.login, args: ['--hidden'] })
  buildTray(); schedule()
})
ipcMain.handle('exportFile', async (e, name, mime, text) => {
  const ext = path.extname(name).slice(1) || 'txt'
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }], buttonLabel: w('save') })
  if (r.canceled || !r.filePath) return false
  fs.writeFileSync(r.filePath, text, 'utf8'); return true
})
ipcMain.handle('importFile', async () => {
  const r = await dialog.showOpenDialog(win, { title: w('importTitle'), properties: ['openFile'], filters: [{ name: 'Mon Orga, .ics, .txt', extensions: ['json', 'ics', 'txt'] }, { name: '*', extensions: ['*'] }] })
  if (r.canceled || !r.filePaths[0]) return null
  return { name: path.basename(r.filePaths[0]), text: fs.readFileSync(r.filePaths[0], 'utf8') }
})
ipcMain.handle('chooseBackupFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled || !r.filePaths[0]) return null
  local.backup = { path: r.filePaths[0], last: 0 }; writeBackup(Date.now()); saveLocal()
  return { name: folderName(local.backup.path), path: local.backup.path }
})
ipcMain.handle('clearBackupFolder', () => { local.backup = null; saveLocal(); return true })
ipcMain.handle('backupInfo', () => { const b = local.backup; return b ? { folder: folderName(b.path), path: b.path, last: b.last } : { folder: null, path: null, last: 0 } })
ipcMain.handle('openUrl', (e, url) => openExternal(url))
ipcMain.handle('copy', (e, text) => { clipboard.writeText(text); return true })
ipcMain.handle('testAlarm', (e, loud) => setTimeout(() => notify({ title: w('test'), body: w('testText'), timeoutType: loud ? 'never' : 'default', urgency: loud ? 'critical' : 'normal' }), 5000))
ipcMain.handle('syncInfo', () => local.sync ? { address: local.sync.address, code: local.sync.code, name: local.sync.name, ok: status.ok, last: status.last, error: status.error } : { error: status.error })
ipcMain.handle('syncScan', () => phone.scan())
ipcMain.handle('syncConnect', async (e, input, code) => {
  const address = phone.normalizeAddress(input); code = (code || phone.codeFrom(input) || '').trim()
  if (!address) return { ok: false, error: 'badAddress' }
  if (!/^\d{6}$/.test(code)) return { ok: false, error: 'badCode' }
  const pong = await phone.ping(address, 3000).catch(() => null)
  if (!pong) { status.error = 'unreachable'; return { ok: false, error: 'unreachable' } }
  try { await phone.state(address, code) } catch (err) { status.error = err.code; return { ok: false, error: err.code || 'connectFailed' } }
  local.sync = { address, code, name: pong.name || address }; saveLocal(); buildTray()
  return syncWithPhone()
})
ipcMain.handle('syncNow', () => syncWithPhone())
ipcMain.handle('syncForget', () => { local.sync = null; status.ok = false; status.error = null; saveLocal(); buildTray() })

// ---------- start ----------
app.on('second-instance', showWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && settings && settings.tray === false) app.quit() })
app.on('before-quit', () => { quitting = true })
app.whenReady().then(() => {
  protocol.handle('app', req => {
    const p = path.normalize(path.join(WEB, decodeURIComponent(new URL(req.url).pathname)))
    if (!p.startsWith(WEB)) return new Response('', { status: 403 })
    return net.fetch(pathToFileURL(p).toString())
  })
  loadAll()
  buildTray()
  createWindow(!HIDDEN)
  powerMonitor.on('resume', () => { tick(); syncWithPhone() }) // reminders missed while the PC slept
  tick()
  if (local.sync) syncWithPhone()
})
