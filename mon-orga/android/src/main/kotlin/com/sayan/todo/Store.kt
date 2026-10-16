package com.sayan.todo

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.UUID

// The data is one JSON document, the same as the interface (web/src/store.js) and the PC app use.
// Kotlin reads only what reminders, the widget and notification buttons need, and keeps every other field as is.
// Merging two copies: per item id, the newest `updatedAt` wins; a deleted item stays a month as a tombstone.

const val PREFS = "todo"
const val STATE_KEY = "state"
const val SETTINGS_KEY = "settings"
val MORNING: LocalTime = LocalTime.of(9, 0) // reminders of an all-day item count from 09:00
private const val DAY_MS = 86_400_000L
private const val TOMBSTONE_DAYS = 30L
private const val HISTORY_MAX = 2000
private val KINDS = listOf("tasks", "notes", "events")
private val lock = Any()

fun Context.prefs(): SharedPreferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

// ---------- storage ----------

fun loadDoc(prefs: SharedPreferences): JSONObject = synchronized(lock) {
    val raw = prefs.getString(STATE_KEY, null) ?: return legacy(prefs)
    try {
        JSONObject(raw)
    } catch (e: JSONException) {
        // Never overwrite data we cannot read: keep a copy aside, start empty.
        prefs.edit().putString("$STATE_KEY.unreadable", raw).apply()
        JSONObject()
    }
}

fun saveDoc(prefs: SharedPreferences, doc: JSONObject, now: Long = System.currentTimeMillis()): Unit = synchronized(lock) {
    prefs.edit().putString(STATE_KEY, purge(doc, now).toString()).apply()
}

// Merges another copy (the interface, the PC, a backup) into what is stored, stores and returns the result.
fun syncDoc(prefs: SharedPreferences, incoming: JSONObject): JSONObject = synchronized(lock) {
    merge(loadDoc(prefs), incoming).also { saveDoc(prefs, it) }
}

// Changes one item in place and stores the document. Returns false when there is no such item.
fun editItem(prefs: SharedPreferences, id: String, now: Long, change: (item: JSONObject, doc: JSONObject) -> Unit): Boolean = synchronized(lock) {
    val doc = loadDoc(prefs)
    val item = findItem(doc, id) ?: return false
    change(item, doc)
    item.put("updatedAt", maxOf(now, item.optLong("updatedAt") + 1))
    saveDoc(prefs, doc, now)
    true
}

fun findItem(doc: JSONObject, id: String): JSONObject? {
    for (k in KINDS) items(doc, k).firstOrNull { it.optString("id") == id }?.let { return it }
    return null
}

fun isTask(doc: JSONObject, id: String) = items(doc, "tasks").any { it.optString("id") == id }

fun items(doc: JSONObject, kind: String): List<JSONObject> {
    val arr = doc.optJSONArray(kind) ?: return emptyList()
    return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
}

fun merge(local: JSONObject, remote: JSONObject): JSONObject {
    val out = JSONObject(local.toString())
    for (k in KINDS) {
        val byId = LinkedHashMap<String, JSONObject>()
        for (item in items(local, k) + items(remote, k)) {
            val id = item.optString("id").ifEmpty { continue }
            val current = byId[id]
            if (current == null || item.optLong("updatedAt") > current.optLong("updatedAt")) byId[id] = item
        }
        out.put(k, JSONArray(byId.values.toList()))
    }
    val history = LinkedHashMap<String, Any>()
    for (doc in listOf(local, remote)) doc.optJSONArray("history")?.let { a -> for (i in 0 until a.length()) a.opt(i)?.let { history[it.toString()] = it } }
    out.put("history", JSONArray(history.values.sortedBy { historyTime(it) }.takeLast(HISTORY_MAX)))
    return out.put("app", "mon-orga").put("version", 2)
}

// History entries: a completion time (v4), or "time:taskId" (v5, so ticking twice the same day counts once).
fun historyTime(entry: Any): Long = (entry as? Number)?.toLong() ?: entry.toString().substringBefore(':').toLongOrNull() ?: 0

private fun purge(doc: JSONObject, now: Long): JSONObject {
    val limit = now - TOMBSTONE_DAYS * DAY_MS
    for (k in KINDS) {
        val list = items(doc, k)
        if (list.any { it.optBoolean("deleted") && it.optLong("updatedAt") < limit }) {
            doc.put(k, JSONArray(list.filter { !(it.optBoolean("deleted") && it.optLong("updatedAt") < limit) }))
        }
    }
    return doc
}

