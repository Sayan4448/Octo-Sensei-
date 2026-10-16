/* Mon Orga: the data model, shared by the phone (WebView), the PC app (Electron) and the tests (Node).
 *
 * One JSON document, merged item by item (newest `updatedAt` wins), so the phone, the PC and a backup file
 * can each be edited offline and synced later. The Android side (Store.kt) reads the same format.
 *
 *  task  {id, createdAt, updatedAt, deleted, text, done, due, remind, repeat, until, important, list, steps, details, loud, doneAt}
 *  note  {id, createdAt, updatedAt, deleted, text, pinned, list, images}
 *  event {id, createdAt, updatedAt, deleted, day, time, end, endDay, text, place, details, remind, repeat, until, skip, loud, list, noteId}
 *  due   "2026-10-17T09:00" (with a time) or "2026-10-17" (a day only: reminders count from 09:00)
 *  remind  minutes before (0 = on time), several allowed: [1440, 60]
 *  repeat  daily | weekdays | weekly | weekly:1,3,5 (1 = Monday) | weeks:N | monthly | yearly | days:N | hours:N
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
      } else if (kind === 'monthly' || kind === 'yearly') {
        const step = kind === 'monthly' ? 1 : 12
        const a = start.split('-').map(Number); const b = d.split('-').map(Number)
        let k = Math.max(0, Math.floor(((b[0] - a[0]) * 12 + b[1] - a[1]) / step))
        c = addMonths(start, k * step)
        while (c < d) { k++; c = addMonths(start, k * step) }
      } else return null
      if (until && c > until) return null
      if (!skip || skip.indexOf(c) < 0) return c
      d = addDays(c, 1)
    }
    return null
  }
  const occursOn = (start, repeat, day, until, skip) => nextDay(start, repeat, day, until, skip) === day

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
  const SECTIONS = ['late', 'today', 'tomorrow', 'week', 'later', 'nodate', 'done']
  function sectionOf(t, now) {
    if (t.done) return 'done'
    if (!t.due) return 'nodate'
    const d = dayOf(t.due); const td = today(now)
    if (d < td || (t.due.length > 10 && ms(t.due) < now)) return 'late'
    if (d === td) return 'today'
    if (d === addDays(td, 1)) return 'tomorrow'
    if (d <= addDays(td, 7)) return 'week'
    return 'later'
  }
  const dueMs = t => ms(t.due.length > 10 ? t.due : t.due + 'T00:00')
  function sortTasks(tasks, now) {
    const rank = t => SECTIONS.indexOf(sectionOf(t, now))
    return tasks.filter(t => !t.deleted).slice().sort((a, b) =>
      rank(a) - rank(b) ||
      (a.done ? (b.doneAt || 0) - (a.doneAt || 0) : 0) ||
      (a.due && b.due ? dueMs(a) - dueMs(b) : 0) ||
      (b.important ? 1 : 0) - (a.important ? 1 : 0) ||
      (b.createdAt || 0) - (a.createdAt || 0))
  }
  // Ticks a task. A repeating one moves to its next date instead (steps unticked), unless the series is over.
  function complete(t, now) {
    const done = Object.assign({}, t, { updatedAt: now, doneAt: now })
    if (t.repeat && t.due) {
      let next
      if (t.due.length > 10) {
        const o = nextOccurrence(t.due, t.repeat, t.until, null, Math.max(ms(t.due), now))
        next = o === null ? null : stamp(new Date(o))
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
    return Object.assign({}, t, { due: day + (timeOf(t.due) ? 'T' + timeOf(t.due) : ''), updatedAt: now })
  }

  // ---------- progress ----------
  function streak(history, now) {
    const days = {}; history.forEach(h => { days[today(h)] = true })
    let d = today(now); if (!days[d]) d = addDays(d, -1)
    let n = 0; while (days[d]) { n++; d = addDays(d, -1) }
    return n
  }
  function doneSince(history, fromDay) { const from = ms(fromDay); return history.filter(h => h >= from).length }
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
      text: str(t.text), done: !!t.done, due: opt(t.due), remind: mins(t.remind), repeat: opt(t.repeat), until: opt(t.until),
      important: !!t.important, list: str(t.list), details: str(t.details), loud: !!t.loud, doneAt: +t.doneAt || null,
      steps: (Array.isArray(t.steps) ? t.steps : []).map(s => ({ text: str(s.text), done: !!s.done })),
    }))
    out.notes = (Array.isArray(d.notes) ? d.notes : []).map(n => Object.assign({}, n, base(n, now), {
      text: str(n.text), pinned: !!n.pinned, list: str(n.list), images: Array.isArray(n.images) ? n.images.filter(i => typeof i === 'string') : [],
    }))
    out.events = (Array.isArray(d.events) ? d.events : []).filter(e => typeof e.day === 'string' && e.day.length === 10).map(e => Object.assign({}, e, base(e, now), {
      text: str(e.text), time: opt(e.time), end: opt(e.end), endDay: opt(e.endDay), place: str(e.place), details: str(e.details),
      remind: mins(e.remind), repeat: opt(e.repeat), until: opt(e.until), skip: Array.isArray(e.skip) ? e.skip.filter(s => typeof s === 'string') : [],
      loud: !!e.loud, list: str(e.list), noteId: opt(e.noteId),
    }))
    out.history = (Array.isArray(d.history) ? d.history : []).map(Number).filter(isFinite)
    return out
  }
  const empty = () => normalize({})
  function find(doc, id) {
    for (let k = 0; k < KINDS.length; k++) { const it = doc[KINDS[k]].find(x => x.id === id); if (it) return it }
    return null
  }
  // Newest edit of each item wins; deletions travel as tombstones.
  function merge(local, remote) {
    const a = normalize(local); const b = normalize(remote)
    const out = Object.assign({}, a)
    KINDS.forEach(k => {
      const byId = {}; const order = []
      a[k].concat(b[k]).forEach(it => {
        const cur = byId[it.id]
        if (!cur) order.push(it.id)
        if (!cur || it.updatedAt > cur.updatedAt) byId[it.id] = it
      })
      out[k] = order.map(id => byId[id])
    })
    const seen = {}
    out.history = a.history.concat(b.history).filter(h => (seen[h] ? false : (seen[h] = true))).sort((x, y) => x - y).slice(-HISTORY_MAX)
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
  const TAG = /(^|\s)#([A-Za-zÀ-ÖØ-öø-ÿ0-9_-]{2,})/g
  function tags(text) { const out = []; let m; TAG.lastIndex = 0; while ((m = TAG.exec(text))) out.push(m[2].toLowerCase()); return out }

  // ---------- natural language: "Sortir les poubelles chaque mardi 19h" ----------
  const L = 'A-Za-zÀ-ÖØ-öø-ÿ0-9'
  const word = src => new RegExp('(^|[^' + L + '])(' + src + ')(?![' + L + '])', 'i')
  const FR_DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
  const EN_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
  const DAYS = FR_DAYS.concat(EN_DAYS).join('|')
  const dayIndex = name => { const n = name.toLowerCase().replace(/s$/, ''); const i = FR_DAYS.indexOf(n); return (i >= 0 ? i : EN_DAYS.indexOf(n)) + 1 }
  const MONTHS = [
    ['janvier', 'janv', 'january', 'jan'], ['février', 'fevrier', 'févr', 'fevr', 'fév', 'fev', 'february', 'feb'], ['mars', 'march', 'mar'],
    ['avril', 'avr', 'april', 'apr'], ['mai', 'may'], ['juin', 'june', 'jun'], ['juillet', 'juil', 'july', 'jul'], ['août', 'aout', 'august', 'aug'],
    ['septembre', 'sept', 'sep', 'september'], ['octobre', 'oct', 'october'], ['novembre', 'nov', 'november'], ['décembre', 'decembre', 'déc', 'dec', 'december']]
  const MONTH_RE = MONTHS.reduce((a, m) => a.concat(m), []).sort((x, y) => y.length - x.length).join('|')
  const monthIndex = name => MONTHS.findIndex(m => m.indexOf(name.toLowerCase().replace('.', '')) >= 0)
  const NUM_WORDS = { un: 1, une: 1, a: 1, an: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3 }
  const num = s => NUM_WORDS[s.toLowerCase()] || parseInt(s, 10)

  const REPEATS = [
    [word('(?:toutes les|every)\\s+(\\d{1,2})\\s*(?:h|heures?|hours?|hrs?)'), g => 'hours:' + g[1]],
    [word('(?:tous les|every)\\s+(\\d{1,3})\\s*(?:jours|days)'), g => 'days:' + g[1]],
    [word('(?:toutes les|every)\\s+(\\d{1,2})\\s*(?:semaines|weeks)'), g => 'weeks:' + g[1]],
    [word('une semaine sur deux|toutes les deux semaines|every other week'), () => 'weeks:2'],
    [word('(?:chaque|tous les|toutes les|every)\\s+((?:' + DAYS + ')s?(?:\\s*(?:,|et|and|&)\\s*(?:' + DAYS + ')s?)*)'),
      g => 'weekly:' + g[1].split(/\s*(?:,|et|and|&)\s*/i).map(dayIndex).filter((n, i, a) => n > 0 && a.indexOf(n) === i).sort().join(',')],
    [word('tous les (?:matins|soirs)|every (?:morning|evening|night)'), g => 'daily'],
    [word('tous les jours|chaque jour|quotidiennement|every ?day|daily'), () => 'daily'],
    [word('en semaine|du lundi au vendredi|les jours ouvr[ée]s|on weekdays|every weekday|weekdays'), () => 'weekdays'],
    [word('toutes les semaines|chaque semaine|every week|weekly'), () => 'weekly'],
    [word('tous les mois|chaque mois|every month|monthly'), () => 'monthly'],
    [word('tous les ans|chaque ann[ée]e|every year|yearly|annually'), () => 'yearly'],
  ]
  const PART_OF_DAY = { matin: '09:00', morning: '09:00', midi: '12:00', 'apres-midi': '14:00', 'apres midi': '14:00', afternoon: '14:00', soir: '19:00', evening: '19:00', night: '21:00' }
  const FILLER = /^\s*(?:rappelle[- ]moi\s+(?:de\s+|d['’])?|remind me to\s+|n['’]oublie pas\s+(?:de\s+|d['’])?|penser [àa]\s+|don['’]t forget to\s+)/i

  function parse(input, nowMs) {
    const now = new Date(nowMs)
    const td = ymd(now)
    let text = input
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
    let repeat = null; let date = null; let time = null; let exact = null; let weekly = null; let single = false; let g
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
    else if ((g = take(word('(?:dans|in)\\s+(\\d{1,3}|une?|an?|one|deux|two|trois|three)\\s*(minutes?|mins?|mn|heures?|hours?|hrs?|h|jours?|days?|semaines?|weeks?|mois|months?)')))) {
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
        date = addDays(td, 1); if (g[1]) time = PART_OF_DAY[fold(g[1])] || null
      } else if (take(word('ce soir|tonight|this evening'))) { date = td; time = '19:00' }
      else if (take(word('cet apr[eè]s[- ]midi|this afternoon'))) { date = td; time = '14:00' }
      else if (take(word('ce matin|this morning'))) { date = td; time = '09:00' }
      else if (take(word("aujourd['’]hui|today"))) date = td
      else if (take(word('la semaine prochaine|next week'))) date = addDays(td, 8 - weekday(td))
      else if (take(word('ce week-?end|this weekend|le week-?end prochain|next weekend'))) date = addDays(td, (6 - weekday(td) + 7) % 7)
      else if (take(word('le mois prochain|next month'))) date = addMonths(td, 1).slice(0, 8) + '01'
      else if ((g = take(word('(?:le\\s+)?(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTH_RE + ')\\.?(?:\\s+(\\d{4}))?'), x => validDay(+x[1], monthIndex(x[2]))))) date = pickDate(g[3] ? +g[3] : null, monthIndex(g[2]), +g[1], td)
      else if ((g = take(word('(' + MONTH_RE + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?'), x => validDay(+x[2], monthIndex(x[1]))))) date = pickDate(g[3] ? +g[3] : null, monthIndex(g[1]), +g[2], td)
      else if ((g = take(word('(?:le\\s+)?(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?'), x => validDay(+x[1], +x[2] - 1)))) {
        const y = g[3] ? (+g[3] < 100 ? 2000 + +g[3] : +g[3]) : null
        date = pickDate(y, +g[2] - 1, +g[1], td)
      } else if ((g = take(word('le\\s+(\\d{1,2})(?:er)?'), x => +x[1] >= 1 && +x[1] <= 31))) {
        const d = +g[1]; const first = td.slice(0, 8) + '01'
        const inMonth = m1 => m1.slice(0, 8) + pad(Math.min(d, monthDays(+m1.slice(0, 4), +m1.slice(5, 7) - 1)))
        date = inMonth(first) >= td ? inMonth(first) : inMonth(addMonths(first, 1))
      } else if ((g = take(word('(?:ce\\s+|next\\s+|this\\s+|on\\s+)?(' + DAYS + ')(?:\\s+prochain)?')))) {
        if (!weekly) { weekly = [dayIndex(g[1])]; single = true }
      }
    }
    if (exact === null) {
      const hourOk = x => +x[1] < 24 && +(x[2] || 0) < 60
      if ((g = take(word('(?:[àa]\\s+)?(midi|minuit|noon|midnight)')))) time = /midi|noon/i.test(g[1]) ? '12:00' : '00:00'
      else if ((g = take(word('(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)'), x => +x[1] >= 1 && +x[1] <= 12 && +(x[2] || 0) < 60))) {
        time = pad((+g[1] % 12) + (g[3].toLowerCase() === 'pm' ? 12 : 0)) + ':' + pad(+(g[2] || 0))
      } else if ((g = take(word('(?:[àa]|at|vers|pour|@)\\s*(\\d{1,2})(?:\\s*(?:h|:)\\s*(\\d{2})?|\\s+heures?)'), hourOk))) {
        time = pad(+g[1]) + ':' + pad(+(g[2] || 0))
      } else {
        // A bare "18h" counts next to a date or a repetition, or at the very end: "faire 2h de sport" stays a text.
        const bare = word('(\\d{1,2})\\s*(?:h|:)\\s*(\\d{2})?')
        g = take(bare, x => {
          const m = bare.exec(text); const s = m.index + m[1].length; const e = s + m[2].length
          return hourOk(x) && (!text.slice(e).trim() || cuts.some(c => Math.abs(c - e) <= 3 || Math.abs(c - s) <= 3))
        })
        if (g) time = pad(+g[1]) + ':' + pad(+(g[2] || 0))
      }
    }
    let due = null
    if (exact !== null) due = stamp(new Date(Math.ceil(exact / 60000) * 60000))
    else {
      if (!date && weekly) {
        // "lundi" means the next Monday, today only with a later time ("lundi 18h" on a Monday morning); "chaque lundi" may start today.
        const fromToday = time ? ms(td + 'T' + time) > nowMs : !single
        let d = fromToday ? td : addDays(td, 1)
        while (weekly.indexOf(weekday(d)) < 0) d = addDays(d, 1)
        date = d
      }
      if (date) due = date + (time ? 'T' + time : '')
      else if (time) due = (ms(td + 'T' + time) > nowMs ? td : addDays(td, 1)) + 'T' + time
      else if (repeat && repeat.indexOf('hours:') === 0) due = stamp(new Date(Math.ceil((nowMs + parseInt(repeat.slice(6), 10) * 3600000) / 60000) * 60000))
      else if (repeat) due = td
    }
    if (!due && !repeat) return { text: input.trim(), due: null, repeat: null }
    let rest = text.replace(FILLER, '').replace(/\s+/g, ' ').trim()
    for (let i = 0; i < 3; i++) rest = rest.replace(/[\s,;:.-]+$/, '').replace(/\s+(?:[àa]|at|le|on|pour|vers|de|du|for|by|et|and|à partir de)$/i, '').trim()
    rest = rest.replace(/^[\s,;:.-]+/, '')
    rest = rest.charAt(0).toUpperCase() + rest.slice(1)
    return { text: rest || input.trim(), due: due, repeat: repeat }
  }
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
      : k === 'weeks' ? 'FREQ=WEEKLY;INTERVAL=' + n : k === 'monthly' ? 'FREQ=MONTHLY' : k === 'yearly' ? 'FREQ=YEARLY' : null
    if (r && until) r += ';UNTIL=' + until.replace(/-/g, '') + 'T235959'
    return r
  }
  const icsText = s => str(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1')
  const icsDate = (day, time) => day.replace(/-/g, '') + (time ? 'T' + time.replace(':', '') + '00' : '')
  function fold75(line) { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74) } out.push(line); return out.join('\r\n') }
  function toIcs(doc, now) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mon Orga//FR', 'CALSCALE:GREGORIAN']
    const dtstamp = new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
    function add(id, day, time, end, endDay, title, place, details, remind, repeat, until, skip) {
      lines.push('BEGIN:VEVENT', 'UID:' + id + '@mon-orga', 'DTSTAMP:' + dtstamp, 'SUMMARY:' + icsText(title))
      if (time) {
        lines.push('DTSTART:' + icsDate(day, time))
        const e = end && end > time ? end : null
        lines.push('DTEND:' + (e ? icsDate(endDay || day, e) : icsDate(day, hm(new Date(ms(day + 'T' + time) + 3600000)))))
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
    live(doc.events).forEach(e => add(e.id, e.day, e.time, e.end, e.endDay, e.text, e.place, e.details, e.remind, e.repeat, e.until, e.skip))
    live(doc.tasks).filter(t => t.due && !t.done).forEach(t => add(t.id, dayOf(t.due), timeOf(t.due), null, null, '☐ ' + t.text, '', t.details, t.remind, t.repeat, t.until, null))
    lines.push('END:VCALENDAR')
    return lines.map(fold75).join('\r\n') + '\r\n'
  }
  // Reads the events of a .ics file. Ids come from the UID, so importing the same file twice updates instead of duplicating.
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
    })
    return events.map(ev => {
      const e = { id: 'ics-' + hash(ev.uid || ev.text + ev.start.day), createdAt: now, updatedAt: now, text: ev.text || '?', day: ev.start.day, time: ev.start.time,
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
        e.repeat = r.FREQ === 'DAILY' ? (n > 1 ? 'days:' + n : 'daily')
          : r.FREQ === 'WEEKLY' ? (by.length === 5 && by.join() === '1,2,3,4,5' && n === 1 ? 'weekdays' : by.length && n === 1 ? 'weekly:' + by.join(',') : n > 1 ? 'weeks:' + n : 'weekly')
          : r.FREQ === 'MONTHLY' ? 'monthly' : r.FREQ === 'YEARLY' ? 'yearly' : null
        if (r.UNTIL) { const u = dt(r.UNTIL, ''); if (u) e.until = u.day }
        else if (r.COUNT && e.repeat) { // keep the exact number of occurrences
          let d = e.day; for (let c = 1; c < +r.COUNT && d; c++) d = nextDay(e.day, e.repeat, addDays(d, 1), null, null)
          if (d) e.until = d
        }
      }
      return e
    })
  }
  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) }

  const api = {
    MORNING, SECTIONS, pad, ymd, hm, stamp, ms, toDate, parseDay, dayOf, timeOf, addDays, addMonths, between, weekday, today,
    repeatDays, nextDay, occursOn, nextOccurrence, eventSpan, eventStartOn, eventsOn, alarms, nextAlarm,
    sectionOf, sortTasks, complete, postpone, streak, doneSince, level,
    newId, normalize, empty, find, merge, purge, live, fold, matches, tags, parse, toIcs, fromIcs, rrule,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.Store = api
})(typeof window !== 'undefined' ? window : this)
