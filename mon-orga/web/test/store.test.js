// Run: TZ=Europe/Paris node --test   (from mon-orga/web)
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../src/store.js')
const F = require('./fixtures.json')
const at = s => S.ms(s)
const NOW = at('2026-10-16T10:00') // a Friday

test('recurrence: next day of a series', () => {
  for (const [start, repeat, from, until, skip, want] of F.nextDay) {
    assert.equal(S.nextDay(start, repeat, from, until, skip), want, JSON.stringify([start, repeat, from, until, skip]))
  }
})

test('completing a task: repeating ones move on, others are done', () => {
  for (const [t, now, due, done] of F.complete) {
    const r = S.complete(S.normalize({ tasks: [t] }).tasks[0], at(now))
    assert.equal(r.due, due, JSON.stringify(t)); assert.equal(r.done, done, JSON.stringify(t))
    assert.equal(r.doneAt, at(now))
  }
})

test('steps are unticked when a repeating task comes back', () => {
  const t = S.normalize({ tasks: [{ text: 'Valise', due: '2026-10-16', repeat: 'weekly', steps: [{ text: 'Brosse', done: true }] }] }).tasks[0]
  assert.equal(S.complete(t, NOW).steps[0].done, false)
})

test('alarms: tasks, all-day and repeating events, skipped dates, done tasks', () => {
  const doc = S.normalize(F.alarms.doc)
  for (const [after, until, want] of F.alarms.cases) {
    const got = S.alarms(doc, {}, at(after), at(until)).map(a => [S.stamp(new Date(a.at)), a.id])
    assert.deepEqual(got.sort(), want.slice().sort(), after)
  }
})

test('next alarm, snoozes, morning summary and focus timer', () => {
  const doc = S.normalize(F.alarms.doc)
  assert.equal(S.nextAlarm(doc, {}, NOW), at('2026-10-16T17:00'))
  assert.equal(S.nextAlarm(doc, { snoozes: { t1: at('2026-10-16T10:10') } }, NOW), at('2026-10-16T10:10'))
  assert.equal(S.nextAlarm(doc, { summary: '08:00' }, at('2026-10-16T08:30')), at('2026-10-16T09:00')) // the day-before reminder of e2
  assert.equal(S.nextAlarm(S.empty(), { summary: '08:00' }, NOW), at('2026-10-17T08:00'))
  assert.equal(S.nextAlarm(S.empty(), { focus: { until: at('2026-10-16T10:25'), title: 'x' } }, NOW), at('2026-10-16T10:25'))
  assert.equal(S.nextAlarm(S.empty(), {}, NOW), null)
})

test('a yearly birthday rings next year', () => {
  const doc = S.normalize({ events: [{ text: 'Anniv', day: '2025-03-01', time: null, repeat: 'yearly', remind: [0] }] })
  assert.equal(S.nextAlarm(doc, {}, NOW), at('2027-03-01T09:00'))
})

test('sections and sort: late first, then today, tomorrow, week, later, no date, done', () => {
  const doc = S.normalize({ tasks: [
    { id: 'nodate', text: 'a' }, { id: 'later', due: '2026-12-01' }, { id: 'late', due: '2026-10-16T08:00' },
    { id: 'today', due: '2026-10-16T18:00' }, { id: 'todayAllDay', due: '2026-10-16' }, { id: 'tomorrow', due: '2026-10-17T09:00' },
    { id: 'week', due: '2026-10-20' }, { id: 'done', done: true, doneAt: 5 }] })
  assert.deepEqual(S.sortTasks(doc.tasks, NOW).map(t => t.id), ['late', 'todayAllDay', 'today', 'tomorrow', 'week', 'later', 'nodate', 'done'])
  assert.equal(S.sectionOf(doc.tasks[4], NOW), 'today') // an all-day task is not late on its day
})

test('postpone keeps the time and starts from today for late tasks', () => {
  assert.equal(S.postpone({ due: '2026-10-10T09:30' }, NOW).due, '2026-10-17T09:30')
  assert.equal(S.postpone({ due: '2026-10-20' }, NOW).due, '2026-10-21')
  assert.equal(S.postpone({ due: null }, NOW).due, '2026-10-17')
})

