/* What the page can ask its host: the Android app (window.Android), the PC app (window.desktop),
 * a phone reached from a browser (?k=code), or nothing (local storage, for a quick try). Same API everywhere. */
(function () {
  'use strict'
  const listeners = []
  const pending = {}
  let seq = 0
  const changed = () => listeners.forEach(f => { try { f() } catch (e) { console.error(e) } })
  // The Android app answers long actions (file pickers, voice) here, and signals data changed elsewhere.
  window.__hostResult = function (id, value) { const p = pending[id]; if (p) { delete pending[id]; p(value) } }
  window.__hostChanged = changed
  const wait = start => new Promise(res => { const id = 'r' + (++seq); pending[id] = res; start(id) })
  const json = (s, fallback) => { try { return s ? JSON.parse(s) : fallback } catch (e) { return fallback } }

  function store(key) {
    return {
      get: fallback => { try { return json(localStorage.getItem(key), fallback) } catch (e) { return fallback } },
      set: v => { try { localStorage.setItem(key, JSON.stringify(v)) } catch (e) { /* private mode: keep going */ } },
    }
  }
  function download(name, mime, text) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name
    document.body.appendChild(a); a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 2000)
    return Promise.resolve(true)
  }
  function pick(accept) {
    return new Promise(res => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = accept
      input.onchange = () => {
        const f = input.files[0]; if (!f) return res(null)
        const r = new FileReader(); r.onload = () => res({ name: f.name, text: r.result }); r.onerror = () => res(null); r.readAsText(f)
      }
      input.click()
    })
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => false)
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'
    document.body.appendChild(t); t.select(); let ok = false
    try { ok = document.execCommand('copy') } catch (e) { /* not allowed */ }
    t.remove(); return Promise.resolve(ok)
  }
  const browserBits = {
    exportFile: download, importFile: pick, copy: copyText,
    openUrl: url => { window.open(url, '_blank', 'noopener') },
    share: navigator.share ? (title, text) => navigator.share({ title: title, text: text }).catch(() => {}) : null,
    onChange: f => listeners.push(f),
  }

  function android(A) {
    const info = json(A.info(), {})
    const has = name => typeof A[name] === 'function'
    const value = v => (typeof v === 'string' ? json(v, null) : v) // async answers come as JSON text or as a value
    return {
      platform: 'android', version: info.version, info: info,
      can: { voice: !!info.voice, share: true, files: true, photos: true, camera: !!info.camera, lock: true, diagnostics: true, sync: 'server', haptic: true, alarms: true },
      load: () => Promise.resolve(json(A.load(), {})),
      save: doc => { const r = json(A.save(JSON.stringify(doc)), null); return r && r.error ? Promise.reject(new Error(r.error)) : Promise.resolve(r) }, // "storage": the phone is full
      loadSettings: () => Promise.resolve(json(A.settings(), {})),
      saveSettings: s => Promise.resolve(A.saveSettings(JSON.stringify(s))),
      onChange: f => listeners.push(f),
      share: (title, text) => A.share(title || '', text),
      copy: text => Promise.resolve(A.copy(text)),
      exportFile: (name, mime, text) => wait(id => A.exportFile(id, name, mime, text)).then(Boolean),
      importFile: accept => wait(id => A.importFile(id, accept)).then(v => json(v, null)),
      voice: () => wait(id => A.voice(id)),
      openUrl: url => A.openUrl(url),
      notifyPermission: () => wait(id => A.notifyPermission(id)).then(Boolean),
      diagnostics: () => Promise.resolve(json(A.diagnostics(), [])),
      fix: key => A.fix(key),
      testAlarm: loud => A.testAlarm(!!loud),
      haptic: () => A.haptic(),
      syncInfo: () => Promise.resolve(json(A.syncInfo(), {})),
      syncSet: on => Promise.resolve(json(A.syncSet(!!on), {})),
      syncNewCode: has('syncNewCode') ? () => Promise.resolve(json(A.syncNewCode(), {})) : null,
      startAction: () => json(A.takeAction(), null),
      theme: has('theme') ? dark => A.theme(!!dark) : null,
      deviceEvents: has('deviceEvents') ? (from, to) => wait(id => A.deviceEvents(id, from, to)).then(value) : null,
      addToCalendar: has('addToCalendar') ? e => A.addToCalendar(JSON.stringify(e)) : null,
      chooseBackupFolder: has('chooseBackupFolder') ? () => wait(id => A.chooseBackupFolder(id)).then(value) : null,
      clearBackupFolder: has('clearBackupFolder') ? () => Promise.resolve(A.clearBackupFolder()) : null,
      backupInfo: has('backupInfo') ? () => Promise.resolve(json(A.backupInfo(), {})) : null,
      testAlarmIn: has('testAlarmIn') ? (minutes, loud) => A.testAlarmIn(minutes, !!loud) : null,
      shareImage: has('shareImage') ? (src, text) => A.shareImage(src, text || '') : null,
    }
  }

  function desktop(D) {
    if (D.onAction) D.onAction(a => window.app && window.app.action(a)) // tray menu, notification clicks
    return Object.assign({}, browserBits, {
      platform: 'desktop', version: D.version,
      can: { files: true, photos: true, sync: 'client', tray: true, alarms: true },
      load: () => D.load(), save: doc => D.save(doc),
      loadSettings: () => D.loadSettings(), saveSettings: s => D.saveSettings(s),
      onChange: f => D.onChange(f),
      exportFile: (name, mime, text) => D.exportFile(name, mime, text),
      importFile: accept => D.importFile(accept),
      openUrl: url => D.openUrl(url), copy: text => D.copy(text), share: null,
      testAlarm: loud => D.testAlarm(!!loud),
      syncInfo: () => D.syncInfo(), syncConnect: (address, code) => D.syncConnect(address, code),
      syncScan: () => D.syncScan(), syncNow: () => D.syncNow(), syncForget: () => D.syncForget(),
      chooseBackupFolder: D.chooseBackupFolder ? () => D.chooseBackupFolder() : null,
      clearBackupFolder: D.clearBackupFolder ? () => D.clearBackupFolder() : null,
      backupInfo: D.backupInfo ? () => D.backupInfo() : null,
      startAction: () => null,
    })
  }

  // A browser on the PC, served by the phone ("Version PC" switch): the phone keeps the data, we poll it.
  function remote(code) {
    const settings = store('mon-orga-settings')
    let last = ''
    const api = (path, body) => fetch(path + '?k=' + encodeURIComponent(code), body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }
      : { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
    const status = { ok: true, at: 0 }
    setInterval(() => api('/api/state').then(d => {
      status.ok = true; status.at = Date.now()
      const s = JSON.stringify(d); if (s !== last) { last = s; changed() }
    }).catch(() => { if (status.ok) { status.ok = false; changed() } }), 4000)
    return Object.assign({}, browserBits, {
      platform: 'browser', can: { files: true, photos: true, sync: 'remote', share: !!navigator.share },
      load: () => api('/api/state').then(d => { last = JSON.stringify(d); status.ok = true; status.at = Date.now(); return d }),
      save: doc => api('/api/sync', doc).then(d => { last = JSON.stringify(d); status.ok = true; status.at = Date.now(); return d }),
      loadSettings: () => Promise.resolve(settings.get({})), saveSettings: s => Promise.resolve(settings.set(s)),
      syncInfo: () => Promise.resolve({ connected: status.ok, last: status.at }),
      startAction: () => null,
    })
  }

  function local() {
    const data = store('mon-orga-doc'); const settings = store('mon-orga-settings')
    return Object.assign({}, browserBits, {
      platform: 'web', can: { files: true, photos: true },
      load: () => Promise.resolve(data.get({})), save: doc => { data.set(doc); return Promise.resolve(doc) },
      loadSettings: () => Promise.resolve(settings.get({})), saveSettings: s => Promise.resolve(settings.set(s)),
      startAction: () => null,
    })
  }

  const code = /[?&]k=(\d{6})/.exec(location.search)
  window.Host = window.Android ? android(window.Android)
    : window.desktop ? desktop(window.desktop)
    : code && /^https?:$/.test(location.protocol) ? remote(code[1])
    : local()
})()