// v1 to v4 kept one item per line under "tasks", "notes" and "events". Read once, never written back.
private fun legacy(prefs: SharedPreferences): JSONObject {
    val now = System.currentTimeMillis()
    fun rows(key: String) = prefs.getString(key, "").orEmpty().split('\n').filter { it.isNotEmpty() }
    fun unescape(s: String) = Regex("""\\(.)""").replace(s) { if (it.groupValues[1] == "n") "\n" else it.groupValues[1] }
    fun base(i: Int) = JSONObject().put("id", UUID.randomUUID().toString()).put("createdAt", now - i).put("updatedAt", now).put("deleted", false)
    val tasks = rows("tasks").mapIndexed { i, line ->
        val body = line.substringBefore('\t'); val due = line.substringAfter('\t', "").ifEmpty { null }?.take(16)
        base(i).put("text", body.drop(1)).put("done", body.firstOrNull() == '1')
            .put("due", due ?: JSONObject.NULL).put("remind", if (due != null) JSONArray(listOf(0)) else JSONArray())
    }
    val notes = rows("notes").mapIndexed { i, line -> base(i).put("text", unescape(line)) }
    val events = rows("events").mapIndexedNotNull { i, line ->
        val parts = line.split('|', limit = 3); if (parts.size < 3) return@mapIndexedNotNull null
        base(i).put("day", parts[0]).put("time", parts[1].ifEmpty { null } ?: JSONObject.NULL).put("text", unescape(parts[2]))
            .put("remind", if (parts[1].isEmpty()) JSONArray(listOf(0)) else JSONArray(listOf(15)))
    }
    return JSONObject().put("app", "mon-orga").put("version", 2)
        .put("tasks", JSONArray(tasks)).put("notes", JSONArray(notes)).put("events", JSONArray(events)).put("history", JSONArray())
}

// ---------- fields ----------

fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key, "").ifEmpty { null }

fun JSONObject.minutesList(key: String): List<Int> = when (val v = opt(key)) {
    is JSONArray -> (0 until v.length()).mapNotNull { (v.opt(it) as? Number)?.toInt() ?: v.optString(it).toIntOrNull() }
    is Number -> listOf(v.toInt())
    is String -> listOfNotNull(v.toIntOrNull())
    else -> emptyList()
}.filter { it >= 0 }.distinct().sorted()

fun JSONObject.days(key: String): Set<LocalDate> {
    val a = optJSONArray(key) ?: return emptySet()
    return (0 until a.length()).mapNotNull { runCatching { LocalDate.parse(a.optString(it)) }.getOrNull() }.toSet()
}

fun JSONObject.date(key: String): LocalDate? = str(key)?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() }

// ---------- dates ----------

private val STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")
fun LocalDateTime.millis(zone: ZoneId = ZoneId.systemDefault()) = atZone(zone).toInstant().toEpochMilli()
fun Long.toLocal(zone: ZoneId = ZoneId.systemDefault()): LocalDateTime = LocalDateTime.ofInstant(Instant.ofEpochMilli(this), zone)
fun stamp(ms: Long): String = ms.toLocal().format(STAMP)
// "2026-10-17T09:00", or "2026-10-17" (no time: reminders count from 09:00).
fun dueTime(due: String): LocalDateTime = LocalDate.parse(due.take(10)).atTime(if (due.length > 10) LocalTime.parse(due.substring(11, 16)) else MORNING)

// ---------- recurrence (same rules as web/src/store.js, checked by the shared fixtures) ----------
// daily | weekdays | weekly | weekly:1,3,5 (1 = Monday) | weeks:N | monthly | yearly | days:N | hours:N

fun repeatDays(repeat: String): List<Int> = repeat.removePrefix("weekly:").split(',').mapNotNull { it.trim().toIntOrNull() }.filter { it in 1..7 }

// First day >= from on which the series starting `start` happens, or null when it is over.
fun nextDay(start: LocalDate, repeat: String?, from: LocalDate, until: LocalDate?, skip: Set<LocalDate>): LocalDate? {
    if (repeat == null) return if (!start.isBefore(from) && (until == null || !start.isAfter(until))) start else null
    val kind = repeat.substringBefore(':')
    val n = repeat.substringAfter(':', "1").toIntOrNull()?.coerceAtLeast(1) ?: 1
    var d = if (from.isAfter(start)) from else start
    repeat(400) {
        val c: LocalDate = when {
            kind == "daily" || kind == "hours" -> d
            kind == "days" || kind == "weeks" || repeat == "weekly" -> {
                val step = if (kind == "days") n else 7 * (if (kind == "weeks") n else 1)
                start.plusDays((ChronoUnit.DAYS.between(start, d) + step - 1) / step * step)
            }
            kind == "weekdays" -> { var x = d; while (x.dayOfWeek.value > 5) x = x.plusDays(1); x }
            kind == "weekly" -> {
                val days = repeatDays(repeat).ifEmpty { return null }
                var x = d; while (x.dayOfWeek.value !in days) x = x.plusDays(1); x
            }
            kind == "monthly" || kind == "yearly" -> {
                val step = if (kind == "monthly") 1L else 12L
                var k = maxOf(0L, ((d.year - start.year) * 12L + d.monthValue - start.monthValue) / step)
                var x = start.plusMonths(k * step)
                while (x.isBefore(d)) { k++; x = start.plusMonths(k * step) }
                x
            }
            else -> return null
        }
        if (until != null && c.isAfter(until)) return null
        if (c !in skip) return c
        d = c.plusDays(1)
    }
    return null
}

