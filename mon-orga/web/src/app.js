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
    remindTask: [0], remindEvent: [15], remindAllDay: [0],
    snooze: 10, nag: 0, nagTimes: 3, summary: null, loudImportant: false, privateNotifs: false, lock: false,
    tray: true, login: false, focus: null, welcomed: false,
  }
  let doc = S.empty()
  let set = Object.assign({}, DEFAULTS)
  const ui = {
    tab: 'tasks', query: '', searchOpen: false, filter: null, showDone: false,
    day: S.today(now()), month: S.today(now()).slice(0, 8) + '01', agendaMode: 'month',
    sheet: null, noteRead: false, draft: { due: null, repeat: null, important: false, raw: false },
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
    return T('rep_' + k, n)
  }
  function remindLabel(m, allDay) {
    if (allDay) {
      if (m === 0) return T('remDayOf')
      if (m === 1440) return T('remEve')
    }
    if (m === 0) return T('remOnTime')
    if (m % 10080 === 0) return T('remWeeks', m / 10080)
    if (m % 1440 === 0) return m === 1440 ? T('remDayBefore') : T('remDays', m / 1440)
    if (m % 60 === 0) return T('remHours', m / 60)
    return T('remMin', m)
  }
  const REMIND_TIMED = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080]
  const REMIND_ALLDAY = [0, 1440, 2880, 10080]

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
    }).catch(e => { console.error(e); snack(T('saveError')) })
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

  function lists() {
    const seen = {}
    S.live(doc.tasks).concat(S.live(doc.notes), S.live(doc.events)).forEach(x => { if (x.list) seen[x.list] = (seen[x.list] || 0) + 1 })
    return Object.keys(seen).sort((a, b) => seen[b] - seen[a] || a.localeCompare(b))
  }
  function allTags() {
    const seen = {}
    S.live(doc.notes).concat(S.live(doc.tasks)).forEach(x => S.tags(x.text + ' ' + (x.details || '')).forEach(t => { seen[t] = 1 }))
    return Object.keys(seen).sort()
  }
  function passes(x) {
    const f = ui.filter; if (!f) return true
    if (f === 'important') return !!x.important
    if (f.indexOf('list:') === 0) return x.list === f.slice(5)
    if (f.indexOf('tag:') === 0) return S.tags(x.text + ' ' + (x.details || '')).indexOf(f.slice(4)) >= 0
    return true
  }
  // History entries are "time:taskId": ticking, unticking and ticking again the same day counts once.
  function doneDays() {
    const seen = {}; const out = {}
    doc.history.forEach(h => {
      const s = String(h); const t = parseInt(s, 10); const day = S.today(t); const key = day + '|' + (s.split(':')[1] || s)
      if (!seen[key]) { seen[key] = 1; out[day] = (out[day] || 0) + 1 }
    })
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
    return { count, streak, week, today: days[td] || 0, last7, level: S.level(count) }
  }

  // ---------- task actions ----------
  function toggleTask(id) {
    const t = S.find(doc, id); if (!t) return
    const before = clone(t); const was = stats()
    if (t.done) {
      put(Object.assign(t, { done: false, doneAt: null }))
      return snack(T('reopened'))
    }
    const c = S.complete(t, now())
    doc.history.push(now() + ':' + t.id)
    put(Object.assign(t, c))
    if (H.haptic) H.haptic()
    const after = stats()
    let msg = c.done ? T('doneMsg') : T('doneNext', fmtDue(c))
    if (!set.sober) {
      if (after.level.level > was.level.level) msg = T('levelUp', after.level.level)
      else if (after.streak > was.streak && [3, 7, 14, 30, 50, 100, 365].indexOf(after.streak) >= 0) msg = T('streakUp', after.streak)
      else if (c.done) { const cheers = T('cheers').split('|'); msg = cheers[Math.floor(Math.random() * cheers.length)] }
    }
    snack(msg, [{ label: T('undo'), run: () => put(Object.assign(S.find(doc, id), before)) }])
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
    if (v === 'tonight') return td + 'T19:00'
    if (v === 'tomorrow') return S.addDays(td, 1) + 'T09:00'
    if (v === 'monday') return S.addDays(td, 8 - S.weekday(td)) + 'T09:00'
    if (v === 'weekend') return S.addDays(td, ((6 - S.weekday(td) + 7) % 7) || 7) + 'T10:00'
    if (v === 'in1h') { n.setMinutes(Math.ceil((n.getMinutes() + 60) / 5) * 5, 0, 0); return S.stamp(n) }
    if (v === 'in3h') { n.setMinutes(Math.ceil((n.getMinutes() + 180) / 5) * 5, 0, 0); return S.stamp(n) }
    return null
  }
  function presets() {
    const h = new Date().getHours()
    return (h < 18 ? ['in1h', 'tonight'] : ['in1h']).concat(['tomorrow', 'monday', 'weekend'])
  }
  function setDue(t, due) {
    const had = !!t.due
    t.due = due
    if (due && !had && !t.remind.length) t.remind = defaultRemind(due)
    if (due && t.remind.length) askNotifications()
  }
  let asked = false
  function askNotifications() { if (!asked && H.notifyPermission) { asked = true; H.notifyPermission() } }

  function addTasks(raw) {
    const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean)
    if (!lines.length) return
    const created = lines.map(line => {
      const p = ui.draft.raw ? { text: line, due: null, repeat: null } : S.parse(line, now())
      const t = newTask({ text: p.text, repeat: ui.draft.repeat || p.repeat, important: ui.draft.important,
        list: ui.filter && ui.filter.indexOf('list:') === 0 ? ui.filter.slice(5) : '' })
      setDue(t, ui.draft.due || p.due)
      if (t.important && set.loudImportant) t.loud = true
      return t
    })
    created.reverse().forEach(t => doc.tasks.unshift(touch(t)))
    commit()
    ui.draft = { due: null, repeat: null, important: false, raw: false }
    renderAddBar()
    const t = created[0]
    if (created.length > 1) snack(T('addedN', created.length), [{ label: T('undo'), run: () => created.forEach(c => put(Object.assign(S.find(doc, c.id), { deleted: true }))) }])
    else if (!t.due) {
      snack(T('addedAsk'), presets().slice(0, 3).map(v => ({ label: T('pre_' + v), run: () => { const x = S.find(doc, t.id); setDue(x, dueFromPreset(v)); put(x); snack(T('remindAt', fmtDue(x))) } })), 8000)
    } else snack(T('addedFor', fmtDue(t)) + (t.remind.length ? ' 🔔' : ''), [{ label: T('edit'), run: () => openSheet(t.id) }])
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
      <input id="photoInput" type="file" accept="image/*" hidden>`
  }
  function render() {
    if (!$('#app')) return
    document.documentElement.lang = lang
    $$('#nav button').forEach(b => { const on = b.dataset.tab === ui.tab; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current') })
    renderTop(); renderMain(); renderFocus()
    const addHere = ui.tab === 'tasks' || ui.tab === 'notes'
    $('#addBar').hidden = !addHere
    if (addHere && $('#addBar').dataset.tab !== ui.tab) renderAddBar()
    const fab = $('#fab'); fab.hidden = ui.tab !== 'agenda'
    fab.innerHTML = icon('add') + '<span>' + esc(T('newEvent')) + '</span>'
  }
  function renderTop() {
    $('#title').textContent = T('tab_' + ui.tab)
    let sub = ''
    if (ui.tab === 'tasks') {
      const live = S.live(doc.tasks).filter(t => !t.done); const n = now()
      const late = live.filter(t => S.sectionOf(t, n) === 'late').length
      const td = live.filter(t => S.sectionOf(t, n) === 'today').length
      const st = stats()
      const parts = [cap(fmt({ weekday: 'long', day: 'numeric', month: 'long' }, new Date()))]
      if (td) parts.push(plural(td, 'todayOne', 'todayMany'))
      if (late) parts.push('<b class="late">' + esc(plural(late, 'lateOne', 'lateMany')) + '</b>')
      if (st.streak > 1) parts.push(esc(T('streakShort', st.streak)))
      sub = parts.map((p, i) => i ? p : esc(p)).join(' · ')
    } else if (ui.tab === 'notes') sub = esc(plural(S.live(doc.notes).length, 'notesOne', 'notesMany'))
    else if (ui.tab === 'agenda') sub = esc(cap(fmt({ weekday: 'long', day: 'numeric', month: 'long' }, new Date())))
    else sub = esc(T('plusSub'))
    $('#subtitle').innerHTML = sub
    let actions = ''
    if (ui.tab !== 'plus') actions += `<button class="icon-btn" data-act="search-open" aria-label="${esc(T('search'))}" title="${esc(T('search'))}">${icon('search')}</button>`
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
    const chip = (v, label, extra) => `<button class="chip ${ui.filter === v ? 'on' : ''}" data-act="filter" data-v="${esc(v || '')}" aria-pressed="${ui.filter === v}">${extra || ''}${esc(label)}</button>`
    el.hidden = false
    el.innerHTML = chip(null, T('all')) + (hasImp ? chip('important', T('importantF'), icon('star')) : '') +
      ls.map(l => chip('list:' + l, l, '<i class="dot" style="--h:' + hue(l.toLowerCase()) + '"></i>')).join('') +
      tg.map(t => chip('tag:' + t, '#' + t)).join('')
  }
  function renderMain() {
    const main = $('#main'); if (!main) return
    const top = main.scrollTop
    main.className = 'tab-' + ui.tab
    main.innerHTML = ui.query.trim() ? searchView() : ui.tab === 'tasks' ? tasksView() : ui.tab === 'notes' ? notesView() : ui.tab === 'agenda' ? agendaView() : plusView()
    main.scrollTop = top
    if (ui.tab === 'plus' && !ui.query.trim()) fillPlusAsync()
  }

  // ---------- tasks ----------
  function taskRow(t, opts) {
    const n = now(); const sec = S.sectionOf(t, n)
    const meta = []
    if (t.due) meta.push(`<span class="m ${sec === 'late' ? 'late' : ''}">${icon('clock')}${esc(fmtDue(t, true))}</span>`)
    if (t.repeat) meta.push(`<span class="m">${icon('repeat')}${esc(repeatLabel(t.repeat))}</span>`)
    if (t.due && t.remind.length && !t.done) meta.push(`<span class="m" title="${esc(t.remind.map(m => remindLabel(m, t.due.length === 10)).join(', '))}">${icon(t.loud ? 'alarm' : 'bell')}</span>`)
    if (t.steps.length) meta.push(`<span class="m">${icon('boxed')}${t.steps.filter(s => s.done).length}/${t.steps.length}</span>`)
    if (t.details) meta.push(`<span class="m">${icon('note')}</span>`)
    if (t.list && !(ui.filter === 'list:' + t.list)) meta.push(listChip(t.list))
    const late = sec === 'late' && !(opts && opts.noPostpone)
    return `<li class="row task ${t.done ? 'done' : ''} ${t.important ? 'imp' : ''}" data-id="${t.id}">
      <button class="check" data-act="toggle" role="checkbox" aria-checked="${t.done}" aria-label="${esc(T(t.done ? 'markUndone' : 'markDone', t.text))}">${icon(t.done ? 'checked' : 'circle')}</button>
      <button class="body" data-act="open"><span class="title">${esc(t.text)}</span>${meta.length ? `<span class="meta">${meta.join('')}</span>` : ''}</button>
      ${late ? `<button class="mini" data-act="postpone" aria-label="${esc(T('toTomorrowFull', t.text))}">${icon('forward')}${esc(T('toTomorrow'))}</button>` : ''}
      <button class="icon-btn star" data-act="star" aria-pressed="${t.important}" aria-label="${esc(T('important'))}" title="${esc(T('important'))}">${icon(t.important ? 'star' : 'star_border')}</button>
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
    const tasks = S.sortTasks(doc.tasks, n).filter(passes)
    const groups = {}; S.SECTIONS.forEach(s => { groups[s] = [] })
    tasks.forEach(t => groups[S.sectionOf(t, n)].push(t))
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
    return top + html + '<div class="spacer"></div>'
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
      <span class="meta">${boxes.length ? `<span class="m">${icon('boxed')}${ticked}/${boxes.length}</span>` : ''}${n.list ? listChip(n.list) : ''}<span class="m soft">${esc(date)}</span></span>
    </button></li>`
  }
  function notesView() {
    const notes = S.live(doc.notes).filter(passes).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt)
    if (!notes.length) return ui.filter ? `<p class="empty">${esc(T('nothingHere'))}</p>` : ''
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
    else when = `<span class="when"><b>${esc(fmtTime(e.time))}</b>${e.end ? '<small>' + esc(fmtTime(e.end)) + '</small>' : ''}</span>`
    const meta = []
    if (e.place) meta.push(`<span class="m">${icon('place')}${esc(e.place)}</span>`)
    if (multi) meta.push(`<span class="m">${esc(T('untilDay', fmtDay(S.addDays(start, S.eventSpan(e)))))}</span>`)
    if (e.repeat) meta.push(`<span class="m">${icon('repeat')}${esc(repeatLabel(e.repeat))}</span>`)
    if (e.remind.length) meta.push(`<span class="m">${icon(e.loud ? 'alarm' : 'bell')}</span>`)
    if (e.list) meta.push(listChip(e.list))
    return `<li class="row event" data-id="${e.id}" data-day="${day}"${e.list ? ` style="--h:${hue(e.list.toLowerCase())}"` : ''}>${when}
      <button class="body" data-act="open"><span class="title">${esc(e.text)}</span>${meta.length ? `<span class="meta">${meta.join('')}</span>` : ''}</button></li>`
  }
  function dayItems(day) {
    const evs = S.eventsOn(doc.events, day).filter(passes)
    const n = now()
    const tasks = S.sortTasks(doc.tasks, n).filter(t => t.due && S.dayOf(t.due) === day && passes(t))
    return { evs, tasks }
  }
  function agendaView() {
    const month = ui.month; const first = S.parseDay(month)
    const offset = (S.weekday(month) - set.weekStart + 7) % 7
    const td = S.today(now())
    let start = S.addDays(month, -offset)
    let weeks = 6
    if (ui.agendaMode === 'week') { start = S.addDays(ui.day, -((S.weekday(ui.day) - set.weekStart + 7) % 7)); weeks = 1 }
    const names = []; for (let i = 0; i < 7; i++) names.push(fmt({ weekday: 'narrow' }, S.parseDay(S.addDays(start, i))))
    let cells = ''
    for (let i = 0; i < weeks * 7; i++) {
      const d = S.addDays(start, i); const it = dayItems(d)
      const out = d.slice(0, 7) !== month.slice(0, 7) && ui.agendaMode !== 'week'
      const dots = it.evs.slice(0, 3).map(e => `<i${e.list ? ` style="--h:${hue(e.list.toLowerCase())}"` : ''}></i>`).join('') + (it.tasks.filter(t => !t.done).length ? '<i class="t"></i>' : '')
      const label = fmtDay(d, true) + (it.evs.length + it.tasks.length ? ', ' + plural(it.evs.length + it.tasks.length, 'itemsOne', 'itemsMany') : '')
      cells += `<button class="day ${out ? 'out' : ''} ${d === td ? 'today' : ''} ${d === ui.day ? 'sel' : ''}" data-act="cal-day" data-day="${d}" aria-label="${esc(label)}" aria-pressed="${d === ui.day}"><span>${+d.slice(8)}</span><span class="dots">${dots}</span></button>`
    }
    const sel = dayItems(ui.day)
    let html = `<section class="cal card">
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
    </section>
    <h2 class="sec">${esc(fmtDay(ui.day, true))}<button class="text-btn" data-act="fab">${icon('add')}${esc(T('add'))}</button></h2>`
    if (sel.evs.length || sel.tasks.length) html += `<ul class="list">${sel.evs.map(e => eventRow(e, ui.day)).join('')}${sel.tasks.map(t => taskRow(t, { noPostpone: true })).join('')}</ul>`
    else html += `<p class="empty small">${esc(T('freeDay'))}</p>`
    let upcoming = ''
    for (let i = 1; i <= 14; i++) {
      const d = S.addDays(ui.day, i); const it = dayItems(d)
      const tasks = it.tasks.filter(t => !t.done)
      if (!it.evs.length && !tasks.length) continue
      upcoming += `<h3 class="subsec">${esc(fmtDay(d, true))}</h3><ul class="list">${it.evs.map(e => eventRow(e, d)).join('')}${tasks.map(t => taskRow(t, { noPostpone: true })).join('')}</ul>`
    }
    if (upcoming) html += `<h2 class="sec">${esc(T('upcoming'))}</h2>` + upcoming
    return html + '<div class="spacer"></div>'
  }

  // ---------- search ----------
  function searchView() {
    const q = ui.query.trim()
    const tasks = S.sortTasks(doc.tasks, now()).filter(t => S.matches(q, [t.text, t.details, t.list].concat(t.steps.map(s => s.text))))
    const notes = S.live(doc.notes).filter(n => S.matches(q, [n.text, n.list])).sort((a, b) => b.updatedAt - a.updatedAt)
    const evs = S.live(doc.events).filter(e => S.matches(q, [e.text, e.place, e.details, e.list])).sort((a, b) => a.day < b.day ? 1 : -1)
    if (!tasks.length && !notes.length && !evs.length) return `<p class="empty">${esc(T('noResult', q))}</p>`
    return (tasks.length ? `<h2 class="sec">${esc(T('tab_tasks'))} <span class="count">${tasks.length}</span></h2><ul class="list">${tasks.slice(0, 100).map(t => taskRow(t)).join('')}</ul>` : '') +
      (notes.length ? `<h2 class="sec">${esc(T('tab_notes'))} <span class="count">${notes.length}</span></h2><ul class="grid">${notes.slice(0, 100).map(noteCard).join('')}</ul>` : '') +
      (evs.length ? `<h2 class="sec">${esc(T('tab_agenda'))} <span class="count">${evs.length}</span></h2><ul class="list">${evs.slice(0, 100).map(e => eventRow(e, S.nextDay(e.day, e.repeat, S.today(now()), e.until, e.skip) || e.day)).join('')}</ul>` : '') + '<div class="spacer"></div>'
  }

  // ---------- add bar ----------
  function renderAddBar() {
    const bar = $('#addBar'); bar.dataset.tab = ui.tab
    const notes = ui.tab === 'notes'
    bar.innerHTML = `
      <div class="add-row">
        ${H.can.voice ? `<button type="button" class="icon-btn" data-act="mic" aria-label="${esc(T('dictate'))}" title="${esc(T('dictate'))}">${icon('mic')}</button>` : ''}
        <textarea id="addInput" rows="1" enterkeyhint="send" aria-label="${esc(T(notes ? 'newNote' : 'newTask'))}" placeholder="${esc(T(notes ? 'notePlaceholder' : 'taskPlaceholder'))}"></textarea>
        ${notes ? `<button type="button" class="icon-btn" data-act="note-full" aria-label="${esc(T('fullNote'))}" title="${esc(T('fullNote'))}">${icon('edit')}</button>` : ''}
        <button type="submit" class="send" aria-label="${esc(T('add'))}">${icon(notes ? 'add' : 'send')}</button>
      </div>
      <div id="addHint" class="add-hint" hidden></div>`
    const input = $('#addInput')
    input.addEventListener('input', () => { autoGrow(input); renderHint() })
    input.addEventListener('focus', renderHint)
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitAdd() } })
  }
  function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px' }
  function renderHint() {
    const hint = $('#addHint'); const input = $('#addInput'); if (!hint || !input) return
    if (ui.tab !== 'tasks') { hint.hidden = true; return }
    const v = input.value.trim()
    if (!v) ui.draft.raw = false
    const p = v && !ui.draft.raw ? S.parse(v.split('\n')[0], now()) : { due: null, repeat: null }
    const due = ui.draft.due || p.due; const repeat = ui.draft.repeat || p.repeat
    const chips = []
    if (due || repeat) {
      chips.push(`<span class="found">${due ? icon('clock') + esc(fmtDue({ due: due }, true)) : ''}${repeat ? ' ' + icon('repeat') + esc(repeatLabel(repeat)) : ''}
        ${p.due || p.repeat ? `<button type="button" class="icon-btn tiny" data-act="add-raw" aria-label="${esc(T('ignoreDate'))}" title="${esc(T('ignoreDate'))}">${icon('close')}</button>` : ''}</span>`)
    }
    const pre = ['today'].concat(presets()).map(v => `<button type="button" class="chip ${ui.draft.due === dueFromPreset(v) && ui.draft.due ? 'on' : ''}" data-act="add-preset" data-v="${v}">${esc(T('pre_' + v))}</button>`)
    pre.push(`<button type="button" class="chip ${ui.draft.important ? 'on' : ''}" data-act="add-imp" aria-pressed="${ui.draft.important}">${icon('star')}${esc(T('important'))}</button>`)
    hint.innerHTML = chips.join('') + `<div class="chips scroll">${pre.join('')}</div>`
    hint.hidden = document.activeElement !== input && !v
  }
  function submitAdd() {
    const input = $('#addInput'); if (!input) return
    const v = input.value
    if (!v.trim()) { input.focus(); return }
    if (ui.tab === 'notes') { const n = addNote(v); snack(T('noteAdded'), [{ label: T('open'), run: () => openSheet(n.id) }]) } else addTasks(v)
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
    ui.sheet = null
    $('#sheet').hidden = true; $('#sheet').innerHTML = ''; document.body.classList.remove('sheet-open')
    commit()
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
    return `<div class="sheet-bar">${act('close', 'back', T('back'))}<h2>${esc(title)}</h2><div class="grow"></div>${actions}</div>`
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
    const k = r.split(':')[0]; const n = +(r.split(':')[1]) || 2
    if (k === 'weekly' && r.indexOf(':') > 0) return { kind: 'pick', n: 2, days: S.repeatDays(r) }
    return { kind: k === 'days' ? 'ndays' : k, n: n, days: [] }
  }
  function repeatCode(kind, n, days) {
    n = Math.max(1, Math.min(99, +n || 2))
    if (!kind) return null
    if (kind === 'pick') return 'weekly:' + (days.length ? days : [1]).slice().sort().join(',')
    if (kind === 'weeks') return 'weeks:' + n
    if (kind === 'ndays') return 'days:' + n
    if (kind === 'hours') return 'hours:' + n
    return kind
  }
  function repeatControls(item, isTask) {
    const p = repeatParts(item.repeat)
    const kinds = ['', 'daily', 'weekdays', 'weekly', 'pick', 'weeks', 'monthly', 'yearly', 'ndays'].concat(isTask ? ['hours'] : [])
    let html = `<select data-f="repeatKind" aria-label="${esc(T('repeat'))}">${kinds.map(k => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${esc(T('rk_' + (k || 'none')))}</option>`).join('')}</select>`
    if (p.kind === 'pick') {
      html += '<div class="weekdays">'
      for (let i = 0; i < 7; i++) {
        const d = ((set.weekStart - 1 + i) % 7) + 1; const on = p.days.indexOf(d) >= 0
        html += `<button class="wd-btn ${on ? 'on' : ''}" data-act="rep-day" data-v="${d}" aria-pressed="${on}" aria-label="${esc(fmt({ weekday: 'long' }, new Date(2024, 0, d)))}">${esc(fmt({ weekday: 'narrow' }, new Date(2024, 0, d)))}</button>`
      }
      html += '</div>'
    }
    if (['weeks', 'ndays', 'hours'].indexOf(p.kind) >= 0) html += `<label class="field inline"><span>${esc(T('every'))}</span><input type="number" min="1" max="99" inputmode="numeric" data-f="repeatN" value="${p.n}"><span>${esc(T('unit_' + p.kind))}</span></label>`
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
        <div class="chips wrap">${['today'].concat(presets()).map(v => `<button class="chip" data-act="due-preset" data-v="${v}">${esc(T('pre_' + v))}</button>`).join('')}
          ${t.due ? `<button class="chip" data-act="due-clear">${icon('close')}${esc(T('noDate'))}</button>` : ''}</div>
        <div class="fields">
          <label class="field"><span>${esc(T('date'))}</span><input type="date" data-f="dueDay" value="${t.due ? S.dayOf(t.due) : ''}"></label>
          <label class="field"><span>${esc(T('time'))}</span><input type="time" data-f="dueTime" value="${S.timeOf(t.due) || ''}"></label>
          ${S.timeOf(t.due) ? act('time-clear', 'close', T('noTime')) : ''}
        </div>
        ${t.due ? `<p class="hint ${S.sectionOf(t, now()) === 'late' ? 'late' : ''}">${esc(fmtDue(t, true))}${allDay ? ' · ' + esc(T('allDayTask')) : ''}</p>` : `<p class="hint">${esc(T('noDateHint'))}</p>`}
      </section>
      ${t.due ? `<section class="group"><h3>${icon('bell')}${esc(T('reminders'))}</h3>${remindChips(t, allDay)}</section>` : ''}
      <section class="group"><h3>${icon('repeat')}${esc(T('repeat'))}</h3>${repeatControls(t, true)}</section>
      <section class="group">
        <h3>${icon('boxed')}${esc(T('steps'))}${t.steps.length ? ` <span class="count">${done}/${t.steps.length}</span>` : ''}</h3>
        <ul class="steps">${t.steps.map((s, i) => `<li class="${s.done ? 'done' : ''}">
          <button class="check small" data-act="step-toggle" data-i="${i}" role="checkbox" aria-checked="${s.done}" aria-label="${esc(s.text)}">${icon(s.done ? 'boxed' : 'box')}</button>
          <input data-f="step" data-i="${i}" value="${esc(s.text)}" aria-label="${esc(T('step', i + 1))}">
          ${act('step-del', 'close', T('delete'), 'tiny" data-i="' + i)}</li>`).join('')}</ul>
        <input class="step-new" data-f="newStep" placeholder="${esc(T('addStep'))}" enterkeyhint="done" aria-label="${esc(T('addStep'))}">
      </section>
      <section class="group"><h3>${icon('label')}${esc(T('list'))}</h3>${listControls(t)}</section>
      <section class="group">
        <h3>${icon('note')}${esc(T('details'))}</h3>
        <textarea class="details" data-f="details" rows="3" placeholder="${esc(T('detailsHint'))}" aria-label="${esc(T('details'))}">${esc(t.details)}</textarea>
        ${linksBox(t.details, 'details')}
      </section>
      <div class="actions">
        ${!t.done ? `<button class="tonal" data-act="focus-start">${icon('timer')}${esc(T('focus25'))}</button><button class="tonal" data-act="postpone-cur">${icon('forward')}${esc(T('postpone1'))}</button>` : ''}
        <button class="filled" data-act="toggle-cur">${icon(t.done ? 'undo' : 'checked')}${esc(T(t.done ? 'reopen' : 'markDoneBtn'))}</button>
      </div>
      <p class="stamp">${stampText(t)}</p>
    </div>`
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
  const tagify = h => h.replace(/(^|\s)#([A-Za-zÀ-ÖØ-öø-ÿ0-9_-]{2,})/g, '$1<span class="tag">#$2</span>')
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
      ${read ? `<div class="note-read" data-act="note-mode">${renderNoteText(n.text) || '<p class="hint">' + esc(T('emptyNote')) + '</p>'}</div>`
        : `<textarea class="note-text" data-f="text" placeholder="${esc(T('noteHint'))}" aria-label="${esc(T('note'))}">${esc(n.text)}</textarea>`}
      ${n.images.length ? `<div class="photos">${n.images.map((src, i) => `<figure><img src="${esc(src)}" alt="${esc(T('photo'))} ${i + 1}" data-act="photo-view" data-i="${i}">${read ? '' : act('photo-del', 'close', T('delete'), 'tiny" data-i="' + i)}</figure>`).join('')}</div>` : ''}
      ${read ? '' : `<div class="toolbar">
        <button class="tonal small" data-act="note-box">${icon('boxed')}${esc(T('checkbox'))}</button>
        ${H.can.photos ? `<button class="tonal small" data-act="photo-add">${icon('photo')}${esc(T('photo'))}</button>` : ''}
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
      <div class="title-row"><textarea class="title-input" data-f="text" rows="1" placeholder="${esc(T('eventTitle'))}" aria-label="${esc(T('title'))}">${esc(e.text)}</textarea></div>
      <section class="group"><h3>${icon('calendar')}${esc(T('when'))}</h3>
        <div class="fields">
          <label class="field"><span>${esc(T(multi ? 'from' : 'date'))}</span><input type="date" data-f="day" value="${e.day}"></label>
          ${multi ? `<label class="field"><span>${esc(T('to'))}</span><input type="date" data-f="endDay" value="${e.endDay}" min="${e.day}"></label>` : ''}
        </div>
        <label class="switch-row"><span><b>${esc(T('allDay'))}</b></span><input type="checkbox" role="switch" data-f="allDay" ${allDay ? 'checked' : ''}></label>
        ${allDay ? '' : `<div class="fields">
          <label class="field"><span>${esc(T('start'))}</span><input type="time" data-f="time" value="${e.time}"></label>
          <label class="field"><span>${esc(T('end'))}</span><input type="time" data-f="end" value="${e.end || ''}"></label></div>`}
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
        ${linksBox(e.details, 'details')}
        <button class="tonal small" data-act="event-note">${icon('note')}${esc(hasNote ? T('openNote', noteTitle(linked) || T('untitled')) : T('linkNote'))}</button>
      </section>
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
    let again = false; let later = !change
    switch (f) {
      case 'text': item.text = el.value; if (el.classList.contains('title-input')) autoGrow(el); else if (el.classList.contains('note-text')) { autoGrow(el); updateLinks('text', el.value) } break
      case 'details': item.details = el.value; autoGrow(el); updateLinks('details', el.value); break
      case 'place': item.place = el.value; break
      case 'list': item.list = el.value.trim(); if (!change) break; again = true; break
      case 'step': item.steps[+el.dataset.i].text = el.value; break
      case 'newStep': return
      case 'dueDay': if (!change) return; setDue(item, el.value ? el.value + (S.timeOf(item.due) ? 'T' + S.timeOf(item.due) : '') : null); again = true; break
      case 'dueTime':
        if (!change || !el.value) return
        if (item.due && item.due.length === 10 && item.remind.join() === set.remindAllDay.join()) item.remind = set.remindTask.slice()
        setDue(item, (item.due ? S.dayOf(item.due) : S.today(now())) + 'T' + el.value); again = true; break
      case 'loud': item.loud = el.checked; break
      case 'repeatKind': {
        const p = repeatParts(item.repeat)
        const day = ui.sheet.kind === 'tasks' ? (item.due ? S.dayOf(item.due) : S.today(now())) : item.day
        item.repeat = repeatCode(el.value, p.n, p.days.length ? p.days : [S.weekday(day)])
        if (ui.sheet.kind === 'tasks' && item.repeat && !item.due) setDue(item, el.value === 'hours' ? dueFromPreset('in1h') : S.today(now()))
        if (!item.repeat) item.until = null
        again = true; later = false; break
      }
      case 'repeatN': { const p = repeatParts(item.repeat); if (!el.value) return; item.repeat = repeatCode(p.kind, el.value, p.days); break }
      case 'until': if (!change) return; item.until = el.value || null; break
      case 'day': {
        if (!change || !el.value) return
        const span = S.eventSpan(item); item.day = el.value; if (item.endDay) item.endDay = S.addDays(el.value, span)
        ui.day = el.value; ui.month = el.value.slice(0, 8) + '01'; again = true; break
      }
      case 'endDay': if (!change) return; item.endDay = el.value && el.value > item.day ? el.value : null; again = true; break
      case 'allDay': item.time = el.checked ? null : '09:00'; item.end = el.checked ? null : '10:00'; item.remind = (el.checked ? set.remindAllDay : set.remindEvent).slice(); again = true; break
      case 'multi': item.endDay = el.checked ? S.addDays(item.day, 1) : null; again = true; break
      case 'time': {
        if (!change || !el.value) return
        const length = item.end && item.time ? minutes(item.end) - minutes(item.time) : 60
        item.time = el.value; item.end = fromMinutes(minutes(el.value) + (length > 0 ? length : 60)); again = true; break
      }
      case 'end': if (!change) return; item.end = el.value || null; break
      default: return
    }
    put(item, later)
    if (again) renderSheet()
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
  function shareText(title, text) {
    if (H.share) H.share(title, text)
    else H.copy(text).then(ok => snack(T(ok ? 'copied' : 'copyFailed')))
  }
  function shrink(file) {
    return new Promise((res, rej) => {
      const img = new Image(); const url = URL.createObjectURL(file)
      img.onload = () => {
        const k = Math.min(1, 1280 / Math.max(img.width, img.height))
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url)
        res(c.toDataURL('image/jpeg', 0.72))
      }
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')) }
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
  const sw = (k, label, hint) => `<label class="switch-row"><span><b>${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span><input type="checkbox" role="switch" data-set="${k}" ${set[k] ? 'checked' : ''}></label>`
  const select = (k, opts) => `<select data-set="${k}" aria-label="${esc(k)}">${opts.map(o => `<option value="${esc(JSON.stringify(o[0]))}" ${JSON.stringify(set[k]) === JSON.stringify(o[0]) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`
  const setRow = (label, control) => `<div class="set-row"><span>${esc(label)}</span>${control}</div>`
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
        <div><b>${st.week}</b><span>${esc(T('thisWeek'))}</span></div>
        <div><b>${st.count}</b><span>${esc(T('total'))}</span></div>
      </div>
      <div class="level"><b>${esc(T('level', st.level.level))}</b><div class="bar" role="progressbar" aria-valuenow="${Math.round(st.level.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.round(st.level.progress * 100)}%"></i></div><small>${esc(plural(st.level.toNext, 'toNextOne', 'toNextMany'))}</small></div>
      ${st.count ? `<div class="week-chart" role="img" aria-label="${esc(T('last7', st.last7.map(x => x.n).join(', ')))}">${st.last7.map(x => `<div><b>${x.n || ''}</b><i style="height:${Math.round(x.n / max * 100)}%"></i><span>${esc(fmt({ weekday: 'narrow' }, S.parseDay(x.day)))}</span></div>`).join('')}</div>` : `<p class="hint">${esc(T('chartEmpty'))}</p>`}`)
    html += card('pc', T('pcTitle'), '<div id="syncBox"><p class="hint">…</p></div>', 'sync')
    const times = [[null, T('off')], ['07:00', '7:00'], ['07:30', '7:30'], ['08:00', '8:00'], ['08:30', '8:30'], ['09:00', '9:00']]
    html += card('bell', T('remTitle'), `
      ${setRow(T('summary'), select('summary', times))}<p class="hint">${esc(T('summaryHint'))}</p>
      ${setRow(T('snoozeLen'), select('snooze', [5, 10, 15, 30, 60].map(m => [m, T('remMin', m).replace(/\s*(avant|before)$/, '')])))}
      ${setRow(T('nag'), select('nag', [[0, T('never')]].concat([5, 10, 15, 30, 60].map(m => [m, T('nagEvery', m)]))))}
      ${set.nag ? setRow(T('nagTimes'), select('nagTimes', [3, 5, 10].map(n => [n, T('nTimes', n)]))) : ''}
      <h3>${esc(T('defaultTask'))}</h3>${remindDefaults('remindTask')}
      <h3>${esc(T('defaultAllDay'))}</h3>${remindDefaults('remindAllDay', true)}
      <h3>${esc(T('defaultEvent'))}</h3>${remindDefaults('remindEvent')}
      ${sw('loudImportant', T('loudImportant'), T('loudImportantHint'))}
      ${H.can.alarms ? `<div class="btns"><button class="tonal" data-act="test-alarm" data-v="0">${icon('bell')}${esc(T('testReminder'))}</button><button class="tonal" data-act="test-alarm" data-v="1">${icon('alarm')}${esc(T('testLoud'))}</button></div>` : ''}
      ${H.can.diagnostics ? '<div id="diag"></div>' : ''}`)
    html += card('download', T('backupTitle'), `<p class="hint">${esc(T('backupHint'))}</p>
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
      ${setRow(T('weekStart'), seg('weekStart', [[1, T('monday')], [7, T('sunday')]]))}
      ${sw('sober', T('sober'), T('soberHint'))}
      ${sw('calm', T('calm'), T('calmHint'))}
      ${sw('lefty', T('lefty'), T('leftyHint'))}`)
    if (H.can.lock) html += card('lock', T('privacyTitle'), sw('lock', T('lock'), T('lockHint')) + sw('privateNotifs', T('privateNotifs'), T('privateNotifsHint')) + `<p class="hint">${esc(T('privacyHint'))}</p>`)
    if (H.can.tray) html += card('pc', T('pcAppTitle'), sw('tray', T('tray'), T('trayHint')) + sw('login', T('login'), T('loginHint')))
    html += card('help', T('helpTitle'), `<ul class="tips">${T('tips').split('|').map(t => `<li>${esc(t)}</li>`).join('')}</ul>
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
          <button class="tonal small" data-act="copy-text" data-v="${esc(s.url)}">${icon('copy')}${esc(T('copyUrl'))}</button></div>` : `<p class="warn">${icon('warn')}${esc(T('pcNoWifi'))}</p>`) : ''}
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
    const diag = $('#diag')
    if (diag && H.diagnostics) {
      const list = await H.diagnostics()
      diag.innerHTML = `<h3>${esc(T('diagTitle'))}</h3>` + list.map(d => `<div class="diag ${d.ok ? 'ok' : 'bad'}">${icon(d.ok ? 'checked' : 'warn')}<span><b>${esc(T('diag_' + d.key))}</b><small>${esc(T(d.ok ? 'diagOk' : 'diag_' + d.key + '_fix'))}</small></span>${d.ok ? '' : `<button class="tonal small" data-act="fix" data-k="${d.key}">${esc(T('fixIt'))}</button>`}</div>`).join('')
    }
  }
  function saveSettings() { H.saveSettings(set) }
  function setSetting(k, v) {
    set[k] = v; saveSettings(); applySettings()
    if (k === 'lang' || k === 'sober') { renderShell(); renderAddBar() }
    render()
  }
  function asText() {
    const n = now(); const lines = ['== ' + T('tab_tasks') + ' ==']
    S.sortTasks(doc.tasks, n).filter(t => !t.done).forEach(t => lines.push('☐ ' + t.text + (t.due ? ' — ' + fmtDue(t) : '') + (t.repeat ? ' (' + repeatLabel(t.repeat) + ')' : '')))
    lines.push('', '== ' + T('tab_agenda') + ' ==')
    for (let i = 0; i < 60; i++) {
      const d = S.addDays(S.today(n), i)
      S.eventsOn(doc.events, d).forEach(e => lines.push(fmtDay(d, true) + (e.time ? ' ' + fmtTime(e.time) : '') + ' — ' + e.text + (e.place ? ' (' + e.place + ')' : '')))
    }
    lines.push('', '== ' + T('tab_notes') + ' ==')
    S.live(doc.notes).forEach(x => lines.push(x.text, '———'))
    return lines.join('\n')
  }
  async function importData(kind) {
    const f = await H.importFile(kind === 'ics' ? '.ics,text/calendar' : '.json,.txt,application/json,text/plain')
    if (!f || typeof f.text !== 'string') return
    if (kind === 'ics' || /BEGIN:VCALENDAR/.test(f.text)) {
      const events = S.fromIcs(f.text, now())
      doc = S.merge(doc, { events: events }); commit()
      return snack(plural(events.length, 'importedEventsOne', 'importedEventsMany'))
    }
    let data = null
    try { data = JSON.parse(f.text) } catch (e) { /* plain text */ }
    if (data && (data.tasks || data.notes || data.events)) {
      const before = S.live(doc.tasks).length + S.live(doc.notes).length + S.live(doc.events).length
      doc = S.merge(doc, data); commit()
      const added = S.live(doc.tasks).length + S.live(doc.notes).length + S.live(doc.events).length - before
      return snack(plural(added, 'importedOne', 'importedMany'))
    }
    const how = await choose(T('importTextTitle'), T('importTextBody'), [{ label: T('cancel'), value: null }, { label: T('asNote'), value: 'note' }, { label: T('asTasks'), value: 'tasks' }])
    if (how === 'note') { addNote(f.text); snack(T('noteAdded')) }
    if (how === 'tasks') { ui.draft.raw = true; addTasks(f.text) }
  }

  // ---------- dialogs, snackbar, focus timer ----------
  let dialogDone = null
  function choose(title, message, options, html) {
    return new Promise(res => {
      const d = $('#dialog')
      d.innerHTML = `<div class="scrim" data-act="dlg" data-v=""></div><div class="dlg card" role="alertdialog" aria-modal="true" aria-labelledby="dlgT"><h2 id="dlgT">${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ''}${html || ''}
        <div class="dlg-actions">${options.map((o, i) => `<button class="${o.danger ? 'danger' : i === options.length - 1 ? 'filled' : 'text-btn'}" data-act="dlg" data-v="${i}">${esc(o.label)}</button>`).join('')}</div></div>`
      d.hidden = false
      dialogDone = v => { d.hidden = true; d.innerHTML = ''; dialogDone = null; res(v === '' || v === undefined ? null : options[+v].value) }
      const last = $$('.dlg-actions button', d).pop(); if (last) last.focus()
    })
  }
  let snackTimer = 0; let snackActions = []
  function snack(msg, actions, ms) {
    const el = $('#snack'); if (!el) return
    snackActions = actions || []
    el.innerHTML = `<span>${esc(msg)}</span>${snackActions.map((a, i) => `<button data-act="snack" data-i="${i}">${esc(a.label)}</button>`).join('')}`
    el.classList.add('show')
    clearTimeout(snackTimer); snackTimer = setTimeout(() => el.classList.remove('show'), ms || (snackActions.length ? 6000 : 3000))
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
      : `${icon('timer')}<span>${esc(T(f.pause ? 'pauseDone' : 'focusDone'))}</span>${f.pause ? '' : `<button class="text-btn" data-act="focus-break">${esc(T('break5'))}</button>`}<button class="text-btn" data-act="focus-stop">${esc(T('ok'))}</button>`
  }
  function startFocus(title, minutesLong, pause) {
    set.focus = { until: now() + minutesLong * 60000, title: title, pause: !!pause }
    saveSettings(); renderFocus()
  }
  function welcome() {
    choose(T('welcomeTitle'), '', [{ label: T('letsGo'), value: 1 }], `<ul class="tips">${T('welcomeTips').split('|').map(t => `<li>${esc(t)}</li>`).join('')}</ul>`)
      .then(() => { set.welcomed = true; saveSettings(); const i = $('#addInput'); if (i && ui.tab === 'tasks') i.focus() })
  }
  function showImage(src) {
    choose('', '', [{ label: T('close'), value: 1 }], `<img class="full" src="${esc(src)}" alt="">`)
  }

  // ---------- navigation ----------
  function switchTab(tab) {
    if (ui.sheet) closeSheet()
    ui.tab = tab; ui.filter = null; ui.query = ''; ui.searchOpen = false
    const s = $('#search'); if (s) s.value = ''
    render(); $('#main').scrollTop = 0
  }
  function openSearch() { ui.searchOpen = true; renderTop(); const s = $('#search'); s.focus(); s.select() }
  function closeSearch() { ui.searchOpen = false; ui.query = ''; $('#search').value = ''; render() }
  function newEventOn(day) {
    const n = new Date(); const today = day === S.today(now())
    const time = today ? (n.getHours() < 23 ? S.pad(n.getHours() + 1) + ':00' : null) : '09:00'
    const e = newEvent({ day: day, time: time, end: time ? fromMinutes(minutes(time) + 60) : null })
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
  async function fromShare(text) {
    const kind = await choose(T('shareTitle'), text.length > 160 ? text.slice(0, 160) + '…' : text, [{ label: T('asNote'), value: 'note' }, { label: T('asEvent'), value: 'event' }, { label: T('asTask'), value: 'task' }])
    if (kind === 'note') { switchTab('notes'); newNoteFull(text) }
    else if (kind === 'task') {
      const lines = text.split('\n'); const p = S.parse(lines[0], now())
      const t = newTask({ text: p.text.slice(0, 300), repeat: p.repeat, details: lines.slice(1).join('\n').trim() }); setDue(t, p.due)
      switchTab('tasks'); add('tasks', t); openSheet(t.id)
    } else if (kind === 'event') {
      const p = S.parse(text.split('\n')[0], now())
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
    star: (el, id) => { const t = S.find(doc, id); put(Object.assign(t, { important: !t.important, loud: !t.important && set.loudImportant ? true : t.loud })) },
    postpone: (el, id) => postponeTask(id),
    'postpone-all': () => {
      const late = S.live(doc.tasks).filter(t => S.sectionOf(t, now()) === 'late'); const before = clone(late)
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
    mic: () => { if (!H.voice) return; H.voice().then(text => { if (!text) return; if (ui.tab === 'notes') { addNote(text); snack(T('noteAdded')) } else addTasks(text) }) },
    'note-full': () => { const i = $('#addInput'); const v = i ? i.value : ''; if (i) i.value = ''; newNoteFull(v) },
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
    'star-cur': () => { const t = S.find(doc, ui.sheet.id); t.important = !t.important; if (t.important && set.loudImportant) t.loud = true; put(t); renderSheet() },
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
    'postpone-cur': () => { postponeTask(ui.sheet.id); renderSheet() },
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
      const p = S.parse(sel.trim().split('\n')[0], now())
      const t = newTask({ text: p.text, repeat: p.repeat, details: T('fromNote', noteTitle(n)) }); setDue(t, p.due)
      add('tasks', t); snack(T('taskCreated'), [{ label: T('open'), run: () => { switchTab('tasks'); openSheet(t.id) } }])
    },
    'photo-add': () => $('#photoInput').click(),
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
    'export-json': () => H.exportFile('mon-orga-' + S.today(now()) + '.json', 'application/json', JSON.stringify(doc)).then(ok => { if (ok) snack(T('exported')) }),
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
  function onClick(e) {
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
      const t = S.find(doc, ui.sheet.id); t.steps = t.steps.concat(v.split(/\s*;\s*/).filter(Boolean).map(x => ({ text: x, done: false }))); put(t); renderSheet()
      const ni = $('.step-new'); if (ni) ni.focus()
      return
    }
    const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch() }
    else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); quickNew() }
    else if (!typing && e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); switchTab(TABS[+e.key - 1][0]) }
    else if (!typing && !mod && e.key === '/') { e.preventDefault(); openSearch() }
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
      else if (el.id === 'photoInput') { if (e.type === 'change') onPhoto(e) }
      else if (el.closest && el.closest('#sheet')) onField(e)
      else if (el.dataset && el.dataset.set && e.type === 'change') onSettingInput(e)
    }
    document.addEventListener('input', onEdit)
    document.addEventListener('change', onEdit)
    H.onChange(refresh)
    if (window.matchMedia) { const mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', () => { applySettings() }) }
    setInterval(() => { if (set.focus) renderFocus() }, 1000)
    setInterval(tick, 30000)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); tick(); checkNotifications() } })
    checkNotifications()
    const start = H.startAction && H.startAction()
    if (start) action(start)
    else if (!set.welcomed && !S.live(doc.tasks).length && !S.live(doc.notes).length) welcome()
    else if (!set.welcomed) { // data from version 4: show what changed instead of the welcome
      set.welcomed = true; saveSettings()
      choose(T('whatsNewTitle'), '', [{ label: T('letsGo'), value: 1 }], `<ul class="tips">${T('whatsNew').split('|').map(t => `<li>${esc(t)}</li>`).join('')}</ul>`)
    }
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
