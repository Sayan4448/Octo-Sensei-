package com.sayan.todo

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Intent
import android.provider.CalendarContract
import android.provider.CalendarContract.Instances
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

// The phone's own calendars, shown in the agenda (read only), and "Add to my calendar".

private val HM = DateTimeFormatter.ofPattern("HH:mm")

fun hex(color: Int): String = String.format(Locale.ROOT, "#%06x", color and 0xFFFFFF)

// Occurrences between `from` and `to` (local days, inclusive) of the visible calendars, 500 at most.
fun deviceEvents(cr: ContentResolver, from: LocalDate, to: LocalDate): JSONArray {
    val uri = Instances.CONTENT_URI.buildUpon().also {
        ContentUris.appendId(it, from.atStartOfDay().millis()); ContentUris.appendId(it, to.atTime(23, 59, 59).millis())
    }.build()
    val cols = arrayOf(Instances.EVENT_ID, Instances.BEGIN, Instances.END, Instances.ALL_DAY, Instances.TITLE, Instances.EVENT_LOCATION, Instances.CALENDAR_DISPLAY_NAME, Instances.DISPLAY_COLOR)
    val query = { where: String -> cr.query(uri, cols, where, null, "${Instances.BEGIN} ASC") }
    val out = JSONArray()
    // Not every calendar provider knows "deleted" in this view: then without it.
    (runCatching { query("${Instances.VISIBLE}=1 AND ${CalendarContract.Events.DELETED}=0") }.getOrNull() ?: query("${Instances.VISIBLE}=1"))?.use { c ->
        while (out.length() < 500 && c.moveToNext()) {
            calendarEvent(c.getLong(0), c.getLong(1), c.getLong(2), c.getInt(3) == 1, c.getString(4), c.getString(5), c.getString(6), c.getInt(7), from, to)?.let { out.put(it) }
        }
    }
    return out
}

// One occurrence as the interface reads it; null when it is outside [from, to]. All-day ones are stored at midnight UTC,
// ending at the next day's midnight: their days are read in UTC, and endDay is the last day.
fun calendarEvent(eventId: Long, begin: Long, end: Long, allDay: Boolean, title: String?, place: String?, calendar: String?, color: Int,
                  from: LocalDate, to: LocalDate): JSONObject? {
    val start = if (allDay) begin.toLocal(ZoneOffset.UTC) else begin.toLocal()
    val stop = if (allDay) maxOf(end, begin).toLocal(ZoneOffset.UTC) else maxOf(end, begin).toLocal()
    val day = start.toLocalDate()
    val endDay = if (allDay) maxOf(day, stop.toLocalDate().minusDays(1)) else stop.toLocalDate()
    if (endDay.isBefore(from) || day.isAfter(to)) return null
    return JSONObject().put("id", "cal-$eventId-$begin").put("text", title.orEmpty()).put("day", day.toString())
        .put("time", if (allDay) JSONObject.NULL else start.format(HM)).put("endDay", endDay.toString()).put("end", if (allDay) JSONObject.NULL else stop.format(HM))
        .put("place", place.orEmpty()).put("calendar", calendar.orEmpty()).put("color", hex(color))
}

// {"text","day","time"|null,"endDay"|null,"end"|null,"place","details"} -> the calendar app's "new event" screen, filled in.
fun calendarInsert(o: JSONObject): Intent {
    val day = LocalDate.parse(o.getString("day")); val endDay = o.date("endDay")?.takeIf { !it.isBefore(day) } ?: day
    val time = o.str("time")?.let { LocalTime.parse(it) }
    val begin = day.atTime(time ?: LocalTime.MIDNIGHT).millis()
    val end = if (time == null) endDay.plusDays(1).atStartOfDay().millis()
    else o.str("end")?.let { endDay.atTime(LocalTime.parse(it)).millis() }?.takeIf { it > begin } ?: (begin + 3_600_000L)
    return Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
        .putExtra(CalendarContract.Events.TITLE, o.optString("text"))
        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
        .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, time == null)
        .putExtra(CalendarContract.Events.EVENT_LOCATION, o.optString("place"))
        .putExtra(CalendarContract.Events.DESCRIPTION, o.optString("details"))
}
