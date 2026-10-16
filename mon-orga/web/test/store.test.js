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
    { id: 'nodate', text: 'a' }, { id: 'later', due: '2026-12-01' }, { id: 'late', due: '2026-10-15T08:00' },
    { id: 'today', due: '2026-10-16T18:00' }, { id: 'todayAllDay', due: '2026-10-16' }, { id: 'tomorrow', due: '2026-10-17T09:00' },
    { id: 'week', due: '2026-10-20' }, { id: 'done', done: true, doneAt: 5 }, { id: 'starred', important: true }, { id: 'passed', due: '2026-10-16T08:00' }] })
  assert.deepEqual(S.sortTasks(doc.tasks, NOW).map(t => t.id), ['late', 'todayAllDay', 'passed', 'today', 'starred', 'tomorrow', 'week', 'later', 'nodate', 'done'])
  assert.equal(S.sectionOf(doc.tasks[4], NOW), 'today') // an all-day task is not late on its day
  assert.equal(S.sectionOf(doc.tasks[9], NOW), 'today') // nor a task of this morning: "late" is for the days before
  // A night shift: with days starting at 6 h, 3 h tomorrow morning is still "today".
  const night = S.normalize({ tasks: [{ due: '2026-10-17T03:00' }] }).tasks[0]
  assert.deepEqual([S.sectionOf(night, NOW), S.sectionOf(night, NOW, 360)], ['tomorrow', 'today'])
})

test('postpone keeps the time and starts from today for late tasks', () => {
  assert.equal(S.postpone({ due: '2026-10-10T09:30' }, NOW).due, '2026-10-17T09:30')
  assert.equal(S.postpone({ due: '2026-10-20' }, NOW).due, '2026-10-21')
  assert.equal(S.postpone({ due: null }, NOW).due, '2026-10-17')
  // a weekly series moved by a day keeps its weekday (Friday 16/10 -> Saturday, then Fridays again)
  const t = S.postpone({ due: '2026-10-16T19:00', repeat: 'weekly' }, NOW)
  assert.deepEqual([t.due, t.repeat, S.complete(t, NOW).due], ['2026-10-17T19:00', 'weekly:5', '2026-10-23T19:00'])
})

test('history: "time:id" entries survive saving, merging and undo', () => {
  const tick = S.ms('2026-10-16T09:00') + ':t1'
  const doc = S.normalize({ history: [tick, 12, 'junk', null] })
  assert.deepEqual(doc.history, [tick, 12])
  const m = S.merge({ history: [tick] }, { history: [S.ms('2026-10-15T09:00') + ':t2', tick] })
  assert.deepEqual(m.history, [S.ms('2026-10-15T09:00') + ':t2', tick])
  assert.equal(S.streak(m.history, NOW), 2)
  assert.equal(S.streak([S.ms('2026-10-16T09:00') + ':t1:x'], NOW), 0)
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
  assert.deepEqual(S.tags('Idée #Projet et #vacances2027 mais pas mail#x, voir @Karim'), ['#projet', '#vacances2027', '@karim'])
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
    ['Pause dans 4h30', 'Pause', '2026-10-16T14:30', null],
    ['Appeler dans 1 heure et demie', 'Appeler', '2026-10-16T11:30', null],
    ['Réunion tous les jours ouvrés à 9h', 'Réunion', '2026-10-19T09:00', 'weekdays'],
    ['Payer la cotisation tous les 3 mois', 'Payer la cotisation', '2026-10-16', 'months:3'],
    ['Bilan chaque trimestre', 'Bilan', '2026-10-16', 'months:3'],
    ['Réunion le premier lundi du mois à 18h', 'Réunion', '2026-11-02T18:00', 'nth:1:1'],
    ['Apéro le dernier vendredi du mois', 'Apéro', '2026-10-30', 'nth:-1:5'],
    ['Rendre le rapport avant 18h', 'Rendre le rapport', '2026-10-16T18:00', null],
    ['Sortir le chien cette nuit', 'Sortir le chien', '2026-10-16T22:00', null],
    ['Piscine le lundi et le jeudi chaque semaine', 'Piscine', '2026-10-19', 'weekly:1,4'],
    ['Gym on mondays and thursdays', 'Gym', '2026-10-19', 'weekly:1,4'],
    ['Team meeting the first monday of the month at 9am', 'Team meeting', '2026-11-02T09:00', 'nth:1:1'],
  ]
  for (const [input, text, due, repeat] of cases) {
    assert.deepEqual(S.parse(input, NOW), { text, due, repeat }, input)
  }
})

test('several times at once make one task each', () => {
  const p = S.parse('Médicament tous les jours à 8h, 12h et 19h', NOW)
  assert.deepEqual([p.text, p.repeat, p.dues], ['Médicament', 'daily', ['2026-10-17T08:00', '2026-10-16T12:00', '2026-10-16T19:00']])
  assert.deepEqual(S.parse('Gouttes matin, midi et soir', NOW).dues, ['2026-10-17T08:00', '2026-10-16T12:00', '2026-10-16T19:00'])
  assert.equal(S.parse('Appeler 18h', NOW).dues, undefined)
})

