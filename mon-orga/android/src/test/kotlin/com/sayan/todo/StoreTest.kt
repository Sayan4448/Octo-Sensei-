package com.sayan.todo

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import android.provider.CalendarContract
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneOffset

// The cases in web/test/fixtures.json are also run by the interface's tests: phone and PC must agree on every date.
@RunWith(RobolectricTestRunner::class)
class StoreTest {
    private val fixtures = JSONObject(File("../web/test/fixtures.json").readText())
    private fun at(s: String) = LocalDateTime.parse(s).millis()
    private fun JSONArray.strings() = (0 until length()).map { optString(it) }
    private fun day(v: Any?) = (v as? String)?.let(LocalDate::parse)

    @Test fun sharedRecurrenceCases() {
        val cases = fixtures.getJSONArray("nextDay")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONArray(i)
            val skip = c.optJSONArray(4)?.strings()?.map(LocalDate::parse)?.toSet() ?: emptySet()
            val got = nextDay(LocalDate.parse(c.getString(0)), c.opt(1) as? String, LocalDate.parse(c.getString(2)), day(c.opt(3)), skip)
            assertEquals(c.toString(), day(c.opt(5)), got)
        }
    }

    @Test fun sharedCompletionCases() {
        val cases = fixtures.getJSONArray("complete")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONArray(i)
            val task = JSONObject(c.getJSONObject(0).toString())
            completeTask(task, at(c.getString(1)))
            assertEquals(c.toString(), c.getString(2), task.getString("due"))
            assertEquals(c.toString(), c.getBoolean(3), task.optBoolean("done"))
        }
    }

    @Test fun sharedAlarmCases() {
        val alarms = fixtures.getJSONObject("alarms")
        val doc = alarms.getJSONObject("doc")
        val cases = alarms.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONArray(i)
            val want = (0 until c.getJSONArray(2).length()).map { c.getJSONArray(2).getJSONArray(it).let { p -> p.getString(0) + " " + p.getString(1) } }.sorted()
            val got = alarms(doc, Local(), at(c.getString(0)), at(c.getString(1))).map { stamp(it.at) + " " + it.id }.sorted()
            assertEquals(want, got)
        }
    }

    @Test fun snoozeSummaryAndFocusAlarms() {
        val doc = fixtures.getJSONObject("alarms").getJSONObject("doc")
        val now = at("2026-10-16T10:00")
        assertEquals(at("2026-10-16T17:00"), nextAlarm(doc, Local(), now))
        assertEquals(at("2026-10-16T10:10"), nextAlarm(doc, Local(snoozes = mapOf("t1" to at("2026-10-16T10:10"))), now))
        assertEquals(at("2026-10-17T08:00"), nextAlarm(JSONObject(), Local(summary = java.time.LocalTime.of(8, 0)), now))
        assertEquals(at("2026-10-16T10:25"), nextAlarm(JSONObject(), Local(focusUntil = at("2026-10-16T10:25")), now))
        assertNull(nextAlarm(JSONObject(), Local(), now))
    }

    @Test fun mergeKeepsNewestAndUnknownFields() {
        val a = JSONObject("""{"tasks":[{"id":"x","text":"old","updatedAt":1},{"id":"y","text":"keep","updatedAt":5}],"history":[1,"2:x"]}""")
        val b = JSONObject("""{"tasks":[{"id":"x","text":"new","updatedAt":2,"color":"blue","prio":3},{"id":"y","deleted":true,"updatedAt":4}],"notes":[{"id":"n","text":"hi","updatedAt":1,"images":["data:x"],"conflictOf":"m"}],"history":["2:x",3]}""")
        val m = merge(a, b)
        assertEquals(listOf("new", "keep"), items(m, "tasks").map { it.getString("text") })
        assertEquals("blue", items(m, "tasks")[0].getString("color"))
        assertEquals(3, items(m, "tasks")[0].getInt("prio"))
        assertEquals("data:x", items(m, "notes")[0].getJSONArray("images").getString(0))
        assertEquals("m", items(m, "notes")[0].getString("conflictOf"))
        assertEquals(listOf("1", "2:x", "3"), m.getJSONArray("history").strings())
    }

    // R5: [local, remote, since, [[id, text] of the merged notes, in order]], the shape of fixtures.json's "merge".
    private fun mergeCase(c: JSONArray) {
        val m = merge(c.getJSONObject(0), c.getJSONObject(1), c.getLong(2))
        val want = c.getJSONArray(3).let { w -> (0 until w.length()).map { w.getJSONArray(it).let { p -> p.getString(0) to p.getString(1) } } }
        assertEquals(c.toString(), want, items(m, "notes").map { it.getString("id") to it.optString("text") })
    }

    @Test fun sharedMergeCases() {
        val cases = fixtures.getJSONArray("merge")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) mergeCase(cases.getJSONArray(i))
    }

    @Test fun aNoteEditedOnBothSidesKeepsBothTexts() {
        val cases = JSONArray("""[
            [{"notes":[{"id":"n","text":"phone","updatedAt":200}]}, {"notes":[{"id":"n","text":"pc","updatedAt":300}]}, 100, [["n","pc"],["n-c200","phone"]]],
            [{"notes":[{"id":"n","text":"phone","updatedAt":200}]}, {"notes":[{"id":"n","text":"pc","updatedAt":300}]}, 0, [["n","pc"]]],
            [{"notes":[{"id":"n","text":"phone","updatedAt":50}]}, {"notes":[{"id":"n","text":"pc","updatedAt":300}]}, 100, [["n","pc"]]],
            [{"notes":[{"id":"n","text":"same","updatedAt":200}]}, {"notes":[{"id":"n","text":"same","updatedAt":300}]}, 100, [["n","same"]]],
            [{"notes":[{"id":"n","text":"phone","updatedAt":200,"deleted":true}]}, {"notes":[{"id":"n","text":"pc","updatedAt":300}]}, 100, [["n","pc"]]],
            [{"notes":[{"id":"n","text":"a","updatedAt":200}]}, {"notes":[{"id":"n","text":"b","updatedAt":200}]}, 100, [["n","a"],["n-c200","b"]]],
            [{"notes":[{"id":"x","text":"x","updatedAt":1},{"id":"n","text":"new","updatedAt":400},{"id":"y","text":"y","updatedAt":1}]},
             {"notes":[{"id":"n","text":"old","updatedAt":300}]}, 100, [["x","x"],["n","new"],["n-c300","old"],["y","y"]]],
            [{"notes":[{"id":"n","text":"phone","updatedAt":200}]}, {"notes":[{"id":"n","text":"pc","updatedAt":300},{"id":"n-c200","text":"phone","updatedAt":200}]}, 100,
             [["n","pc"],["n-c200","phone"]]]
        ]""")
        for (i in 0 until cases.length()) mergeCase(cases.getJSONArray(i))
        val local = JSONObject("""{"notes":[{"id":"n","text":"phone","createdAt":1,"updatedAt":200,"pinned":true,"images":["data:x"]}],"tasks":[{"id":"t","text":"a","updatedAt":200}]}""")
        val m = merge(local, JSONObject("""{"notes":[{"id":"n","text":"pc","updatedAt":300}],"tasks":[{"id":"t","text":"b","updatedAt":300}]}"""), 100)
        val copy = items(m, "notes")[1]
        assertEquals(listOf("n", "false", "200", "200", "data:x"), listOf(copy.getString("conflictOf"), copy.getString("pinned"), copy.getString("createdAt"), copy.getString("updatedAt"), copy.getJSONArray("images").getString(0)))
        assertEquals(listOf("b"), items(m, "tasks").map { it.getString("text") }) // notes only
    }

    @Test fun googleBackupIsOffOnRequestAndWithTheLock() {
        assertTrue(Settings(JSONObject()).googleBackup)
        assertFalse(Settings(JSONObject("""{"googleBackup":false}""")).googleBackup)
        assertFalse(Settings(JSONObject("""{"googleBackup":true,"lock":true}""")).googleBackup)
        assertEquals(GoogleBackupAgent::class.java.name, RuntimeEnvironment.getApplication().applicationInfo.backupAgentName)
    }

    @Test fun storageMigratesVersion4AndPurgesOldTombstones() {
        val prefs = RuntimeEnvironment.getApplication().getSharedPreferences("t", Context.MODE_PRIVATE)
        prefs.edit().putString("tasks", "0Sortir le chien\t2026-10-17T09:00\n1Pain").putString("notes", "Ligne 1\\nLigne 2").putString("events", "2026-10-20|14:00|Dentiste").commit()
        val doc = loadDoc(prefs)
        assertEquals(items(doc, "tasks").map { it.getString("id") }, items(loadDoc(prefs), "tasks").map { it.getString("id") }) // converted once
        val tasks = items(doc, "tasks")
        assertEquals(listOf("Sortir le chien", "Pain"), tasks.map { it.getString("text") })
        assertEquals("2026-10-17T09:00", tasks[0].getString("due"))
        assertEquals(listOf(0), tasks[0].minutesList("remind"))
        assertTrue(tasks[1].getBoolean("done"))
        assertEquals("Ligne 1\nLigne 2", items(doc, "notes")[0].getString("text"))
        assertEquals("14:00", items(doc, "events")[0].getString("time"))
        val now = System.currentTimeMillis()
        tasks[1].put("deleted", true).put("updatedAt", now - 31 * 86_400_000L)
        saveDoc(prefs, doc, now)
        assertEquals(1, items(loadDoc(prefs), "tasks").size)
        prefs.edit().putString(STATE_KEY, "{broken").commit()
        assertEquals(0, items(loadDoc(prefs), "tasks").size)
        assertEquals("{broken", prefs.getString("$STATE_KEY.unreadable", null)) // kept aside, never lost
    }

    @Test fun postponeAndSteps() {
        val now = at("2026-10-16T10:00")
        val late = JSONObject().put("due", "2026-10-10T09:30"); postponeTask(late, now)
        assertEquals("2026-10-17T09:30", late.getString("due"))
        val future = JSONObject().put("due", "2026-10-20"); postponeTask(future, now)
        assertEquals("2026-10-21", future.getString("due"))
        val weekly = JSONObject().put("due", "2026-10-16").put("repeat", "weekly").put("steps", JSONArray().put(JSONObject().put("text", "a").put("done", true)))
        completeTask(weekly, now)
        assertFalse(weekly.getJSONArray("steps").getJSONObject(0).getBoolean("done"))
    }

    // The tests run in Los Angeles: 2027-03-14 at 02:00 jumps to 03:00 there.
    @Test fun aDailyTaskKeepsItsTimeAcrossTheClockChange() {
        val t = JSONObject().put("due", "2027-03-13T02:30").put("repeat", "daily")
        completeTask(t, at("2027-03-13T02:31"))
        assertEquals("2027-03-14T02:30", t.getString("due")) // 02:30 does not exist that night: it rings at 03:30, and stays 02:30
        completeTask(t, at("2027-03-14T03:31"))
        assertEquals("2027-03-15T02:30", t.getString("due"))
        val hours = JSONObject().put("due", "2027-03-14T00:00").put("repeat", "hours:4")
        completeTask(hours, at("2027-03-14T00:30"))
        assertEquals("2027-03-14T05:00", hours.getString("due")) // every 4 real hours
    }

    @Test fun postponingKeepsAWeeklySeriesOnItsWeekday() {
        val now = at("2026-10-16T10:00") // a Friday
        val weekly = JSONObject().put("due", "2026-10-16T09:30").put("repeat", "weekly")
        postponeTask(weekly, now)
        assertEquals("2026-10-17T09:30", weekly.getString("due"))
        assertEquals("weekly:5", weekly.getString("repeat"))
        val days = JSONObject().put("due", "2026-10-20").put("repeat", "weekly:1,3"); postponeTask(days, now, 3)
        assertEquals("2026-10-23", days.getString("due"))
        assertEquals("weekly:1,3", days.getString("repeat"))
        val morning = JSONObject().put("due", "2026-10-16T18:00"); tomorrowMorning(morning, now)
        assertEquals("2026-10-17T09:00", morning.getString("due"))
        val allDay = JSONObject().put("due", "2026-10-12"); tomorrowMorning(allDay, now)
        assertEquals("2026-10-17", allDay.getString("due"))
    }

    @Test fun afterRepeatsCountFromTheTickAndDatesIgnoreTheSuffix() {
        val start = LocalDate.parse("2026-10-16"); val from = LocalDate.parse("2026-10-19")
        assertEquals(nextDay(start, "days:2", from, null, emptySet()), nextDay(start, "days:2:after", from, null, emptySet()))
        assertEquals(nextOccurrence("2026-10-16T08:00", "hours:4", null, emptySet(), at("2026-10-16T09:00")),
            nextOccurrence("2026-10-16T08:00", "hours:4:after", null, emptySet(), at("2026-10-16T09:00")))
        val ended = JSONObject().put("due", "2026-10-16T08:00").put("repeat", "hours:4:after").put("until", "2026-10-16")
        completeTask(ended, at("2026-10-16T22:00"))
        assertTrue(ended.getBoolean("done"))
        val weeks = JSONObject().put("due", "2026-10-16").put("repeat", "weeks:2:after")
        completeTask(weeks, at("2026-10-18T10:00"))
        assertEquals("2026-11-01", weeks.getString("due"))
    }

    @Test fun nagRingsAgainUntilAnswered() {
        val t0 = at("2026-10-16T18:00")
        assertEquals(t0 + 600_000, nagAt(10, 3, 0, t0, t0))
        assertNull(nagAt(10, 3, 3, t0, t0 + 1_800_000))
        assertNull(nagAt(0, 3, 0, t0, t0))
        // 0 times = until answered: three quick ones, then hourly, for 24 hours at most.
        var now = t0; var count = 0
        while (true) { now = nagAt(10, 0, count, t0, now) ?: break; count++ }
        assertEquals(26, count)
        assertEquals(t0 + (30 + 23 * 60) * 60_000L, now)
        assertEquals(10, Settings(JSONObject()).nag)
        assertEquals(0, Settings(JSONObject("""{"nagTimes":0}""")).nagTimes)
    }

    @Test fun quietHoursMayWrapMidnight() {
        val night = Settings(JSONObject("""{"quietFrom":"22:00","quietTo":"07:00"}"""))
        assertTrue(night.quiet(at("2026-10-16T23:00")))
        assertTrue(night.quiet(at("2026-10-17T06:59")))
        assertFalse(night.quiet(at("2026-10-17T07:00")))
        assertFalse(night.quiet(at("2026-10-16T12:00")))
        assertTrue(Settings(JSONObject("""{"quietFrom":"13:00","quietTo":"14:00"}""")).quiet(at("2026-10-16T13:30")))
        assertFalse(Settings(JSONObject("""{"quietFrom":"","quietTo":"07:00"}""")).quiet(at("2026-10-16T03:00")))
    }

    @Test fun phoneNumbersInATask() {
        assertEquals("0612345678", phoneIn("Appeler Paul 06 12 34 56 78"))
        assertEquals("+33612345678", phoneIn("Rappeler +33 6 12 34 56 78 demain"))
        assertNull(phoneIn("Réunion 2026-10-16 14:00"))
        assertNull(phoneIn("Voir https://example.com/0612345678"))
        assertNull(phoneIn("Acheter 3 pains"))
    }

    @Test fun historyKeepsUndoneTicks() {
        val m = merge(JSONObject("""{"history":["5:a","9:a:x"]}"""), JSONObject("""{"history":["7:b","9:a:x"]}"""))
        assertEquals(listOf("5:a", "7:b", "9:a:x"), m.getJSONArray("history").strings())
        assertEquals(9L, historyTime("9:a:x"))
    }

    @Test fun phoneCalendarRowsLandOnTheirDays() {
        val from = LocalDate.parse("2026-10-19"); val to = LocalDate.parse("2026-10-25")
        fun utc(d: String) = LocalDate.parse(d).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli()
        val allDay = calendarEvent(7, utc("2026-10-20"), utc("2026-10-23"), true, "Salon", null, "Perso", 0xFF33B679.toInt(), from, to)!!
        assertEquals(listOf("cal-7-${utc("2026-10-20")}", "2026-10-20", "2026-10-22", "#33b679"), listOf(allDay.getString("id"), allDay.getString("day"), allDay.getString("endDay"), allDay.getString("color")))
        assertTrue(allDay.isNull("time"))
        val timed = calendarEvent(8, at("2026-10-21T14:00"), at("2026-10-21T15:30"), false, "Dentiste", "Lyon", "Perso", 0, from, to)!!
        assertEquals(listOf("2026-10-21", "14:00", "2026-10-21", "15:30", "Lyon"), listOf("day", "time", "endDay", "end", "place").map { timed.getString(it) })
        assertNull(calendarEvent(9, utc("2026-10-26"), utc("2026-10-27"), true, "Après", null, null, 0, from, to)) // 25th 17:00 here, but the 26th
        val insert = calendarInsert(JSONObject("""{"text":"Salon","day":"2026-10-20","time":null,"endDay":"2026-10-22","place":"Lyon","details":""}"""))
        assertTrue(insert.getBooleanExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, false))
        assertEquals(at("2026-10-23T00:00"), insert.getLongExtra(CalendarContract.EXTRA_EVENT_END_TIME, 0))
        val hour = calendarInsert(JSONObject("""{"text":"Dentiste","day":"2026-10-21","time":"14:00","endDay":null,"end":null,"place":"","details":""}"""))
        assertEquals(at("2026-10-21T15:00"), hour.getLongExtra(CalendarContract.EXTRA_EVENT_END_TIME, 0))
    }

    @Test fun backupsKeepTheFourteenNewest() {
        val names = (1..20).map { "mon-orga-2026-10-%02d.json".format(it) } + "mon-orga-export.json" + "notes.json"
        assertEquals((1..6).map { "mon-orga-2026-10-%02d.json".format(it) }.reversed(), Backup.oldBackups(names))
    }

    @Test fun todayListsLateTasksFirstThenTheDay() {
        val doc = JSONObject("""{"tasks":[{"id":"a","text":"Plus tard","due":"2026-10-16T18:00"},{"id":"b","text":"Retard","due":"2026-10-15"},{"id":"c","text":"Fini","due":"2026-10-16","done":true}],
            "events":[{"id":"e","text":"Salon","day":"2026-10-15","endDay":"2026-10-17","time":null},{"id":"f","text":"Dentiste","day":"2026-10-16","time":"14:00"}]}""")
        val lines = today(doc, at("2026-10-16T10:00"))
        assertEquals(listOf("Retard", "Salon", "Dentiste", "Plus tard"), lines.map { it.text })
        assertTrue(lines[0].late)
    }
}
