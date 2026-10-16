package com.sayan.todo

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

// due = when the task is scheduled; the phone rings a reminder at that time.
data class Task(val text: String, val done: Boolean = false, val due: LocalDateTime? = null)

data class Event(val day: LocalDate, val time: LocalTime?, val text: String)

// Storage format: one item per line, so free text is escaped to never contain '\n'.

// Tasks keep the v1 format "<0|1><text>" so existing lists still load; clean() strips line breaks and tabs,
// so a tab can separate the optional due date.
fun encodeTasks(tasks: List<Task>) =
    tasks.joinToString("\n") { (if (it.done) "1" else "0") + it.text + (it.due?.let { d -> "\t$d" } ?: "") }

fun decodeTasks(s: String) = rows(s).map { line ->
    val (body, due) = line.split('\t', limit = 2).let { it[0] to it.getOrNull(1) }
    Task(body.substring(1), body[0] == '1', due?.let(LocalDateTime::parse))
}

fun encodeNotes(notes: List<String>) = notes.joinToString("\n") { escape(it) }

fun decodeNotes(s: String) = rows(s).map { unescape(it) }

fun encodeEvents(events: List<Event>) = events.joinToString("\n") { "${it.day}|${it.time ?: ""}|${escape(it.text)}" }

fun decodeEvents(s: String) = rows(s).map {
    val (day, time, text) = it.split('|', limit = 3)
    Event(LocalDate.parse(day), if (time.isEmpty()) null else LocalTime.parse(time), unescape(text))
}

// All-day events (time == null) come first, then by time.
private val byWhen = compareBy<Event>({ it.day }, { it.time })

fun eventsOn(events: List<Event>, day: LocalDate) = events.filter { it.day == day }.sortedWith(byWhen)

// Events not over yet at `now`; an all-day event lasts until the end of its day.
fun upcoming(events: List<Event>, now: LocalDateTime) =
    events.filter { it.day.atTime(it.time ?: LocalTime.MAX) >= now }.sortedWith(byWhen)

// The next reminder to ring: the earliest due of an open task that is still in the future.
fun nextDue(tasks: List<Task>, now: LocalDateTime) =
    tasks.mapNotNull { t -> t.due?.takeIf { !t.done && it.isAfter(now) } }.minOrNull()

fun clean(input: String) = input.replace(Regex("\\s+"), " ").trim()

private fun rows(s: String) = s.split('\n').filter { it.isNotEmpty() }

private fun escape(s: String) = s.replace("\\", "\\\\").replace("\n", "\\n")

private fun unescape(s: String) = Regex("""\\(.)""").replace(s) { if (it.groupValues[1] == "n") "\n" else it.groupValues[1] }
