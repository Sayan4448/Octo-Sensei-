// Every word the interface asks for exists in French and in English (a missing one shows up as its raw key).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8')
global.window = {}
require('../src/i18n.js')
const I = global.window.I18N

test('every key used by the interface exists in both languages', () => {
  const used = new Set()
  let m
  const literal = /\bT\(\s*'([A-Za-z0-9_-]+)'(?!\s*\+)/g
  while ((m = literal.exec(src))) used.add(m[1])
  const plural = /plural\([^,]+,\s*'([A-Za-z0-9_]+)',\s*'([A-Za-z0-9_]+)'/g
  while ((m = plural.exec(src))) { used.add(m[1]); used.add(m[2]) }
  const ternary = /T\(\s*[^'()]*\?\s*'([A-Za-z0-9_]+)'\s*:\s*'([A-Za-z0-9_]+)'(?!\s*\+)/g
  while ((m = ternary.exec(src))) { used.add(m[1]); used.add(m[2]) }
  const families = { // keys built at run time: T('rep_' + kind)…
    rep_: ['daily', 'weekdays', 'weekly', 'weeks', 'monthly', 'months', 'yearly', 'days', 'hours', 'nth'],
    rk_: ['none', 'daily', 'weekdays', 'weekly', 'pick', 'weeks', 'monthly', 'months', 'nth', 'yearly', 'ndays', 'hours'],
    unit_: ['weeks', 'months', 'ndays', 'hours'], ord_: ['1', '2', '3', '4', '5', '-1'],
    pre_: ['today', 'tonight', 'tomorrow', 'monday', 'weekend', 'in1h', 'in3h'],
    sec_: ['late', 'today', 'starred', 'tomorrow', 'week', 'later', 'nodate', 'done'], tab_: ['tasks', 'notes', 'agenda', 'plus'],
    new: ['Task', 'Note', 'Event'], '': ['taskPlaceholder', 'notePlaceholder', 'eventPlaceholder'],
  }
  ;['notifications', 'exact', 'battery', 'fullscreen', 'storage', 'samsung', 'xiaomi'].forEach(k => { used.add('diag_' + k); used.add('diag_' + k + '_fix') }) // Android's checks
  Object.keys(families).forEach(p => families[p].forEach(k => used.add(p + k)))
  const missing = [...used].filter(k => I.fr[k] === undefined || I.en[k] === undefined)
  assert.deepEqual(missing, [])
})
