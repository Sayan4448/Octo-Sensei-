/* Mon Orga: the data model, shared by the phone (WebView), the PC app (Electron) and the tests (Node).
 *
 * One JSON document, merged item by item (newest `updatedAt` wins), so the phone, the PC and a backup file
 * can each be edited offline and synced later. The Android side (Store.kt) reads the same format.
 *
 *  task  {id, createdAt, updatedAt, deleted, text, done, due, remind, repeat, until, important, prio (1-3 when important), list, steps, details, loud, doneAt, place}
 *  note  {id, createdAt, updatedAt, deleted, text, pinned, list, images, conflictOf (a copy kept by a sync conflict)}
 *  event {id, createdAt, updatedAt, deleted, day, time, end, endDay, text, place, details, remind, repeat, until, skip, loud, important, list, noteId}
 *  history "ms:taskId" for each tick, "ms:taskId:x" when that tick was undone (the latest entry of the day wins)
 *  due   "2026-10-17T09:00" (with a time) or "2026-10-17" (a day only: reminders count from 09:00)
 *  remind  minutes before (0 = on time), several allowed: [1440, 60]
 *  repeat  daily | weekdays | weekly | weekly:1,3,5 (1 = Monday) | weeks:N | monthly | months:N | nth:K:D (K-th weekday D
 *          of the month, K = -1 for the last) | yearly | days:N | hours:N; days, weeks and hours may end with
 *          ":after" (counted from the tick: hours:3:after = 3 hours after the last time it was done)
 */