test('reminders, alarm mode, priority, ranges and expiry dates in the sentence', () => {
  const p = (x, o) => S.parse(x, NOW, o)
  assert.deepEqual(p('Dentiste mardi 14h rappel 1 h avant'), { text: 'Dentiste', due: '2026-10-20T14:00', repeat: null, remind: [60] })
  assert.deepEqual(p('Rappel la veille dentiste jeudi 9h').remind, [1440])
  assert.deepEqual([p('Médicament 8h alarme').text, p('Médicament 8h alarme').loud], ['Médicament', true])
  assert.deepEqual([p('Réveil 7h').text, p('Réveil 7h').loud], ['Réveil', true]) // the only word stays the title
  assert.deepEqual([p('Appeler la banque !').text, p('Appeler la banque !').important], ['Appeler la banque', true])
  assert.deepEqual([p('Service 18h-1h samedi').due, p('Service 18h-1h samedi').end], ['2026-10-17T18:00', '01:00'])
  assert.deepEqual([p('Réunion de 9h à 12h30 jeudi').due, p('Réunion de 9h à 12h30 jeudi').end], ['2026-10-22T09:00', '12:30'])
  assert.equal(p('Lait EXP 03/27').due, '2027-03-31') // expiry dates: the end of the month
  assert.equal(p('Yaourts 03/2027').due, '2027-03-31')
  assert.equal(p('RDV 12/03').due, '2027-03-12') // day first...
  assert.equal(p('Party 10/22').due, '2026-10-22') // ...unless impossible
  assert.equal(p('Party 03/04', { mdy: true }).due, '2027-03-04') // month first in the US
  assert.equal(p('Ronde quai cette nuit 3h').due, '2026-10-17T03:00') // the coming night, not this morning
})

test('English: short day names, "at 7", "on the 1st"', () => {
  const p = x => S.parse(x, NOW)
  assert.equal(p('Dentist Thu 3pm').due, '2026-10-22T15:00')
  assert.equal(p('Gym on thurs').due, '2026-10-22')
  assert.equal(p('Shift 6pm-1am fri').due, '2026-10-16T18:00')
  assert.deepEqual(p('Team call every tue and thu at 6pm').repeat, 'weekly:2,4')
  assert.equal(p('Appeler mon frère').due, null) // "mon" is French too
  assert.equal(p('Buy sun cream').due, null)
  assert.equal(p('Call mum at 7').due, '2026-10-16T19:00') // 7 AM is past: the next 7 o'clock
  assert.equal(p('Dinner at 8 tonight').due, '2026-10-16T20:00')
  assert.deepEqual([p('Rent every month on the 1st').due, p('Rent every month on the 1st').repeat], ['2026-11-01', 'monthly'])
  assert.equal(p('Pay bills on the 15th').due, '2026-11-15')
})

test('calendar files: monthly patterns and moved occurrences', () => {
  const doc = S.normalize({ events: [{ id: 'q', text: 'Bilan', day: '2026-10-16', time: null, repeat: 'months:3' }, { id: 'n', text: 'Réunion', day: '2026-11-02', time: '18:00', repeat: 'nth:1:1' }] })
  const ics = S.toIcs(doc, NOW)
  assert.match(ics, /RRULE:FREQ=MONTHLY;INTERVAL=3/)
  assert.match(ics, /RRULE:FREQ=MONTHLY;BYDAY=1MO/)
  assert.deepEqual(S.fromIcs(ics, NOW).map(e => e.repeat).sort(), ['months:3', 'nth:1:1'])
  const outlook = ['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:w1', 'SUMMARY:Point équipe', 'DTSTART:20261019T090000', 'DTEND:20261019T093000', 'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=3', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:w1', 'RECURRENCE-ID:20261116T090000', 'SUMMARY:Point équipe (déplacé)', 'DTSTART:20261117T140000', 'DTEND:20261117T143000', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n')
  const got = S.fromIcs(outlook, NOW)
  const master = got.find(e => e.repeat); const moved = got.find(e => !e.repeat)
  assert.deepEqual([master.repeat, master.skip, moved.day, moved.time], ['nth:3:1', ['2026-11-16'], '2026-11-17', '14:00'])
  assert.notEqual(master.id, moved.id)
})

test('calendar files: export then import gives the events back', () => {
  const doc = S.normalize({ events: [
    { id: 'a', text: 'Dentiste, cabinet; 2e', day: '2026-10-20', time: '14:00', end: '14:30', place: 'Lyon', remind: [15], repeat: 'weekly:1,3', until: '2026-12-31', skip: ['2026-10-26'], updatedAt: 1000 },
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
  assert.equal(back.length, 2) // our exported task stays in the task list
  assert.deepEqual(back.map(e => e.id), ['a', 'b']) // our events come back with their ids: no duplicates
  assert.equal(a.updatedAt, 1000) // from LAST-MODIFIED: a local edit or deletion made since then wins
})

test('calendar import: LAST-MODIFIED, cancelled and moved sessions', () => {
  const ev = body => 'BEGIN:VEVENT\r\nUID:club\r\nSUMMARY:Entraînement\r\n' + body + 'END:VEVENT\r\n'
  const ics = 'BEGIN:VCALENDAR\r\n' + ev('DTSTART:20261020T180000\r\nRRULE:FREQ=WEEKLY\r\nLAST-MODIFIED:20261001T120000Z\r\n') +
    ev('RECURRENCE-ID:20261027T180000\r\nDTSTART:20261027T180000\r\nSTATUS:CANCELLED\r\n') +
    ev('RECURRENCE-ID:20261103T180000\r\nDTSTART:20261104T190000\r\n') + 'END:VCALENDAR'
  const out = S.fromIcs(ics, NOW)
  assert.deepEqual(out.map(e => [e.day, e.time, e.repeat || null]), [['2026-10-20', '18:00', 'weekly'], ['2026-11-04', '19:00', null]])
  assert.deepEqual(out[0].skip, ['2026-10-27', '2026-11-03'])
  assert.equal(out[0].updatedAt, Date.UTC(2026, 9, 1, 12, 0, 0))
  assert.equal(out[1].updatedAt, 1) // no date in the file: older than any local change
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