test('merge: newest edit wins, deletions travel, history is a union', () => {
  const a = { tasks: [{ id: 'x', text: 'old', updatedAt: 1 }, { id: 'y', text: 'keep', updatedAt: 5 }], history: [1, 2] }
  const b = { tasks: [{ id: 'x', text: 'new', updatedAt: 2 }, { id: 'y', deleted: true, updatedAt: 4 }, { id: 'z', text: 'other', updatedAt: 1 }], history: [2, 3], notes: [{ id: 'n', text: 'hi', updatedAt: 1, color: 'blue' }] }
  const m = S.merge(a, b)
  assert.deepEqual(m.tasks.map(t => [t.id, t.text, t.deleted]), [['x', 'new', false], ['y', 'keep', false], ['z', 'other', false]])
  assert.deepEqual(m.history, [1, 2, 3])
  assert.equal(m.notes[0].color, 'blue') // fields from a newer version are kept
  assert.deepEqual(S.merge(b, a).tasks.find(t => t.id === 'x').text, 'new')
})

test('purge drops old tombstones only', () => {
  const doc = S.normalize({ tasks: [{ id: 'old', deleted: true, updatedAt: NOW - 31 * 86400000 }, { id: 'recent', deleted: true, updatedAt: NOW }] })
  assert.deepEqual(S.purge(doc, NOW).tasks.map(t => t.id), ['recent'])
})

test('normalize repairs anything', () => {
  const d = S.normalize({ tasks: [{ text: 'a', remind: 15 }, { text: 'b', remind: '30' }], events: [{ day: 'bad' }, { day: '2026-10-16', text: 'ok' }] })
  assert.deepEqual(d.tasks.map(t => t.remind), [[15], [30]])
  assert.equal(d.events.length, 1)
  assert.ok(d.tasks[0].id && d.tasks[0].id !== d.tasks[1].id)
  assert.deepEqual(S.normalize(null).tasks, [])
})

test('progress: streak, week count, level', () => {
  const h = [at('2026-10-14T09:00'), at('2026-10-15T09:00'), at('2026-10-16T09:00'), at('2026-10-10T09:00')]
  assert.equal(S.streak(h, NOW), 3)
  assert.equal(S.streak(h.slice(0, 2), NOW), 2) // nothing yet today: yesterday's streak still counts
  assert.equal(S.streak([at('2026-10-10T09:00')], NOW), 0)
  assert.equal(S.doneSince(h, '2026-10-12'), 3)
  assert.deepEqual([S.level(0).level, S.level(3).level, S.level(12).level, S.level(11).toNext], [1, 2, 3, 1])
})

test('search ignores case and accents', () => {
  assert.ok(S.matches('ecole', ['Réunion à l’École']))
  assert.ok(S.matches('reu ecol', ['Réunion', 'école']))
  assert.ok(!S.matches('piscine', ['Réunion']))
  assert.deepEqual(S.tags('Idée #Projet et #vacances2027 mais pas mail#x'), ['projet', 'vacances2027'])
})

test('natural language, French and English', () => {
  const cases = [
    ['Sortir les poubelles demain 7h', 'Sortir les poubelles', '2026-10-17T07:00', null],
    ['Sortir les poubelles chaque mardi 19h', 'Sortir les poubelles', '2026-10-20T19:00', 'weekly:2'],
    ['Appeler maman', 'Appeler maman', null, null],
    ['RDV dentiste jeudi à 14h30', 'RDV dentiste', '2026-10-22T14:30', null],
    ['Faire 2h de sport', 'Faire 2h de sport', null, null],
    ['Faire 2h de sport demain', 'Faire 2h de sport', '2026-10-17', null],
    ['Réunion 14h demain', 'Réunion', '2026-10-17T14:00', null],
    ['Payer le loyer le 5', 'Payer le loyer', '2026-11-05', null],
    ['Réunion le 25/12 à 10h', 'Réunion', '2026-12-25T10:00', null],
    ['Payer impôts le 15/10', 'Payer impôts', '2027-10-15', null],
    ['Médicament tous les jours à 8h', 'Médicament', '2026-10-17T08:00', 'daily'],
    ["Rappelle-moi d'appeler Paul dans 2 h", 'Appeler Paul', '2026-10-16T12:00', null],
    ['Réviser dans une demi-heure', 'Réviser', '2026-10-16T10:30', null],
    ['Arroser les plantes tous les 3 jours', 'Arroser les plantes', '2026-10-16', 'days:3'],
    ['Anniversaire de Léa le 3 novembre', 'Anniversaire de Léa', '2026-11-03', null],
    ["Boire de l'eau toutes les 2 h", "Boire de l'eau", '2026-10-16T12:00', 'hours:2'],
    ['Courses ce soir', 'Courses', '2026-10-16T19:00', null],
    ['Sport lundi', 'Sport', '2026-10-19', null],
    ['Cours de piano tous les mercredis et vendredis à 17h', 'Cours de piano', '2026-10-16T17:00', 'weekly:3,5'],
    ['Rendre le livre après-demain', 'Rendre le livre', '2026-10-18', null],
    ['Appeler le garagiste 18h', 'Appeler le garagiste', '2026-10-16T18:00', null],
    ['Sortir le chien tous les soirs', 'Sortir le chien', '2026-10-16T19:00', 'daily'],
    ['Rdv à midi', 'Rdv', '2026-10-16T12:00', null],
    ['Appeler la banque demain matin', 'Appeler la banque', '2026-10-17T09:00', null],
    ['Ménage une semaine sur deux', 'Ménage', '2026-10-16', 'weeks:2'],
    ['Le pain de 18.30', 'Le pain de 18.30', null, null],
    ['Call mom tomorrow at 6pm', 'Call mom', '2026-10-17T18:00', null],
    ['Pay rent every month', 'Pay rent', '2026-10-16', 'monthly'],
    ['Dentist on march 5', 'Dentist', '2027-03-05', null],
    ['Gym every monday and thursday at 7am', 'Gym', '2026-10-19T07:00', 'weekly:1,4'],
    ['Meeting next monday 3pm', 'Meeting', '2026-10-19T15:00', null],
    ['Dinner tonight', 'Dinner', '2026-10-16T19:00', null],
    ['Read in 10 minutes', 'Read', '2026-10-16T10:10', null],
  ]
  for (const [input, text, due, repeat] of cases) {
    assert.deepEqual(S.parse(input, NOW), { text, due, repeat }, input)
  }
})