(function (root) {
  'use strict'

  const DAY_MS = 86400000
  const MORNING = '09:00' // reminders of an all-day item count from this time
  const TOMBSTONE_DAYS = 30
  const HISTORY_MAX = 2000

  // ---------- dates: local days "YYYY-MM-DD", local date-times "YYYY-MM-DDTHH:MM" ----------
  const pad = n => (n < 10 ? '0' : '') + n
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  const hm = d => pad(d.getHours()) + ':' + pad(d.getMinutes())
  const stamp = d => ymd(d) + 'T' + hm(d)
  function parseDay(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]) }
  function toDate(s) { // "YYYY-MM-DD" (midnight) or "YYYY-MM-DDTHH:MM"
    const parts = s.split('T'); const d = parseDay(parts[0])
    if (parts[1]) { const t = parts[1].split(':'); d.setHours(+t[0], +t[1], 0, 0) }
    return d
  }
  const ms = s => toDate(s).getTime()
  const dayOf = s => s.slice(0, 10)
  const timeOf = s => (s && s.length > 10 ? s.slice(11, 16) : null)
  function addDays(day, n) { const d = parseDay(day); d.setDate(d.getDate() + n); return ymd(d) }
  const between = (a, b) => Math.round((parseDay(b) - parseDay(a)) / DAY_MS) // whole days, DST-proof
  function weekday(day) { const w = parseDay(day).getDay(); return w === 0 ? 7 : w } // 1 = Monday … 7 = Sunday
  const monthDays = (y, m) => new Date(y, m + 1, 0).getDate() // m is 0-based
  function addMonths(day, n) { // 31 Jan + 1 month = 28/29 Feb, like java.time
    const p = day.split('-').map(Number); const t = p[1] - 1 + n
    const y = p[0] + Math.floor(t / 12); const m = ((t % 12) + 12) % 12
    return y + '-' + pad(m + 1) + '-' + pad(Math.min(p[2], monthDays(y, m)))
  }
  const today = (now) => ymd(new Date(now))

  // ---------- recurrence ----------
  function repeatDays(repeat) { // weekly:1,3 -> [1, 3]
    return repeat.slice(7).split(',').map(Number).filter(n => n >= 1 && n <= 7)
  }
  // First day >= from on which the series (starting `start`) happens, or null when it is over.
  function nextDay(start, repeat, from, until, skip) {
    if (!repeat) return start >= from && !(until && start > until) ? start : null
    let d = from > start ? from : start
    for (let guard = 0; guard < 400; guard++) {
      let c
      const kind = repeat.split(':')[0]; const n = Math.max(1, parseInt(repeat.split(':')[1], 10) || 1)
      if (kind === 'daily' || kind === 'hours') c = d
      else if (kind === 'days' || kind === 'weeks' || repeat === 'weekly') {
        const step = kind === 'days' ? n : 7 * (kind === 'weeks' ? n : 1)
        c = addDays(start, Math.ceil(between(start, d) / step) * step)
      } else if (kind === 'weekdays') { c = d; while (weekday(c) > 5) c = addDays(c, 1) }
      else if (kind === 'weekly') {
        const days = repeatDays(repeat); if (!days.length) return null
        c = d; while (days.indexOf(weekday(c)) < 0) c = addDays(c, 1)
      } else if (kind === 'monthly' || kind === 'yearly' || kind === 'months') {
        const step = kind === 'monthly' ? 1 : kind === 'yearly' ? 12 : n
        const a = start.split('-').map(Number); const b = d.split('-').map(Number)
        let k = Math.max(0, Math.floor(((b[0] - a[0]) * 12 + b[1] - a[1]) / step))
        c = addMonths(start, k * step)
        while (c < d) { k++; c = addMonths(start, k * step) }
      } else if (kind === 'nth') { // nth:2:4 = the 2nd Thursday of each month, nth:-1:5 = the last Friday
        const k = +repeat.split(':')[1]; const wd = +repeat.split(':')[2]
        if (!(wd >= 1 && wd <= 7) || !(k === -1 || (k >= 1 && k <= 5))) return null
        const y = +d.slice(0, 4); const m0 = +d.slice(5, 7) - 1
        c = null
        for (let i = 0; i < 24 && !c; i++) {
          const x = nthWeekday(y + Math.floor((m0 + i) / 12), (m0 + i) % 12, k, wd)
          if (x && x >= d) c = x
        }
        if (!c) return null
      } else return null
      if (until && c > until) return null
      if (!skip || skip.indexOf(c) < 0) return c
      d = addDays(c, 1)
    }
    return null
  }
  const occursOn = (start, repeat, day, until, skip) => nextDay(start, repeat, day, until, skip) === day
  // The k-th weekday wd (1 = Monday) of a month (m from 0), k = -1 for the last one; null when the month has none.
  function nthWeekday(y, m, k, wd) {
    const days = monthDays(y, m)
    let day
    if (k > 0) { const first = new Date(y, m, 1).getDay() || 7; day = 1 + ((wd - first + 7) % 7) + (k - 1) * 7 }
    else { const last = new Date(y, m, days).getDay() || 7; day = days - ((last - wd + 7) % 7) }
    return day <= days ? y + '-' + pad(m + 1) + '-' + pad(day) : null
  }

  // First occurrence strictly after `after` (ms) of a series starting at `start` ("YYYY-MM-DD[THH:MM]").
  function nextOccurrence(start, repeat, until, skip, after) {
    const startMs = ms(start.length > 10 ? start : start + 'T' + MORNING)
    if (startMs > after) return nextDay(dayOf(start), repeat, dayOf(start), until, skip) === dayOf(start) ? startMs : firstAfterDay(start, repeat, until, skip, startMs)
    if (!repeat) return null
    if (repeat.indexOf('hours:') === 0) {
      const step = Math.max(1, parseInt(repeat.slice(6), 10) || 1) * 3600000
      const t = startMs + (Math.floor((after - startMs) / step) + 1) * step
      return until && today(t) > until ? null : t
    }
    return firstAfterDay(start, repeat, until, skip, after)
  }
  function firstAfterDay(start, repeat, until, skip, after) {
    const time = timeOf(start) || MORNING
    let d = nextDay(dayOf(start), repeat, today(after), until, skip)
    for (let i = 0; d && i < 3; i++) {
      const t = ms(d + 'T' + time)
      if (t > after) return t
      d = nextDay(dayOf(start), repeat, addDays(d, 1), until, skip)
    }
    return null
  }

  // ---------- events ----------
  const eventSpan = e => (e.endDay && e.endDay > e.day ? between(e.day, e.endDay) : 0)
  // Start day of the occurrence covering `day`, or null (multi-day events cover several days).
  function eventStartOn(e, day) {
    if (e.deleted) return null
    for (let back = 0; back <= eventSpan(e); back++) {
      const s = addDays(day, -back)
      if (occursOn(e.day, e.repeat, s, e.until, e.skip)) return s
    }
    return null
  }
  const eventsOn = (events, day) => events.filter(e => eventStartOn(e, day) !== null)
    .sort((a, b) => (a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : 0)

  // ---------- alarms (what should ring, on this device) ----------
  // local: {snoozes: {id: ms}, summary: "08:00" | null, focus: {until, title} | null}
  function itemAlarms(item, isTask, after, until, out) {
    if (item.deleted || (isTask && (item.done || !item.due))) return
    const start = isTask ? item.due : item.day + (item.time ? 'T' + item.time : '')
    const offsets = item.remind || []
    for (let i = 0; i < offsets.length; i++) {
      const m = offsets[i] * 60000
      let o = nextOccurrence(start, item.repeat, item.until, isTask ? null : item.skip, after + m)
      for (let n = 0; o !== null && o - m <= until && n < 50; n++) {
        out.push({ at: o - m, id: item.id, kind: isTask ? 'task' : 'event', occurrence: o, title: item.text, loud: !!item.loud, important: !!item.important })
        o = nextOccurrence(start, item.repeat, item.until, isTask ? null : item.skip, o)
      }
    }
  }
  function alarms(doc, local, after, until) {
    const out = []
    doc.tasks.forEach(t => itemAlarms(t, true, after, until, out))
    doc.events.forEach(e => itemAlarms(e, false, after, until, out))
    const snoozes = (local && local.snoozes) || {}
    Object.keys(snoozes).forEach(id => {
      const at = snoozes[id]; if (at <= after || at > until) return
      const item = find(doc, id); if (!item || item.deleted || item.done) return
      out.push({ at: at, id: id, kind: doc.tasks.indexOf(item) >= 0 ? 'task' : 'event', occurrence: at, title: item.text, loud: !!item.loud, important: !!item.important, snoozed: true })
    })
    if (local && local.summary) {
      for (let d = today(after); ; d = addDays(d, 1)) {
        const at = ms(d + 'T' + local.summary)
        if (at > until) break
        if (at > after) { out.push({ at: at, id: 'summary', kind: 'summary' }); break }
      }
    }
    if (local && local.focus && local.focus.until > after && local.focus.until <= until) out.push({ at: local.focus.until, id: 'focus', kind: 'focus', title: local.focus.title })
    return out.sort((a, b) => a.at - b.at)
  }
  // Earliest alarm after `after`, looking a year ahead (yearly events), or null.
  function nextAlarm(doc, local, after) {
    const list = alarms(doc, local, after, after + 366 * DAY_MS)
    return list.length ? list[0].at : null
  }

  // ---------- tasks ----------
  const SECTIONS = ['late', 'today', 'starred', 'tomorrow', 'week', 'later', 'nodate', 'done']
  // dayStart: minutes after midnight when a day begins (360 = a night shift until 6 h stays in "today").
  function sectionOf(t, now, dayStart) {
    if (t.done) return 'done'
    if (!t.due) return t.important ? 'starred' : 'nodate'
    const off = (dayStart || 0) * 60000
    const d = t.due.length > 10 ? today(ms(t.due) - off) : t.due; const td = today(now - off)
    if (d < td) return 'late'
    if (d === td) return 'today'
    if (d === addDays(td, 1)) return 'tomorrow'
    if (d <= addDays(td, 7)) return 'week'
    return 'later'
  }
  const dueMs = t => ms(t.due.length > 10 ? t.due : t.due + 'T00:00')
  const pri = t => (t.important ? t.prio || 1 : 0) // 0 none, 1 = ★ or "!", 2 = "!!", 3 = "!!!" (p1)
  function sortTasks(tasks, now, dayStart) {
    const rank = t => SECTIONS.indexOf(sectionOf(t, now, dayStart))
    return tasks.filter(t => !t.deleted).slice().sort((a, b) =>
      rank(a) - rank(b) ||
      (a.done ? (b.doneAt || 0) - (a.doneAt || 0) : 0) ||
      pri(b) - pri(a) || // within a day, the most important first
      (a.due && b.due ? dueMs(a) - dueMs(b) : 0) ||
      (b.createdAt || 0) - (a.createdAt || 0))
  }
  // Ticks a task. A repeating one moves to its next date instead (steps unticked), unless the series is over.
  function complete(t, now) {
    const done = Object.assign({}, t, { updatedAt: now, doneAt: now })
    if (t.repeat && t.due) {
      let next
      if (/:after$/.test(t.repeat)) { // "every 3 h after the last one": counted from the tick
        const k = t.repeat.split(':')[0]; const n = Math.max(1, parseInt(t.repeat.split(':')[1], 10) || 1)
        next = k === 'hours' ? stamp(new Date(now + n * 3600000)) : addDays(today(now), k === 'weeks' ? 7 * n : n) + (timeOf(t.due) ? 'T' + timeOf(t.due) : '')
        if (t.until && dayOf(next) > t.until) next = null
      } else if (t.due.length > 10) {
        const o = nextOccurrence(t.due, t.repeat, t.until, null, Math.max(ms(t.due), now))
        // the planned time stays, even when a DST change skips it on the next day (02:30 would become 03:30 for good)
        next = o === null ? null : t.repeat.indexOf('hours:') === 0 ? stamp(new Date(o)) : today(o) + 'T' + timeOf(t.due)
      } else {
        const from = addDays(t.due > today(now) ? t.due : today(now), 1)
        next = nextDay(t.due, t.repeat, from, t.until, null)
      }
      if (next) return Object.assign(done, { due: next, steps: (t.steps || []).map(s => Object.assign({}, s, { done: false })) })
    }
    return Object.assign(done, { done: true })
  }
  // Same day, pushed to tomorrow (or to the next day after a late due), keeping the time.
  function postpone(t, now, days) {
    const base = t.due && dayOf(t.due) > today(now) ? dayOf(t.due) : today(now)
    const day = addDays(base, days || 1)
    const out = Object.assign({}, t, { due: day + (timeOf(t.due) ? 'T' + timeOf(t.due) : ''), updatedAt: now })
    if (t.repeat === 'weekly' && t.due) out.repeat = 'weekly:' + weekday(dayOf(t.due)) // the series keeps its weekday
    return out
  }

  // ---------- progress ----------
  const histTime = h => parseInt(String(h), 10) // entries are numbers (old) or "ms:taskId[:x]"
  function streak(history, now) {
    const days = {}; history.forEach(h => { if (!/:x$/.test(h)) days[today(histTime(h))] = true })
    let d = today(now); if (!days[d]) d = addDays(d, -1)
    let n = 0; while (days[d]) { n++; d = addDays(d, -1) }
    return n
  }
  function doneSince(history, fromDay) { const from = ms(fromDay); return history.filter(h => histTime(h) >= from && !/:x$/.test(h)).length }
  function level(count) { // 3 to reach level 2, 12 for 3, 27 for 4…
    const lv = 1 + Math.floor(Math.sqrt(count / 3))
    const lo = 3 * (lv - 1) * (lv - 1); const hi = 3 * lv * lv
    return { level: lv, progress: (count - lo) / (hi - lo), toNext: hi - count }
  }

  // ---------- documents ----------
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const KINDS = ['tasks', 'notes', 'events']
  function base(o, now) {
    return { id: o.id ? String(o.id) : newId(), createdAt: +o.createdAt || now, updatedAt: +o.updatedAt || 0, deleted: !!o.deleted }
  }
  const str = v => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
  const opt = v => (typeof v === 'string' && v ? v : null)
  function mins(v) { // tolerant: 15, "15", [15, 60] -> [15] / [15, 60]
    const list = Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v]
    return list.map(Number).filter(n => isFinite(n) && n >= 0).filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b)
  }
  // Fills every field, so the UI never meets undefined; unknown fields are kept (newer versions, other devices).
  function normalize(doc, now) {
    now = now || Date.now()
    const d = doc && typeof doc === 'object' ? doc : {}
    const out = Object.assign({}, d, { app: 'mon-orga', version: 2 })
    out.tasks = (Array.isArray(d.tasks) ? d.tasks : []).map(t => Object.assign({}, t, base(t, now), {
      text: str(t.text), done: !!t.done, due: opt(t.due), remind: mins(t.remind), repeat: opt(t.repeat), until: opt(t.until), place: str(t.place),
      important: !!t.important, prio: t.important ? Math.max(0, Math.min(3, +t.prio || 0)) : 0, list: str(t.list), details: str(t.details), loud: !!t.loud, doneAt: +t.doneAt || null,
      steps: (Array.isArray(t.steps) ? t.steps : []).map(s => ({ text: str(s.text), done: !!s.done })),
    }))
    out.notes = (Array.isArray(d.notes) ? d.notes : []).map(n => Object.assign({}, n, base(n, now), {
      text: str(n.text), pinned: !!n.pinned, list: str(n.list), images: Array.isArray(n.images) ? n.images.filter(i => typeof i === 'string') : [],
    }))
    out.events = (Array.isArray(d.events) ? d.events : []).filter(e => typeof e.day === 'string' && e.day.length === 10).map(e => Object.assign({}, e, base(e, now), {
      text: str(e.text), time: opt(e.time), end: opt(e.end), endDay: opt(e.endDay), place: str(e.place), details: str(e.details),
      remind: mins(e.remind), repeat: opt(e.repeat), until: opt(e.until), skip: Array.isArray(e.skip) ? e.skip.filter(s => typeof s === 'string') : [],
      loud: !!e.loud, important: !!e.important, list: str(e.list), noteId: opt(e.noteId),
    }))
    out.history = (Array.isArray(d.history) ? d.history : []).filter(h => (typeof h === 'number' || typeof h === 'string') && isFinite(histTime(h)))
    return out
  }
  const empty = () => normalize({})
  function find(doc, id) {
    for (let k = 0; k < KINDS.length; k++) { const it = doc[KINDS[k]].find(x => x.id === id); if (it) return it }
    return null
  }
  // Newest edit of each item wins; deletions travel as tombstones. With `since` (the last sync between two devices),
  // a note whose text changed on both sides since then keeps the older text as a copy next to it ("<id>-c<time>").
  function merge(local, remote, since) {
    const a = normalize(local); const b = normalize(remote)
    const out = Object.assign({}, a)
    KINDS.forEach(k => {
      const byId = {}; const order = []; const copies = {}
      a[k].concat(b[k]).forEach(it => {
        const cur = byId[it.id]
        if (!cur) order.push(it.id)
        else if (k === 'notes' && since > 0 && cur.text !== it.text && !cur.deleted && !it.deleted && cur.updatedAt > since && it.updatedAt > since) {
          const loser = it.updatedAt > cur.updatedAt ? cur : it
          copies[it.id] = Object.assign({}, loser, { id: loser.id + '-c' + loser.updatedAt, conflictOf: loser.id, pinned: false, createdAt: loser.updatedAt })
        }
        if (!cur || it.updatedAt > cur.updatedAt) byId[it.id] = it
      })
      out[k] = []
      order.forEach(id => { out[k].push(byId[id]); const c = copies[id]; if (c && !byId[c.id]) { byId[c.id] = c; out[k].push(c) } })
    })
    const seen = {}
    out.history = a.history.concat(b.history).filter(h => (seen[h] ? false : (seen[h] = true))).sort((x, y) => histTime(x) - histTime(y)).slice(-HISTORY_MAX)
    return out
  }
  // Drops tombstones older than 30 days (every device has had the time to sync them).
  function purge(doc, now) {
    const limit = now - TOMBSTONE_DAYS * DAY_MS
    const out = Object.assign({}, doc)
    KINDS.forEach(k => { out[k] = doc[k].filter(it => !(it.deleted && it.updatedAt < limit)) })
    return out
  }
  const live = list => list.filter(x => !x.deleted)

  // ---------- search ----------
  const fold = s => str(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  function matches(query, texts) {
    const words = fold(query).split(/\s+/).filter(Boolean)
    const hay = fold(texts.join(' '))
    return words.every(w => hay.indexOf(w) >= 0)
  }
  const TAG = /(^|\s)([#@][A-Za-zÀ-ÖØ-öø-ÿ0-9_-]{2,})/g // #mot-clé, @personne
  function tags(text) { const out = []; let m; TAG.lastIndex = 0; while ((m = TAG.exec(text))) out.push(m[2].toLowerCase()); return out }

  // ---------- natural language: "Sortir les poubelles chaque mardi 19h" ----------
  const L = 'A-Za-zÀ-ÖØ-öø-ÿ0-9'
  const word = src => new RegExp('(^|[^' + L + '])(' + src + ')(?![' + L + '])', 'i')
  const FR_DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
  const EN_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
  const EN_SHORT = { mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6, sun: 7 }
  const SHORT = 'tues?|wed|thu(?:rs?)?|fri|sat|sun|mon'
  const EN_NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
  const DAYS = FR_DAYS.concat(EN_DAYS).join('|')
  const DAYS_X = DAYS + '|' + SHORT // short English names, only where a word like "every" or "on" says it is a day ("mon" is French too)
  const dayIndex = name => {
    const n = name.toLowerCase().replace(/\.$/, ''); if (EN_SHORT[n]) return EN_SHORT[n]
    const m = n.replace(/s$/, ''); const i = FR_DAYS.indexOf(m); return (i >= 0 ? i : EN_DAYS.indexOf(m)) + 1
  }
  const MONTHS = [
    ['janvier', 'janv', 'january', 'jan'], ['février', 'fevrier', 'févr', 'fevr', 'fév', 'fev', 'february', 'feb'], ['mars', 'march', 'mar'],
    ['avril', 'avr', 'april', 'apr'], ['mai', 'may'], ['juin', 'june', 'jun'], ['juillet', 'juil', 'july', 'jul'], ['août', 'aout', 'august', 'aug'],
    ['septembre', 'sept', 'sep', 'september'], ['octobre', 'oct', 'october'], ['novembre', 'nov', 'november'], ['décembre', 'decembre', 'déc', 'dec', 'december']]
  const MONTH_RE = MONTHS.reduce((a, m) => a.concat(m), []).sort((x, y) => y.length - x.length).join('|')
  const monthIndex = name => MONTHS.findIndex(m => m.indexOf(name.toLowerCase().replace('.', '')) >= 0)
  const NUM_WORDS = { un: 1, une: 1, a: 1, an: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3 }
  const num = s => NUM_WORDS[s.toLowerCase()] || parseInt(s, 10)

  const ORDINALS = { premier: 1, '1er': 1, first: 1, deuxieme: 2, '2e': 2, second: 2, troisieme: 3, '3e': 3, third: 3, quatrieme: 4, '4e': 4, fourth: 4, cinquieme: 5, '5e': 5, fifth: 5, dernier: -1, last: -1 }
  const SEP = '\\s*(?:,|et|and|&)\\s*(?:le\\s+|les\\s+)?'
  const daysOf = s => 'weekly:' + s.split(/\s*(?:,|et|and|&)\s*/i).map(x => dayIndex(x.replace(/^(le|les)\s+/i, '')))
    .filter((n, i, a) => n > 0 && a.indexOf(n) === i).sort().join(',')
  const REPEATS = [
    [word('(?:le\\s+|chaque\\s+|tous les\\s+|every\\s+|the\\s+|on the\\s+)?(premier|1er|deuxi[eè]me|2e|second|troisi[eè]me|3e|quatri[eè]me|4e|cinqui[eè]me|5e|dernier|first|third|fourth|fifth|last)\\s+(' + DAYS + ')s?\\s+(?:du mois|de chaque mois|de tous les mois|of the month|of every month|of each month)'),
      g => 'nth:' + ORDINALS[fold(g[1])] + ':' + dayIndex(g[2])],
    [word('(?:toutes les|every)\\s+(\\d{1,2})\\s*(?:h|heures?|hours?|hrs?)'), g => 'hours:' + g[1]],
    [word('(?:tous les|every)\\s+(\\d{1,3})\\s*(?:jours|days)'), g => 'days:' + g[1]],
    [word('(?:toutes les|every)\\s+(\\d{1,2})\\s*(?:semaines|weeks)'), g => 'weeks:' + g[1]],
    [word('(?:tous les|every)\\s+(\\d{1,2})\\s*(?:mois|months)'), g => 'months:' + g[1]],
    [word('une semaine sur deux|toutes les deux semaines|every other week'), () => 'weeks:2'],
    [word('(?:chaque|tous les)\\s+trimestres?|tous les trois mois|every quarter|quarterly'), () => 'months:3'],
    [word('(?:chaque|tous les)\\s+semestres?|tous les six mois|twice a year'), () => 'months:6'],
    [word('(?:le\\s+|les\\s+|on\\s+)?((?:' + DAYS_X + ')s?(?:' + SEP + '(?:' + DAYS_X + ')s?)+)\\s+(?:chaque semaine|toutes les semaines|every week)'), g => daysOf(g[1])],
    [word('(?:chaque|tous les|toutes les|every)\\s+((?:' + DAYS_X + ')s?(?:' + SEP + '(?:' + DAYS_X + ')s?)*)'), g => daysOf(g[1])],
    [word('on\\s+((?:' + EN_DAYS.join('|') + ')s(?:\\s*(?:,|and|&)\\s*(?:' + EN_DAYS.join('|') + ')s)*)'), g => daysOf(g[1])],
    [word('(?:tous les\\s+)?jours ouvr[ée]s|(?:tous les|chaque) jours? de la semaine|en semaine|du lundi au vendredi|on weekdays|every weekday|weekdays'), () => 'weekdays'],
    [word('tous les (?:matins|soirs)|every (?:morning|evening|night)'), () => 'daily'],
    [word('tous les jours|chaque jour|quotidiennement|every ?day|daily'), () => 'daily'],
    [word('toutes les semaines|chaque semaine|every week|weekly'), () => 'weekly'],
    [word('tous les mois|chaque mois|every month|monthly'), () => 'monthly'],
    [word('tous les ans|chaque ann[ée]e|every year|yearly|annually'), () => 'yearly'],
  ]
  const STREET = 'rue|avenue|av\\.|bd|boulevard|chemin|place|all[ée]e|impasse|route|quai|cours|street|st\\.|road|rd\\.|ave\\.?|lane|drive'
  const PHONE = /\+?\d[\d .-]{7,16}\d/g // the same numbers as the "Call" button (app.js findLinks)
  const isPhone = m => { const d = m.replace(/\D/g, '').length; return d >= 9 && d <= 15 && !/^\d{4}-\d{2}-\d{2}/.test(m) }
  const PLACE_END = new RegExp('(?:(?:,?\\s+|,)(?:t[ée]l(?:[ée]phone)?|phone|portable|mobile)\\.?\\s*:?)?\\s*\uE000|,\\s*(?:m\\.|mme|mlle|mr|mrs|ms|madame|monsieur|dr|docteur)(?![' + L + '])', 'i')
  const ADDRESS = new RegExp('\\s\\d{1,4}(?:\\s?(?:bis|ter))?,?\\s+(?:' + STREET + ')(?![' + L + '])', 'i')
  const DAY_PARTS = [ // [words, time, evening]
    ["(?:en\\s+)?fin\\s+de\\s+(?:la\\s+)?journ[ée]e|end\\s+of\\s+(?:the\\s+)?day", '18:00', true],
    ["(?:en\\s+)?fin\\s+d['’]apr[eè]s[- ]midi", '17:00', true],
    ["(?:en\\s+)?fin\\s+de\\s+(?:la\\s+)?matin[ée]e", '11:00'],
    ["(?:dans|en)\\s+(?:la\\s+)?matin[ée]e", '10:00'],
    ["dans\\s+l['’]apr[eè]s[- ]midi|in\\s+the\\s+afternoon", '15:00', true],
    ["dans\\s+la\\s+soir[ée]e|le\\s+soir|in\\s+the\\s+evening", '19:00', true],
    ['le\\s+matin|in\\s+the\\s+morning', '09:00'],
  ]
  const DAY_PART = DAY_PARTS.map(x => x[0]).join('|')
  const PART_OF_DAY = { matin: '09:00', morning: '09:00', midi: '12:00', 'apres-midi': '14:00', 'apres midi': '14:00', afternoon: '14:00', soir: '19:00', evening: '19:00', night: '21:00' }
  // "Rappelle-moi de…", "Il faut que je…", "Remind me to…": asking words, not the task's name ("je dois" only before a verb: "je dois 20 €" stays)
  const FILLER = /^\s*(?:rappelle[- ]moi(?:\s+(?:de\s+|d['’]|que\s+|qu['’])?|$)|rappel(?:\s*:\s*|\s+(?:de\s+|d['’])?)|me rappeler\s+(?:de\s+|d['’]|que\s+|qu['’])|n['’]oublie(?:z)? pas(?:\s+(?:de\s+|d['’]|que\s+|qu['’])?|$)|ne pas oublier\s+(?:de\s+|d['’])?|(?:il\s+)?(?:ne\s+)?faut pas que j['’]oublie\s*(?:de\s+|d['’])?|pense[rz]? [àa]\s+|fais[- ]moi penser [àa]\s+|souviens[- ]toi\s+(?:de\s+|d['’])|(?:il\s+)?faudrait\s+(?:que\s+(?:je\s+|j['’]))?|(?:il\s+)?faut\s+(?:que\s+(?:je\s+|j['’]))?|je dois\s+(?=\S+(?:er|ir|re|oir)\b)|j['’]ai [àa]\s+|(?:ajoute[rz]? une|nouvelle) t[âa]che\s*:?\s*|remind me(?:\s+to\s+|\s+|$)|don['’]t forget(?:\s+to\s+|\s+|$)|remember to\s+|i (?:need|have|must|should|got) to\s+|i(?:['’]ve| have)? got to\s+|i must\s+|i gotta\s+|gotta\s+|(?:add a|new) task\s*:?\s*|to-?do\s*:\s*)/i
  // "Il faut que je prenne mes gouttes": the verb as a to-do says it ("Prendre mes gouttes")
  const E_VERBS = /^(?:r?ach|[ée]?lev|enlev|relev|soulev|[ae]?m+en|promen|ramen|pes|sem|gel|achev)/ // "achète" is "acheter", "règle" is "régler"
  const IRREGULAR = { prenne: 'prendre', mette: 'mettre', fasse: 'faire', aille: 'aller', voie: 'voir', sorte: 'sortir', parte: 'partir', dorme: 'dormir', serve: 'servir', écrive: 'écrire', inscrive: 'inscrire', lise: 'lire', dise: 'dire', vienne: 'venir', revienne: 'revenir', tienne: 'tenir', prévienne: 'prévenir', puisse: 'pouvoir', sache: 'savoir', boive: 'boire', reçoive: 'recevoir', conduise: 'conduire', suive: 'suivre', ouvre: 'ouvrir', offre: 'offrir', couvre: 'couvrir', coure: 'courir', soit: 'être', sois: 'être', aie: 'avoir', ait: 'avoir', rejoigne: 'rejoindre', éteigne: 'éteindre', peigne: 'peindre' }
  function infinitive(w) {
    const l = w.toLowerCase(); let v = IRREGULAR[l]
    if (!v && /(?:end|ond|erd|ord)e$/.test(l)) v = l.slice(0, -1) + 're' // rende → rendre, réponde → répondre, perde → perdre
    else if (!v && /isse$/.test(l)) v = l.slice(0, -4) + 'ir' // finisse → finir
    else if (!v && /[ae]lle$/.test(l)) v = l.slice(0, -3) + 'ler' // appelle → appeler
    else if (!v && /ette$/.test(l)) v = l.slice(0, -3) + 'ter' // jette → jeter
    else if (!v && /[oua]ie$/.test(l)) v = l.slice(0, -2) + 'yer' // envoie → envoyer, paie → payer
    else if (!v && /è[^aeiouyè]+e$/.test(l)) v = l.replace(/è([^aeiouyè]+)e$/, (m, c) => (E_VERBS.test(l.replace(/è/g, 'e')) ? 'e' : 'é') + c + 'er')
    else if (!v && /e$/.test(l)) v = l + 'r' // passe → passer
    return v ? (w[0] === w[0].toUpperCase() ? cap(v) : v) : w
  }
  function unask(t) { // takes the asking words off, however many: "N'oublie pas que je dois renouveler…"
    let asked = ''; let a
    while ((a = FILLER.exec(t)) && a[0]) { asked += a[0]; t = t.slice(a[0].length) }
    if (/que\s+(?:je\s+|j['’])$/i.test(asked)) t = t.replace(/^[A-Za-zÀ-ÿ]+/, infinitive)
    return { t: t, asked: asked }
  }
  const askWord = a => (/^\s*(?:remind|don|i\s|add|new|to)/i.test(a) ? 'Reminder' : 'Rappel') // "Rappelle-moi demain 8h": the name when nothing else is said
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1)

  // opts.mdy: dates typed month first (10/22), as in the United States.
  function parse(input, nowMs, opts) {
    const now = new Date(nowMs)
    const td = ymd(now)
    const mdy = !!(opts && opts.mdy)
    const phones = [] // set aside: a phone number is never read as a date, a time or an address
    let text = input.replace(PHONE, m => (isPhone(m) ? '\uE000' + String.fromCharCode(0xE001 + phones.push(m) - 1) : m))
    const back = s => s.replace(/\uE000([\uE001-\uF8FF])/g, (m, c) => phones[c.charCodeAt(0) - 0xE001])
    text = text.replace(/(\d{1,2})\s*h(?:eures?)?\s+et\s+(demie?|quart)(?![A-Za-zÀ-ÿ])/gi, (m, h, q) => h + 'h' + (/^q/i.test(q) ? '15' : '30')) // "14h et demie"
      .replace(/(\d{1,2})\s*h(?:eures?)?\s+moins\s+(?:le\s+)?quart(?![A-Za-zÀ-ÿ])/gi, (m, h) => (+h + 23) % 24 + 'h45').replace(/midi\s+et\s+demie?/gi, '12h30')
      .replace(/(half|quarter)\s+past\s+(\d{1,2}|[a-z]+)|quarter\s+to\s+(\d{1,2}|[a-z]+)/gi, (m, k, a, b) => { // "half past two": 2:30, in the afternoon like "at 2"
        const n = +(a || b) || EN_NUMBERS.indexOf(String(a || b).toLowerCase()) + 1; if (!(n >= 1 && n <= 12)) return m
        const h = b ? n - 1 || 12 : n; return pad(h <= 6 ? h + 12 : h) + ':' + (b ? '45' : /^h/i.test(k) ? '30' : '15')
      })
    const cuts = [] // where date/repeat words were, to accept a bare "18h" right next to them
    // Removes the first match (when `ok` accepts its groups) and returns [phrase, group1, …].
    function take(re, ok) {
      const m = re.exec(text); if (!m) return null
      const g = m.slice(2); if (ok && !ok(g)) return null
      const start = m.index + m[1].length
      text = text.slice(0, start) + ' ' + text.slice(start + m[2].length)
      cuts.push(start)
      return g
    }
    const validDay = (d, mo) => d >= 1 && d <= 31 && mo >= 0 && mo <= 11
    const hhmm = (h, m) => pad(+h) + ':' + pad(+(m || 0))
    let repeat = null; let date = null; let time = null; let times = null; let exact = null; let weekly = null; let single = false; let g
    let remind = null; let loud = false; let important = false; let end = null; let evening = false; let night = false; let later = false
    if ((g = take(word("(?:rappel(?:le[- ]moi|er)?|pr[ée]viens[- ]moi|remind(?:er|\\s+me)?)\\s+(\\d{1,3}|une?|an?|one|deux|two|trois|three)\\s*(minutes?|mins?|mn|h|heures?|hours?|jours?|days?|semaines?|weeks?|mois|months?)\\s+(?:avant|before)")))) {
      const n = num(g[1]); const u = g[2].toLowerCase()
      remind = [n * (/^mois|^month/.test(u) ? 43200 : /^m/.test(u) ? 1 : /^h/.test(u) ? 60 : /^(j|d)/.test(u) ? 1440 : 10080)]
    } else if (take(word("(?:rappel(?:le[- ]moi|er)?|pr[ée]viens[- ]moi|remind(?:er|\\s+me)?)\\s+(?:la veille|the day before)"))) remind = [1440]
    const LOUD = word('(?:en\\s+)?(?:mode\\s+)?(?:alarme|r[ée]veil|alarm)')
    const lm = LOUD.exec(text)
    if (lm && !/(?:^|\s)(?:le|mon|ton|un|du|au|the|my|an?)\s*$/i.test(text.slice(0, lm.index + lm[1].length))) { loud = true; if (text.replace(LOUD, ' ').replace(/[\s\d:h!]+/gi, '').length > 1) take(LOUD) } // "Réveil 7h" keeps its name; "mettre le réveil" is a task
    let prio = 0 // "!", "!!", "!!!" or p3, p2, p1 (p1 is the highest)
    if ((g = /(^|\s)(!{1,3})(?=\s|$)/.exec(text))) { prio = g[2].length; text = text.slice(0, g.index) + g[1] + text.slice(g.index + g[0].length) }
    else if ((g = /(^|\s)[pP]([123])(?=\s|$)(?!\s+(?:à|a|au|to|-|–)\s+[pP]\d)/.exec(text))) { prio = 4 - +g[2]; text = text.slice(0, g.index) + g[1] + text.slice(g.index + g[0].length) } // not "pièces p1 à p12"
    if (prio) important = true
    for (let i = 0; i < REPEATS.length && !repeat; i++) {
      if ((g = take(REPEATS[i][0]))) {
        repeat = REPEATS[i][1](g)
        if (/soir|evening/i.test(g[0])) time = '19:00'
        else if (/night/i.test(g[0])) time = '21:00'
        else if (/matin|morning/i.test(g[0])) time = '08:00'
      }
    }
    if (repeat && repeat.indexOf('weekly:') === 0) weekly = repeatDays(repeat)
    if (take(word('(?:dans|in)\\s+(?:une\\s+)?(?:demi[- ]heure|half an hour)'))) exact = nowMs + 30 * 60000
    else if ((g = take(word('(?:dans|in)\\s+(\\d{1,2}|une?|an?|one|deux|two|trois|three)\\s*(?:h|heures?|hours?)\\s*(?:et\\s+|and\\s+(?:a\\s+)?)?(\\d{1,2}|demie?|quart|half)(?:\\s*(?:min|mn|minutes?))?'), x => !/^\d/.test(x[2]) || +x[2] < 60))) {
      exact = nowMs + (num(g[1]) * 60 + (/demi|half/i.test(g[2]) ? 30 : /quart/i.test(g[2]) ? 15 : +g[2])) * 60000
    } else if ((g = take(word('(?:dans|in)\\s+(\\d{1,3}|une?|an?|one|deux|two|trois|three)\\s*(minutes?|mins?|mn|heures?|hours?|hrs?|h|jours?|days?|semaines?|weeks?|mois|months?)')))) {
      const n = num(g[1]); const u = g[2].toLowerCase()
      if (/^mois|^month/.test(u)) date = addMonths(td, n)
      else if (/^m/.test(u)) exact = nowMs + n * 60000
      else if (/^h/.test(u)) exact = nowMs + n * 3600000
      else if (/^(j|d)/.test(u)) date = addDays(td, n)
      else date = addDays(td, 7 * n)
    }
    if (exact === null && !date) {
      if (take(word('apr[eè]s[- ]demain|the day after tomorrow'))) date = addDays(td, 2)
      else if ((g = take(word('(?:demain|tomorrow)(?:\\s+(matin|midi|soir|apr[eè]s[- ]midi|morning|afternoon|evening|night))?')))) {
        date = addDays(td, 1); if (g[1]) { time = PART_OF_DAY[fold(g[1])] || null; if (/soir|evening/i.test(g[1])) evening = true }
      } else if (take(word('cette nuit|late tonight'))) { date = td; time = '22:00'; night = true }
      else if (take(word('ce soir|tonight|this evening'))) { date = td; time = '19:00'; evening = true }
      else if (take(word('cet apr[eè]s[- ]midi|this afternoon'))) { date = td; time = '14:00' }
      else if (take(word('ce matin|this morning'))) { date = td; time = '09:00' }
      else if (take(word("aujourd['’]hui|today"))) date = td
      else if (take(word('la semaine prochaine|next week'))) date = addDays(td, 8 - weekday(td))
      else if (take(word('ce week-?end|this weekend|le week-?end prochain|next weekend'))) date = addDays(td, (6 - weekday(td) + 7) % 7)
      else if (take(word('le mois prochain|next month'))) date = addMonths(td, 1).slice(0, 8) + '01'
      else if (take(word("(?:le\\s+)?dernier\\s+jour\\s+du\\s+mois|(?:[àa]\\s+la\\s+|avant\\s+la\\s+|d['’]ici\\s+la\\s+)?fin\\s+du\\s+mois|en\\s+fin\\s+de\\s+mois|(?:by\\s+|at\\s+)?the\\s+end\\s+of\\s+the\\s+month|(?:on\\s+)?the\\s+last\\s+day\\s+of\\s+the\\s+month"))) date = endOfMonth(td.slice(0, 4), +td.slice(5, 7)) // "avant la fin du mois"
      else if ((g = take(word('(?:le\\s+|on\\s+)?(?:(?:' + DAYS + '),?\\s+(?:the\\s+)?)?(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTH_RE + ')\\.?(?:\\s+(\\d{4}))?'), x => validDay(+x[1], monthIndex(x[2]))))) date = pickDate(g[3] ? +g[3] : null, monthIndex(g[2]), +g[1], td)
      else if ((g = take(word('(?:(?:on\\s+)?(?:' + DAYS + '),?\\s+)?(' + MONTH_RE + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?'), x => validDay(+x[2], monthIndex(x[1]))))) date = pickDate(g[3] ? +g[3] : null, monthIndex(g[1]), +g[2], td)
      else if ((g = take(word("(?:exp\\.?|dlc|ddm|best before|use by|p[ée]rim[ée]?(?:\\s+(?:le|en|fin))?|[àa] consommer avant)\\s*:?\\s*(\\d{1,2})[/.](\\d{4}|\\d{2})"), x => +x[1] >= 1 && +x[1] <= 12))) date = endOfMonth(g[2], +g[1])
      else if ((g = take(word('(?:le\\s+)?(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?'), x => validDay(mdy ? +x[2] : +x[1], (mdy ? +x[1] : +x[2]) - 1)))) {
        const y = g[3] ? (+g[3] < 100 ? 2000 + +g[3] : +g[3]) : null
        date = mdy ? pickDate(y, +g[1] - 1, +g[2], td) : pickDate(y, +g[2] - 1, +g[1], td)
      } else if ((g = take(word('(\\d{1,2})[/.](\\d{4}|\\d{2})(?![/.\\d])'), x => +x[1] >= 1 && +x[1] <= 12 && endOfMonth(x[2], +x[1]) >= td))) date = endOfMonth(g[2], +g[1]) // 03/2027 on a box
      else if ((g = take(word('(\\d{1,2})[/.](\\d{1,2})'), x => validDay(+x[2], +x[1] - 1)))) date = pickDate(null, +g[1] - 1, +g[2], td) // 10/22, month first
      else if ((g = take(word('(?:le\\s+(?:(?:' + DAYS + ')\\s+)?(\\d{1,2})(?:er)?|(?:on\\s+)?(?:(?:' + DAYS + ')\\s+)?the\\s+(\\d{1,2})(?:st|nd|rd|th)|(?:' + DAYS + ')\\s+(\\d{1,2})(?:er|st|nd|rd|th)?(?![\\d:hH])(?!\\s*(?:h|heures?)(?![' + L + ']))(?!(?:\\s?(?:bis|ter))?,?\\s+(?:' + STREET + ')(?![' + L + '])))'), x => +(x[1] || x[2] || x[3]) >= 1 && +(x[1] || x[2] || x[3]) <= 31))) {
        const d = +(g[1] || g[2] || g[3]); const first = td.slice(0, 8) + '01'
        const inMonth = m1 => m1.slice(0, 8) + pad(Math.min(d, monthDays(+m1.slice(0, 4), +m1.slice(5, 7) - 1)))
        date = inMonth(first) >= td ? inMonth(first) : inMonth(addMonths(first, 1))
      } else if ((g = take(word('(?:ce\\s+|next\\s+|this\\s+|on\\s+)?(' + DAYS + ')(?:\\s+prochain)?(?:\\s+(matin|midi|soir|apr[eè]s[- ]midi|morning|afternoon|evening|night))?'))) ||
        (g = take(word('(?:next|this|on)\\s+(' + SHORT + ')\\.?'))) || (g = take(word('(' + SHORT + ')\\.?(?=\\s+(?:\\d|at\\s|@))'), x => !/^mon/i.test(x[0]) || /^Mon/.test(x[0])))) {
        if (!weekly) { weekly = [dayIndex(g[1])]; single = true; later = /prochain|next/i.test(g[0]) }
        if (g[2]) { time = time || PART_OF_DAY[fold(g[2])] || null; if (/soir|evening/i.test(g[2])) evening = true } // "mardi soir"
      }
    }
    if (exact === null) {
      const hourOk = x => +x[1] < 24 && +(x[2] || 0) < 60
      const MIN = '(\\d{2}(?![\\dh:])(?!(?:\\s?(?:bis|ter))?,?\\s+(?:' + STREET + ')(?![' + L + '])))?' // "8h 12 rue…": 12 is the street
      const ampm = (h, m, ap) => pad((+h % 12) + (/p/i.test(ap) ? 12 : 0)) + ':' + pad(+(m || 0))
      // A time range: "18h-1h", "de 9h à 12h30", "6pm-1am" (the end is used by events)
      if ((g = take(word('(?:de\\s+|from\\s+)?(\\d{1,2})\\s*(?:h|:)\\s*' + MIN + '\\s*(?:-|–|à|a|to|until|jusqu[\'’]à)\\s*(\\d{1,2})\\s*(?:h|:)\\s*' + MIN), x => hourOk(x) && +x[3] < 24 && +(x[4] || 0) < 60))) {
        time = hhmm(g[1], g[2]); end = hhmm(g[3], g[4])
      } else if ((g = take(word('(?:from\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?\\s*(?:-|–|to|until)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)'), x => +x[1] >= 1 && +x[1] <= 12 && +x[4] >= 1 && +x[4] <= 12))) {
        time = ampm(g[1], g[2], g[3] || g[6]); end = ampm(g[4], g[5], g[6])
      }
      // Several times at once: "à 8h, 12h et 19h", "matin, midi et soir" (one task each).
      if (time) { /* range found */ } else if ((g = take(word('(?:[àa]\\s+|at\\s+)?(\\d{1,2})\\s*(?:h|:)\\s*' + MIN + '((?:(?:\\s*(?:,|et|and|&)\\s*|\\s+)\\d{1,2}\\s*(?:h|:)(?:\\s*\\d{2}(?![\\dh:]))?)+)'), hourOk))) {
        times = [hhmm(g[1], g[2])]
        ;(g[3].match(/\d{1,2}\s*(?:h|:)(?:\s*\d{2}(?![\dh:]))?/g) || []).forEach(t => { const m = /(\d{1,2})\s*(?:h|:)\s*(\d{2})?/.exec(t); if (+m[1] < 24 && +(m[2] || 0) < 60) times.push(hhmm(m[1], m[2])) })
      } else if (take(word('(?:le\\s+)?matin,?\\s+(?:le\\s+)?midi,?\\s+(?:et\\s+)?(?:le\\s+)?soir|morning,?\\s+noon,?\\s+(?:and\\s+)?(?:evening|night)'))) times = ['08:00', '12:00', '19:00']
      else if (take(word('(?:le\\s+)?matin,?\\s+(?:et\\s+)?(?:le\\s+)?soir|morning,?\\s+(?:and\\s+)?(?:evening|night)'))) times = ['08:00', '19:00']
      else if (take(word('(?:le\\s+)?midi et (?:le\\s+)?soir|noon and (?:evening|night)'))) times = ['12:00', '19:00']
      if (times) time = times[0]
      else if ((g = take(word('(?:[àa]\\s+)?(midi|minuit|noon|midnight)')))) time = /midi|noon/i.test(g[1]) ? '12:00' : '00:00'
      else if ((g = take(word('(?:at\\s+|by\\s+|before\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)'), x => +x[1] >= 1 && +x[1] <= 12 && +(x[2] || 0) < 60))) {
        time = pad((+g[1] % 12) + (g[3].toLowerCase() === 'pm' ? 12 : 0)) + ':' + pad(+(g[2] || 0))
      } else if ((g = take(word("(?:[àa]|at|vers|pour|@|avant|d['’]ici|before|by)\\s*(\\d{1,2})(?:\\s*(?:h|:)\\s*" + MIN + "|\\s+heures?)"), hourOk))) {
        time = hhmm(g[1], g[2])
      } else if ((g = take(word('(?:at|by)\\s+(\\d{1,2})(?![\\d:hH])(?!\\s+(?:' + STREET + ')(?![' + L + ']))'), x => +x[1] >= 1 && +x[1] <= 12))) {
        // "at 7": 1 to 6 o'clock is the afternoon; without a date, the next 7 o'clock (7 PM once 7 AM is past)
        const h = +g[1]; const pm = h < 12 && (h <= 6 || evening || (!date && !weekly && ms(td + 'T' + pad(h) + ':00') <= nowMs))
        time = pad(pm ? h + 12 : h) + ':00'
      } else {
        // A bare "18h" counts next to a date or a repetition, or at the very end: "faire 2h de sport" stays a text.
        const bare = word('(\\d{1,2})\\s*(?:h|:)\\s*' + MIN)
        g = take(bare, x => {
          const m = bare.exec(text); const s = m.index + m[1].length; const e = s + m[2].length
          return hourOk(x) && (!text.slice(e).trim() || cuts.some(c => Math.abs(c - e) <= 3 || Math.abs(c - s) <= 3))
        })
        if (g) time = hhmm(g[1], g[2])
      }
    }
    if (exact === null && (g = take(word(DAY_PART)))) { const k = DAY_PARTS.find(x => new RegExp('^(?:' + x[0] + ')$', 'i').test(g[0])); if (!time) time = k[1]; if (k[2]) evening = true } // "en fin de journée", "le soir"
    if (evening && time >= '01:00' && time < '12:00') time = pad(+time.slice(0, 2) + 12) + time.slice(2) // "ce soir 8h" is 20:00
    if (night && time && time < '12:00') date = addDays(td, 1) // "cette nuit 3h": the coming night
    if (!date && !weekly && exact === null) { // "Shift 6pm-1am fri": a short day name right after a time
      const short = word('(tues?|wed|thu(?:rs?)?|fri|sat|sun)\\.?')
      if ((g = take(short, () => { const m = short.exec(text); const s = m.index + m[1].length; return !text.slice(s + m[2].length).trim() || cuts.some(c => Math.abs(c - s) <= 3) }))) { weekly = [dayIndex(g[0])]; single = true }
    }
    function dueAt(tm) {
      if (exact !== null) return stamp(new Date(Math.ceil(exact / 60000) * 60000))
      let d = date
      if (!d && weekly) {
        // "lundi" means the next Monday, today only with a later time ("lundi 18h" on a Monday morning); "chaque lundi" may start today.
        const fromToday = !later && (tm ? ms(td + 'T' + tm) > nowMs : !single)
        d = fromToday ? td : addDays(td, 1)
        while (weekly.indexOf(weekday(d)) < 0) d = addDays(d, 1)
      }
      if (!d && !tm && repeat && repeat.indexOf('hours:') === 0) return stamp(new Date(Math.ceil((nowMs + parseInt(repeat.slice(6), 10) * 3600000) / 60000) * 60000))
      if (!d && (tm || repeat)) d = tm && ms(td + 'T' + tm) <= nowMs ? addDays(td, 1) : td
      if (!d) return null
      if (repeat && !date) d = nextDay(d, repeat, d, null, null) || d // the first day the repetition really happens (a weekday, the 1st Monday…)
      return d + (tm ? 'T' + tm : '')
    }
    const due = dueAt(time)
    const extra = o => { if (remind) o.remind = remind; if (loud) o.loud = true; if (important) { o.important = true; o.prio = prio } if (end && due && due.length > 10) o.end = end; return o }
    if (!due && !repeat) {
      const t = (loud || important || remind ? back(text) : input).replace(/\s+/g, ' ').trim(); const a = unask(t)
      return extra({ text: (a.asked ? cap(a.t.trim()) || askWord(a.asked) : t) || input.trim(), due: null, repeat: null })
    }
    const un = unask(text.replace(/\s+/g, ' ').trim()); let rest = un.t; const asked = un.asked
    for (let i = 0; i < 3; i++) rest = rest.replace(/[\s,;:.-]+$/, '').replace(/\s+(?:[àa]|at|le|on|the|pour|vers|de|du|for|by|et|and|à partir de|avant|before|d['’]ici)$/i, '').trim()
    rest = rest.replace(/^[\s,;:.-]+/, '')
    rest = cap(rest)
    const addr = ADDRESS.exec(rest) // "Chantier 12 rue des Lilas": the address becomes the place
    let place = ''
    if (addr && addr.index > 0) {
      place = rest.slice(addr.index).trim(); rest = rest.slice(0, addr.index).replace(/[\s,;:-]+$/, '').replace(/\s+(?:au|à|a|at|chez)$/i, '').trim()
      const who = PLACE_END.exec(place) // "3 avenue Foch, Mme Durand 06…": the name and the number stay in the title
      if (who) { rest = (rest + ' ' + place.slice(who.index).replace(/^[\s,]+/, '')).trim(); place = place.slice(0, who.index).replace(/[\s,;:-]+$/, '') }
    }
    const out = extra({ text: back(rest) || (asked ? askWord(asked) : input.trim()), due: due, repeat: repeat })
    if (place) out.place = back(place)
    if (times && times.length > 1 && exact === null) out.dues = times.map(dueAt)
    return out
  }
  // ---------- the assistant: where a spoken or typed sentence belongs ----------
  // "Rappelle-moi d'appeler maman demain 18h" → a task, "J'ai rendez-vous chez le dentiste jeudi 14h" → an event,
  // "Note que le code est 1234" → a note, "Ajoute du lait à la liste des courses" → a task in that list.
  // Returns {kind: 'task' | 'event' | 'note' | null (nothing said: the open tab decides), text (date words kept for parse), list}.
  const APPOINTMENT_WORDS = 'rdv|rendez[- ]vous|dentiste|m[ée]decin|docteur|kin[ée]|ost[ée]o|coiffeur|r[ée]union|v[ée]t[ée]rinaire|chantier|intervention|d[ée]pannage|visite|consultation|cardio\\w*|ophtalmo\\w*|dermato\\w*|gyn[ée]co\\w*|p[ée]diatre|psy\\w*|orthophoniste|radio|scanner|irm|[ée]chographie|prise de sang|analyses|labo|infirmi[eè]re|dr|contr[ôo]le technique|entretien|cours|examen|partiel|d[îi]ner|d[ée]jeuner|resto|ap[ée]ro|match|entra[îi]nement|meeting|appointment|dentist|doctor|vet|interview|class|lecture|exam|dinner|lunch'
  const APPOINTMENT = new RegExp('(^|[^A-Za-zÀ-ÿ])(' + APPOINTMENT_WORDS + ')(?![A-Za-zÀ-ÿ])', 'i') // "Dentiste mardi 14h30" is an appointment
  const SAY_NOTE = /^(?:(?:prends?|prenez|take|make)\s+(?:en\s+)?(?:une?\s+|a\s+)?notes?|not(?:e|ez|er)(?:[- ]moi)?(?=\s*(?::|que\s|qu['’]))|not(?:e|ez|er)(?:[- ]moi)?(?=\s+(?!de\s|d['’]|du\s|des\s)\S)|note\s+(?:down|that)|write\s+(?:it\s+)?down|remember\s+that|[ée]cri(?:s|vez)(?=\s*(?::|que\s|qu['’])))\s*(?::\s*|que\s+|qu['’]|de\s+|d['’]|that\s+)?/i
  const SAY_LIST = /^(?:ajoute[rz]?|rajoute[rz]?|mets|mettre|mettez|add|put)\s+(.+?)\s+(?:[àa]|dans|sur|to|on|in)\s+(?:la\s+|ma\s+|the\s+|my\s+)?liste\s+(?:des\s+|de\s+|du\s+|d['’]|[àa]\s+)?(\S+)\s*(.*)$/i
  const SAY_LIST_EN = /^(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:the\s+|my\s+)?(\S+)\s+list\b\s*(.*)$/i
  const SAY_TO_LIST = /^(?:ajoute[rz]?|rajoute[rz]?|mets|mettre|mettez|add|put)\s+(.+?)\s+(?:aux|au|[àa]\s+la|[àa]\s+l['’]|[àa]|dans(?:\s+(?:la|le|les|ma|mes|mon))?|to(?:\s+(?:the|my))?|on(?:\s+(?:the|my))?)\s+(\S+)\s*(.*)$/i // "aux courses": only a list that exists
  const SAY_LIST_FIRST = /^(?:ajoute[rz]?|rajoute[rz]?|mets|mettre|mettez|add|put)\s+(?:dans|sur|[àa]|to|on)\s+(?:la\s+|ma\s+|the\s+|my\s+)?liste\s+(?:des\s+|de\s+|du\s+|d['’]|[àa]\s+)?(\S+)\s*:?\s+(.+)$/i
  const UM = /^(?:euh+|heu+|hum+|um+|uh+|hmm+)(?![A-Za-zÀ-ÿ'’-])[\s,]*/i // never meant
  const LEAD = /^(?:bon|ok(?:ay)?|alors|donc|dis(?:[- ]moi)?|h[ée]|hey|eh|s['’]il te pla[iî]t|stp|est-ce que tu (?:peux|pourrais)|tu (?:peux|pourrais)|peux-tu|pourrais-tu|so|like|well|please|hi|hello|can you|could you|would you|will you)(?![A-Za-zÀ-ÿ'’-])[\s,]*/i // only before an order: "Bon anniversaire" stays
  const SAY_EVENT = /^(?:j['’]ai|on a|nous avons|i have|i['’]ve got|we have|prends|prenez|mets|mettez|ajoute[z]?|rajoute[z]?|cr[ée]e[z]?|programme[z]?|planifie[z]?|fixe[z]?|schedule|add|make|book)\s+(?:un\s+|une\s+|an?\s+)?(rendez[- ]vous|rdv|r[ée]union|[ée]v[ée]nement|entretien|appointment|meeting|event|interview)(?![A-Za-zÀ-ÿ])\s*/i
  const SAY_AGENDA = /^(?:mets|mettez|ajoute[z]?|rajoute[z]?|note[z]?|inscri(?:s|vez)|add|put)\s+(?:dans|[àa]|sur|au|to|in|on)\s+(?:l['’]|le\s+|mon\s+|ma\s+|the\s+|my\s+)?(?:agenda|calendrier|calendar)\s*:?\s*/i
  const SAY_RDV = /(?:^|\s)(?:(?:mon|un|le|my|an?)\s+)?(?:rdv|rendez[- ]vous)(?![A-Za-zÀ-ÿ])\s*/i // "Rendez-vous chez le docteur Martin le 23 à 9h", "vendredi 17h rendez-vous garagiste"
  const SAY_MEETING = /^(?:r[ée]union|meeting|appointment)(?![A-Za-zÀ-ÿ])/i
  const SAY_HAVE = new RegExp('^(?:j[\'’]ai|on a|i have|i[\'’]ve got)\\s+(?:(?:un|une|le|la|l[\'’]|mon|ma|my|an?|the)\\s*)?(?=(?:' + APPOINTMENT_WORDS + ')(?![A-Za-zÀ-ÿ]))', 'i') // "J'ai kiné mardi 18h"
  const ARTICLE = /^(?:du|de la|de l['’]|des|de|d['’]|le|la|l['’]|les|un|une|some|the|an?)\s+|^(?:de l['’]|l['’]|d['’])/i
  function understand(input, nowMs, opts) {
    let s = str(input).replace(/\s+/g, ' ').trim().replace(/\.+$/, '') // speech may end with a dot ("!" is a priority)
    for (let m0; (m0 = UM.exec(s) || LEAD.exec(s)) && m0[0];) s = s.slice(m0[0].length) // "Euh", "Ok", "Can you…"
    s = s.replace(/[\s,]*(?:s['’]il (?:te|vous) pla[iî]t|stp|svp|please)[\s.!]*$/i, '')
    const lists = (opts && opts.lists) || []
    const known = name => lists.find(l => fold(l) === fold(name))
    // A sentence that is only a date keeps a name: "J'ai rendez-vous demain 10h" is "Rendez-vous".
    const named = (rest, name) => { if (!rest) return name; const p = parse(rest, nowMs, opts); return (p.due || p.repeat) && p.text === rest ? name + ' ' + rest : cap(rest) }
    let m
    if ((m = SAY_NOTE.exec(s)) && s.length > m[0].length) return { kind: 'note', text: cap(s.slice(m[0].length)) }
    if ((m = SAY_LIST_FIRST.exec(s))) m = [m[0], m[2], m[1], '']
    else m = SAY_LIST.exec(s) || SAY_LIST_EN.exec(s) || ((m = SAY_TO_LIST.exec(s)) && known(m[2]) ? m : null)
    if (m) { // "du pain et des œufs": one task each, unless it is a to-do ("appeler le plombier et le chauffagiste")
      const items = /^\S+(?:er|ir|re)(?![A-Za-zÀ-ÿ])/i.test(m[1]) ? [m[1]] : m[1].split(/\s*,\s*|\s+(?:et|and|&)\s+/i)
      return { kind: 'task', text: items.map(i => cap((i.replace(ARTICLE, '') + ' ' + m[3]).trim())).filter(Boolean).join('\n'), list: known(m[2]) || cap(m[2].toLowerCase()) }
    }
    if ((m = SAY_EVENT.exec(s) || SAY_AGENDA.exec(s) || ((m = SAY_HAVE.exec(s)) && !/\s[àa]\s+\S+(?:er|ir|re)(?![A-Za-zÀ-ÿ])/i.test(s) ? m : null))) {
      const noun = m[1] ? (/^rdv$/i.test(m[1]) ? 'Rendez-vous' : cap(m[1].toLowerCase())) : ''
      let rest = s.slice(m[0].length)
      if (noun && /^(?:(?:avec|with|de|du|des|pour|for|of|about|sur)(?![A-Za-zÀ-ÿ])|d['’])/i.test(rest)) rest = noun + ' ' + rest // "Réunion d'équipe", "Rendez-vous avec Paul"
      else rest = rest.replace(/^(?:chez|au|aux|[àa] la|[àa] l['’]|at(?: the)?)\s*(?:le\s+|la\s+|l['’]|les\s+)?/i, '') // "chez le dentiste" is "Dentiste"
      return { kind: 'event', text: named(rest, noun || (/^(?:i|we|add|put|make|book|schedule)\b/i.test(s) ? 'Event' : 'Rendez-vous')) }
    }
    if (FILLER.test(s)) return { kind: 'task', text: s } // parse() takes the asking words off
    const p = parse(s, nowMs, opts); const timed = p.due && p.due.length > 10 // a meeting word makes an event once there is a time
    const onlyDate = t => { if (!t.trim()) return true; const q = parse(t, nowMs, opts); return !!(q.due || q.repeat) && q.text === t.trim() } // "vendredi 17h rendez-vous…", not "Annuler le rendez-vous…"
    if (timed && (m = SAY_RDV.exec(s)) && onlyDate(s.slice(0, m.index))) {
      const after = s.slice(m.index + m[0].length)
      const text = /^(?:(?:avec|with|de|du|des|pour|for)(?![A-Za-zÀ-ÿ])|d['’])/i.test(after) ? s : (s.slice(0, m.index) + ' ' + after.replace(/^(?:chez|au|aux|[àa] la|[àa] l['’])\s*(?:le\s+|la\s+|l['’]|les\s+)?/i, '')).trim()
      return { kind: 'event', text: named(text, 'Rendez-vous') }
    }
    if (timed && SAY_MEETING.test(s)) return { kind: 'event', text: s }
    let plain = str(input).replace(/\s+/g, ' ').trim().replace(/\.+$/, '') // nothing asked: what was said, hesitations aside ("Bon anniversaire" keeps its "Bon")
    for (let m0; (m0 = UM.exec(plain)) && m0[0];) plain = cap(plain.slice(m0[0].length))
    return { kind: null, text: plain || s }
  }
  function endOfMonth(year, month) { const y = +year < 100 ? 2000 + +year : +year; return y + '-' + pad(month) + '-' + pad(monthDays(y, month - 1)) }
  function pickDate(y, mo, d, td) { // without a year: the next such date
    const year = y || +td.slice(0, 4)
    let c = year + '-' + pad(mo + 1) + '-' + pad(Math.min(d, monthDays(year, mo)))
    if (!y && c < td) c = (year + 1) + '-' + pad(mo + 1) + '-' + pad(Math.min(d, monthDays(year + 1, mo)))
    return c
  }

  // ---------- calendar files (.ics), for Google Agenda, Outlook, Apple ----------
  const ICS_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
  function rrule(repeat, until) {
    if (!repeat || repeat.indexOf('hours:') === 0) return null
    const k = repeat.split(':')[0]; const n = repeat.split(':')[1]
    let r = k === 'daily' ? 'FREQ=DAILY' : k === 'days' ? 'FREQ=DAILY;INTERVAL=' + n : k === 'weekdays' ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
      : repeat === 'weekly' ? 'FREQ=WEEKLY' : k === 'weekly' ? 'FREQ=WEEKLY;BYDAY=' + repeatDays(repeat).map(d => ICS_DAYS[d - 1]).join(',')
      : k === 'weeks' ? 'FREQ=WEEKLY;INTERVAL=' + n : k === 'monthly' ? 'FREQ=MONTHLY' : k === 'months' ? 'FREQ=MONTHLY;INTERVAL=' + n
      : k === 'nth' ? 'FREQ=MONTHLY;BYDAY=' + repeat.split(':')[1] + ICS_DAYS[+repeat.split(':')[2] - 1] : k === 'yearly' ? 'FREQ=YEARLY' : null
    if (r && until) r += ';UNTIL=' + until.replace(/-/g, '') + 'T235959'
    return r
  }
  const icsText = s => str(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1')
  const icsDate = (day, time) => day.replace(/-/g, '') + (time ? 'T' + time.replace(':', '') + '00' : '')
  function fold75(line) { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74) } out.push(line); return out.join('\r\n') }
  function toIcs(doc, now) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mon Orga//FR', 'CALSCALE:GREGORIAN']
    const utc = t => new Date(t).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
    function add(id, day, time, end, endDay, title, place, details, remind, repeat, until, skip, updatedAt) {
      lines.push('BEGIN:VEVENT', 'UID:' + id + '@mon-orga', 'DTSTAMP:' + utc(now), 'LAST-MODIFIED:' + utc(updatedAt || now), 'SUMMARY:' + icsText(title))
      if (time) {
        lines.push('DTSTART:' + icsDate(day, time))
        const e = end && (end > time || (endDay && endDay > day)) ? end : null
        lines.push('DTEND:' + (e ? icsDate(endDay || day, e) : icsDate(endDay || day, hm(new Date(ms(day + 'T' + time) + 3600000)))))
      } else {
        lines.push('DTSTART;VALUE=DATE:' + icsDate(day), 'DTEND;VALUE=DATE:' + icsDate(addDays(endDay || day, 1)))
      }
      if (place) lines.push('LOCATION:' + icsText(place))
      if (details) lines.push('DESCRIPTION:' + icsText(details))
      const r = rrule(repeat, until); if (r) lines.push('RRULE:' + r)
      ;(skip || []).forEach(s => lines.push(time ? 'EXDATE:' + icsDate(s, time) : 'EXDATE;VALUE=DATE:' + icsDate(s)))
      ;(remind || []).forEach(m => {
        const before = time ? m : m - 9 * 60 // all-day: our reminders count from 09:00, .ics ones from midnight
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(title), 'TRIGGER:' + (before >= 0 ? '-PT' + before : 'PT' + -before) + 'M', 'END:VALARM')
      })
      lines.push('END:VEVENT')
    }
    live(doc.events).forEach(e => add(e.id, e.day, e.time, e.end, e.endDay, e.text, e.place, e.details, e.remind, e.repeat, e.until, e.skip, e.updatedAt))
    live(doc.tasks).filter(t => t.due && !t.done).forEach(t => add(t.id, dayOf(t.due), timeOf(t.due), null, null, TASK_MARK + t.text, t.place, t.details, t.remind, t.repeat, t.until, null, t.updatedAt))
    lines.push('END:VCALENDAR')
    return lines.map(fold75).join('\r\n') + '\r\n'
  }
  const TASK_MARK = '☐ '
  // Reads the events of a .ics file. Ids come from the UID (ours come back as they left), so importing the same file
  // twice updates instead of duplicating. updatedAt is the file's LAST-MODIFIED (else very old): a local edit or
  // deletion made after that wins over a re-import. Our own exported tasks are skipped (they live in the task list).
  function fromIcs(text, now) {
    const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/)
    const unesc = s => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
    const events = []; let ev = null; let inAlarm = false
    function dt(v, params) {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(v); if (!m) return null
      if (!m[4] || /VALUE=DATE(?!-)/.test(params)) return { day: m[1] + '-' + m[2] + '-' + m[3], time: null }
      const d = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
      return { day: ymd(d), time: hm(d) }
    }
    lines.forEach(line => {
      const i = line.indexOf(':'); if (i < 0) return
      const head = line.slice(0, i); const value = line.slice(i + 1)
      const name = head.split(';')[0].toUpperCase(); const params = head.slice(name.length)
      if (name === 'BEGIN' && value === 'VEVENT') { ev = { remind: [], skip: [] }; return }
      if (name === 'BEGIN' && value === 'VALARM') { inAlarm = true; return }
      if (name === 'END' && value === 'VALARM') { inAlarm = false; return }
      if (name === 'END' && value === 'VEVENT') { if (ev && ev.start) events.push(ev); ev = null; return }
      if (!ev) return
      if (inAlarm) {
        const m = /^([-+])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(value)
        if (name === 'TRIGGER' && m) ev.remind.push((m[1] === '-' ? 1 : -1) * ((+m[2] || 0) * 7 * 1440 + (+m[3] || 0) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0)))
        return
      }
      if (name === 'UID') ev.uid = value
      else if (name === 'SUMMARY') ev.text = unesc(value)
      else if (name === 'LOCATION') ev.place = unesc(value)
      else if (name === 'DESCRIPTION') ev.details = unesc(value)
      else if (name === 'DTSTART') ev.start = dt(value, params)
      else if (name === 'DTEND') ev.end = dt(value, params)
      else if (name === 'EXDATE') value.split(',').forEach(v => { const d = dt(v, params); if (d) ev.skip.push(d.day) })
      else if (name === 'RRULE') ev.rrule = value
      else if (name === 'RECURRENCE-ID') ev.recurrence = dt(value, params)
      else if (name === 'LAST-MODIFIED' || (name === 'CREATED' && !ev.modified)) {
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value)
        if (m) ev.modified = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
      } else if (name === 'STATUS') ev.cancelled = /CANCELLED/i.test(value)
    })
    const ours = ev => /@mon-orga$/.test(ev.uid || '') && !ev.recurrence
    const out = events.filter(ev => !(ours(ev) && (ev.text || '').indexOf(TASK_MARK) === 0) && !(ev.cancelled && !ev.recurrence)).map(ev => {
      const id = ours(ev) ? ev.uid.slice(0, -9) : 'ics-' + hash((ev.uid || ev.text + ev.start.day) + (ev.recurrence ? '@' + ev.recurrence.day : ''))
      const e = { id: id, createdAt: now, updatedAt: Math.min(ev.modified || 1, now), text: ev.text || '?', day: ev.start.day, time: ev.start.time,
        place: ev.place || '', details: ev.details || '', skip: ev.skip,
        remind: ev.remind.map(m => (ev.start.time ? m : m + 9 * 60)).filter(m => m >= 0) }
      if (ev.end) {
        const lastDay = ev.start.time ? ev.end.day : addDays(ev.end.day, -1) // an all-day DTEND is exclusive
        if (lastDay > e.day) e.endDay = lastDay
        if (ev.start.time && ev.end.time && ev.end.day === ev.start.day) e.end = ev.end.time
      }
      if (ev.rrule) {
        const r = {}; ev.rrule.split(';').forEach(p => { const kv = p.split('='); r[kv[0].toUpperCase()] = kv[1] })
        const n = +r.INTERVAL || 1
        const by = (r.BYDAY || '').split(',').map(d => ICS_DAYS.indexOf(d.replace(/^[-+\d]+/, '')) + 1).filter(d => d > 0)
        const ord = /^([-+]?\d)([A-Z]{2})$/.exec(r.BYDAY || '') // 2TH, -1FR: the Nth weekday of the month
        const nth = ord ? +ord[1] : r.BYSETPOS && by.length === 1 ? +r.BYSETPOS : 0
        e.repeat = r.FREQ === 'DAILY' ? (n > 1 ? 'days:' + n : 'daily')
          : r.FREQ === 'WEEKLY' ? (by.length === 5 && by.join() === '1,2,3,4,5' && n === 1 ? 'weekdays' : by.length && n === 1 ? 'weekly:' + by.join(',') : n > 1 ? 'weeks:' + n : 'weekly')
          : r.FREQ === 'MONTHLY' ? (nth && by.length === 1 && n === 1 ? 'nth:' + nth + ':' + by[0] : n > 1 ? 'months:' + n : 'monthly')
          : r.FREQ === 'YEARLY' ? 'yearly' : null
        if (r.UNTIL) { const u = dt(r.UNTIL, ''); if (u) e.until = u.day }
        else if (r.COUNT && e.repeat) { // keep the exact number of occurrences
          let d = e.day; for (let c = 1; c < +r.COUNT && d; c++) d = nextDay(e.day, e.repeat, addDays(d, 1), null, null)
          if (d) e.until = d
        }
      }
      e.uid = ev.uid; e.moved = ev.recurrence ? ev.recurrence.day : null; e.cancelled = !!ev.cancelled // a cancelled session only skips its day
      return e
    })
    out.filter(e => e.moved).forEach(o => { const master = out.find(m => m.uid === o.uid && !m.moved); if (master && master.skip.indexOf(o.moved) < 0) master.skip.push(o.moved) })
    return out.filter(e => !e.cancelled).map(e => { delete e.uid; delete e.moved; delete e.cancelled; return e })
  }
  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) }

  const api = {
    MORNING, SECTIONS, pad, ymd, hm, stamp, ms, toDate, parseDay, dayOf, timeOf, addDays, addMonths, between, weekday, today,
    repeatDays, nextDay, occursOn, nextOccurrence, eventSpan, eventStartOn, eventsOn, alarms, nextAlarm,
    sectionOf, sortTasks, pri, complete, postpone, histTime, streak, doneSince, level,
    newId, normalize, empty, find, merge, purge, live, fold, matches, tags, parse, understand, APPOINTMENT, toIcs, fromIcs, rrule,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.Store = api
})(typeof window !== 'undefined' ? window : this)
