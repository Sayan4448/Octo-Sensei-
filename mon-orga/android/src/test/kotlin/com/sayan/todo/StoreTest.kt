package com.sayan.todo

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
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
        val b = JSONObject("""{"tasks":[{"id":"x","text":"new","updatedAt":2,"color":"blue"},{"id":"y","deleted":true,"updatedAt":4}],"notes":[{"id":"n","text":"hi","updatedAt":1,"images":["data:x"]}],"history":["2:x",3]}""")
        val m = merge(a, b)
        assertEquals(listOf("new", "keep"), items(m, "tasks").map { it.getString("text") })
        assertEquals("blue", items(m, "tasks")[0].getString("color"))
        assertEquals("data:x", items(m, "notes")[0].getJSONArray("images").getString(0))
        assertEquals(listOf("1", "2:x", "3"), m.getJSONArray("history").strings())
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

    @Test fun todayListsLateTasksFirstThenTheDay() {
        val doc = JSONObject("""{"tasks":[{"id":"a","text":"Plus tard","due":"2026-10-16T18:00"},{"id":"b","text":"Retard","due":"2026-10-15"},{"id":"c","text":"Fini","due":"2026-10-16","done":true}],
            "events":[{"id":"e","text":"Salon","day":"2026-10-15","endDay":"2026-10-17","time":null},{"id":"f","text":"Dentiste","day":"2026-10-16","time":"14:00"}]}""")
        val lines = today(doc, at("2026-10-16T10:00"))
        assertEquals(listOf("Retard", "Salon", "Dentiste", "Plus tard"), lines.map { it.text })
        assertTrue(lines[0].late)
    }
}
