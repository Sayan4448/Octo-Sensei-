// What main.js decides about re-rings, quiet hours and daily backups. Plain Node, so it is tested without Electron.
const fs = require('fs')
const path = require('path')

const DAY = 86400000

// Reminders that just rang ring again until answered (tasks and events). Updates local.snoozes and local.nags.
// settings.nag: minutes between rings (10 if absent, 0 = off); nagTimes: how many more (3 if absent),
// 0 = until answered: 3 quick ones, then hourly, never more than 24 h after the first ring.
function nag(rings, local, settings, now) {
  const every = settings.nag == null ? 10 : +settings.nag
  const times = settings.nagTimes == null ? 3 : +settings.nagTimes
  rings.forEach(a => {
    const last = a.snoozed && local.nags[a.id]
    const n = last && last.first ? (last.n || 0) + 1 : 0 // a fresh ring starts over
    const first = n ? last.first : now
    const at = now + (times > 0 || n < 3 ? every : 60) * 60000
    if (every > 0 && !(times > 0 && n >= times) && at - first <= DAY) { local.snoozes[a.id] = at; local.nags[a.id] = { n, first } } else delete local.nags[a.id]
  })
}

// Quiet hours "22:00" to "07:00" may wrap midnight; an empty end means none.
const quiet = (from, to, hhmm) => !!from && !!to && (from <= to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to)

// Writes <folder>/mon-orga-<day>.json, then keeps only the 14 newest such files. Throws when the folder is unusable.
const BACKUP = /^mon-orga-\d{4}-\d{2}-\d{2}\.json$/
function backup(folder, day, data) {
  const name = path.join(folder, 'mon-orga-' + day + '.json')
  fs.writeFileSync(name + '.tmp', JSON.stringify(data))
  fs.renameSync(name + '.tmp', name)
  fs.readdirSync(folder).filter(f => BACKUP.test(f)).sort().reverse().slice(14).forEach(f => fs.unlinkSync(path.join(folder, f)))
}

module.exports = { nag, quiet, backup }