test('calendar files: export then import gives the events back', () => {
  const doc = S.normalize({ events: [
    { id: 'a', text: 'Dentiste, cabinet; 2e', day: '2026-10-20', time: '14:00', end: '14:30', place: 'Lyon', remind: [15], repeat: 'weekly:1,3', until: '2026-12-31', skip: ['2026-10-26'] },
    { id: 'b', text: 'Vacances', day: '2026-10-24', time: null, endDay: '2026-11-01', remind: [0, 1440], repeat: 'yearly' },
  ], tasks: [{ id: 'c', text: 'Rendre le livre', due: '2026-10-18T10:00', remind: [0] }] })
  const ics = S.toIcs(doc, NOW)
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959/)
  assert.match(ics, /TRIGGER:PT540M/) // all-day "on the day" reminder rings at 09:00
  assert.ok(ics.split('\r\n').every(l => l.length <= 75))
  const back = S.fromIcs(ics, NOW)
  const a = back.find(e => e.text.indexOf('Dentiste') === 0)
  assert.deepEqual([a.text, a.day, a.time, a.end, a.place, a.remind, a.repeat, a.until, a.skip], ['Dentiste, cabinet; 2e', '2026-10-20', '14:00', '14:30', 'Lyon', [15], 'weekly:1,3', '2026-12-31', ['2026-10-26']])
  const b = back.find(e => e.text === 'Vacances')
  assert.deepEqual([b.day, b.time, b.endDay, b.remind.sort((x, y) => x - y), b.repeat], ['2026-10-24', null, '2026-11-01', [0, 1440], 'yearly'])
  assert.equal(back.length, 3)
  assert.equal(S.fromIcs(ics, NOW)[0].id, back[0].id) // same file twice: same ids, no duplicates
})

test('calendar import: UTC times, COUNT and Google-style files', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x1\r\nSUMMARY:Cours\r\nDTSTART:20261019T080000Z\r\nDTEND:20261019T090000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR'
  const e = S.fromIcs(ics, NOW)[0]
  const local = h => new Date(Date.UTC(2026, 9, 19, h, 0)) // UTC in the file, local in the app
  assert.deepEqual([e.day, e.time, e.end, e.repeat, e.until], [S.ymd(local(8)), S.hm(local(8)), S.hm(local(9)), 'weekly', S.addDays(S.ymd(local(8)), 14)])
})

test('multi-day and repeating events cover the right days', () => {
  const e = S.normalize({ events: [{ text: 'Salon', day: '2026-10-16', endDay: '2026-10-18', time: null }, { text: 'Garde', day: '2026-10-02', time: '20:00', repeat: 'weeks:2', skip: ['2026-10-16'] }] }).events
  assert.deepEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'].map(d => S.eventsOn(e, d).length), [0, 1, 1, 1, 0])
  assert.equal(S.eventStartOn(e[0], '2026-10-18'), '2026-10-16')
  assert.equal(S.eventsOn(e, '2026-10-30').length, 1)
  assert.equal(S.eventsOn(e, '2026-10-23').length, 0)
})
