/* Mon Orga, the interface: one page for the phone (Android WebView), the PC app (Electron) and a browser connected to the phone. */
(function () {
  'use strict'
  const S = window.Store
  const H = window.Host
  const I18N = window.I18N
  const $ = (sel, el) => (el || document).querySelector(sel)
  const $$ = (sel, el) => Array.prototype.slice.call((el || document).querySelectorAll(sel))
  const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const now = () => Date.now()
  const clone = o => JSON.parse(JSON.stringify(o))

  const DEFAULTS = {
    theme: 'auto', text: 1, sober: false, calm: false, lefty: false, lang: 'auto', weekStart: 1,
    remindTask: [0], remindEvent: [60, 1440], remindAllDay: [0],
    snooze: 10, nag: 10, nagTimes: 3, summary: '08:00', loudImportant: false, privateNotifs: false, lock: false,
    tray: true, login: false, focus: null, welcomed: false,
    loudAll: false, dayStart: 0, eventLength: 60, recentTimes: [], morning: '09:00', evening: '19:00', quietFrom: '', quietTo: '',
    colors: 'app', phoneCalendar: false, backupLast: 0, backupAsked: 0, news: 0, googleBackup: true, archivedLists: [],
  }
  const NEWS = 52 // bump with each "what's new" list
  let doc = S.empty()
  let set = Object.assign({}, DEFAULTS)
  const ui = {
    tab: 'tasks', query: '', searchOpen: false, filter: null, showDone: false,
    day: S.today(now()), month: S.today(now()).slice(0, 8) + '01', agendaMode: 'month',
    sheet: null, noteRead: false, draft: { due: null, repeat: null, important: false, raw: false },
    filters: {}, upcoming: 30,
  }

  // ---------- words ----------
  let lang = 'fr'
  const EMOJI = /[☀-➿⭐⬆↔-↪⌚-⏿]️?|\uD83C[\uDC00-\uDFFF]️?|\uD83D[\uDC00-\uDFFF]️?|\uD83E[\uDD00-\uDFFF]️?/g
  function T(key) {
    const dict = I18N[lang] || I18N.fr
    if (set.sober && dict[key + '_s'] !== undefined) key += '_s' // sober mode: neutral wording, no "tu"
    let s = dict[key] !== undefined ? dict[key] : (I18N.fr[key] !== undefined ? I18N.fr[key] : key)
    for (let i = 1; i < arguments.length; i++) s = s.split('{' + (i - 1) + '}').join(arguments[i])
    return set.sober ? s.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim() : s
  }
  const plural = (n, one, many) => T(n === 1 ? one : many, n)
  const parse = text => S.parse(text, now(), { mdy: /^en-US/i.test(navigator.language || '') })
  const locale = () => lang === 'fr' ? 'fr-FR' : (/^en/.test(navigator.language) ? navigator.language : 'en-GB')
  const fmt = (opts, d) => new Intl.DateTimeFormat(locale(), opts).format(d)
  function fmtTime(t) { if (!t) return ''; const p = t.split(':'); return fmt({ hour: 'numeric', minute: '2-digit' }, new Date(2000, 0, 1, +p[0], +p[1])) }
  function fmtDay(day, long) {
    const td = S.today(now()); const diff = S.between(td, day)
    if (diff === 0) return T('today')
    if (diff === 1) return T('tomorrow')
    if (diff === -1) return T('yesterday')
    const d = S.parseDay(day)
    if (diff > 1 && diff < 7 && !long) return cap(fmt({ weekday: 'long' }, d))
    const opts = { weekday: 'short', day: 'numeric', month: 'short' }
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'
    return cap(fmt(opts, d))
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
  function rel(at) {
    const diff = at - now(); const m = Math.round(Math.abs(diff) / 60000)
    const v = m < 60 ? T('nMin', Math.max(1, m)) : m < 48 * 60 ? T('nH', Math.round(m / 60)) : T('nDays', Math.round(m / 1440))
    return diff >= 0 ? T('inX', v) : T('agoX', v)
  }
  function fmtDue(t, withRel) {
    if (!t.due) return ''
    const time = S.timeOf(t.due)
    let s = fmtDay(S.dayOf(t.due)) + (time ? ' ' + fmtTime(time) : '')
    if (withRel && time && !t.done && Math.abs(S.ms(t.due) - now()) < 36 * 3600000) s += ' · ' + rel(S.ms(t.due))
    return s
  }
  function repeatLabel(r) {
    if (!r) return T('never')
    const k = r.split(':')[0]; const n = r.split(':')[1]
    if (k === 'weekly' && n) {
      const names = S.repeatDays(r).map(d => fmt({ weekday: 'short' }, new Date(2024, 0, d))) // 2024-01-01 is a Monday
      return T('everyDays', names.join(', '))
    }
    if (k === 'nth') { const p = r.split(':'); return T('rep_nth', T('ord_' + p[1]), fmt({ weekday: 'long' }, new Date(2024, 0, +p[2]))) }
    return T('rep_' + k, n) + (/:after$/.test(r) ? ' ' + T('afterTick') : '')
  }
  function remindLabel(m, allDay) {
    if (allDay) {
      if (m === 0) return T('remDayOf')
      if (m === 1440) return T('remEve')
    }
    if (m === 0) return T('remOnTime')
    if (m === 43200) return T('remMonth')
    if (m === 129600) return T('remMonths', 3)
    if (m % 10080 === 0) return T('remWeeks', m / 10080)
    if (m % 1440 === 0) return m === 1440 ? T('remDayBefore') : T('remDays', m / 1440)
    if (m % 60 === 0) return T('remHours', m / 60)
    return T('remMin', m)
  }
  const REMIND_TIMED = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080, 20160, 43200]
  const REMIND_ALLDAY = [0, 1440, 2880, 10080, 20160, 43200, 129600]

  // ---------- icons (Material Symbols, Apache 2.0) ----------
  const ICONS = {
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    mic: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
    send: 'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z',
    star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    star_border: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
    bell: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
    repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z',
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    pin: 'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z',
    left: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
    right: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    expand: 'M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z',
    calendar: 'M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z',
    note: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    tasks: 'M22 5.18 10.59 16.6l-4.24-4.24 1.41-1.41 2.83 2.83 10-10L22 5.18zM19.79 10.22c.13.57.21 1.17.21 1.78 0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8c1.58 0 3.04.46 4.28 1.25l1.44-1.44A9.9 9.9 0 0 0 12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10c0-1.19-.22-2.33-.6-3.39l-1.61 1.61z',
    tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    alarm: 'M22 5.72l-4.6-3.86-1.29 1.53 4.6 3.86L22 5.72zM7.88 3.39 6.6 1.86 2 5.71l1.29 1.53 4.59-3.85zM12.5 8H11v6l4.75 2.85.75-1.23-4-2.37V8zM12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z',
    clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    place: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
    photo: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z',
    timer: 'M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61 1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42A8.96 8.96 0 0 0 12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9 9-4.03 9-9c0-2.12-.74-4.07-1.97-5.61zM12 20c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z',
    sync: 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
    lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
    box: 'M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z',
    boxed: 'M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm-9 14-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    circle: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
    checked: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    forward: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
    link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
    phone: 'M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z',
    mail: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    upload: 'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
    info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
    warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    palette: 'M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
    pc: 'M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z',
    trophy: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z',
    label: 'M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z',
    list: 'M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z',
    loud: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    help: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z',
    undo: 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    fullOn: 'M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z',
    fullOff: 'M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2 22 3.41zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59 3.41 22z',
    camera: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9z',
    folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  }
  const icon = (name, cls) => '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + ICONS[name] + '"/></svg>'
  function hue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h }
  const listChip = name => '<span class="lchip" style="--h:' + hue(name.toLowerCase()) + '">' + esc(name) + '</span>'

  // ---------- data ----------
  let saving = Promise.resolve()
  let saveTimer = 0
  function commit(later) {
    doc = S.purge(doc, now())
    render()
    clearTimeout(saveTimer)
    if (later) saveTimer = setTimeout(flush, 500)
    else flush()
  }
  function flush() {
    clearTimeout(saveTimer)
    saving = saving.then(() => H.save(doc)).then(back => {
      if (!back) return
      const merged = S.merge(doc, back) // edits made while saving stay: they are newer
      if (JSON.stringify(merged) !== JSON.stringify(doc)) { doc = merged; render(); refreshSheet() }
    }).catch(e => { console.error(e); snack(T(e && e.message === 'storage' ? 'storageFull' : 'saveError'), null, 9000) })
    return saving
  }
  function touch(item) { item.updatedAt = Math.max(now(), (item.updatedAt || 0) + 1); return item }
  function kindOf(id) { return doc.tasks.some(x => x.id === id) ? 'tasks' : doc.notes.some(x => x.id === id) ? 'notes' : 'events' }
  function put(item, later) {
    const k = kindOf(item.id); const list = doc[k]
    touch(item)
    const i = list.findIndex(x => x.id === item.id)
    if (i >= 0) list[i] = item; else list.unshift(item)
    commit(later)
  }
  function add(kind, item) { doc[kind].unshift(touch(item)); commit() }
  function remove(id) {
    const item = S.find(doc, id); if (!item) return
    const before = clone(item)
    put(Object.assign(item, { deleted: true }))
    snack(T('deleted'), [{ label: T('undo'), run: () => put(Object.assign(S.find(doc, id), before, { deleted: false })) }])
  }
  const newTask = (o) => Object.assign(S.normalize({ tasks: [{}] }, now()).tasks[0], { createdAt: now() }, o)
  const newNote = (o) => Object.assign(S.normalize({ notes: [{}] }, now()).notes[0], { createdAt: now() }, o)
  const newEvent = (o) => Object.assign(S.normalize({ events: [{ day: ui.day }] }, now()).events[0], { createdAt: now(), remind: set.remindEvent.slice() }, o)
  const defaultRemind = due => (due && due.length > 10 ? set.remindTask : set.remindAllDay).slice()

  const archived = name => !!name && (set.archivedLists || []).indexOf(name) >= 0
  function lists(all) {
    const seen = {}
    S.live(doc.tasks).concat(S.live(doc.notes), S.live(doc.events)).forEach(x => { if (x.list && (all || !archived(x.list))) seen[x.list] = (seen[x.list] || 0) + 1 })
    return Object.keys(seen).sort((a, b) => seen[b] - seen[a] || a.localeCompare(b))
  }
  function allTags() {
    const seen = {}
    S.live(doc.notes).concat(S.live(doc.tasks)).forEach(x => S.tags(x.text + ' ' + (x.details || '')).forEach(t => { seen[t] = 1 }))
    return Object.keys(seen).sort()
  }
  function passes(x) {
    const f = ui.filter
    if (archived(x.list) && f !== 'list:' + x.list) return false // an archived project stays out of the way
    if (!f) return true
    if (f === 'important') return !!x.important
    if (f.indexOf('list:') === 0) return x.list === f.slice(5)
    if (f.indexOf('tag:') === 0) return S.tags(x.text + ' ' + (x.details || '')).indexOf(f.slice(4)) >= 0
    return true
  }
  // History entries are "time:taskId" for a tick, "time:taskId:x" when it was undone: per day and task the latest wins,
  // so ticking, unticking and ticking again the same day counts once.
  function ticks() {
    const last = {}
    doc.history.forEach(h => {
      const p = String(h).split(':'); const t = S.histTime(h); const key = S.today(t) + '|' + (p[1] || p[0])
      if (!last[key] || t >= last[key].t) last[key] = { t: t, id: p[1] || null, undone: p[2] === 'x' }
    })
    return Object.keys(last).map(k => last[k]).filter(x => !x.undone)
  }
  function doneDays() {
    const out = {}
    ticks().forEach(x => { const day = S.today(x.t); out[day] = (out[day] || 0) + 1 })
    return out
  }
  function stats() {
    const days = doneDays(); const td = S.today(now())
    const count = Object.keys(days).reduce((a, d) => a + days[d], 0)
    let streak = 0; let d = days[td] ? td : S.addDays(td, -1)
    while (days[d]) { streak++; d = S.addDays(d, -1) }
    const weekStart = S.addDays(td, -((S.weekday(td) - set.weekStart + 7) % 7))
    let week = 0; for (let x = weekStart; x <= td; x = S.addDays(x, 1)) week += days[x] || 0
    const last7 = []; for (let i = 6; i >= 0; i--) { const x = S.addDays(td, -i); last7.push({ day: x, n: days[x] || 0 }) }
    let best = 0; let run = 0; let prev = null
    Object.keys(days).sort().forEach(x => { run = prev && S.addDays(prev, 1) === x ? run + 1 : 1; prev = x; best = Math.max(best, run) })
    return { count, streak, best, week, today: days[td] || 0, last7, level: S.level(count) }
  }

  // ---------- task actions ----------
  let lastToggle = { id: null, at: 0 }
  function toggleTask(id, sure) {
    const t = S.find(doc, id); if (!t) return
    if (lastToggle.id === id && now() - lastToggle.at < 800) return // a double tap must not skip an occurrence
    const open = t.steps.filter(x => !x.done).length
    if (!sure && !t.done && !t.repeat && open) {
      return choose(plural(open, 'openStepsOne', 'openStepsMany'), t.text, [{ label: T('cancel'), value: false }, { label: T('markDoneBtn'), value: true }])
        .then(ok => { if (ok) { toggleTask(id, true); if (ui.sheet && ui.sheet.id === id) renderSheet() } })
    }
    lastToggle = { id: id, at: now() }
    const before = clone(t); const was = stats()
    if (t.done) {
      doc.history.push(now() + ':' + t.id + ':x')
      put(Object.assign(t, { done: false, doneAt: null }))
      return snack(T('reopened'))
    }
    const c = S.complete(t, now())
    doc.history.push(now() + ':' + t.id)
    put(Object.assign(t, c))
    if (H.haptic) H.haptic()
    const after = stats()
    let msg = c.done ? T('doneMsg') : T('doneNext', fmtDue(c))
    if (!set.sober && !set.calm) {
      if (after.level.level > was.level.level) msg = T('levelUp', after.level.level)
      else if (after.streak > was.streak && [3, 7, 14, 30, 50, 100, 365].indexOf(after.streak) >= 0) msg = T('streakUp', after.streak)
      else if (c.done) { const cheers = T('cheers').split('|'); msg = cheers[Math.floor(Math.random() * cheers.length)] }
      if (after.count > was.count) msg += ' · ' + T('xpGain', 10)
    }
    snack(msg, [{ label: T('undo'), run: () => { doc.history.push(now() + ':' + id + ':x'); put(Object.assign(S.find(doc, id), before)) } }])
  }
  // A long press on a task: "in 1 h", "tonight", "tomorrow morning", +2 days… without opening it.
  async function quickMenu(id) {
    const t = S.find(doc, id); if (!t || t.done || kindOf(id) !== 'tasks') return
    const pre = ['in1h', 'in3h', 'tonight', 'tomorrow'].filter(v => v !== 'tonight' || S.ms(S.today(now()) + 'T' + set.evening) > now())
    const v = await choose(T('moveTo'), t.text, pre.map(x => ({ label: presetLabel(x), value: x, menu: true, icon: 'clock' }))
      .concat([{ label: T('postpone2'), value: 'p2', menu: true, icon: 'forward' }, { label: T('postpone7'), value: 'p7', menu: true, icon: 'forward' }, { label: T('cancel'), value: null }]))
    if (!v) return
    if (v === 'p2' || v === 'p7') return postponeTask(id, v === 'p2' ? 2 : 7)
    const before = clone(t); setDue(t, dueFromPreset(v)); put(t)
    snack(T('movedTo', fmtDue(t)), [{ label: T('undo'), run: () => put(Object.assign(S.find(doc, id), before)) }])
  }
  function postponeTask(id, days) {
    const t = S.find(doc, id); if (!t) return
    const before = clone(t)
    put(Object.assign(t, S.postpone(t, now(), days || 1)))
    snack(T('movedTo', fmtDue(t)), [{ label: T('undo'), run: () => put(Object.assign(S.find(doc, id), before)) }])
  }
  function dueFromPreset(v) {
    const td = S.today(now()); const n = new Date()
    if (v === 'today') return td
    if (v === 'tonight') return td + 'T' + set.evening
    if (v === 'tomorrow') return S.addDays(td, 1) + 'T' + set.morning
    if (v === 'monday') return S.addDays(td, 8 - S.weekday(td)) + 'T' + set.morning
    if (v === 'weekend') return S.addDays(td, ((6 - S.weekday(td) + 7) % 7) || 7) + 'T10:00'
    if (v === 'in1h') { n.setMinutes(Math.ceil((n.getMinutes() + 60) / 5) * 5, 0, 0); return S.stamp(n) }
    if (v === 'in3h') { n.setMinutes(Math.ceil((n.getMinutes() + 180) / 5) * 5, 0, 0); return S.stamp(n) }
    if (v.indexOf('t:') === 0) { const tm = v.slice(2); return (S.ms(td + 'T' + tm) > now() ? td : S.addDays(td, 1)) + 'T' + tm } // a recent time
    return null
  }
  function presets() {
    const evening = S.ms(S.today(now()) + 'T' + set.evening) - now() > 3600000
    return (evening ? ['in1h', 'tonight'] : ['in1h', 'in3h']).concat(['tomorrow', 'monday', 'weekend'], (set.recentTimes || []).map(t => 't:' + t))
  }
  const presetLabel = v => v.indexOf('t:') === 0 ? T('atTime', fmtDay(S.dayOf(dueFromPreset(v))), fmtTime(v.slice(2))) : T('pre_' + v)
  function setDue(t, due) {
    if (due && due.length > 10) rememberTime(S.timeOf(due))
    const had = !!t.due
    t.due = due
    if (due && !had && !t.remind.length) t.remind = defaultRemind(due)
    if (due && t.remind.length) askNotifications()
  }
  function rememberTime(tm) { // the times people use come back as one-tap chips
    if (!tm || [set.morning, set.evening, '10:00'].indexOf(tm) >= 0) return
    const list = [tm].concat((set.recentTimes || []).filter(x => x !== tm)).slice(0, 3)
    if (list.join() !== (set.recentTimes || []).join()) { set.recentTimes = list; saveSettings() }
  }
  let asked = false
  function askNotifications() { if (!asked && H.notifyPermission) { asked = true; H.notifyPermission() } }

  // A day picked with the chips plus a time typed in the text: both count.
  const pickDue = (d, p) => d && d.length === 10 && p && p.length > 10 ? d + 'T' + S.timeOf(p) : d || p
  // "#Courses" names an existing list: the task goes in it (other #words stay tags).
  function withList(text) {
    const ls = lists(); let list = ''
    const out = text.replace(/(^|\s)#([^\s#]{2,})/g, (m, sp, name) => { const l = !list && ls.find(x => S.fold(x) === S.fold(name)); if (!l) return m; list = l; return sp }).replace(/\s+/g, ' ').trim()
    return list && out ? { text: out, list: list } : { text: text, list: '' }
  }
  const APPOINTMENT = /(^|[^A-Za-zÀ-ÿ])(rdv|rendez[- ]vous|dentiste|m[ée]decin|docteur|kin[ée]|ost[ée]o|coiffeur|r[ée]union|v[ée]t[ée]rinaire|chantier|intervention|d[ée]pannage|visite|consultation|cardio\w*|ophtalmo\w*|dermato\w*|gyn[ée]co\w*|p[ée]diatre|psy\w*|orthophoniste|radio|scanner|irm|[ée]chographie|prise de sang|analyses|labo|infirmi[eè]re|dr|meeting|appointment|dentist|doctor|vet)(?![A-Za-zÀ-ÿ])/i
  function addTasks(raw) {
    const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean)
    if (!lines.length) return
    const created = []
    lines.forEach(line => {
      const p = ui.draft.raw ? { text: line, due: null, repeat: null } : parse(line)
      const named = withList(p.text)
      const dues = ui.draft.due && ui.draft.due.length > 10 ? [ui.draft.due] : p.dues ? p.dues.map(d => pickDue(ui.draft.due, d)) : [pickDue(ui.draft.due, p.due)]
      dues.forEach(due => {
        const t = newTask({ text: named.text, repeat: ui.draft.repeat || p.repeat, important: ui.draft.important || !!p.important, prio: p.prio || 0, place: p.place || '',
          list: named.list || (ui.filter && ui.filter.indexOf('list:') === 0 ? ui.filter.slice(5) : '') })
        setDue(t, due)
        if (p.remind && t.due) t.remind = p.remind.slice()
        if (p.loud || (t.important && set.loudImportant)) t.loud = true
        created.push(t)
      })
    })
    created.reverse().forEach(t => doc.tasks.unshift(touch(t)))
    commit()
    ui.draft = { due: null, repeat: null, important: false, raw: false }
    renderAddBar()
    const t = created[0]
    if (created.length > 1) snack(T('addedN', created.length), [{ label: T('undo'), run: () => created.forEach(c => put(Object.assign(S.find(doc, c.id), { deleted: true }))) }]
      .concat(created.every(c => c.repeat && c.due && !c.loud && !set.loudAll) ? [{ label: T('loudShort'), run: () => { created.forEach(c => put(Object.assign(S.find(doc, c.id), { loud: true }))); warnIfBlocked() } }] : [])) // a pill box: offer the alarm
    else if (!t.due) {
      snack(T('addedAsk'), presets().slice(0, 3).map(v => ({ label: presetLabel(v), run: () => { const x = S.find(doc, t.id); setDue(x, dueFromPreset(v)); put(x); snack(T('remindAt', fmtDue(x))) } })), undoMs())
    } else {
      const acts = [{ label: T('edit'), run: () => openSheet(t.id) }]
      if (t.due.length > 10 && APPOINTMENT.test(t.text)) acts.unshift({ label: T('makeEvent'), run: () => taskToEvent(t.id) }) // "Dentiste mardi 14h30" is an appointment
      snack(T(t.remind.length ? 'addedForBell' : 'addedFor', fmtDue(t)), acts)
    }
  }
  function taskToEvent(id) {
    const t = S.find(doc, id); if (!t || !t.due) return
    const time = S.timeOf(t.due)
    const e = newEvent({ text: t.text, day: S.dayOf(t.due), time: time, end: time ? fromMinutes(minutes(time) + (+set.eventLength || 60)) : null,
      place: t.place, details: t.details, repeat: t.repeat, until: t.until, list: t.list, important: t.important, loud: t.loud })
    if (!time) e.remind = set.remindAllDay.slice()
    t.deleted = true; touch(t); add('events', e)
    snack(T('movedToAgenda', fmtDay(e.day, true) + (time ? ' ' + fmtTime(time) : '')), [{ label: T('open'), run: () => { switchTab('agenda'); ui.day = e.day; ui.month = e.day.slice(0, 8) + '01'; render(); openSheet(e.id, { day: e.day }) } }])
  }
  // "Dentiste mardi 14h30" typed on the calendar: an event that day (the selected day when no date is given).
  function addEvents(raw) {
    raw.split(/\n+/).map(s => s.trim()).filter(Boolean).forEach((line, i, all) => {
      const p = ui.draft.raw ? { text: line, due: null, repeat: null } : parse(line)
      const due = pickDue(ui.draft.due, p.due)
      const time = S.timeOf(due)
      const named = withList(p.text)
      const e = newEvent({ text: named.text, list: named.list, day: due ? S.dayOf(due) : ui.day, time: time, repeat: p.repeat, place: p.place || '', important: !!p.important, loud: !!p.loud })
      if (time) e.end = p.end || fromMinutes(minutes(time) + (+set.eventLength || 60)); else e.remind = set.remindAllDay.slice()
      if (p.remind) e.remind = p.remind.slice()
      add('events', e)
      if (i === all.length - 1) {
        ui.day = e.day; ui.month = e.day.slice(0, 8) + '01'; render()
        snack(T('eventAdded', fmtDay(e.day, true) + (time ? ' ' + fmtTime(time) : '')), [{ label: T('open'), run: () => openSheet(e.id, { day: e.day }) }])
      }
    })
    ui.draft = { due: null, repeat: null, important: false, raw: false }
  }
  function addNote(text) {
    const n = newNote({ text: text.trim(), list: ui.filter && ui.filter.indexOf('list:') === 0 ? ui.filter.slice(5) : '' })
    add('notes', n)
    return n
  }

  // ---------- page ----------
  const TABS = [['tasks', 'tasks'], ['notes', 'note'], ['agenda', 'calendar'], ['plus', 'tune']]
  function renderShell() {
    document.body.innerHTML = `
      <div id="app">
        <header id="top">
          <div class="top-row">
            <div class="titles"><h1 id="title"></h1><div id="subtitle"></div></div>
            <div class="top-actions" id="topActions"></div>
          </div>
          <div id="searchBar" hidden>
            ${icon('search')}<input id="search" type="search" autocomplete="off" enterkeyhint="search">
            <button class="icon-btn" data-act="search-close" aria-label="${esc(T('close'))}">${icon('close')}</button>
          </div>
          <div id="chips" class="chips scroll"></div>
        </header>
        <div id="focusBar" hidden></div>
        <main id="main" tabindex="-1"></main>
        <form id="addBar" autocomplete="off"></form>
        <button id="fab" class="fab" data-act="fab" hidden></button>
        <nav id="nav" aria-label="${esc(T('sections'))}">
          ${TABS.map(([k, ic]) => `<button data-act="tab" data-tab="${k}" aria-label="${esc(T('tab_' + k))}">${icon(ic)}<span>${esc(T('tab_' + k))}</span></button>`).join('')}
        </nav>
      </div>
      <div id="sheet" role="dialog" aria-modal="true" hidden></div>
      <div id="dialog" hidden></div>
      <div id="snack" role="status" aria-live="polite"></div>
      <input id="photoInput" type="file" accept="image/*" hidden>
      <input id="cameraInput" type="file" accept="image/*" capture="environment" hidden>`
    lastMain = ''
  }
  function render() {
    if (!$('#app')) return
    document.documentElement.lang = lang
    $$('#nav button').forEach(b => { const on = b.dataset.tab === ui.tab; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current') })
    renderTop(); renderMain(); renderFocus()
    const addHere = ui.tab !== 'plus'
    $('#addBar').hidden = !addHere
    if (addHere && $('#addBar').dataset.tab !== ui.tab) renderAddBar()
    $('#fab').hidden = true
  }
  function renderTop() {
    $('#title').textContent = T('tab_' + ui.tab)
    let sub = ''
    if (ui.tab === 'tasks') {
      const live = S.live(doc.tasks).filter(t => !t.done); const n = now()
      const late = live.filter(t => S.sectionOf(t, n, set.dayStart) === 'late').length
      const td = live.filter(t => S.sectionOf(t, n, set.dayStart) === 'today').length
      const st = stats()
      const parts = [cap(fmt({ weekday: 'long', day: 'numeric', month: 'long' }, new Date()))]
      if (td) parts.push(plural(td, 'todayOne', 'todayMany'))
      if (late) parts.push('<b class="late">' + esc(plural(late, 'lateOne', 'lateMany')) + '</b>')
      if (!set.calm && st.count) parts.push(esc(T('levelShort', st.level.level)))
      if (!set.calm && st.streak > 1) parts.push(esc(T('streakTiny', st.streak)))
      sub = parts.map((p, i) => i ? '<span class="nb">' + p + '</span>' : esc(p)).join(' · ') // "🔥 6 j" never splits
    } else if (ui.tab === 'notes') sub = esc(plural(S.live(doc.notes).length, 'notesOne', 'notesMany'))
    else if (ui.tab === 'agenda') sub = esc(cap(fmt({ weekday: 'long', day: 'numeric', month: 'long' }, new Date())))
    else sub = esc(T('plusSub'))
    $('#subtitle').innerHTML = sub
    let actions = ''
    if (ui.tab !== 'plus') actions += `<button class="icon-btn" data-act="search-open" aria-label="${esc(T('search'))}" title="${esc(T('search'))}">${icon('search')}</button>`
    if (ui.tab === 'tasks' || ui.tab === 'agenda') actions += `<button class="icon-btn" data-act="${ui.tab === 'tasks' ? 'share-list' : 'share-day'}" aria-label="${esc(T(ui.tab === 'tasks' ? 'shareList' : 'shareDay'))}" title="${esc(T(ui.tab === 'tasks' ? 'shareList' : 'shareDay'))}">${icon('share')}</button>`
    if (ui.tab === 'agenda') actions += `<button class="tonal small" data-act="cal-today">${esc(T('todayBtn'))}</button>`
    $('#topActions').innerHTML = actions
    $('#searchBar').hidden = !ui.searchOpen
    $('#search').placeholder = T('searchAll')
    renderChips()
  }
  function renderChips() {
    const el = $('#chips')
    if (ui.tab === 'plus' || ui.tab === 'agenda' || ui.query) { el.innerHTML = ''; el.hidden = true; return }
    const items = ui.tab === 'tasks' ? S.live(doc.tasks) : S.live(doc.notes)
    const ls = lists().filter(l => items.some(x => x.list === l))
    const tg = allTags().filter(t => items.some(x => S.tags(x.text + ' ' + (x.details || '')).indexOf(t) >= 0))
    const hasImp = ui.tab === 'tasks' && items.some(x => x.important && !x.done)
    if (!ls.length && !tg.length && !hasImp) { el.innerHTML = ''; el.hidden = true; return }
    const chip = (v, label, extra) => `<button class="chip ${ui.filter === v ? 'on' : ''}" data-act="filter" data-v="${esc(v || '')}" aria-pressed="${ui.filter === v}">${ui.filter === v ? icon('check', 'tick') : extra || ''}${esc(label)}</button>`
    el.hidden = false
    el.innerHTML = chip(null, T('all')) + (hasImp ? chip('important', T('importantF'), icon('star')) : '') +
      ls.map(l => chip('list:' + l, l, '<i class="dot" style="--h:' + hue(l.toLowerCase()) + '"></i>')).join('') +
      tg.map(t => chip('tag:' + t, t)).join('')
  }
  let lastMain = ''
  function renderMain() {
    const main = $('#main'); if (!main) return
    const html = ui.query.trim() ? searchView() : ui.tab === 'tasks' ? tasksView() : ui.tab === 'notes' ? notesView() : ui.tab === 'agenda' ? agendaView() : plusView()
    const cls = 'tab-' + ui.tab
    if (html === lastMain && main.className === cls) return // nothing changed: screen readers keep their place
    // The same control gets the focus back (or the row that took the place of a ticked task).
    const a = document.activeElement; const row = a && main.contains(a) ? a.closest('[data-id]') : null
    const keep = row ? { id: row.dataset.id, act: a.dataset.act, index: $$('[data-id]', main).indexOf(row) } : null
    const top = main.scrollTop
    main.className = cls; main.innerHTML = html; lastMain = html
    main.scrollTop = top
    if (keep) {
      const rows = $$('[data-id]', main)
      const again = $('[data-id="' + keep.id + '"] [data-act="' + keep.act + '"]', main) || (rows[Math.min(keep.index, rows.length - 1)] && $('[data-act]', rows[Math.min(keep.index, rows.length - 1)]))
      if (again) again.focus({ preventScroll: true })
    }
    if (ui.tab === 'plus' && !ui.query.trim()) fillPlusAsync()
  }

  // ---------- tasks ----------
  const overdue = (t, n) => !t.done && !!t.due && (t.due.length > 10 ? S.ms(t.due) < n : t.due < S.today(n))
  const mapUrl = place => (H.platform === 'android' ? 'geo:0,0?q=' : 'https://www.google.com/maps/search/?api=1&query=') + encodeURIComponent(place)
  function rowLinks(text, place) { // one tap to call the number in the title, or to go to the place
    const tel = phoneIn(text)
    return (tel ? `<button class="icon-btn call" data-act="link" data-href="${esc(tel.href)}" aria-label="${esc(T('call', tel.label))}" title="${esc(T('call', tel.label))}">${icon('phone')}</button>` : '') +
      (place ? `<button class="icon-btn route" data-act="link" data-href="${esc(mapUrl(place))}" aria-label="${esc(T('routeTo', place))}" title="${esc(T('routeTo', place))}">${icon('place')}</button>` : '')
  }
  function taskRow(t, opts) {
    const n = now(); const over = overdue(t, n)
    const meta = []
    if (t.due) meta.push(`<span class="m ${over ? 'late' : ''}">${icon('clock')}${esc(fmtDue(t, true))}</span>`)
    if (t.repeat) meta.push(`<span class="m">${icon('repeat')}${esc(repeatLabel(t.repeat))}</span>`)
    if (t.due && t.remind.length && !t.done) {
      const what = t.remind.map(m => remindLabel(m, t.due.length === 10)).join(', ') + (t.loud || set.loudAll ? ', ' + T('loud') : '')
      meta.push(`<span class="m" title="${esc(what)}">${icon(t.loud || set.loudAll ? 'alarm' : 'bell')}<span class="sr">${esc(T('srRemind', what))}</span></span>`)
    }
    if (t.steps.length) meta.push(`<span class="m">${icon('boxed')}<span aria-hidden="true">${t.steps.filter(s => s.done).length}/${t.steps.length}</span><span class="sr">${esc(T('srSteps', t.steps.filter(s => s.done).length, t.steps.length))}</span></span>`)
    if (t.place) meta.push(`<span class="m">${icon('place')}${esc(t.place)}</span>`)
    if (S.pri(t) > 1) meta.push(`<span class="m prio" title="${esc(T('prioN', S.pri(t)))}"><span aria-hidden="true">${'!'.repeat(S.pri(t))}</span><span class="sr">${esc(T('prioN', S.pri(t)))}</span></span>`)
    if (t.repeat && t.doneAt && S.today(t.doneAt) === S.today(n)) meta.push(`<span class="m good">${icon('checked')}${esc(T('doneAt', fmtTime(S.hm(new Date(t.doneAt)))))}</span>`)
    if (t.details) meta.push(`<span class="m">${icon('note')}<span class="sr">${esc(T('srDetails'))}</span></span>`)
    if (t.list && !(ui.filter === 'list:' + t.list)) meta.push(listChip(t.list))
    const late = over && !(opts && opts.noPostpone)
    return `<li class="row task ${t.done ? 'done' : ''} ${t.important ? 'imp' : ''}" data-id="${t.id}">
      <button class="check" data-act="toggle" role="checkbox" aria-checked="${t.done}" aria-label="${esc(T(t.done ? 'markUndone' : 'markDone', t.text))}">${icon(t.done ? 'checked' : 'circle')}</button>
      <button class="body" data-act="open"><span class="title">${esc(t.text)}</span>${meta.length ? `<span class="meta">${meta.join('')}</span>` : ''}</button>
      ${late ? `<button class="mini" data-act="postpone" aria-label="${esc(T('toTomorrowFull', t.text))}">${icon('forward')}${esc(T('toTomorrow'))}</button>` : ''}
      ${t.done ? '' : rowLinks(t.text, t.place)}
      <button class="icon-btn star" data-act="star" aria-pressed="${t.important}" aria-label="${esc(T('importantFor', t.text))}" title="${esc(T('important'))}">${icon(t.important ? 'star' : 'star_border')}</button>
    </li>`
  }
  // The next thing with a time, in the coming 24 hours: "Next: Dentist · 4:30 PM (in 2 h)".
  function nextUp() {
    const n = now(); let best = null
    S.live(doc.tasks).forEach(t => { if (!t.done && t.due && t.due.length > 10) { const at = S.ms(t.due); if (at >= n && (!best || at < best.at)) best = { at: at, item: t } } })
    for (let i = 0; i < 2; i++) {
      const d = S.addDays(S.today(n), i)
      S.eventsOn(doc.events, d).forEach(e => { if (e.time && S.eventStartOn(e, d) === d) { const at = S.ms(d + 'T' + e.time); if (at >= n && (!best || at < best.at)) best = { at: at, item: e, day: d } } })
    }
    return best && best.at - n < 86400000 ? best : null
  }
  function tasksView() {
    const n = now()
    let top = ''
    if (ui.notifOff) top += `<div class="banner warn-banner">${icon('bell')}<span>${esc(T('notifOff'))}</span><button class="text-btn" data-act="fix" data-k="notifications">${esc(T('fixIt'))}</button></div>`
    const next = !ui.filter && nextUp()
    if (next) top += `<button class="banner next" data-act="open-next" data-id="${next.item.id}" data-day="${next.day || ''}">${icon('clock')}<span>${esc(T('nextUp', next.item.text, fmtTime(S.hm(new Date(next.at))), rel(next.at)))}</span>${icon('right')}</button>`
    const old = backupDue()
    if (old !== null && !ui.filter) top += `<div class="banner warn-banner">${icon('download')}<span>${esc(old ? T('backupOld', old) : T('backupNever'))}</span><button class="text-btn" data-act="export-json">${esc(T('backupNow'))}</button>${act('backup-later', 'close', T('later'), 'tiny')}</div>`
    const tasks = S.sortTasks(doc.tasks, n, set.dayStart).filter(passes)
    const groups = {}; S.SECTIONS.forEach(s => { groups[s] = [] })
    tasks.forEach(t => groups[S.sectionOf(t, n, set.dayStart)].push(t))
    let html = ''
    S.SECTIONS.forEach(s => {
      const list = groups[s]; if (!list.length) return
      if (s === 'done') {
        html += `<button class="sec-toggle" data-act="show-done" aria-expanded="${ui.showDone}">${icon('expand', ui.showDone ? 'flip' : '')}${esc(T('sec_done'))} <span class="count">${list.length}</span></button>`
        if (ui.showDone) html += `<ul class="list">${list.slice(0, 200).map(t => taskRow(t)).join('')}</ul>` + (list.length > 1 ? `<button class="text-btn danger" data-act="clear-done">${esc(T('clearDone'))}</button>` : '')
        return
      }
      const extra = s === 'late' && list.length > 1 ? `<button class="text-btn" data-act="postpone-all">${esc(T('allTomorrow'))}</button>` : ''
      html += `<h2 class="sec ${s}">${esc(T('sec_' + s))} <span class="count">${list.length}</span>${extra}</h2><ul class="list">${list.map(t => taskRow(t)).join('')}</ul>`
    })
    if (!tasks.length && ui.filter) html = `<p class="empty">${esc(T('nothingHere'))}</p>`
    else if (!tasks.some(t => !t.done)) html = emptyState(tasks.length ? 'check' : 'tasks', T(tasks.length ? 'allDone' : 'emptyTasks'), T(tasks.length ? 'allDoneHint' : 'emptyTasksHint')) + html
    return top + html + '<div class="spacer"></div>'
  }

  const emptyState = (ic, title, hint) => `<div class="empty-state">${icon(ic)}<p><b>${esc(title)}</b></p><p class="hint">${esc(hint)}</p></div>`
  // Days since the last backup when it is time to make one (null: nothing to say). Auto backups in a folder count.
  function backupDue() {
    const live = S.live(doc.tasks).length + S.live(doc.notes).length + S.live(doc.events).length
    if (live < 10 || ui.autoBackup) return null
    const first = Math.min.apply(null, doc.tasks.concat(doc.notes, doc.events).map(x => x.createdAt || now()))
    const last = Math.max(set.backupLast || 0, set.backupAsked || 0, first)
    const days = Math.floor((now() - last) / 86400000)
    if (days < 30) return null
    return set.backupLast ? Math.floor((now() - set.backupLast) / 86400000) : 0
  }

  // ---------- notes ----------
  function noteTitle(n) { const first = n.text.split('\n').find(l => l.trim()) || ''; return first.replace(/^#+\s*|^-\s*\[[ xX]\]\s*/g, '').trim() }
  function noteCard(n) {
    const lines = n.text.split('\n'); const title = noteTitle(n)
    const body = lines.slice(lines.findIndex(l => l.trim()) + 1).join('\n').trim()
    const boxes = lines.filter(l => /^\s*[-*]\s*\[[ xX]\]/.test(l)); const ticked = boxes.filter(l => /\[[xX]\]/.test(l)).length
    const date = n.updatedAt ? fmtDay(S.today(n.updatedAt)) : ''
    return `<li class="card note" data-id="${n.id}"><button class="body" data-act="open">
      ${n.images.length ? `<img class="thumb" src="${esc(n.images[0])}" alt="">` : ''}
      <span class="title">${n.pinned ? icon('pin', 'pin') : ''}${esc(title || T('untitled'))}</span>
      ${body ? `<span class="preview">${esc(body.replace(/^\s*[-*]\s*\[[ ]\]\s*/gm, '☐ ').replace(/^\s*[-*]\s*\[[xX]\]\s*/gm, '☑ '))}</span>` : ''}
      <span class="meta">${n.conflictOf ? `<span class="m late">${icon('warn')}${esc(T('conflictCopy'))}</span>` : ''}${boxes.length ? `<span class="m">${icon('boxed')}${ticked}/${boxes.length}</span>` : ''}${n.list ? listChip(n.list) : ''}<span class="m soft">${esc(date)}</span></span>
    </button></li>`
  }
  function notesView() {
    const notes = S.live(doc.notes).filter(passes).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt)
    if (!notes.length) return ui.filter ? `<p class="empty">${esc(T('nothingHere'))}</p>` : emptyState('note', T('emptyNotes'), T('emptyNotesHint'))
    const pinned = notes.filter(n => n.pinned); const rest = notes.filter(n => !n.pinned)
    return (pinned.length ? `<h2 class="sec">${esc(T('pinned'))}</h2><ul class="grid">${pinned.map(noteCard).join('')}</ul>` : '') +
      (rest.length ? (pinned.length ? `<h2 class="sec">${esc(T('others'))}</h2>` : '') + `<ul class="grid">${rest.map(noteCard).join('')}</ul>` : '') + '<div class="spacer"></div>'
  }

  // ---------- agenda ----------
  function eventRow(e, day) {
    const start = S.eventStartOn(e, day) || e.day
    const multi = S.eventSpan(e) > 0
    let when
    if (!e.time) when = `<span class="when">${esc(T('allDay'))}</span>`
    else if (multi && start !== day) when = `<span class="when">${esc(T('continues'))}</span>`
    else when = `<span class="when"><b>${esc(fmtTime(e.time))}</b>${e.end ? '<small>' + esc(fmtTime(e.end)) + (!multi && e.end <= e.time ? ' (+1)' : '') + '</small>' : ''}</span>`
    const meta = []
    if (e.place) meta.push(`<span class="m">${icon('place')}${esc(e.place)}</span>`)
    if (multi) meta.push(`<span class="m">${esc(T('untilDay', fmtDay(S.addDays(start, S.eventSpan(e)))))}</span>`)
    if (e.repeat) meta.push(`<span class="m">${icon('repeat')}${esc(repeatLabel(e.repeat))}</span>`)
    if (e.remind.length) meta.push(`<span class="m">${icon(e.loud || set.loudAll ? 'alarm' : 'bell')}<span class="sr">${esc(T('srRemind', e.remind.map(m => remindLabel(m, !e.time)).join(', ')))}</span></span>`)
    if (e.list) meta.push(listChip(e.list))
    return `<li class="row event ${e.important ? 'imp' : ''}" data-id="${e.id}" data-day="${day}"${e.list ? ` style="--h:${hue(e.list.toLowerCase())}"` : ''}>${when}
      <button class="body" data-act="open"><span class="title">${e.important ? icon('star', 'pin') : ''}${esc(e.text)}</span>${meta.length ? `<span class="meta">${meta.join('')}</span>` : ''}</button>${rowLinks(e.text, e.place)}</li>`
  }
  // Events of the phone's own calendars (Google…), read only.
  function phoneRow(e, day) {
    const when = !e.time ? T('allDay') : e.day !== day ? T('continues') : fmtTime(e.time)
    return `<li class="row event phone" style="--c:${esc(e.color || '#888')}"><span class="when"><b>${esc(when)}</b>${e.end && e.day === day ? '<small>' + esc(fmtTime(e.end)) + '</small>' : ''}</span>
      <div class="body"><span class="title">${esc(e.text)}</span><span class="meta"><span class="m">${icon('calendar')}${esc(e.calendar || T('phoneCal'))}</span>${e.place ? `<span class="m">${icon('place')}${esc(e.place)}</span>` : ''}</span></div></li>`
  }
  function dayItems(day) {
    const evs = S.eventsOn(doc.events, day).filter(passes)
    const n = now()
    const tasks = S.sortTasks(doc.tasks, n, set.dayStart).filter(t => t.due && S.dayOf(t.due) === day && passes(t))
    const phone = ui.filter ? [] : phoneEvents.list.filter(e => e.day <= day && (e.endDay || e.day) >= day)
    return { evs, tasks, phone }
  }
  // Phone calendars are read once per range shown, then kept until the agenda moves.
  const phoneEvents = { key: '', list: [] }
  function loadPhoneEvents(from, to) {
    if (!set.phoneCalendar || !H.deviceEvents) { phoneEvents.list = []; return }
    const key = from + '|' + to; if (phoneEvents.key === key) return
    phoneEvents.key = key
    H.deviceEvents(from, to).then(list => {
      if (phoneEvents.key !== key) return
      if (!list) { setSetting('phoneCalendar', false); return snack(T('phoneCalDenied')) }
      phoneEvents.list = list; if (ui.tab === 'agenda') renderMain()
    })
  }
  function agendaView() {
    const month = ui.month; const first = S.parseDay(month)
    const offset = (S.weekday(month) - set.weekStart + 7) % 7
    const td = S.today(now())
    let start = S.addDays(month, -offset)
    let weeks = 6
    if (ui.agendaMode === 'week') { start = S.addDays(ui.day, -((S.weekday(ui.day) - set.weekStart + 7) % 7)); weeks = 1 }
    const names = []; for (let i = 0; i < 7; i++) names.push(fmt({ weekday: 'narrow' }, S.parseDay(S.addDays(start, i))))
    loadPhoneEvents(start, S.addDays(ui.day, Math.max(ui.upcoming, S.between(ui.day, S.addDays(start, weeks * 7)))))
    let cells = ''
    for (let i = 0; i < weeks * 7; i++) {
      const d = S.addDays(start, i); const it = dayItems(d)
      const out = d.slice(0, 7) !== month.slice(0, 7) && ui.agendaMode !== 'week'
      const dots = it.evs.slice(0, 3).map(e => `<i${e.list ? ` style="--h:${hue(e.list.toLowerCase())}"` : ''}></i>`).join('') + it.phone.slice(0, 2).map(e => `<i class="p" style="--c:${esc(e.color || '#888')}"></i>`).join('') + (it.tasks.filter(t => !t.done).length ? '<i class="t"></i>' : '')
      const n = it.evs.length + it.tasks.length + it.phone.length
      const label = fmtDay(d, true) + (n ? ', ' + plural(n, 'itemsOne', 'itemsMany') : '')
      // On a wide screen the cells also show the first titles.
      const titles = it.evs.map(e => e.text).concat(it.phone.map(e => e.text), it.tasks.filter(t => !t.done).map(t => '☐ ' + t.text)).slice(0, ui.agendaMode === 'week' ? 6 : 3)
      cells += `<button class="day ${out ? 'out' : ''} ${d === td ? 'today' : ''} ${d === ui.day ? 'sel' : ''}" data-act="cal-day" data-day="${d}" aria-label="${esc(label)}" aria-pressed="${d === ui.day}"><span>${+d.slice(8)}</span><span class="dots">${dots}</span>${titles.length ? `<span class="cell-titles" aria-hidden="true">${titles.map(x => `<small>${esc(x)}</small>`).join('')}</span>` : ''}</button>`
    }
    const sel = dayItems(ui.day)
    let html = `<div class="agenda-cols"><section class="cal card">
      <div class="cal-head">
        <button class="icon-btn" data-act="cal-prev" aria-label="${esc(T('previous'))}">${icon('left')}</button>
        <h2>${esc(cap(fmt({ month: 'long', year: 'numeric' }, ui.agendaMode === 'week' ? S.parseDay(ui.day) : first)))}</h2>
        <button class="icon-btn" data-act="cal-next" aria-label="${esc(T('next'))}">${icon('right')}</button>
        <div class="seg small" role="group">
          <button data-act="cal-mode" data-v="month" class="${ui.agendaMode === 'month' ? 'on' : ''}">${esc(T('month'))}</button>
          <button data-act="cal-mode" data-v="week" class="${ui.agendaMode === 'week' ? 'on' : ''}">${esc(T('week'))}</button>
        </div>
      </div>
      <div class="cal-grid">${names.map(n => `<span class="wd">${esc(n)}</span>`).join('')}${cells}</div>
    </section><div class="agenda-list">
    <h2 class="sec">${esc(fmtDay(ui.day, true))}<button class="text-btn" data-act="fab">${icon('add')}${esc(T('add'))}</button></h2>`
    if (sel.evs.length || sel.tasks.length || sel.phone.length) html += `<ul class="list">${sel.evs.map(e => eventRow(e, ui.day)).join('')}${sel.phone.map(e => phoneRow(e, ui.day)).join('')}${sel.tasks.map(t => taskRow(t, { noPostpone: true })).join('')}</ul>`
    else html += `<p class="empty small">${esc(T('freeDay'))}</p>`
    let upcoming = ''; let lastMonth = ui.day.slice(0, 7)
    for (let i = 1; i <= ui.upcoming; i++) {
      const d = S.addDays(ui.day, i); const it = dayItems(d)
      const tasks = it.tasks.filter(t => !t.done); const phone = it.phone.filter(e => e.day === d)
      if (!it.evs.length && !tasks.length && !phone.length) continue
      if (d.slice(0, 7) !== lastMonth) { lastMonth = d.slice(0, 7); upcoming += `<h2 class="sec month">${esc(cap(fmt({ month: 'long', year: 'numeric' }, S.parseDay(d))))}</h2>` }
      upcoming += `<h3 class="subsec">${esc(fmtDay(d, true))}</h3><ul class="list">${it.evs.map(e => eventRow(e, d)).join('')}${phone.map(e => phoneRow(e, d)).join('')}${tasks.map(t => taskRow(t, { noPostpone: true })).join('')}</ul>`
    }
    html += `<h2 class="sec">${esc(T('upcoming'))}</h2>` + (upcoming || `<p class="empty small">${esc(T('nothingSoon', ui.upcoming))}</p>`)
    html += `<button class="text-btn more" data-act="more-upcoming">${icon('expand')}${esc(T('seeMore'))}</button>`
    return html + '</div></div><div class="spacer"></div>'
  }

  // ---------- search ----------
  function searchView() {
    const q = ui.query.trim()
    const tasks = S.sortTasks(doc.tasks, now(), set.dayStart).filter(t => S.matches(q, [t.text, t.details, t.list].concat(t.steps.map(s => s.text))))
    const notes = S.live(doc.notes).filter(n => S.matches(q, [n.text, n.list])).sort((a, b) => b.updatedAt - a.updatedAt)
    const evs = S.live(doc.events).filter(e => S.matches(q, [e.text, e.place, e.details, e.list])).sort((a, b) => a.day < b.day ? 1 : -1)
    if (!tasks.length && !notes.length && !evs.length) return `<p class="empty">${esc(T('noResult', q))}</p>`
    const more = n => n > 100 ? `<p class="hint">${esc(T('moreResults', n - 100))}</p>` : ''
    const parts = {
      tasks: tasks.length ? `<h2 class="sec">${esc(T('tab_tasks'))} <span class="count">${tasks.length}</span></h2><ul class="list">${tasks.slice(0, 100).map(t => taskRow(t)).join('')}</ul>${more(tasks.length)}` : '',
      notes: notes.length ? `<h2 class="sec">${esc(T('tab_notes'))} <span class="count">${notes.length}</span></h2><ul class="grid">${notes.slice(0, 100).map(noteCard).join('')}</ul>${more(notes.length)}` : '',
      agenda: evs.length ? `<h2 class="sec">${esc(T('tab_agenda'))} <span class="count">${evs.length}</span></h2><ul class="list">${evs.slice(0, 100).map(e => eventRow(e, S.nextDay(e.day, e.repeat, S.today(now()), e.until, e.skip) || e.day)).join('')}</ul>${more(evs.length)}` : '',
    }
    const order = [ui.tab].concat(['tasks', 'notes', 'agenda'].filter(k => k !== ui.tab)).filter(k => parts[k] !== undefined) // where you search from comes first
    return order.map(k => parts[k]).join('') + '<div class="spacer"></div>'
  }

  // ---------- add bar ----------
  function renderAddBar() {
    const bar = $('#addBar'); bar.dataset.tab = ui.tab
    const notes = ui.tab === 'notes'; const agenda = ui.tab === 'agenda'
    const what = notes ? 'Note' : agenda ? 'Event' : 'Task'
    bar.innerHTML = `
      <div class="add-row">
        ${H.can.voice ? `<button type="button" class="icon-btn" data-act="mic" aria-label="${esc(T('dictate'))}" title="${esc(T('dictate'))}">${icon('mic')}</button>` : ''}
        <textarea id="addInput" rows="1" enterkeyhint="send" aria-label="${esc(T('new' + what))}" placeholder="${esc(T((notes ? 'note' : agenda ? 'event' : 'task') + 'Placeholder'))}"></textarea>
        ${notes || agenda ? `<button type="button" class="icon-btn" data-act="${notes ? 'note-full' : 'event-full'}" aria-label="${esc(T(notes ? 'fullNote' : 'fullEvent'))}" title="${esc(T(notes ? 'fullNote' : 'fullEvent'))}">${icon('edit')}</button>` : ''}
        <button type="submit" class="send" aria-label="${esc(T('add'))}">${icon(notes ? 'add' : 'send')}</button>
      </div>
      <div id="addHint" class="add-hint" hidden></div>
      <input id="addDate" type="date" class="hidden-date" tabindex="-1" aria-hidden="true">`
    const input = $('#addInput')
    input.addEventListener('input', () => { autoGrow(input); renderHint() })
    input.addEventListener('focus', renderHint)
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitAdd() } })
  }
  function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px' }
  function renderHint() {
    const hint = $('#addHint'); const input = $('#addInput'); if (!hint || !input) return
    if (ui.tab === 'notes') { hint.hidden = true; return }
    const v = input.value.trim()
    if (!v) ui.draft.raw = false
    const p = v && !ui.draft.raw ? parse(v.split('\n')[0]) : { due: null, repeat: null }
    const due = pickDue(ui.draft.due, p.due); const repeat = ui.draft.repeat || p.repeat
    const chips = []
    if (due || repeat) {
      chips.push(`<span class="found">${due ? icon('clock') + esc(fmtDue({ due: due }, true)) : ''}${repeat ? ' ' + icon('repeat') + esc(repeatLabel(repeat)) : ''}${p.place ? ' ' + icon('place') + esc(p.place) : ''}
        ${p.due || p.repeat ? `<button type="button" class="icon-btn tiny" data-act="add-raw" aria-label="${esc(T('ignoreDate'))}" title="${esc(T('ignoreDate'))}">${icon('close')}</button>` : ''}</span>`)
    }
    const pre = ['today'].concat(presets()).map(v => `<button type="button" class="chip ${ui.draft.due === dueFromPreset(v) && ui.draft.due ? 'on' : ''}" data-act="add-preset" data-v="${v}">${esc(presetLabel(v))}</button>`)
    pre.push(`<button type="button" class="chip ${ui.draft.due && ui.draft.due.length === 10 && ui.draft.due !== S.today(now()) ? 'on' : ''}" data-act="add-date">${icon('calendar')}${esc(ui.draft.due && ui.draft.due.length === 10 && ui.draft.due !== S.today(now()) ? fmtDay(ui.draft.due) : T('pickDate'))}</button>`)
    if (ui.tab === 'tasks') pre.push(`<button type="button" class="chip ${ui.draft.important ? 'on' : ''}" data-act="add-imp" aria-pressed="${ui.draft.important}">${icon('star')}${esc(T('important'))}</button>`)
    hint.innerHTML = chips.join('') + `<div class="chips scroll">${pre.join('')}</div>`
    hint.hidden = document.activeElement !== input && !v
  }
  function submitAdd() {
    const input = $('#addInput'); if (!input) return
    const v = input.value
    if (!v.trim()) { input.focus(); return }
    if (ui.tab === 'notes') { const n = addNote(v); snack(T('noteAdded'), [{ label: T('open'), run: () => openSheet(n.id) }]) }
    else if (ui.tab === 'agenda') addEvents(v)
    else addTasks(v)
    input.value = ''; autoGrow(input); renderHint()
    input.focus()
  }

  // ---------- editors (a full page on the phone, a side panel on the PC) ----------
  function openSheet(id, opts) {
    const item = S.find(doc, id); if (!item) return
    ui.sheet = { id: id, kind: kindOf(id), day: opts && opts.day, isNew: !!(opts && opts.isNew) }
    ui.noteRead = ui.sheet.kind === 'notes' && !ui.sheet.isNew && /\[[ xX]\]|https?:\/\/|www\./.test(item.text)
    const sh = $('#sheet'); sh.hidden = false; document.body.classList.add('sheet-open') // visible first: text areas measure their height
    renderSheet()
    const first = ui.sheet.isNew ? $('[data-f="text"]', sh) : $('.sheet-bar .icon-btn', sh)
    if (first) setTimeout(() => first.focus(), 30)
  }
  function closeSheet() {
    if (!ui.sheet) return
    const item = S.find(doc, ui.sheet.id)
    if (item && ui.sheet.isNew && !item.text.trim() && !(item.images && item.images.length)) item.deleted = true // nothing typed: no empty item
    const id = ui.sheet.id
    ui.sheet = null
    $('#sheet').hidden = true; $('#sheet').innerHTML = ''; document.body.classList.remove('sheet-open')
    commit()
    const back = $('#main [data-id="' + id + '"] [data-act="open"]'); if (back) back.focus({ preventScroll: true }) // back where we were
  }
  function refreshSheet() {
    if (!ui.sheet) return
    const item = S.find(doc, ui.sheet.id)
    if (!item || item.deleted) return closeSheet()
    const a = document.activeElement
    if (a && $('#sheet').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return // do not move the caret under the user's fingers
    renderSheet()
  }
  function renderSheet() {
    if (!ui.sheet) return
    const item = S.find(doc, ui.sheet.id); if (!item) return
    const sh = $('#sheet'); const body = $('.sheet-body', sh); const top = body ? body.scrollTop : 0
    sh.className = 'sheet-' + ui.sheet.kind
    sh.setAttribute('aria-label', T(ui.sheet.kind === 'tasks' ? 'task' : ui.sheet.kind === 'notes' ? 'note' : 'event'))
    sh.innerHTML = ui.sheet.kind === 'tasks' ? taskSheet(item) : ui.sheet.kind === 'notes' ? noteSheet(item) : eventSheet(item)
    $$('textarea.title-input, textarea.note-text, textarea.details', sh).forEach(autoGrow)
    const nb = $('.sheet-body', sh); if (nb) nb.scrollTop = top
  }
  const act = (a, ic, label, extra) => `<button class="icon-btn ${extra || ''}" data-act="${a}" aria-label="${esc(label)}" title="${esc(label)}">${icon(ic)}</button>`
  function sheetBar(title, actions) {
    return `<div class="sheet-bar">${act('close', 'back', T('back'))}<h2>${esc(title)}</h2><div class="grow"></div>${actions}${act('sheet-full', ui.sheetFull ? 'fullOff' : 'fullOn', T(ui.sheetFull ? 'smaller' : 'bigger'), 'wide-only')}
      <button class="filled small save" data-act="close" aria-label="${esc(T('save'))}">${icon('check')}<span>${esc(T('save'))}</span></button></div>`
  }
  function stampText(x) {
    const d = t => fmtDay(S.today(t), true) + ' ' + fmtTime(S.hm(new Date(t)))
    return esc(T('created', d(x.createdAt)) + (x.updatedAt && x.updatedAt - x.createdAt > 60000 ? ' · ' + T('modified', d(x.updatedAt)) : '') + (x.doneAt && x.done ? ' · ' + T('doneOn', d(x.doneAt)) : ''))
  }
  function remindChips(item, allDay) {
    const opts = allDay ? REMIND_ALLDAY : REMIND_TIMED
    return `<div class="chips wrap">${opts.map(m => `<button class="chip ${item.remind.indexOf(m) >= 0 ? 'on' : ''}" data-act="remind" data-v="${m}" aria-pressed="${item.remind.indexOf(m) >= 0}">${esc(remindLabel(m, allDay))}</button>`).join('')}
      <button class="chip ${item.remind.length ? '' : 'on'}" data-act="remind" data-v="none" aria-pressed="${!item.remind.length}">${esc(T('noReminder'))}</button></div>
      <label class="switch-row"><span>${icon('alarm')}<span><b>${esc(T('loud'))}</b><small>${esc(T(H.platform === 'android' ? 'loudHint' : 'loudHintPc'))}</small></span></span><input type="checkbox" role="switch" data-f="loud" ${item.loud ? 'checked' : ''}></label>`
  }
  function repeatParts(r) {
    if (!r) return { kind: '', n: 2, days: [] }
    if (/:after$/.test(r)) return Object.assign(repeatParts(r.slice(0, -6)), { after: true })
    const k = r.split(':')[0]; const n = +(r.split(':')[1]) || 2
    if (k === 'weekly' && r.indexOf(':') > 0) return { kind: 'pick', n: 2, days: S.repeatDays(r) }
    if (k === 'nth') return { kind: 'nth', n: +r.split(':')[1], days: [+r.split(':')[2]] }
    return { kind: k === 'days' ? 'ndays' : k, n: n, days: [] }
  }
  // The k-th weekday of the month a day falls on: 2026-10-15 is the 3rd Thursday (or the last one).
  const nthOf = day => { const k = Math.ceil(+day.slice(8) / 7); return { k: k === 5 ? -1 : k, wd: S.weekday(day) } }
  function repeatCode(kind, n, days, after) {
    const code = repeatBase(kind, n, days)
    return code && after && /^(hours|days|weeks):/.test(code) ? code + ':after' : code
  }
  function repeatBase(kind, n, days) {
    n = Math.max(1, Math.min(99, +n || 2))
    if (!kind) return null
    if (kind === 'pick') return 'weekly:' + (days.length ? days : [1]).slice().sort().join(',')
    if (kind === 'weeks') return 'weeks:' + n
    if (kind === 'months') return 'months:' + n
    if (kind === 'nth') return 'nth:' + (n === -1 || (n >= 1 && n <= 5) ? n : 1) + ':' + (days[0] || 1)
    if (kind === 'ndays') return 'days:' + n
    if (kind === 'hours') return 'hours:' + n
    return kind
  }
  function repeatControls(item, isTask) {
    const p = repeatParts(item.repeat)
    const kinds = ['', 'daily', 'weekdays', 'weekly', 'pick', 'weeks', 'monthly', 'months', 'nth', 'yearly', 'ndays'].concat(isTask ? ['hours'] : [])
    let html = `<select data-f="repeatKind" aria-label="${esc(T('repeat'))}">${kinds.map(k => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${esc(T('rk_' + (k || 'none')))}</option>`).join('')}</select>`
    if (p.kind === 'pick') {
      html += '<div class="weekdays">'
      for (let i = 0; i < 7; i++) {
        const d = ((set.weekStart - 1 + i) % 7) + 1; const on = p.days.indexOf(d) >= 0
        html += `<button class="wd-btn ${on ? 'on' : ''}" data-act="rep-day" data-v="${d}" aria-pressed="${on}" aria-label="${esc(fmt({ weekday: 'long' }, new Date(2024, 0, d)))}">${esc(fmt({ weekday: 'narrow' }, new Date(2024, 0, d)))}</button>`
      }
      html += '</div>'
    }
    if (['weeks', 'months', 'ndays', 'hours'].indexOf(p.kind) >= 0) html += `<label class="field inline"><span>${esc(T('every'))}</span><input type="number" min="1" max="99" inputmode="numeric" data-f="repeatN" value="${p.n}"><span>${esc(T('unit_' + p.kind))}</span></label>`
    if (isTask && ['weeks', 'ndays', 'hours'].indexOf(p.kind) >= 0) html += `<label class="switch-row"><span><span><b>${esc(T('fromTick'))}</b><small>${esc(T('fromTickHint'))}</small></span></span><input type="checkbox" role="switch" data-f="repeatAfter" ${p.after ? 'checked' : ''}></label>`
    if (p.kind === 'nth') {
      html += `<div class="fields"><select data-f="nthK" aria-label="${esc(T('which'))}">${[1, 2, 3, 4, 5, -1].map(k => `<option value="${k}" ${p.n === k ? 'selected' : ''}>${esc(T('ord_' + k))}</option>`).join('')}</select>
        <select data-f="nthD" aria-label="${esc(T('weekday'))}">${[1, 2, 3, 4, 5, 6, 7].map(d => `<option value="${d}" ${p.days[0] === d ? 'selected' : ''}>${esc(fmt({ weekday: 'long' }, new Date(2024, 0, d)))}</option>`).join('')}</select>
        <span class="hint">${esc(T('ofMonth'))}</span></div>`
    }
    if (item.repeat) html += `<label class="field"><span>${esc(T('until'))}</span><input type="date" data-f="until" value="${item.until || ''}"></label>`
    return html
  }
  function listControls(item) {
    const ls = lists()
    return `<input class="list-input" data-f="list" list="dl-lists" value="${esc(item.list)}" placeholder="${esc(T('listHint'))}" aria-label="${esc(T('list'))}">
      <datalist id="dl-lists">${ls.map(l => `<option value="${esc(l)}">`).join('')}</datalist>
      ${ls.length ? `<div class="chips wrap">${ls.slice(0, 12).map(l => `<button class="chip ${item.list === l ? 'on' : ''}" data-act="list-pick" data-v="${esc(l)}" aria-pressed="${item.list === l}"><i class="dot" style="--h:${hue(l.toLowerCase())}"></i>${esc(l)}</button>`).join('')}</div>` : ''}`
  }
  const LINK_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(\+?\d[\d .-]{7,16}\d)/g
  function findLinks(text) {
    const out = []; let m; LINK_RE.lastIndex = 0
    while ((m = LINK_RE.exec(text || ''))) {
      if (m[1]) { const v = m[1].replace(/[.,;:!?)\]]+$/, ''); out.push({ kind: 'link', label: v.replace(/^https?:\/\//, '').replace(/\/$/, ''), href: /^http/.test(v) ? v : 'https://' + v, start: m.index, end: m.index + v.length }) }
      else if (m[2]) out.push({ kind: 'mail', label: m[2], href: 'mailto:' + m[2], start: m.index, end: m.index + m[0].length })
      else { const digits = m[3].replace(/\D/g, ''); if (digits.length >= 9 && digits.length <= 15 && !/^\d{4}-\d{2}-\d{2}/.test(m[3])) out.push({ kind: 'phone', label: m[3], href: 'tel:' + m[3].replace(/[^\d+]/g, ''), start: m.index, end: m.index + m[0].length }) }
    }
    return out
  }
  const phoneIn = text => findLinks(text).filter(l => l.kind === 'phone')[0] || null
  function linksRow(text) {
    const ls = findLinks(text)
    return ls.slice(0, 12).map(l => `<button class="chip link" data-act="link" data-href="${esc(l.href)}">${icon(l.kind)}${esc(l.label.length > 40 ? l.label.slice(0, 38) + '…' : l.label)}</button>`).join('')
  }
  const linksBox = (text, key) => `<div class="chips wrap links" data-links="${key}">${linksRow(text)}</div>`

  function taskSheet(t) {
    const allDay = !!t.due && t.due.length === 10
    const done = t.steps.filter(s => s.done).length
    return sheetBar(T('task'), act('share-item', 'share', T('share')) + act('duplicate', 'copy', T('duplicate')) + act('delete', 'delete', T('delete'))) + `
    <div class="sheet-body">
      <div class="title-row">
        <button class="check big" data-act="toggle-cur" role="checkbox" aria-checked="${t.done}" aria-label="${esc(T(t.done ? 'markUndone' : 'markDone', t.text))}">${icon(t.done ? 'checked' : 'circle')}</button>
        <textarea class="title-input" data-f="text" rows="1" aria-label="${esc(T('title'))}" placeholder="${esc(T('taskTitle'))}">${esc(t.text)}</textarea>
        <button class="icon-btn star" data-act="star-cur" aria-pressed="${t.important}" aria-label="${esc(T('important'))}" title="${esc(T('important'))}">${icon(t.important ? 'star' : 'star_border')}</button>
      </div>
      <section class="group">
        <h3>${icon('calendar')}${esc(T('when'))}</h3>
        <div class="chips wrap">${['today'].concat(presets()).map(v => `<button class="chip" data-act="due-preset" data-v="${v}">${esc(presetLabel(v))}</button>`).join('')}
          ${t.due ? `<button class="chip" data-act="due-clear">${icon('close')}${esc(T('noDate'))}</button>` : ''}</div>
        <div class="fields">
          <label class="field"><span>${esc(T('date'))}</span><input type="date" data-f="dueDay" value="${t.due ? S.dayOf(t.due) : ''}"></label>
          <label class="field"><span>${esc(T('time'))}</span><input type="time" data-f="dueTime" value="${S.timeOf(t.due) || ''}"></label>
          ${S.timeOf(t.due) ? act('time-clear', 'close', T('noTime')) : ''}
        </div>
        ${timeButtons(S.timeOf(t.due))}
        ${t.due ? `<p class="hint ${S.sectionOf(t, now(), set.dayStart) === 'late' ? 'late' : ''}">${esc(fmtDue(t, true))}${allDay ? ' · ' + esc(T('allDayTask')) : ''}</p>` : `<p class="hint">${esc(T('noDateHint'))}</p>`}
      </section>
      <section class="group"><h3>${icon('star')}${esc(T('priority'))}</h3><div class="chips wrap">${[0, 1, 2, 3].map(n => `<button class="chip ${S.pri(t) === n ? 'on' : ''}" data-act="prio" data-v="${n}" aria-pressed="${S.pri(t) === n}">${esc(n ? '!'.repeat(n) + ' ' + T('prio' + n) : T('prio0'))}</button>`).join('')}</div></section>
      ${t.due ? `<section class="group"><h3>${icon('bell')}${esc(T('reminders'))}</h3>${remindChips(t, allDay)}</section>` : ''}
      <section class="group"><h3>${icon('repeat')}${esc(T('repeat'))}</h3>${repeatControls(t, true)}</section>
      <section class="group">
        <h3>${icon('boxed')}${esc(T('steps'))}${t.steps.length ? ` <span class="count">${done}/${t.steps.length}</span>` : ''}</h3>
        <ul class="steps">${t.steps.map((s, i) => `<li class="${s.done ? 'done' : ''}">
          <button class="check small" data-act="step-toggle" data-i="${i}" role="checkbox" aria-checked="${s.done}" aria-label="${esc(s.text)}">${icon(s.done ? 'boxed' : 'box')}</button>
          <input data-f="step" data-i="${i}" value="${esc(s.text)}" aria-label="${esc(T('step', i + 1))}">
          ${act('step-task', 'forward', T('stepToTask'), 'tiny" data-i="' + i)}${act('step-del', 'close', T('delete'), 'tiny" data-i="' + i)}</li>`).join('')}</ul>
        <input class="step-new" data-f="newStep" placeholder="${esc(T('addStep'))}" enterkeyhint="done" aria-label="${esc(T('addStep'))}">
      </section>
      <section class="group"><h3>${icon('label')}${esc(T('list'))}</h3>${listControls(t)}</section>
      <section class="group"><h3>${icon('place')}${esc(T('place'))}</h3>
        <div class="fields"><input class="grow" data-f="place" value="${esc(t.place)}" placeholder="${esc(T('placeHint'))}" aria-label="${esc(T('place'))}">${t.place ? `<button class="tonal small" data-act="map">${icon('place')}${esc(T('map'))}</button>` : ''}</div>
      </section>
      <section class="group">
        <h3>${icon('note')}${esc(T('details'))}</h3>
        <textarea class="details" data-f="details" rows="3" placeholder="${esc(T('detailsHint'))}" aria-label="${esc(T('details'))}">${esc(t.details)}</textarea>
        ${linksBox(t.text + '\n' + t.details, 'details')}
      </section>
      <div class="actions">
        ${!t.done ? `<button class="tonal" data-act="focus-start">${icon('timer')}${esc(T('focus25'))}</button>
          <button class="tonal" data-act="postpone-cur" data-v="1">${icon('forward')}${esc(T('postpone1'))}</button>
          <button class="tonal" data-act="postpone-cur" data-v="2">${esc(T('postpone2'))}</button>
          <button class="tonal" data-act="postpone-cur" data-v="7">${esc(T('postpone7'))}</button>` : ''}
        ${!t.done && t.due && APPOINTMENT.test(t.text) ? `<button class="tonal" data-act="make-event">${icon('calendar')}${esc(T('makeEvent'))}</button>` : ''}
        <button class="filled" data-act="toggle-cur">${icon(t.done ? 'undo' : 'checked')}${esc(T(t.done ? 'reopen' : 'markDoneBtn'))}</button>
      </div>
      <p class="stamp">${stampText(t)}</p>
    </div>`
  }
  // Big one-tap times (and a quarter of an hour less or more), instead of the phone's clock dial.
  function timeButtons(current) {
    const times = [set.morning, '12:00', '14:00', '18:00', set.evening].filter((x, i, a) => a.indexOf(x) === i).sort()
    return `<div class="chips wrap times">${times.map(x => `<button class="chip ${current === x ? 'on' : ''}" data-act="due-time" data-v="${x}" aria-pressed="${current === x}">${esc(fmtTime(x))}</button>`).join('')}
      ${current ? `<button class="chip" data-act="time-step" data-v="-15" aria-label="${esc(T('minus15'))}">−15 min</button><button class="chip" data-act="time-step" data-v="15" aria-label="${esc(T('plus15'))}">+15 min</button>` : ''}</div>`
  }
  function renderNoteText(text) {
    return text.split('\n').map((line, i) => {
      const box = /^\s*[-*]\s*\[([ xX])\]\s?(.*)$/.exec(line)
      if (box) { const on = box[1] !== ' '; return `<p class="line box ${on ? 'on' : ''}"><button class="check small" data-act="line-toggle" data-i="${i}" role="checkbox" aria-checked="${on}" aria-label="${esc(box[2])}">${icon(on ? 'boxed' : 'box')}</button><span>${inline(box[2])}</span></p>` }
      const h = /^(#{1,3})\s+(.*)$/.exec(line); if (h) return `<p class="line h${h[1].length}">${inline(h[2])}</p>`
      const li = /^\s*[-*•]\s+(.*)$/.exec(line); if (li) return `<p class="line li">${inline(li[1])}</p>`
      return line.trim() ? `<p class="line">${inline(line)}</p>` : '<p class="line gap"></p>'
    }).join('')
  }
  // #mot-clé and @personne, then **gras**, *italique* and `code` (on text already escaped).
  const tagify = h => h.replace(/(^|\s)([#@][A-Za-zÀ-ÖØ-öø-ÿ0-9_-]{2,})/g, '$1<span class="tag">$2</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>')
  function inline(s) {
    let out = ''; let pos = 0
    findLinks(s).forEach(l => { out += tagify(esc(s.slice(pos, l.start))) + `<a href="${esc(l.href)}" data-act="link" data-href="${esc(l.href)}">${esc(s.slice(l.start, l.end))}</a>`; pos = l.end })
    return out + tagify(esc(s.slice(pos)))
  }
  function noteSheet(n) {
    const read = ui.noteRead
    return sheetBar(T('note'), act('note-mode', read ? 'edit' : 'eye', T(read ? 'editMode' : 'readMode')) +
      `<button class="icon-btn ${n.pinned ? 'on' : ''}" data-act="note-pin" aria-pressed="${n.pinned}" aria-label="${esc(T('pinIt'))}" title="${esc(T('pinIt'))}">${icon('pin')}</button>` +
      act('share-item', 'share', T('share')) + act('copy-item', 'copy', T('copy')) + act('delete', 'delete', T('delete'))) + `
    <div class="sheet-body note-body">
      ${n.conflictOf ? `<div class="banner warn-banner">${icon('warn')}<span>${esc(T('conflictHint'))}</span></div>` : ''}
      ${read ? `<div class="note-read" data-act="note-mode">${renderNoteText(n.text) || '<p class="hint">' + esc(T('emptyNote')) + '</p>'}</div>`
        : `<textarea class="note-text" data-f="text" placeholder="${esc(T('noteHint'))}" aria-label="${esc(T('note'))}">${esc(n.text)}</textarea>`}
      ${n.images.length ? `<div class="photos">${n.images.map((src, i) => `<figure><img src="${esc(src)}" alt="${esc(T('photo'))} ${i + 1}" data-act="photo-view" data-i="${i}">${read ? '' : act('photo-del', 'close', T('delete'), 'tiny" data-i="' + i)}</figure>`).join('')}</div>` : ''}
      ${read ? '' : `<div class="toolbar">
        <button class="tonal small" data-act="note-box">${icon('boxed')}${esc(T('checkbox'))}</button>
        ${H.can.photos ? `<button class="tonal small" data-act="photo-add">${icon('photo')}${esc(T('photo'))}</button>` : ''}
        ${H.can.camera ? `<button class="tonal small" data-act="camera">${icon('camera')}${esc(T('takePhoto'))}</button>` : ''}
        ${H.can.voice ? `<button class="tonal small" data-act="note-voice">${icon('mic')}${esc(T('dictate'))}</button>` : ''}
        <button class="tonal small" data-act="note-task">${icon('tasks')}${esc(T('toTask'))}</button>
      </div>${linksBox(n.text, 'text')}`}
      <section class="group"><h3>${icon('label')}${esc(T('list'))}</h3>${listControls(n)}</section>
      <p class="stamp">${stampText(n)}</p>
    </div>`
  }
  function eventSheet(e) {
    const allDay = !e.time; const multi = !!e.endDay
    const linked = e.noteId && S.find(doc, e.noteId); const hasNote = linked && !linked.deleted
    return sheetBar(T('event'), act('share-item', 'share', T('share')) + act('duplicate', 'copy', T('duplicate')) + act('delete', 'delete', T('delete'))) + `
    <div class="sheet-body">
      <div class="title-row"><textarea class="title-input" data-f="text" rows="1" placeholder="${esc(T('eventTitle'))}" aria-label="${esc(T('title'))}">${esc(e.text)}</textarea>
        <button class="icon-btn star" data-act="star-cur" aria-pressed="${e.important}" aria-label="${esc(T('important'))}" title="${esc(T('important'))}">${icon(e.important ? 'star' : 'star_border')}</button></div>
      <section class="group"><h3>${icon('calendar')}${esc(T('when'))}</h3>
        <div class="chips wrap"><button class="chip" data-act="ev-day" data-v="0">${esc(T('today'))}</button><button class="chip" data-act="ev-day" data-v="1">${esc(T('tomorrow'))}</button><button class="chip" data-act="ev-day" data-v="7">${esc(T('nextWeek'))}</button></div>
        <div class="fields">
          <label class="field"><span>${esc(T(multi ? 'from' : 'date'))}</span><input type="date" data-f="day" value="${e.repeat && ui.sheet.day ? ui.sheet.day : e.day}"></label>
          ${multi ? `<label class="field"><span>${esc(T('to'))}</span><input type="date" data-f="endDay" value="${e.endDay}" min="${e.day}"></label>` : ''}
        </div>
        <label class="switch-row"><span><b>${esc(T('allDay'))}</b></span><input type="checkbox" role="switch" data-f="allDay" ${allDay ? 'checked' : ''}></label>
        ${allDay ? '' : `<div class="fields">
          <label class="field"><span>${esc(T('start'))}</span><input type="time" data-f="time" value="${e.time}"></label>
          <label class="field"><span>${esc(T('end'))}${e.end && e.end <= e.time && !multi ? ' (+1)' : ''}</span><input type="time" data-f="end" value="${e.end || ''}"></label></div>${timeButtons(e.time)}`}
        <label class="switch-row"><span><b>${esc(T('severalDays'))}</b></span><input type="checkbox" role="switch" data-f="multi" ${multi ? 'checked' : ''}></label>
      </section>
      <section class="group"><h3>${icon('place')}${esc(T('place'))}</h3>
        <div class="fields"><input class="grow" data-f="place" value="${esc(e.place)}" placeholder="${esc(T('placeHint'))}" aria-label="${esc(T('place'))}">${e.place ? `<button class="tonal small" data-act="map">${icon('place')}${esc(T('map'))}</button>` : ''}</div>
      </section>
      <section class="group"><h3>${icon('bell')}${esc(T('reminders'))}</h3>${remindChips(e, allDay)}</section>
      <section class="group"><h3>${icon('repeat')}${esc(T('repeat'))}</h3>${repeatControls(e, false)}</section>
      <section class="group"><h3>${icon('label')}${esc(T('list'))}</h3>${listControls(e)}</section>
      <section class="group"><h3>${icon('note')}${esc(T('details'))}</h3>
        <textarea class="details" data-f="details" rows="3" placeholder="${esc(T('detailsHint'))}" aria-label="${esc(T('details'))}">${esc(e.details)}</textarea>
        ${linksBox(e.text + '\n' + e.details, 'details')}
        <button class="tonal small" data-act="event-note">${icon('note')}${esc(hasNote ? T('openNote', noteTitle(linked) || T('untitled')) : T('linkNote'))}</button>
      </section>
      ${H.addToCalendar ? `<div class="actions"><button class="tonal" data-act="add-calendar">${icon('calendar')}${esc(T('addToPhoneCal'))}</button></div>` : ''}
      <p class="stamp">${stampText(e)}</p>
    </div>`
  }
  const minutes = t => +t.slice(0, 2) * 60 + +t.slice(3, 5)
  const fromMinutes = m => S.pad(Math.floor(((m % 1440) + 1440) % 1440 / 60)) + ':' + S.pad(((m % 60) + 60) % 60)
  function onField(e) {
    const el = e.target; const f = el.dataset && el.dataset.f
    if (!f || !ui.sheet) return
    const item = S.find(doc, ui.sheet.id); if (!item) return
    const change = e.type === 'change'
    if (change && ui.sheet.kind === 'events' && item.repeat && ui.sheet.day && !ui.sheet.series && ['day', 'time', 'end', 'allDay', 'multi'].indexOf(f) >= 0) return seriesChange(item, el)
    let again = false; let later = !change
    switch (f) {
      case 'text': item.text = el.value; if (el.classList.contains('title-input')) { autoGrow(el); if (ui.sheet.kind !== 'notes') updateLinks('details', item.text + '\n' + item.details) } else if (el.classList.contains('note-text')) { autoGrow(el); updateLinks('text', el.value) } break
      case 'details': item.details = el.value; autoGrow(el); updateLinks('details', (ui.sheet.kind === 'notes' ? '' : item.text + '\n') + el.value); break
      case 'place': item.place = el.value; break
      case 'list': item.list = el.value.trim(); if (!change) break; again = true; break
      case 'step': item.steps[+el.dataset.i].text = el.value; break
      case 'newStep': return
      case 'dueDay': if (!change) return; setDue(item, el.value ? el.value + (S.timeOf(item.due) ? 'T' + S.timeOf(item.due) : '') : null); again = true; break
      case 'dueTime':
        if (!change || !el.value) return
        if (item.due && item.due.length === 10 && item.remind.join() === set.remindAllDay.join()) item.remind = set.remindTask.slice()
        setDue(item, (item.due ? S.dayOf(item.due) : S.today(now())) + 'T' + el.value); again = true; break
      case 'loud': item.loud = el.checked; if (el.checked) warnIfBlocked(); break
      case 'repeatKind': {
        const p = repeatParts(item.repeat)
        const day = ui.sheet.kind === 'tasks' ? (item.due ? S.dayOf(item.due) : S.today(now())) : item.day
        const nth = nthOf(day)
        item.repeat = el.value === 'nth' ? repeatCode('nth', nth.k, [nth.wd]) : el.value === 'months' && p.kind !== 'months' ? repeatCode('months', 3)
          : repeatCode(el.value, p.n, p.days.length ? p.days : [S.weekday(day)])
        if (ui.sheet.kind === 'tasks' && item.repeat && !item.due) setDue(item, el.value === 'hours' ? dueFromPreset('in1h') : S.today(now()))
        alignDue(item)
        if (!item.repeat) item.until = null
        again = true; later = false; break
      }
      case 'repeatN': { const p = repeatParts(item.repeat); if (!el.value) return; item.repeat = repeatCode(p.kind, el.value, p.days, p.after); break }
      case 'repeatAfter': { const p = repeatParts(item.repeat); item.repeat = repeatCode(p.kind, p.n, p.days, el.checked); again = true; break }
      case 'nthK': { const p = repeatParts(item.repeat); item.repeat = repeatCode('nth', +el.value, p.days); alignDue(item); again = true; break }
      case 'nthD': { const p = repeatParts(item.repeat); item.repeat = repeatCode('nth', p.n, [+el.value]); alignDue(item); again = true; break }
      case 'until': if (!change) return; item.until = el.value || null; break
      case 'day': {
        if (!change || !el.value) return
        const span = S.eventSpan(item)
        // A series shown on one of its dates moves by the same number of days.
        item.day = item.repeat && ui.sheet.day ? S.addDays(item.day, S.between(ui.sheet.day, el.value)) : el.value
        if (item.endDay) item.endDay = S.addDays(item.day, span)
        if (ui.sheet.day) ui.sheet.day = el.value
        ui.day = el.value; ui.month = el.value.slice(0, 8) + '01'; again = true; break
      }
      case 'endDay': if (!change) return; item.endDay = el.value && el.value > item.day ? el.value : null; again = true; break
      case 'allDay': item.time = el.checked ? null : '09:00'; item.end = el.checked ? null : fromMinutes(9 * 60 + (+set.eventLength || 60)); item.remind = (el.checked ? set.remindAllDay : set.remindEvent).slice(); again = true; break
      case 'multi': item.endDay = el.checked ? S.addDays(item.day, 1) : null; again = true; break
      case 'time': {
        if (!change || !el.value) return
        let length = item.end && item.time ? minutes(item.end) - minutes(item.time) : (+set.eventLength || 60)
        if (length <= 0 && !item.endDay) length += 1440 // 18:00 -> 01:00 is a night, not a mistake
        item.time = el.value; item.end = fromMinutes(minutes(el.value) + (length > 0 ? length : 60)); again = true; break
      }
      case 'end': if (!change) return; item.end = el.value || null; break
      default: return
    }
    put(item, later)
    if (again) renderSheet()
  }
  // A task moved to the first day its new repetition really happens (Friday + "every Monday" -> Monday).
  function alignDue(t) {
    if (ui.sheet.kind !== 'tasks' || !t.due || !t.repeat || t.repeat.indexOf('hours:') === 0) return
    const first = S.nextDay(S.dayOf(t.due), t.repeat, S.dayOf(t.due), null, null)
    if (first && first !== S.dayOf(t.due)) t.due = first + (S.timeOf(t.due) ? 'T' + S.timeOf(t.due) : '')
  }
  async function seriesChange(item, el) {
    const occ = ui.sheet.day
    const how = await choose(T('editEventQ'), item.text, [{ label: T('cancel'), value: null }, { label: T('wholeSeries'), value: 'all' }, { label: T('onlyDay', fmtDay(occ, true)), value: 'one' }])
    if (!how) return renderSheet() // puts the field back
    if (how === 'all') { ui.sheet.series = true; return onField({ target: el, type: 'change' }) }
    const copy = Object.assign(clone(item), { id: S.newId(), createdAt: now(), repeat: null, until: null, skip: [], day: occ })
    if (copy.endDay) copy.endDay = S.addDays(occ, S.eventSpan(item))
    item.skip = item.skip.concat([occ]); put(item)
    add('events', copy)
    ui.sheet = { id: copy.id, kind: 'events', day: occ, isNew: false }
    onField({ target: el, type: 'change' })
    snack(T('onlyThisDone', fmtDay(occ, true)))
  }
  function updateLinks(key, text) { const box = $('[data-links="' + key + '"]'); if (box) box.innerHTML = linksRow(text) }
  function itemText(item, kind, day) {
    if (kind === 'notes') return item.text
    if (kind === 'tasks') {
      return [(item.done ? '☑ ' : '☐ ') + item.text, item.due ? '📅 ' + fmtDue(item) : '', item.repeat ? '🔁 ' + repeatLabel(item.repeat) : '']
        .concat(item.steps.map(s => (s.done ? '   ☑ ' : '   ☐ ') + s.text), [item.details]).filter(Boolean).join('\n')
    }
    const d = day || item.day
    return [item.text, '📅 ' + fmtDay(d, true) + (item.time ? ' ' + fmtTime(item.time) + (item.end ? ' – ' + fmtTime(item.end) : '') : ' (' + T('allDay') + ')'),
      item.place ? '📍 ' + item.place : '', item.repeat ? '🔁 ' + repeatLabel(item.repeat) : '', item.details].filter(Boolean).join('\n')
  }
  // A picture of the progress, the size of a story (1080 × 1920), in the theme's colours.
  function progressImage() {
    const st = stats(); const css = getComputedStyle(document.documentElement); const v = k => css.getPropertyValue(k).trim()
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1920; const g = c.getContext('2d')
    const font = (w, px) => w + ' ' + px + 'px ' + (v('--font') || 'sans-serif')
    g.fillStyle = v('--surface') || '#fef7ff'; g.fillRect(0, 0, 1080, 1920)
    g.fillStyle = v('--primary-container') || '#eaddff'; g.beginPath(); g.arc(540, 520, 330, 0, 2 * Math.PI); g.fill()
    g.textAlign = 'center'; g.fillStyle = v('--on-primary-container') || '#21005d'
    g.font = font(800, 260); g.fillText(String(st.streak), 540, 600)
    g.font = font(600, 54); g.fillText(T('streakDays'), 540, 700)
    g.fillStyle = v('--on-surface') || '#1d1b20'
    g.font = font(700, 70); g.fillText(T('level', st.level.level) + ' · ' + T('xpTotal', st.count * 10), 540, 1000)
    g.font = font(400, 46); g.fillText(T('bestStreak') + ' : ' + st.best + ' · ' + T('thisWeek') + ' : ' + st.week, 540, 1080)
    const max = Math.max.apply(null, [1].concat(st.last7.map(x => x.n)))
    st.last7.forEach((x, i) => {
      const h = Math.round(x.n / max * 420); const left = 140 + i * 120
      g.fillStyle = v('--primary') || '#6750a4'; g.fillRect(left, 1580 - h, 80, Math.max(6, h))
      g.fillStyle = v('--on-variant') || '#49454f'; g.font = font(600, 40); g.fillText(fmt({ weekday: 'narrow' }, S.parseDay(x.day)), left + 40, 1640)
      if (x.n) { g.fillStyle = v('--on-surface') || '#1d1b20'; g.fillText(String(x.n), left + 40, 1560 - h) }
    })
    g.fillStyle = v('--primary') || '#6750a4'; g.font = font(700, 48); g.fillText('Mon Orga', 540, 1800)
    return c.toDataURL('image/png')
  }
  async function shareProgress() {
    const st = stats(); const text = T('progressShare', st.streak, st.level.level, st.week, st.best); const src = progressImage()
    if (H.shareImage) return H.shareImage(src, text)
    try {
      const bin = atob(src.split(',')[1]); const bytes = new Uint8Array(bin.length) // no fetch() of a data: URL (the page's CSP)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const file = new File([bytes], 'mon-orga.png', { type: 'image/png' })
      if (navigator.canShare && navigator.canShare({ files: [file] })) return await navigator.share({ files: [file], text: text })
    } catch (e) { /* no sharing here: save it */ }
    const a = document.createElement('a'); a.href = src; a.download = 'mon-orga-progres.png'; document.body.appendChild(a); a.click(); a.remove()
    snack(T('imageSaved'))
  }
  function shareText(title, text) {
    if (H.share) H.share(title, text)
    else H.copy(text).then(ok => snack(T(ok ? 'copied' : 'copyFailed')))
  }
  function shrink(file) {
    const url = URL.createObjectURL(file)
    return shrinkUrl(url).then(r => { URL.revokeObjectURL(url); return r }, e => { URL.revokeObjectURL(url); throw e })
  }
  function shrinkUrl(url) { // photos stay small: 1280 px, JPEG
    return new Promise((res, rej) => {
      const img = new Image()
      img.onload = () => {
        const k = Math.min(1, 1280 / Math.max(img.width, img.height))
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
        res(c.toDataURL('image/jpeg', 0.72))
      }
      img.onerror = () => rej(new Error('image'))
      img.src = url
    })
  }
  function onPhoto(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = ''
    if (!file || !ui.sheet) return
    shrink(file).then(src => { const n = S.find(doc, ui.sheet.id); n.images = n.images.concat([src]); put(n); renderSheet() }, () => snack(T('photoError')))
  }

  // ---------- "Plus": progress, PC, reminders, backup, display ----------
  const RELEASES = 'https://github.com/Sayan4448/Octo-Sensei-/releases/latest'
  const ISSUES = 'https://github.com/Sayan4448/Octo-Sensei-/issues/new'
  const card = (ic, title, body, id) => `<section class="card pcard"${id ? ` id="${id}"` : ''}><h2>${icon(ic)}${esc(title)}</h2>${body}</section>`
  const seg = (k, opts) => `<div class="seg" role="group">${opts.map(o => { const on = JSON.stringify(set[k]) === JSON.stringify(o[0]); return `<button data-act="set" data-k="${k}" data-v="${esc(JSON.stringify(o[0]))}" class="${on ? 'on' : ''}" aria-pressed="${on}">${esc(o[1])}</button>` }).join('')}</div>`
  const sw = (k, label, hint) => `<label class="switch-row"><span><span><b>${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span></span><input type="checkbox" role="switch" data-set="${k}" ${set[k] ? 'checked' : ''}></label>`
  const select = (k, opts) => `<select data-set="${k}">${opts.map(o => `<option value="${esc(JSON.stringify(o[0]))}" ${JSON.stringify(set[k]) === JSON.stringify(o[0]) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`
  const setRow = (label, control) => /^<select/.test(control) && control.indexOf('<select', 1) < 0 ? `<label class="set-row"><span>${esc(label)}</span>${control}</label>` // the label names its list
    : `<div class="set-row" role="group" aria-label="${esc(label)}"><span>${esc(label)}</span>${control}</div>`
  function remindDefaults(k, allDay) {
    const opts = allDay ? REMIND_ALLDAY : [0, 10, 15, 30, 60, 1440]
    return `<div class="chips wrap">${opts.map(m => `<button class="chip ${set[k].indexOf(m) >= 0 ? 'on' : ''}" data-act="set-remind" data-k="${k}" data-v="${m}">${esc(remindLabel(m, allDay))}</button>`).join('')}
      <button class="chip ${set[k].length ? '' : 'on'}" data-act="set-remind" data-k="${k}" data-v="none">${esc(T('noReminder'))}</button></div>`
  }
  function plusView() {
    const st = stats()
    const max = Math.max.apply(null, [1].concat(st.last7.map(x => x.n)))
    let html = card('trophy', T('progress'), `
      <div class="stats">
        <div><b>${st.streak}</b><span>${esc(T('streakDays'))}</span></div>
        <div><b>${st.best}</b><span>${esc(T('bestStreak'))}</span></div>
        <div><b>${st.week}</b><span>${esc(T('thisWeek'))}</span></div>
        <div><b>${st.count}</b><span>${esc(T('total'))}</span></div>
      </div>
      <div class="level"><b>${esc(T('level', st.level.level))}</b><div class="bar" role="progressbar" aria-label="${esc(T('level', st.level.level))}" aria-valuenow="${Math.round(st.level.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.round(st.level.progress * 100)}%"></i></div><small>${esc(T('xpTotal', st.count * 10) + ' · ' + plural(st.level.toNext, 'toNextOne', 'toNextMany'))}</small></div>
      ${st.count ? `<div class="week-chart" role="img" aria-label="${esc(T('last7', st.last7.map(x => x.n).join(', ')))}">${st.last7.map(x => `<div><b>${x.n || ''}</b><i style="height:${Math.round(x.n / max * 100)}%"></i><span>${esc(fmt({ weekday: 'narrow' }, S.parseDay(x.day)))}</span></div>`).join('')}</div>
        <div class="btns"><button class="tonal small" data-act="share-progress">${icon('share')}${esc(T('shareProgress'))}</button></div>` : `<p class="hint">${esc(T('chartEmpty'))}</p>`}`)
    html += card('pc', T('pcTitle'), '<div id="syncBox"><p class="hint">…</p></div>', 'sync')
    const times = [[null, T('off')], ['07:00', '7:00'], ['07:30', '7:30'], ['08:00', '8:00'], ['08:30', '8:30'], ['09:00', '9:00']]
    html += card('bell', T('remTitle'), `
      ${setRow(T('summary'), select('summary', times))}<p class="hint">${esc(T('summaryHint'))}</p>
      ${setRow(T('snoozeLen'), select('snooze', [5, 10, 15, 30, 60].map(m => [m, T('remMin', m).replace(/\s*(avant|before)$/, '')])))}
      ${setRow(T('nag'), select('nag', [[0, T('never')]].concat([5, 10, 15, 30, 60].map(m => [m, T('nagEvery', m)]))))}
      ${set.nag ? setRow(T('nagTimes'), select('nagTimes', [3, 5, 10].map(n => [n, T('nTimes', n)]).concat([[0, T('untilAnswer')]]))) : ''}
      ${sw('loudAll', T('loudAll'), T('loudAllHint'))}
      ${H.can.alarms ? setRow(T('quietHours'), select('quietFrom', [['', T('off')]].concat(['21:00', '22:00', '23:00'].map(t => [t, T('fromTime', fmtTime(t))]))) +
        (set.quietFrom ? select('quietTo', ['06:00', '07:00', '08:00'].map(t => [t, T('toTime', fmtTime(t))])) : '')) + `<p class="hint">${esc(T('quietHint'))}</p>` : ''}
      <h3>${esc(T('defaultTask'))}</h3>${remindDefaults('remindTask')}
      <h3>${esc(T('defaultAllDay'))}</h3>${remindDefaults('remindAllDay', true)}
      <h3>${esc(T('defaultEvent'))}</h3>${remindDefaults('remindEvent')}
      ${sw('loudImportant', T('loudImportant'), T('loudImportantHint'))}
      ${H.can.alarms ? `<div class="btns"><button class="tonal" data-act="test-alarm" data-v="0">${icon('bell')}${esc(T('testReminder'))}</button><button class="tonal" data-act="test-alarm" data-v="1">${icon('alarm')}${esc(T('testLoud'))}</button>${H.testAlarmIn ? `<button class="tonal" data-act="test-alarm-15">${icon('timer')}${esc(T('test15'))}</button>` : ''}</div>` : ''}
      ${H.can.diagnostics ? '<div id="diag"></div>' : ''}`)
    const hours = list => list.map(t => [t, fmtTime(t)])
    html += card('calendar', T('dayTitle'), `
      ${setRow(T('morningAt'), select('morning', hours(['07:00', '07:30', '08:00', '08:30', '09:00', '10:00'])))}
      ${setRow(T('eveningAt'), select('evening', hours(['17:00', '18:00', '19:00', '20:00', '21:00'])))}
      ${setRow(T('dayStart'), select('dayStart', [[0, T('midnight')]].concat([180, 240, 300, 360].map(m => [m, fmtTime(fromMinutes(m))]))))}<p class="hint">${esc(T('dayStartHint'))}</p>
      ${setRow(T('eventLength'), select('eventLength', [15, 30, 45, 60, 90, 120].map(m => [m, m < 60 ? m + ' min' : m % 60 ? Math.floor(m / 60) + ' h ' + (m % 60) : (m / 60) + ' h'])))}
      ${setRow(T('weekStart'), seg('weekStart', [[1, T('monday')], [7, T('sunday')]]))}
      ${H.deviceEvents ? sw('phoneCalendar', T('phoneCalendar'), T('phoneCalendarHint')) : ''}`)
    html += card('download', T('backupTitle'), `<p class="hint">${esc(T('backupHint'))}</p>
      <p class="${set.backupLast ? 'ok' : 'warn'}">${icon(set.backupLast ? 'checked' : 'warn')}${esc(set.backupLast ? T('lastBackup', fmtDay(S.today(set.backupLast), true)) : T('noBackupYet'))}</p>
      ${H.chooseBackupFolder ? '<div id="autoBackup"></div>' : ''}
      <div class="btns">
        <button class="tonal" data-act="export-json">${icon('download')}${esc(T('exportJson'))}</button>
        <button class="tonal" data-act="import-json">${icon('upload')}${esc(T('importJson'))}</button>
        <button class="tonal" data-act="export-ics">${icon('calendar')}${esc(T('exportIcs'))}</button>
        <button class="tonal" data-act="import-ics">${icon('calendar')}${esc(T('importIcs'))}</button>
        <button class="tonal" data-act="copy-all">${icon('copy')}${esc(T('copyAll'))}</button>
      </div>`)
    html += card('palette', T('displayTitle'), `
      ${setRow(T('theme'), seg('theme', [['auto', T('auto')], ['light', T('light')], ['dark', T('dark')]]))}
      ${setRow(T('textSize'), seg('text', [[1, 'A'], [1.15, 'A+'], [1.3, 'A++']]))}
      ${setRow(T('language'), seg('lang', [['auto', T('auto')], ['fr', 'Français'], ['en', 'English']]))}
      ${H.info && H.info.dynamic ? setRow(T('colors'), seg('colors', [['app', T('colorsApp')], ['phone', T('colorsPhone')]])) : ''}
      ${sw('sober', T('sober'), T('soberHint'))}
      ${sw('calm', T('calm'), T('calmHint'))}
      ${sw('lefty', T('lefty'), T('leftyHint'))}`)
    if (H.can.lock) html += card('lock', T('privacyTitle'), sw('lock', T('lock'), T('lockHint')) + sw('privateNotifs', T('privateNotifs'), T('privateNotifsHint')) +
      (H.platform === 'android' ? sw('googleBackup', T('googleBackup'), T(set.lock ? 'googleBackupLocked' : 'googleBackupHint')) : '') + `<p class="hint">${esc(T(set.lock || !set.googleBackup ? 'privacyHintOff' : 'privacyHint'))}</p>`)
    if (H.can.tray) html += card('pc', T('pcAppTitle'), sw('tray', T('tray'), T('trayHint')) + sw('login', T('login'), T('loginHint')))
    const ls = lists(true)
    if (ls.length) html += card('label', T('listsTitle'), `<ul class="lists">${ls.map(l => `<li class="${archived(l) ? 'archived' : ''}">${listChip(l)}${archived(l) ? `<small>${esc(T('archivedTag'))}</small>` : ''}<span class="grow"></span><button class="text-btn" data-act="list-rename" data-v="${esc(l)}">${esc(T('rename'))}</button><button class="text-btn" data-act="list-archive" data-v="${esc(l)}">${esc(T(archived(l) ? 'restore' : 'archive'))}</button><button class="text-btn danger" data-act="list-remove" data-v="${esc(l)}">${esc(T('removeList'))}</button></li>`).join('')}</ul><p class="hint">${esc(T('archiveHint'))}</p>`)
    html += card('help', T('helpTitle'), `<ul class="tips">${T('tips').split('|').concat([T('keysTip')]).map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="btns">
        <button class="tonal" data-act="welcome">${icon('help')}${esc(T('welcomeAgain'))}</button>
        <button class="tonal" data-act="link" data-href="${RELEASES}">${icon('download')}${esc(T('download'))}</button>
        <button class="tonal" data-act="link" data-href="${ISSUES}">${icon('mail')}${esc(T('report'))}</button>
      </div>`)
    return html + `<p class="about">Mon Orga ${esc(H.version || '')} · ${esc(T('madeBy'))}</p><div class="spacer"></div>`
  }
  async function syncHtml() {
    const s = H.syncInfo ? await H.syncInfo() : {}
    if (H.can.sync === 'server') {
      return `<label class="switch-row"><span><b>${esc(T('pcShare'))}</b><small>${esc(T('pcShareHint'))}</small></span><input type="checkbox" role="switch" data-act="sync-toggle" ${s.on ? 'checked' : ''}></label>
        ${s.on ? (s.url ? `<div class="sync-on"><p>${esc(T('pcOpen'))}</p><p class="big">${esc(s.url.replace(/\?k=.*/, ''))}</p><p>${esc(T('pcCode'))} <b class="code">${esc(s.code)}</b></p>
          <button class="tonal small" data-act="copy-text" data-v="${esc(s.url)}">${icon('copy')}${esc(T('copyUrl'))}</button>${H.syncNewCode ? `<button class="text-btn" data-act="sync-new-code">${esc(T('newCode'))}</button>` : ''}
          <p class="hint">${esc(T('pcPlainWifi'))}</p></div>` : `<p class="warn">${icon('warn')}${esc(T('pcNoWifi'))}</p>`) : ''}
        <p class="hint">${esc(T('pcHowAndroid'))}</p>`
    }
    if (H.can.sync === 'client') {
      if (s.address && s.code) {
        return `<p class="${s.ok ? 'ok' : 'warn'}">${icon(s.ok ? 'checked' : 'warn')}${esc(s.ok ? T('pcConnected', s.name || s.address) : T('pcUnreachable', s.address))}</p>
          ${s.last ? `<p class="hint">${esc(T('lastSync', rel(s.last)))}</p>` : ''}
          <div class="btns"><button class="tonal" data-act="sync-now">${icon('sync')}${esc(T('syncNow'))}</button><button class="text-btn danger" data-act="sync-forget">${esc(T('forget'))}</button></div>`
      }
      return `<p class="hint">${esc(T('pcHowDesktop'))}</p>
        <div class="btns"><button class="tonal" data-act="sync-scan">${icon('search')}${esc(T('findPhone'))}</button></div>
        <div id="found" class="chips wrap"></div>
        <div class="fields"><label class="field grow"><span>${esc(T('phoneAddress'))}</span><input id="syncAddr" placeholder="192.168.1.20:8080" value="${esc(s.address || '')}" autocomplete="off"></label>
          <label class="field"><span>${esc(T('code'))}</span><input id="syncCode" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="off"></label></div>
        <button class="filled" data-act="sync-connect">${icon('sync')}${esc(T('connect'))}</button>
        ${s.error ? `<p class="warn">${icon('warn')}${esc(T(s.error))}</p>` : ''}`
    }
    if (H.can.sync === 'remote') return `<p class="${s.connected ? 'ok' : 'warn'}">${icon(s.connected ? 'checked' : 'warn')}${esc(T(s.connected ? 'remoteOk' : 'remoteLost'))}</p><p class="hint">${esc(T('remoteHint'))}</p>`
    return `<p class="hint">${esc(T('pcWeb'))}</p><div class="btns"><button class="tonal" data-act="link" data-href="${RELEASES}">${icon('download')}${esc(T('download'))}</button></div>`
  }
  async function fillPlusAsync() {
    const box = $('#syncBox'); if (box) box.innerHTML = await syncHtml()
    const ab = $('#autoBackup')
    if (ab && H.backupInfo) {
      const b = await H.backupInfo(); ui.autoBackup = !!(b && b.folder)
      ab.innerHTML = ui.autoBackup ? `<p class="ok">${icon('folder')}${esc(T('autoBackupOn', b.folder) + (b.last ? ' · ' + T('lastAuto', rel(b.last)) : ''))}</p><button class="text-btn danger" data-act="backup-folder-off">${esc(T('autoBackupOff'))}</button>`
        : `<p class="hint">${esc(T('autoBackupHint'))}</p><button class="tonal" data-act="backup-folder">${icon('folder')}${esc(T('autoBackupChoose'))}</button>`
    }
    const diag = $('#diag')
    if (diag && H.diagnostics) {
      const list = await H.diagnostics()
      diag.innerHTML = `<h3>${esc(T('diagTitle'))}</h3>` + list.map(d => `<div class="diag ${d.ok ? 'ok' : 'bad'}">${icon(d.ok ? 'checked' : 'warn')}<span><b>${esc(T('diag_' + d.key))}</b><small>${esc(T(d.ok ? 'diagOk' : 'diag_' + d.key + '_fix'))}</small></span>${d.ok ? '' : `<button class="tonal small" data-act="fix" data-k="${d.key}">${esc(T('fixIt'))}</button>`}</div>`).join('')
    }
  }
  function saveSettings() { H.saveSettings(set) }
  function setSetting(k, v) {
    set[k] = v
    if (k === 'quietFrom' && v && !set.quietTo) set.quietTo = '07:00'
    if (k === 'phoneCalendar') phoneEvents.key = ''
    saveSettings(); applySettings()
    if (k === 'lang' || k === 'sober') { renderShell(); renderAddBar() }
    render()
  }
  function asText() {
    const n = now(); const lines = ['== ' + T('tab_tasks') + ' ==']
    S.sortTasks(doc.tasks, n, set.dayStart).filter(t => !t.done).forEach(t => lines.push('☐ ' + t.text + (t.due ? ' — ' + fmtDue(t) : '') + (t.repeat ? ' (' + repeatLabel(t.repeat) + ')' : '')))
    lines.push('', '== ' + T('tab_agenda') + ' ==')
    for (let i = 0; i < 60; i++) {
      const d = S.addDays(S.today(n), i)
      S.eventsOn(doc.events, d).forEach(e => lines.push(fmtDay(d, true) + (e.time ? ' ' + fmtTime(e.time) : '') + ' — ' + e.text + (e.place ? ' (' + e.place + ')' : '')))
    }
    const week = ticks().filter(x => x.id && x.t >= n - 7 * 86400000).sort((a, b) => a.t - b.t) // what got done, repeating tasks included
    if (week.length) {
      lines.push('', '== ' + T('doneThisWeek') + ' ==')
      week.forEach(x => { const t = S.find(doc, x.id); if (t) lines.push('☑ ' + t.text + ' — ' + fmtDay(S.today(x.t), true) + (t.list ? ' [' + t.list + ']' : '')) })
    }
    lines.push('', '== ' + T('tab_notes') + ' ==')
    S.live(doc.notes).forEach(x => lines.push(x.text, '———'))
    return lines.join('\n')
  }
  const LOCAL_KEYS = ['focus', 'welcomed', 'news', 'backupLast', 'backupAsked', 'recentTimes'] // this device only
  const portable = () => { const o = Object.assign({}, set); LOCAL_KEYS.forEach(k => { delete o[k] }); return o }
  async function importData(kind) {
    const f = await H.importFile(kind === 'ics' ? '.ics,text/calendar' : '.json,.txt,.md,application/json,text/plain')
    if (!f || typeof f.text !== 'string') return
    if (/^PK/.test(f.text) || /\.zip$/i.test(f.name || '')) return snack(T('zipFile'), null, 9000) // Google Agenda exports a .zip
    if (kind === 'ics' || /BEGIN:VCALENDAR/.test(f.text)) return importIcs(f.text)
    let data = null
    try { data = JSON.parse(f.text) } catch (e) { /* plain text */ }
    if (data && (data.tasks || data.notes || data.events)) return importBackup(data)
    return importText(f.text)
  }
  // Events of a calendar file: new ones are added, changed ones updated; what was edited or deleted here since stays.
  function importIcs(text) {
    let added = 0; let updated = 0
    S.fromIcs(text, now()).forEach(e => {
      const x = doc.events.find(y => y.id === e.id)
      if (!x) { doc.events.push(e); added++ } else if (e.updatedAt > x.updatedAt) { Object.assign(x, e, { deleted: false }); updated++ } // the list or the linked note stay
    })
    commit(); snack(T('importedIcs', added, updated))
  }
  const count = d => S.live(d.tasks).length + S.live(d.notes).length + S.live(d.events).length
  async function importBackup(data) {
    const settings = data.settings; delete data.settings
    const incoming = S.normalize(data)
    const newest = Math.max.apply(null, [0].concat(incoming.tasks, incoming.notes, incoming.events).map(x => +x.updatedAt || 0))
    const age = newest ? Math.floor((now() - newest) / 86400000) : 0
    const how = await choose(T('importHowTitle'), age > 30 ? T('importOld', age) : T('importHowBody'),
      [{ label: T('cancel'), value: null }, { label: T('importReplace'), value: 'replace', danger: true }, { label: T('importMerge'), value: 'merge' }])
    if (!how) return
    const before = clone(doc); const n0 = count(doc); const t = now()
    if (how === 'replace') { // exactly the file: the rest goes, as deletions the other devices will follow
      const ids = {}
      ;['tasks', 'notes', 'events'].forEach(k => incoming[k].forEach(x => { ids[x.id] = 1; x.updatedAt = t }))
      ;['tasks', 'notes', 'events'].forEach(k => doc[k].forEach(x => { if (!ids[x.id] && !x.deleted) { x.deleted = true; x.updatedAt = t } }))
    }
    doc = S.merge(doc, incoming); commit()
    snack(how === 'replace' ? T('restored', count(doc)) : plural(count(doc) - n0, 'importedOne', 'importedMany'), [{ label: T('undo'), run: () => {
      const t2 = now(); const back = clone(before); const had = {}
      ;['tasks', 'notes', 'events'].forEach(k => back[k].forEach(x => { had[x.id] = 1; x.updatedAt = t2 }))
      ;['tasks', 'notes', 'events'].forEach(k => doc[k].forEach(x => { if (!had[x.id] && !x.deleted) { x.deleted = true; x.updatedAt = t2 } }))
      doc = S.merge(doc, back); commit()
    } }])
    if (settings && typeof settings === 'object' && JSON.stringify(Object.assign({}, portable(), settings)) !== JSON.stringify(portable()) &&
      await choose(T('importSettingsQ'), '', [{ label: T('no'), value: false }, { label: T('yes'), value: true }])) {
      Object.keys(settings).forEach(k => { if (LOCAL_KEYS.indexOf(k) < 0 && k in DEFAULTS) set[k] = settings[k] })
      saveSettings(); applySettings(); renderShell(); render(); renderAddBar()
    }
  }
  async function importText(text) {
    const blocks = text.split(/\n[ \t]*(?:———+|-{3,}|_{3,}|\*{3,})[ \t]*(?:\n|$)|\n[ \t]*\n[ \t]*\n+/).map(b => b.trim()).filter(Boolean)
    const options = [{ label: T('cancel'), value: null }, { label: T('asNote'), value: 'note' }]
    if (blocks.length > 1) options.push({ label: T('asNotesN', blocks.length), value: 'notes' })
    options.push({ label: T('asTasks'), value: 'tasks' })
    const how = await choose(T('importTextTitle'), T('importTextBody'), options)
    if (how === 'note') { addNote(text); snack(T('noteAdded')) }
    if (how === 'notes') { blocks.slice().reverse().forEach(b => doc.notes.unshift(touch(newNote({ text: b })))); commit(); snack(T('notesAdded', blocks.length)) }
    if (how === 'tasks') { ui.draft.raw = true; addTasks(text) }
  }

  // ---------- dialogs, snackbar, focus timer ----------
  let dialogDone = null
  function choose(title, message, options, html) {
    return new Promise(res => {
      const d = $('#dialog')
      const menu = options.map((o, i) => o.menu ? `<button class="menu-item" data-act="dlg" data-v="${i}">${o.icon ? icon(o.icon) : ''}${esc(o.label)}</button>` : '').join('')
      const buttons = options.filter(o => !o.menu); const lastI = options.indexOf(buttons[buttons.length - 1])
      d.innerHTML = `<div class="scrim" data-act="dlg" data-v=""></div><div class="dlg card" role="alertdialog" aria-modal="true" aria-labelledby="dlgT"><h2 id="dlgT">${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ''}${html || ''}${menu ? `<div class="menu">${menu}</div>` : ''}
        <div class="dlg-actions">${options.map((o, i) => o.menu ? '' : `<button class="${o.danger ? 'danger' : i === lastI && !menu ? 'filled' : 'text-btn'}" data-act="dlg" data-v="${i}">${esc(o.label)}</button>`).join('')}</div></div>`
      d.hidden = false
      dialogDone = v => { const box = $('#askInput', d); typed = box ? box.value.trim() : ''; d.hidden = true; d.innerHTML = ''; dialogDone = null; res(v === '' || v === undefined ? null : options[+v].value) }
      const first = $('#askInput', d) || $('.menu-item', d) || $$('.dlg-actions button', d).pop(); if (first) first.focus()
    })
  }
  let typed = ''
  const ask = (title, value) => choose(title, '', [{ label: T('cancel'), value: null }, { label: T('ok'), value: 'ok' }], `<input id="askInput" class="ask" value="${esc(value || '')}" autocomplete="off" aria-label="${esc(title)}">`)
    .then(v => (v === 'ok' && typed ? typed : null))
  let snackTimer = 0; let snackActions = []
  const undoMs = () => Math.max(15000, (H.info && H.info.a11yTimeout) || 0) // time to read and reach "Undo", more with accessibility settings
  function snack(msg, actions, ms) {
    const el = $('#snack'); if (!el) return
    snackActions = actions || []
    el.innerHTML = `<span>${esc(msg)}</span>${snackActions.map((a, i) => `<button data-act="snack" data-i="${i}">${esc(a.label)}</button>`).join('')}`
    el.classList.add('show')
    hideSnack(el, ms || (snackActions.length ? undoMs() : 4000))
  }
  function hideSnack(el, ms) {
    clearTimeout(snackTimer)
    snackTimer = setTimeout(() => { if (el.matches(':hover') || el.contains(document.activeElement)) return hideSnack(el, 3000); el.classList.remove('show') }, ms)
  }
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + S.pad(s % 60) }
  function renderFocus() {
    const bar = $('#focusBar'); if (!bar) return
    const f = set.focus
    if (!f) { bar.hidden = true; return }
    const left = f.until - now()
    bar.hidden = false
    bar.innerHTML = left > 0
      ? `${icon('timer')}<span><b>${mmss(left)}</b> · ${esc(f.pause ? T('pauseLeft') : f.title)}</span><button class="text-btn" data-act="focus-stop">${esc(T('stop'))}</button>`
      : `${icon('timer')}<span>${esc(T(f.pause ? 'pauseDone' : 'focusDone'))}</span>${f.pause ? `<button class="text-btn" data-act="focus-again">${esc(T('again25'))}</button>` : `<button class="text-btn" data-act="focus-break">${esc(T('break5'))}</button>`}<button class="text-btn" data-act="focus-stop">${esc(T('ok'))}</button>`
  }
  function startFocus(title, minutesLong, pause) {
    set.focus = { until: now() + minutesLong * 60000, title: title, pause: !!pause, task: pause && set.focus ? set.focus.task : title }
    saveSettings(); renderFocus()
  }
  function welcome() {
    choose(T('welcomeTitle'), '', [{ label: T('letsGo'), value: 1 }], `<ul class="tips">${T('welcomeTips').split('|').map(t => `<li>${esc(t)}</li>`).join('')}</ul>${sw('calm', T('calm'), T('calmHint'))}`)
      .then(() => { set.welcomed = true; set.news = NEWS; saveSettings(); const i = $('#addInput'); if (i && ui.tab === 'tasks') i.focus() })
  }
  function showImage(src) {
    choose('', '', [{ label: T('close'), value: 1 }], `<img class="full" src="${esc(src)}" alt="">`)
  }

  // ---------- navigation ----------
  function switchTab(tab) {
    if (ui.sheet) closeSheet()
    ui.filters[ui.tab] = ui.filter
    ui.tab = tab; ui.filter = ui.filters[tab] || null; ui.query = ''; ui.searchOpen = false
    const s = $('#search'); if (s) s.value = ''
    render(); $('#main').scrollTop = 0
  }
  function openSearch() { ui.searchOpen = true; renderTop(); const s = $('#search'); s.focus(); s.select() }
  function closeSearch() { ui.searchOpen = false; ui.query = ''; $('#search').value = ''; render() }
  function newEventOn(day) {
    const n = new Date(); const today = day === S.today(now())
    const time = today ? (n.getHours() < 23 ? S.pad(n.getHours() + 1) + ':00' : null) : '09:00'
    const e = newEvent({ day: day, time: time, end: time ? fromMinutes(minutes(time) + (+set.eventLength || 60)) : null })
    if (!time) e.remind = set.remindAllDay.slice()
    add('events', e)
    openSheet(e.id, { isNew: true, day: day })
  }
  function newNoteFull(text) { const n = addNote(text || ''); openSheet(n.id, { isNew: true }) }
  function quickNew() {
    if (ui.tab === 'agenda') return newEventOn(ui.day)
    if (ui.tab === 'plus') switchTab('tasks')
    const i = $('#addInput'); if (i) i.focus()
  }
  const bullet = l => l.replace(/^\s*(?:[-*•▪◦·]|\d{1,2}[.)]|\[[ xX]?\])\s*/, '').trim()
  async function fromShare(text) {
    const lines = text.split('\n').map(bullet).filter(Boolean)
    const options = [{ label: T('asNote'), value: 'note' }, { label: T('asEvent'), value: 'event' }]
    if (lines.length > 1) options.push({ label: T('asSteps'), value: 'steps' }, { label: T('asTasksN', lines.length), value: 'tasks' })
    options.push({ label: T('asTask'), value: 'task' })
    const kind = await choose(T('shareTitle'), text.length > 160 ? text.slice(0, 160) + '…' : text, options)
    if (kind === 'note') { switchTab('notes'); newNoteFull(text) }
    else if (kind === 'tasks') { switchTab('tasks'); addTasks(lines.join('\n')) }
    else if (kind === 'steps') {
      const p = parse(lines[0])
      const t = newTask({ text: p.text.slice(0, 300), repeat: p.repeat, steps: lines.slice(1).map(l => ({ text: l, done: false })) }); setDue(t, p.due)
      switchTab('tasks'); add('tasks', t); openSheet(t.id)
    }
    else if (kind === 'task') {
      const lines = text.split('\n'); const p = parse(lines[0])
      const t = newTask({ text: p.text.slice(0, 300), repeat: p.repeat, details: lines.slice(1).join('\n').trim() }); setDue(t, p.due)
      switchTab('tasks'); add('tasks', t); openSheet(t.id)
    } else if (kind === 'event') {
      const p = parse(text.split('\n')[0])
      const e = newEvent({ text: p.text.slice(0, 300), day: p.due ? S.dayOf(p.due) : S.today(now()), time: S.timeOf(p.due), details: text.split('\n').slice(1).join('\n').trim() })
      if (e.time) e.end = fromMinutes(minutes(e.time) + 60); else e.remind = set.remindAllDay.slice()
      switchTab('agenda'); ui.day = e.day; ui.month = e.day.slice(0, 8) + '01'; add('events', e); openSheet(e.id, { isNew: true, day: e.day })
    }
  }
  function action(a) {
    if (!a || !a.type) return
    if (a.type === 'add-task') { switchTab('tasks'); setTimeout(() => $('#addInput') && $('#addInput').focus(), 50) }
    else if (a.type === 'add-note') { switchTab('notes'); newNoteFull('') }
    else if (a.type === 'add-event') { switchTab('agenda'); newEventOn(ui.day) }
    else if (a.type === 'voice') { switchTab('tasks'); run('mic') }
    else if (a.type === 'voice-note') {
      switchTab('notes')
      if (H.voice) H.voice().then(text => { if (!text) return; const n = addNote(text); snack(T('noteAdded'), [{ label: T('open'), run: () => openSheet(n.id) }]) })
    } else if (a.type === 'ics' && a.text) { switchTab('agenda'); importIcs(a.text) }
    else if (a.type === 'image' && a.src) {
      switchTab('notes')
      shrinkUrl(a.src).then(src => { const n = newNote({ text: a.text || '', images: [src] }); add('notes', n); openSheet(n.id, { isNew: true }) }, () => snack(T('photoError')))
    }
    else if (a.type === 'tab') switchTab(a.tab)
    else if (a.type === 'share' && a.text) fromShare(a.text)
    else if (a.type === 'open' && a.id) {
      const item = S.find(doc, a.id); if (!item || item.deleted) return
      const k = kindOf(a.id)
      switchTab(k === 'events' ? 'agenda' : k)
      if (k === 'events') { ui.day = S.nextDay(item.day, item.repeat, S.today(now()), item.until, item.skip) || item.day; ui.month = ui.day.slice(0, 8) + '01'; render() }
      openSheet(a.id, { day: ui.day })
    }
  }

  // ---------- clicks ----------
  const ACTS = {
    tab: el => switchTab(el.dataset.tab),
    'search-open': openSearch, 'search-close': closeSearch,
    filter: el => { ui.filter = el.dataset.v || null; render() },
    toggle: (el, id) => toggleTask(id),
    open: (el, id) => openSheet(id, { day: el.closest('[data-day]') ? el.closest('[data-day]').dataset.day : null }),
    star: (el, id) => { const t = S.find(doc, id); put(Object.assign(t, { important: !t.important, prio: 0, loud: !t.important && set.loudImportant ? true : t.loud })) },
    postpone: (el, id) => postponeTask(id),
    'postpone-all': () => {
      const late = S.live(doc.tasks).filter(t => S.sectionOf(t, now(), set.dayStart) === 'late'); const before = clone(late)
      late.forEach(t => Object.assign(t, S.postpone(t, now(), 1), { updatedAt: now() }))
      commit(); snack(plural(late.length, 'movedOne', 'movedMany'), [{ label: T('undo'), run: () => { before.forEach(b => Object.assign(S.find(doc, b.id), b, { updatedAt: now() + 1 })); commit() } }])
    },
    'show-done': () => { ui.showDone = !ui.showDone; renderMain() },
    'clear-done': () => choose(T('clearDoneQ'), '', [{ label: T('cancel'), value: false }, { label: T('delete'), value: true, danger: true }]).then(ok => {
      if (!ok) return
      const done = S.live(doc.tasks).filter(t => t.done); done.forEach(t => { t.deleted = true; touch(t) }); commit()
      snack(T('deleted'), [{ label: T('undo'), run: () => { done.forEach(t => { t.deleted = false; touch(t) }); commit() } }])
    }),
    'add-preset': el => { const d = dueFromPreset(el.dataset.v); ui.draft.due = ui.draft.due === d ? null : d; renderHint(); $('#addInput').focus() },
    'add-imp': () => { ui.draft.important = !ui.draft.important; renderHint(); $('#addInput').focus() },
    'add-raw': () => { ui.draft.raw = true; renderHint(); $('#addInput').focus() },
    mic: () => { if (!H.voice) return; H.voice().then(text => { if (!text) return; if (ui.tab === 'notes') { addNote(text); snack(T('noteAdded')) } else if (ui.tab === 'agenda') addEvents(text); else addTasks(text) }) },
    'note-full': () => { const i = $('#addInput'); const v = i ? i.value : ''; if (i) i.value = ''; newNoteFull(v) },
    'event-full': () => {
      const i = $('#addInput'); const v = i ? i.value.trim() : ''; if (i) { i.value = ''; autoGrow(i) }
      if (!v) return newEventOn(ui.day)
      const p = parse(v); const due = pickDue(ui.draft.due, p.due); const time = S.timeOf(due)
      const e = newEvent({ text: p.text, day: due ? S.dayOf(due) : ui.day, time: time, end: time ? p.end || fromMinutes(minutes(time) + (+set.eventLength || 60)) : null, place: p.place || '', repeat: p.repeat })
      if (!time) e.remind = set.remindAllDay.slice()
      ui.draft = { due: null, repeat: null, important: false, raw: false }; renderHint()
      add('events', e); openSheet(e.id, { isNew: true, day: e.day })
    },
    'add-date': () => {
      const d = $('#addDate'); if (!d) return
      d.value = ui.draft.due ? S.dayOf(ui.draft.due) : S.today(now())
      try { d.showPicker() } catch (e) { d.click() }
    },
    'more-upcoming': () => { ui.upcoming += 30; renderMain() },
    'share-list': () => {
      const tasks = S.sortTasks(doc.tasks, now(), set.dayStart).filter(t => !t.done && passes(t))
      if (!tasks.length) return snack(T('nothingToShare'))
      const f = ui.filter || ''; const title = f.indexOf('list:') === 0 ? f.slice(5) : f.indexOf('tag:') === 0 ? f.slice(4) : f === 'important' ? T('importantF') : T('tab_tasks')
      shareText(title, title + '\n' + tasks.map(t => '☐ ' + t.text + (t.due ? ' — ' + fmtDue(t) : '')).join('\n'))
    },
    'share-day': () => {
      const it = dayItems(ui.day)
      const lines = it.evs.map(e => (e.time ? fmtTime(e.time) + (e.end ? '–' + fmtTime(e.end) : '') : T('allDay')) + ' · ' + e.text + (e.place ? ' (' + e.place + ')' : ''))
        .concat(it.tasks.filter(t => !t.done).map(t => '☐ ' + t.text + (S.timeOf(t.due) ? ' · ' + fmtTime(S.timeOf(t.due)) : '')))
      if (!lines.length) return snack(T('nothingToShare'))
      shareText(fmtDay(ui.day, true), [fmtDay(ui.day, true)].concat(lines).join('\n'))
    },
    'backup-later': () => { set.backupAsked = now(); saveSettings(); renderMain() },
    fab: () => newEventOn(ui.day),
    'cal-prev': () => { if (ui.agendaMode === 'week') { ui.day = S.addDays(ui.day, -7); ui.month = ui.day.slice(0, 8) + '01' } else ui.month = S.addMonths(ui.month, -1); render() },
    'cal-next': () => { if (ui.agendaMode === 'week') { ui.day = S.addDays(ui.day, 7); ui.month = ui.day.slice(0, 8) + '01' } else ui.month = S.addMonths(ui.month, 1); render() },
    'cal-today': () => { ui.day = S.today(now()); ui.month = ui.day.slice(0, 8) + '01'; render() },
    'cal-day': el => { ui.day = el.dataset.day; ui.month = ui.day.slice(0, 8) + '01'; render() },
    'cal-mode': el => { ui.agendaMode = el.dataset.v; ui.month = ui.day.slice(0, 8) + '01'; render() },
    // editor
    close: closeSheet,
    'share-item': () => { const it = S.find(doc, ui.sheet.id); shareText(it.text.split('\n')[0], itemText(it, ui.sheet.kind, ui.sheet.day)) },
    'copy-item': () => { const it = S.find(doc, ui.sheet.id); H.copy(itemText(it, ui.sheet.kind)).then(ok => snack(T(ok ? 'copied' : 'copyFailed'))) },
    duplicate: () => {
      const it = clone(S.find(doc, ui.sheet.id)); const k = ui.sheet.kind
      Object.assign(it, { id: S.newId(), createdAt: now(), done: false, doneAt: null })
      if (k === 'events' && ui.sheet.day) { it.day = ui.sheet.day; it.repeat = null; it.skip = [] }
      closeSheet(); add(k, it); openSheet(it.id, { day: it.day }); snack(T('duplicated'))
    },
    delete: async () => {
      const it = S.find(doc, ui.sheet.id); const day = ui.sheet.day
      if (ui.sheet.kind === 'events' && it.repeat && day) {
        const how = await choose(T('deleteEventQ'), it.text, [{ label: T('cancel'), value: null }, { label: T('wholeSeries'), value: 'all', danger: true }, { label: T('onlyDay', fmtDay(day, true)), value: 'one' }])
        if (!how) return
        if (how === 'one') { it.skip = it.skip.concat([day]); closeSheet(); put(it); return snack(T('skipped'), [{ label: T('undo'), run: () => { const x = S.find(doc, it.id); x.skip = x.skip.filter(s => s !== day); put(x) } }]) }
      }
      closeSheet(); remove(it.id)
    },
    'toggle-cur': () => { toggleTask(ui.sheet.id); renderSheet() },
    'star-cur': () => { const t = S.find(doc, ui.sheet.id); t.important = !t.important; if (!t.important) t.prio = 0; if (t.important && set.loudImportant) t.loud = true; put(t); renderSheet() },
    prio: el => { const t = S.find(doc, ui.sheet.id); const n = +el.dataset.v; t.important = n > 0; t.prio = n; if (n && set.loudImportant) t.loud = true; put(t); renderSheet() },
    'make-event': () => { const id = ui.sheet.id; closeSheet(); taskToEvent(id) },
    'list-archive': el => { const name = el.dataset.v; const on = archived(name); set.archivedLists = on ? set.archivedLists.filter(x => x !== name) : (set.archivedLists || []).concat([name]); if (!on && ui.filter === 'list:' + name) ui.filter = null; saveSettings(); render(); snack(T(on ? 'listRestored' : 'listArchived', name)) },
    'sheet-full': () => { ui.sheetFull = !ui.sheetFull; document.body.classList.toggle('sheet-full', ui.sheetFull); renderSheet() },
    'due-time': el => {
      if (ui.sheet.kind !== 'tasks') { const f = $('[data-f="time"]'); if (f) { f.value = el.dataset.v; onField({ target: f, type: 'change' }) } return }
      const t = S.find(doc, ui.sheet.id)
      if (t.due && t.due.length === 10 && t.remind.join() === set.remindAllDay.join()) t.remind = set.remindTask.slice()
      setDue(t, t.due ? S.dayOf(t.due) + 'T' + el.dataset.v : dueFromPreset('t:' + el.dataset.v)); alignDue(t); put(t); renderSheet()
    },
    'time-step': el => {
      const f = $(ui.sheet.kind === 'tasks' ? '[data-f="dueTime"]' : '[data-f="time"]'); if (!f || !f.value) return
      f.value = fromMinutes(minutes(f.value) + +el.dataset.v); onField({ target: f, type: 'change' })
    },
    'ev-day': el => {
      const f = $('[data-f="day"]'); if (!f) return
      f.value = el.dataset.v === '7' ? S.addDays(f.value || S.today(now()), 7) : S.addDays(S.today(now()), +el.dataset.v)
      onField({ target: f, type: 'change' })
    },
    'add-calendar': () => {
      const e = S.find(doc, ui.sheet.id); const day = ui.sheet.day || e.day
      const endDay = e.endDay ? S.addDays(day, S.eventSpan(e)) : e.time && e.end && e.end <= e.time ? S.addDays(day, 1) : null
      H.addToCalendar({ text: e.text, day: day, time: e.time, endDay: endDay, end: e.end, place: e.place, details: e.details })
    },
    'step-task': el => {
      const t = S.find(doc, ui.sheet.id); const st = t.steps[+el.dataset.i]; if (!st) return
      const p = parse(st.text); const n = newTask({ text: p.text, repeat: p.repeat, list: t.list, details: T('fromTask', t.text) }); setDue(n, p.due)
      t.steps.splice(+el.dataset.i, 1); put(t); add('tasks', n); renderSheet()
      snack(T('taskCreated'), [{ label: T('open'), run: () => openSheet(n.id) }])
    },
    'due-preset': el => { const t = S.find(doc, ui.sheet.id); setDue(t, dueFromPreset(el.dataset.v)); put(t); renderSheet() },
    'due-clear': () => { const t = S.find(doc, ui.sheet.id); t.due = null; t.repeat = null; t.until = null; put(t); renderSheet() },
    'time-clear': () => { const t = S.find(doc, ui.sheet.id); t.due = S.dayOf(t.due); if (t.repeat && t.repeat.indexOf('hours:') === 0) t.repeat = 'daily'; put(t); renderSheet() },
    remind: el => {
      const it = S.find(doc, ui.sheet.id); const v = el.dataset.v
      if (v === 'none') it.remind = []
      else { const m = +v; it.remind = it.remind.indexOf(m) >= 0 ? it.remind.filter(x => x !== m) : it.remind.concat([m]).sort((a, b) => a - b); askNotifications() }
      put(it); renderSheet()
    },
    'rep-day': el => {
      const it = S.find(doc, ui.sheet.id); const p = repeatParts(it.repeat); const d = +el.dataset.v
      const days = p.days.indexOf(d) >= 0 ? p.days.filter(x => x !== d) : p.days.concat([d])
      if (!days.length) return
      it.repeat = repeatCode('pick', 2, days); put(it); renderSheet()
    },
    'step-toggle': el => { const t = S.find(doc, ui.sheet.id); const s = t.steps[+el.dataset.i]; s.done = !s.done; put(t); renderSheet() },
    'step-del': el => { const t = S.find(doc, ui.sheet.id); t.steps.splice(+el.dataset.i, 1); put(t); renderSheet() },
    'list-pick': el => { const it = S.find(doc, ui.sheet.id); it.list = it.list === el.dataset.v ? '' : el.dataset.v; put(it); renderSheet() },
    'focus-start': () => { const t = S.find(doc, ui.sheet.id); startFocus(t.text, 25); snack(T('focusStarted')) },
    'focus-stop': () => { set.focus = null; saveSettings(); renderFocus() },
    'focus-break': () => startFocus(T('pause'), 5, true),
    'focus-again': () => startFocus((set.focus && set.focus.task) || T('focus'), 25),
    'postpone-cur': el => { postponeTask(ui.sheet.id, +el.dataset.v || 1); renderSheet() },
    'note-mode': () => { ui.noteRead = !ui.noteRead; renderSheet(); if (!ui.noteRead) { const ta = $('.note-text'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) } } },
    'note-pin': () => { const n = S.find(doc, ui.sheet.id); n.pinned = !n.pinned; put(n); renderSheet() },
    'note-box': () => {
      const ta = $('.note-text'); const n = S.find(doc, ui.sheet.id); if (!ta) return
      const pos = ta.selectionStart; const start = ta.value.lastIndexOf('\n', pos - 1) + 1
      const insert = ta.value.slice(start, pos).trim() || start === pos ? '- [ ] ' : '\n- [ ] '
      const at = ta.value.slice(start, pos).trim() ? pos : start
      ta.value = ta.value.slice(0, at) + insert + ta.value.slice(at); n.text = ta.value; put(n, true)
      ta.focus(); const c = at + insert.length; ta.setSelectionRange(c, c); autoGrow(ta)
    },
    'note-task': () => {
      const ta = $('.note-text'); const n = S.find(doc, ui.sheet.id)
      const sel = ta && ta.selectionEnd > ta.selectionStart ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : noteTitle(n)
      if (!sel.trim()) return snack(T('selectText'))
      const p = parse(sel.trim().split('\n')[0])
      const t = newTask({ text: p.text, repeat: p.repeat, details: T('fromNote', noteTitle(n)) }); setDue(t, p.due)
      add('tasks', t); snack(T('taskCreated'), [{ label: T('open'), run: () => { switchTab('tasks'); openSheet(t.id) } }])
    },
    'photo-add': () => $('#photoInput').click(),
    camera: () => $('#cameraInput').click(),
    'note-voice': () => H.voice().then(text => {
      if (!text || !ui.sheet) return
      const n = S.find(doc, ui.sheet.id); n.text = n.text.replace(/\s+$/, '') + (n.text.trim() ? '\n' : '') + text; put(n); renderSheet()
    }),
    'photo-del': el => choose(T('deletePhotoQ'), '', [{ label: T('cancel'), value: false }, { label: T('delete'), value: true, danger: true }]).then(ok => {
      if (!ok) return; const n = S.find(doc, ui.sheet.id); n.images = n.images.filter((x, i) => i !== +el.dataset.i); put(n); renderSheet()
    }),
    'photo-view': el => showImage(S.find(doc, ui.sheet.id).images[+el.dataset.i]),
    'line-toggle': el => {
      const n = S.find(doc, ui.sheet.id); const lines = n.text.split('\n'); const i = +el.dataset.i
      lines[i] = /\[[xX]\]/.test(lines[i]) ? lines[i].replace(/\[[xX]\]/, '[ ]') : lines[i].replace('[ ]', '[x]')
      n.text = lines.join('\n'); put(n); renderSheet()
    },
    link: el => H.openUrl(el.dataset.href),
    map: () => { const e = S.find(doc, ui.sheet.id); H.openUrl(H.platform === 'android' ? 'geo:0,0?q=' + encodeURIComponent(e.place) : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(e.place)) },
    'event-note': () => {
      const e = S.find(doc, ui.sheet.id); const linked = e.noteId && S.find(doc, e.noteId)
      if (linked && !linked.deleted) return openSheet(linked.id)
      const n = newNote({ text: e.text + '\n' + fmtDay(ui.sheet.day || e.day, true) + (e.time ? ' ' + fmtTime(e.time) : '') + '\n\n', list: e.list })
      e.noteId = n.id; put(e); add('notes', n); openSheet(n.id, { isNew: true })
    },
    // plus
    set: el => setSetting(el.dataset.k, JSON.parse(el.dataset.v)),
    'set-remind': el => {
      const k = el.dataset.k; const v = el.dataset.v
      set[k] = v === 'none' ? [] : set[k].indexOf(+v) >= 0 ? set[k].filter(x => x !== +v) : set[k].concat([+v]).sort((a, b) => a - b)
      saveSettings(); renderMain()
    },
    'test-alarm': el => { H.testAlarm(el.dataset.v === '1'); snack(T('testSoon')) },
    fix: el => H.fix(el.dataset.k),
    'open-next': el => { const it = S.find(doc, el.dataset.id); if (!it) return; if (kindOf(it.id) === 'events') { ui.day = el.dataset.day || it.day } openSheet(it.id, { day: el.dataset.day || null }) },
    'export-json': () => H.exportFile('mon-orga-' + S.today(now()) + '.json', 'application/json', JSON.stringify(Object.assign({}, doc, { settings: portable() })))
      .then(ok => { if (!ok) return; set.backupLast = now(); saveSettings(); snack(T('exported')); render() }),
    'backup-folder': async () => { const r = await H.chooseBackupFolder(); if (r) snack(T('backupFolderSet', r.name)); fillPlusAsync() },
    'backup-folder-off': async () => { await H.clearBackupFolder(); ui.autoBackup = false; fillPlusAsync() },
    'test-alarm-15': () => { H.testAlarmIn(15, false); snack(T('testIn15')) },
    'sync-new-code': () => { H.syncNewCode(); fillPlusAsync(); snack(T('newCodeDone')) },
    'share-progress': () => shareProgress(),
    'list-rename': async el => {
      const old = el.dataset.v
      const name = await ask(T('renameList'), old); if (!name || name === old) return
      doc.tasks.concat(doc.notes, doc.events).forEach(x => { if (x.list === old) { x.list = name; touch(x) } })
      if (ui.filter === 'list:' + old) ui.filter = 'list:' + name
      commit(); snack(T('listRenamed', name))
    },
    'list-remove': async el => {
      const old = el.dataset.v
      if (!(await choose(T('removeListQ', old), T('removeListHint'), [{ label: T('cancel'), value: false }, { label: T('removeList'), value: true, danger: true }]))) return
      doc.tasks.concat(doc.notes, doc.events).forEach(x => { if (x.list === old) { x.list = ''; touch(x) } })
      if (ui.filter === 'list:' + old) ui.filter = null
      commit()
    },
    'import-json': () => importData('json'),
    'export-ics': () => H.exportFile('mon-orga-agenda.ics', 'text/calendar', S.toIcs(doc, now())).then(ok => { if (ok) snack(T('exportedIcs')) }),
    'import-ics': () => importData('ics'),
    'copy-all': () => H.copy(asText()).then(ok => snack(T(ok ? 'copiedAll' : 'copyFailed'))),
    'copy-text': el => H.copy(el.dataset.v).then(ok => snack(T(ok ? 'copied' : 'copyFailed'))),
    'sync-toggle': el => H.syncSet(el.checked).then(() => fillPlusAsync()),
    'sync-scan': async el => {
      el.disabled = true; const found = $('#found'); found.innerHTML = '<span class="hint">' + esc(T('searching')) + '</span>'
      const list = await H.syncScan(); el.disabled = false
      found.innerHTML = list.length ? list.map(p => `<button class="chip" data-act="sync-pick" data-v="${esc(p.address)}">${icon('phone')}${esc(p.name || p.address)}</button>`).join('') : '<span class="warn">' + esc(T('notFound')) + '</span>'
    },
    'sync-pick': el => { $('#syncAddr').value = el.dataset.v; $('#syncCode').focus() },
    'sync-connect': async () => {
      const r = await H.syncConnect($('#syncAddr').value.trim(), $('#syncCode').value.trim())
      if (r && r.ok) { snack(T('connected')); await refresh() } else snack(T((r && r.error) || 'connectFailed'))
      fillPlusAsync()
    },
    'sync-now': async () => { const r = await H.syncNow(); snack(T(r && r.ok ? 'synced' : 'syncFailed')); await refresh(); fillPlusAsync() },
    'sync-forget': () => H.syncForget().then(fillPlusAsync),
    welcome: welcome,
    // dialogs and snackbar
    dlg: el => dialogDone && dialogDone(el.dataset.v),
    snack: el => { const a = snackActions[+el.dataset.i]; $('#snack').classList.remove('show'); if (a) a.run() },
  }
  function run(name, el, id) { const f = ACTS[name]; if (f) f(el || document.body, id) }
  let press = null; let swallow = false // long press on a task row; the click its release makes is not a tap
  function onClick(e) {
    if (swallow) { swallow = false; e.preventDefault(); return }
    const el = e.target.closest('[data-act]'); if (!el) return
    if (el.tagName === 'A') e.preventDefault()
    if (el.tagName === 'INPUT' && el.type === 'checkbox' && el.dataset.act !== 'sync-toggle') return
    const row = el.closest('[data-id]')
    run(el.dataset.act, el, row ? row.dataset.id : null)
  }
  function onSettingInput(e) {
    const el = e.target; const k = el.dataset && el.dataset.set; if (!k) return
    setSetting(k, el.type === 'checkbox' ? el.checked : JSON.parse(el.value))
  }
  function onKey(e) {
    const dlg = $('#dialog')
    if (e.key === 'Escape') {
      if (dlg && !dlg.hidden) { e.preventDefault(); return dialogDone && dialogDone('') }
      if (ui.sheet) { e.preventDefault(); return closeSheet() }
      if (ui.searchOpen) { e.preventDefault(); return closeSearch() }
      return
    }
    if (e.target && e.target.dataset && e.target.dataset.f === 'newStep' && e.key === 'Enter') {
      e.preventDefault(); const v = e.target.value.trim(); if (!v) return
      return addSteps(v.split(/\s*;\s*/))
    }
    if (e.target && e.target.id === 'askInput' && e.key === 'Enter') { e.preventDefault(); return dialogDone && dialogDone('1') }
    const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key === 'Enter' && ui.sheet && (!dlg || dlg.hidden)) { e.preventDefault(); return closeSheet() }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch() }
    else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); quickNew() }
    else if (!typing && e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); switchTab(TABS[+e.key - 1][0]) }
    else if (!typing && !mod && e.key === '/') { e.preventDefault(); openSearch() }
    else if (!typing && !mod && !e.altKey && !ui.sheet && (!dlg || dlg.hidden) && rowKeys(e)) e.preventDefault()
  }

  function addSteps(list) {
    const t = S.find(doc, ui.sheet.id); const more = list.map(bullet).filter(Boolean)
    if (!more.length) return
    t.steps = t.steps.concat(more.map(x => ({ text: x, done: false }))); put(t); renderSheet()
    const ni = $('.step-new'); if (ni) ni.focus()
  }
  // Up and down move from row to row, X ticks the task in focus (a keyboard on a tablet or a PC).
  function rowKeys(e) {
    const rows = $$('#main .row .body'); if (!rows.length) return false
    const cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.row') : null
    const i = cur ? rows.indexOf($('.body', cur)) : -1
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]; next.focus(); next.scrollIntoView({ block: 'nearest' }); return true }
    if ((e.key === 'x' || e.key === 'X') && cur && cur.classList.contains('task')) { toggleTask(cur.dataset.id); return true }
    if ((e.key === 'm' || e.key === 'M') && cur && cur.classList.contains('task')) { quickMenu(cur.dataset.id); return true }
    return false
  }

  // ---------- start ----------
  function applySettings() {
    lang = set.lang === 'auto' ? (/^fr/i.test(navigator.language || 'fr') ? 'fr' : 'en') : set.lang
    const dark = set.theme === 'dark' || (set.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    const root = document.documentElement
    root.dataset.theme = dark ? 'dark' : 'light'
    root.style.setProperty('--scale', set.text)
    document.body.classList.toggle('lefty', !!set.lefty)
    document.body.classList.toggle('calm', !!set.calm)
    document.body.classList.toggle('wide-ok', true)
    const meta = $('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#141218' : '#fef7ff'
    if (H.theme) H.theme(dark) // status and navigation bars follow the theme shown, not only the phone's
    const dyn = set.colors === 'phone' && H.info && H.info.dynamic // Material You: the wallpaper's colours
    const vars = { '--primary': dyn && (dark ? dyn.primaryDark : dyn.primary), '--primary-container': dyn && (dark ? dyn.containerDark : dyn.container), '--on-primary-container': dyn && (dark ? dyn.onContainerDark : dyn.onContainer) }
    Object.keys(vars).forEach(k => { if (vars[k]) root.style.setProperty(k, vars[k]); else root.style.removeProperty(k) })
  }
  async function warnIfBlocked() {
    if (!H.diagnostics) return
    const bad = (await H.diagnostics()).filter(d => !d.ok)
    if (bad.length) snack(T('loudBlocked', bad.map(d => T('diag_' + d.key)).join(', ')), [{ label: T('fixIt'), run: () => { closeSheet(); switchTab('plus') } }], 9000)
  }
  async function checkNotifications() {
    if (!H.diagnostics) return
    const hasReminders = S.live(doc.tasks).some(t => !t.done && t.due && t.remind.length) || S.live(doc.events).some(e => e.remind.length)
    const list = await H.diagnostics()
    const off = hasReminders && list.some(d => d.key === 'notifications' && !d.ok)
    if (off !== !!ui.notifOff) { ui.notifOff = off; if (ui.tab === 'tasks') renderMain() }
  }
  async function refresh() {
    let fresh
    try { fresh = S.normalize(await H.load()) } catch (e) { return }
    const merged = S.merge(doc, fresh)
    if (JSON.stringify(merged) === JSON.stringify(doc)) { if (ui.tab === 'plus') fillPlusAsync(); return }
    doc = merged; render(); refreshSheet()
  }
  function tick() {
    if (set.focus) { renderFocus(); if (set.focus.until < now() - 3600000) { set.focus = null; saveSettings() } }
    const a = document.activeElement
    if (ui.tab !== 'plus' && !(a && $('#main').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) { renderTop(); renderMain() }
  }
  async function boot() {
    try { set = Object.assign({}, DEFAULTS, await H.loadSettings()) } catch (e) { /* defaults */ }
    const seen = set.welcomed ? set.news || 0 : -1 // the "what's new" already shown (-1: data from version 4)
    if (seen >= 0 && seen < 52 && !set.before511) { // from 5.0 or 5.1: the old defaults become the new ones ("what's new" says so and can put them back)
      const before = { remindEvent: set.remindEvent, nag: set.nag, summary: set.summary }
      if (String(set.remindEvent) === '15') set.remindEvent = DEFAULTS.remindEvent.slice()
      if (set.nag === 0) set.nag = DEFAULTS.nag
      if (set.summary === null) set.summary = DEFAULTS.summary
      if (set.remindEvent !== before.remindEvent || set.nag !== before.nag || set.summary !== before.summary) { set.before511 = before; saveSettings() } // saved now: the app may first open on a widget action
    }
    applySettings()
    renderShell()
    try { doc = S.normalize(await H.load()) } catch (e) { console.error(e) }
    render(); renderAddBar()
    // Listeners live on the document: the page is rebuilt when the language changes.
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    document.addEventListener('submit', e => { if (e.target.id === 'addBar') { e.preventDefault(); submitAdd() } })
    const onEdit = e => {
      const el = e.target
      if (el.id === 'search') { if (e.type === 'input') { ui.query = el.value; renderMain() } }
      else if (el.id === 'photoInput' || el.id === 'cameraInput') { if (e.type === 'change') onPhoto(e) }
      else if (el.id === 'addDate') { if (e.type === 'change' && el.value) { ui.draft.due = el.value; renderHint(); const i = $('#addInput'); if (i) i.focus() } }
      else if (el.closest && el.closest('#sheet')) onField(e)
      else if (el.dataset && el.dataset.set && e.type === 'change') onSettingInput(e)
    }
    document.addEventListener('input', onEdit)
    document.addEventListener('change', onEdit)
    document.addEventListener('paste', e => { // a list pasted in "Add a step": one step per line
      const el = e.target; if (!el.dataset || el.dataset.f !== 'newStep' || !ui.sheet) return
      const text = (e.clipboardData || window.clipboardData).getData('text')
      if (/\n/.test(text.trim())) { e.preventDefault(); addSteps(text.split(/\r?\n/)) }
    })
    const rowOf = e => { const b = e.target.closest && e.target.closest('.row.task .body'); return b ? b.closest('[data-id]').dataset.id : null }
    document.addEventListener('pointerdown', e => {
      swallow = false
      const id = rowOf(e); if (!id || e.button > 0) return
      press = { id: id, x: e.clientX, y: e.clientY, fired: false }
      press.timer = setTimeout(() => { if (press && press.id === id) { press.fired = true; if (H.haptic) H.haptic(); quickMenu(id) } }, 550)
    })
    const unpress = e => {
      if (!press) return
      if (press.fired) { if (e.type === 'pointerup') swallow = true; if (e.type !== 'pointermove') press = null; return }
      if (e.type !== 'pointermove' || Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) > 12) { clearTimeout(press.timer); press = null }
    }
    ;['pointerup', 'pointercancel', 'pointermove'].forEach(t => document.addEventListener(t, unpress))
    document.addEventListener('contextmenu', e => { const id = rowOf(e); if (!id) return; e.preventDefault(); if (!(press && press.fired)) quickMenu(id) })
    let swipe = null // a swipe on the calendar changes the month (or the week)
    document.addEventListener('touchstart', e => { swipe = e.target.closest && e.target.closest('.cal') && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null }, { passive: true })
    document.addEventListener('touchend', e => {
      if (!swipe) return; const t = e.changedTouches[0]; const dx = t.clientX - swipe.x; const dy = t.clientY - swipe.y; swipe = null
      if (Math.abs(dx) > 60 && Math.abs(dy) < 50) run(dx < 0 ? 'cal-next' : 'cal-prev')
    }, { passive: true })
    H.onChange(refresh)
    if (window.matchMedia) { const mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', () => { applySettings() }) }
    setInterval(() => { if (set.focus) renderFocus() }, 1000)
    setInterval(tick, 30000)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); tick(); checkNotifications() } })
    checkNotifications()
    const start = H.startAction && H.startAction()
    if (start) action(start)
    else if (!set.welcomed && !S.live(doc.tasks).length && !S.live(doc.notes).length) welcome()
    else if (seen < NEWS) whatsNew(seen)
    if (H.backupInfo) H.backupInfo().then(b => { ui.autoBackup = !!(b && b.folder); if (ui.autoBackup && ui.tab === 'tasks') renderMain() })
  }
  // What changed since the version they had; their planned events can take the new reminders too.
  function whatsNew(seen) {
    const before = set.before511 // the reminder settings the new defaults replaced (they may have been chosen on purpose)
    set.welcomed = true; set.news = NEWS; set.before511 = null; saveSettings()
    const items = (seen < 0 ? T('whatsNew').split('|') : []).concat(seen < 51 ? T('whatsNew51').split('|') : [], T('whatsNew511').split('|'))
    const old = S.live(doc.events).filter(e => String(e.remind) === '15' && (e.repeat || e.day >= S.today(now())))
    const opts = []
    if (old.length && String(set.remindEvent) === String(DEFAULTS.remindEvent)) opts.push({ label: plural(old.length, 'newRemindOne', 'newRemindMany'), value: 2, menu: true, icon: 'calendar' })
    if (before) opts.push({ label: T('keepOldReminders'), value: 3, menu: true, icon: 'undo' })
    opts.push({ label: T('letsGo'), value: 1 })
    choose(T('whatsNewTitle511'), '', opts, `<ul class="tips">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`).then(v => {
      if (v === 3) { Object.assign(set, before); saveSettings(); snack(T('oldRemindersKept')) }
      if (v !== 2) return
      const setAll = r => { old.forEach(o => { const e = S.find(doc, o.id); if (e) { e.remind = r.slice(); touch(e) } }); commit() } // by id: a sync may have replaced the objects
      setAll(set.remindEvent)
      snack(plural(old.length, 'newRemindDoneOne', 'newRemindDoneMany'), [{ label: T('undo'), run: () => setAll([15]) }], undoMs())
    })
  }
  window.app = {
    back: () => {
      const dlg = $('#dialog')
      if (dlg && !dlg.hidden) { dialogDone && dialogDone(''); return true }
      if (ui.sheet) { closeSheet(); return true }
      if (ui.searchOpen) { closeSearch(); return true }
      if (ui.tab !== 'tasks') { switchTab('tasks'); return true }
      return false
    },
    refresh: refresh, action: action, flush: flush,
    themeChanged: applySettings,
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot()
})()