// First occurrence strictly after `after` (epoch ms) of a series starting at `start` ("YYYY-MM-DD[THH:MM]").
fun nextOccurrence(start: String, repeat: String?, until: LocalDate?, skip: Set<LocalDate>, after: Long): Long? {
    val startDay = LocalDate.parse(start.take(10))
    val time = if (start.length > 10) LocalTime.parse(start.substring(11, 16)) else MORNING
    val startMs = startDay.atTime(time).millis()
    if (startMs > after) return if (nextDay(startDay, repeat, startDay, until, skip) == startDay) startMs else firstAfterDay(startDay, time, repeat, until, skip, startMs)
    if (repeat == null) return null
    if (repeat.startsWith("hours:")) {
        val step = (repeat.substringAfter(':').toIntOrNull()?.coerceAtLeast(1) ?: 1) * 3_600_000L
        val t = startMs + ((after - startMs) / step + 1) * step
        return if (until != null && t.toLocal().toLocalDate().isAfter(until)) null else t
    }
    return firstAfterDay(startDay, time, repeat, until, skip, after)
}

private fun firstAfterDay(startDay: LocalDate, time: LocalTime, repeat: String?, until: LocalDate?, skip: Set<LocalDate>, after: Long): Long? {
    var d = nextDay(startDay, repeat, after.toLocal().toLocalDate(), until, skip)
    repeat(3) {
        val day = d ?: return null
        val t = day.atTime(time).millis()
        if (t > after) return t
        d = nextDay(startDay, repeat, day.plusDays(1), until, skip)
    }
    return null
}

// ---------- alarms: what should ring on this phone ----------

data class Alarm(val at: Long, val id: String, val kind: String, val occurrence: Long, val title: String, val loud: Boolean, val important: Boolean, val snoozed: Boolean = false)

// Device-only state: snoozes (id -> ms), the morning summary time, the focus timer end.
data class Local(val snoozes: Map<String, Long> = emptyMap(), val summary: LocalTime? = null, val focusUntil: Long? = null, val focusTitle: String = "")

private fun itemAlarms(item: JSONObject, task: Boolean, after: Long, until: Long, out: MutableList<Alarm>) {
    if (item.optBoolean("deleted") || (task && item.optBoolean("done"))) return
    val start = if (task) item.str("due") ?: return else (item.str("day") ?: return) + (item.str("time")?.let { "T$it" } ?: "")
    val repeat = item.str("repeat"); val end = item.date("until"); val skip = if (task) emptySet() else item.days("skip")
    for (m in item.minutesList("remind")) {
        val before = m * 60_000L
        var o = runCatching { nextOccurrence(start, repeat, end, skip, after + before) }.getOrNull()
        var n = 0
        while (o != null && o - before <= until && n++ < 50) {
            out += Alarm(o - before, item.optString("id"), if (task) "task" else "event", o, item.optString("text"), item.optBoolean("loud"), item.optBoolean("important"))
            o = nextOccurrence(start, repeat, end, skip, o)
        }
    }
}

fun alarms(doc: JSONObject, local: Local, after: Long, until: Long): List<Alarm> {
    val out = mutableListOf<Alarm>()
    items(doc, "tasks").forEach { itemAlarms(it, true, after, until, out) }
    items(doc, "events").forEach { itemAlarms(it, false, after, until, out) }
    for ((id, at) in local.snoozes) {
        if (at <= after || at > until) continue
        val item = findItem(doc, id) ?: continue
        if (item.optBoolean("deleted") || item.optBoolean("done")) continue
        out += Alarm(at, id, if (isTask(doc, id)) "task" else "event", at, item.optString("text"), item.optBoolean("loud"), item.optBoolean("important"), snoozed = true)
    }
    local.summary?.let { time ->
        var d = after.toLocal().toLocalDate()
        while (true) {
            val at = d.atTime(time).millis()
            if (at > until) break
            if (at > after) { out += Alarm(at, "summary", "summary", at, "", false, false); break }
            d = d.plusDays(1)
        }
    }
    local.focusUntil?.let { if (it > after && it <= until) out += Alarm(it, "focus", "focus", it, local.focusTitle, false, false) }
    return out.sortedBy { it.at }
}

// Earliest alarm after `after`, a year ahead at most (yearly events), or null.
fun nextAlarm(doc: JSONObject, local: Local, after: Long): Long? = alarms(doc, local, after, after + 366 * DAY_MS).firstOrNull()?.at

// ---------- task changes made from a notification ----------

// Ticks a task; a repeating one moves to its next date (steps unticked) unless the series is over.
fun completeTask(t: JSONObject, now: Long) {
    t.put("doneAt", now)
    val due = t.str("due"); val repeat = t.str("repeat")
    if (repeat != null && due != null) {
        val until = t.date("until")
        val next = if (due.length > 10) {
            nextOccurrence(due, repeat, until, emptySet(), maxOf(dueTime(due).millis(), now))?.let { stamp(it) }
        } else {
            val day = LocalDate.parse(due); val today = now.toLocal().toLocalDate()
            nextDay(day, repeat, maxOf(day, today).plusDays(1), until, emptySet())?.toString()
        }
        if (next != null) {
            t.put("due", next)
            t.optJSONArray("steps")?.let { s -> for (i in 0 until s.length()) s.optJSONObject(i)?.put("done", false) }
            return
        }
    }
    t.put("done", true)
}

// Same time, one day later (from today for a late task).
fun postponeTask(t: JSONObject, now: Long) {
    val due = t.str("due"); val today = now.toLocal().toLocalDate()
    val day = due?.let { LocalDate.parse(it.take(10)) }?.takeIf { it.isAfter(today) } ?: today
    t.put("due", day.plusDays(1).toString() + (due?.takeIf { it.length > 10 }?.let { it.substring(10, 16) } ?: ""))
}

// ---------- settings (written by the interface) ----------

class Settings(private val json: JSONObject) {
    val lang: String get() = json.optString("lang", "auto")
    val snooze: Int get() = json.optInt("snooze", 10).coerceIn(1, 240)
    val nag: Int get() = json.optInt("nag", 0).coerceIn(0, 240)
    val nagTimes: Int get() = json.optInt("nagTimes", 3).coerceIn(1, 20)
    val privateNotifs: Boolean get() = json.optBoolean("privateNotifs")
    val lock: Boolean get() = json.optBoolean("lock")
    val summary: LocalTime? get() = json.str("summary")?.let { runCatching { LocalTime.parse(it) }.getOrNull() }
    val focusUntil: Long? get() = json.optJSONObject("focus")?.optLong("until")?.takeIf { it > 0 }
    val focusTitle: String get() = json.optJSONObject("focus")?.optString("title").orEmpty()
}

fun settings(prefs: SharedPreferences) = Settings(runCatching { JSONObject(prefs.getString(SETTINGS_KEY, null) ?: "{}") }.getOrDefault(JSONObject()))

// ---------- today, for the morning summary and the widget ----------

// Start day of the event occurrence covering `day` (multi-day and repeating events), or null.
fun eventStartOn(e: JSONObject, day: LocalDate): LocalDate? {
    if (e.optBoolean("deleted")) return null
    val start = e.date("day") ?: return null
    val span = e.date("endDay")?.takeIf { it.isAfter(start) }?.let { ChronoUnit.DAYS.between(start, it) } ?: 0L
    for (back in 0..span) {
        val s = day.minusDays(back)
        if (nextDay(start, e.str("repeat"), s, e.date("until"), e.days("skip")) == s) return s
    }
    return null
}

data class Line(val time: LocalTime?, val text: String, val late: Boolean, val task: Boolean, val id: String)

// Late tasks first, then today's tasks and events by time.
fun today(doc: JSONObject, now: Long): List<Line> {
    val nowLocal = now.toLocal(); val day = nowLocal.toLocalDate()
    val out = mutableListOf<Line>()
    for (t in items(doc, "tasks")) {
        if (t.optBoolean("deleted") || t.optBoolean("done")) continue
        val due = t.str("due") ?: continue
        val d = runCatching { LocalDate.parse(due.take(10)) }.getOrNull() ?: continue
        val time = if (due.length > 10) runCatching { LocalTime.parse(due.substring(11, 16)) }.getOrNull() else null
        val late = d.isBefore(day) || (d == day && time != null && day.atTime(time).isBefore(nowLocal))
        if (late || d == day) out += Line(time, t.optString("text"), late, true, t.optString("id"))
    }
    for (e in items(doc, "events")) {
        val s = eventStartOn(e, day) ?: continue
        out += Line(if (s == day) e.str("time")?.let { runCatching { LocalTime.parse(it) }.getOrNull() } else null, e.optString("text"), false, false, e.optString("id"))
    }
    return out.sortedWith(compareBy<Line>({ !it.late }, { it.time ?: LocalTime.MIN }))
}
