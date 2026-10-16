package com.sayan.todo

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

// "Later…", the relays for call / directions / widget rows, the alarm screen and the widget.
@RunWith(RobolectricTestRunner::class)
class ScreensTest {
    private val app = RuntimeEnvironment.getApplication()
    private val prefs get() = app.prefs()
    private val today get() = System.currentTimeMillis().toLocal().toLocalDate()
    private fun store(tasks: List<JSONObject> = emptyList(), events: List<JSONObject> = emptyList()) =
        prefs.edit().putString(STATE_KEY, JSONObject().put("tasks", JSONArray(tasks)).put("events", JSONArray(events)).toString()).commit()
    private fun item(id: String, vararg f: Pair<String, Any>) = JSONObject().put("id", id).put("text", "Item $id").put("updatedAt", 1).apply { f.forEach { (k, v) -> put(k, v) } }
    private fun later(id: String) = Robolectric.buildActivity(SnoozeActivity::class.java, SnoozeActivity.intent(app, id)).setup().get()
    private fun relay(action: String, id: String, data: Uri? = null) =
        Robolectric.buildActivity(SnoozeActivity::class.java, Intent(app, SnoozeActivity::class.java).setAction(action).setData(data).putExtra(Reminders.EXTRA_ID, id)).create().get()
    private fun buttons(a: Activity): List<Button> {
        val out = mutableListOf<Button>()
        fun walk(v: View) { if (v is Button) out += v; if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i)) }
        walk(a.window.decorView); return out
    }
    private fun press(a: Activity, label: (String) -> Boolean) = buttons(a).first { label(it.text.toString()) }.performClick()

    @Test fun laterSnoozesOrMovesATask() {
        store(listOf(item("a", "due" to "${today}T10:00")))
        val a = later("a")
        val labels = buttons(a).map { it.text.toString() }
        assertTrue(labels.containsAll(listOf("+10 min", "+1 h", "+3 h", "Tomorrow, same time")))
        press(a) { it == "+1 h" }
        val now = System.currentTimeMillis()
        assertTrue(Reminders.snoozes(app)["a"]!! in now + 59 * 60_000..now + 60 * 60_000)
        assertTrue(a.isFinishing)
        press(later("a")) { it == "Tomorrow, same time" }
        assertEquals("${today.plusDays(1)}T10:00", items(loadDoc(prefs), "tasks").single().getString("due"))
        assertTrue(Reminders.snoozes(app).isEmpty()) // moved: answered
        press(later("a")) { it.startsWith("Tomorrow 9") }
        assertEquals("${today.plusDays(1)}T09:00", items(loadDoc(prefs), "tasks").single().getString("due"))
        store(listOf(item("d", "due" to today.toString())))
        press(later("d")) { it.startsWith("Tomorrow 9") }
        assertEquals(today.plusDays(1).toString(), items(loadDoc(prefs), "tasks").single().getString("due")) // still a day only
    }

    @Test fun laterOnlySnoozesAnEvent() {
        store(events = listOf(item("e", "day" to today.toString(), "time" to "20:00")))
        val a = later("e")
        assertFalse(buttons(a).any { it.text == "Tomorrow, same time" })
        press(a) { it.startsWith("Tomorrow 9") }
        assertEquals(today.plusDays(1).atTime(MORNING).millis(), Reminders.snoozes(app)["e"])
        assertEquals(today.toString(), items(loadDoc(prefs), "events").single().getString("day"))
    }

    @Test fun callDirectionsAndWidgetTapsGoThroughTheRelay() {
        store(listOf(item("a", "due" to "${today}T10:00")))
        Reminders.snooze(app, "a", System.currentTimeMillis() + 600_000)
        val dial = shadowOf(relay(Reminders.CALL, "a", Uri.parse("tel:0612345678"))).nextStartedActivity
        assertEquals(Intent.ACTION_DIAL, dial.action)
        assertEquals("tel:0612345678", dial.dataString)
        assertTrue(Reminders.snoozes(app).isEmpty()) // calling answers the reminder
        assertEquals(Intent.ACTION_VIEW, shadowOf(relay(Reminders.ROUTE, "a", Uri.parse("geo:0,0?q=Lyon"))).nextStartedActivity.action)
        relay(Reminders.DONE, "a")
        assertEquals(Reminders.DONE, shadowOf(app).broadcastIntents.last().action)
        val open = shadowOf(relay(MainActivity.OPEN, "a")).nextStartedActivity
        assertEquals(MainActivity.OPEN, open.action)
        assertEquals("a", open.getStringExtra(Reminders.EXTRA_ID))
    }

    @Test fun lockedAlarmScreenKeepsAPrivateTitleHidden() {
        prefs.edit().putString(SETTINGS_KEY, """{"privateNotifs":true}""").commit()
        shadowOf(app.getSystemService(KeyguardManager::class.java)).setKeyguardLocked(true)
        val i = Intent(app, AlarmActivity::class.java).putExtra(Reminders.EXTRA_ID, "a").putExtra("title", "Secret").putExtra("task", true)
        val a = Robolectric.buildActivity(AlarmActivity::class.java, i).setup().get()
        assertEquals("Mon Orga reminder", a.findViewById<TextView>(R.id.alarm_title).text.toString())
        a.findViewById<Button>(R.id.alarm_done).performClick()
        assertTrue(shadowOf(app).broadcastIntents.none { it.action == Reminders.DONE }) // only once unlocked
        a.findViewById<Button>(R.id.alarm_snooze).performClick()
        assertEquals(Reminders.SNOOZE, shadowOf(app).broadcastIntents.last().action)
    }

    @Test fun widgetListsTasksThenEventsAndOnlyCountsWhenPrivate() {
        store(listOf(item("a", "due" to today.toString()), item("b", "due" to "${today}T23:59")), listOf(item("e", "day" to today.toString(), "time" to "12:00")))
        val factory = Robolectric.buildService(WidgetService::class.java).create().get().onGetViewFactory(Intent())
        factory.onDataSetChanged()
        assertEquals(3, factory.count)
        val lines = Widget.lines(app)
        assertEquals(listOf(true, true, false), lines.map { it.task })
        assertEquals("2 tasks today · 1 event", Widget.counts(app, lines))
        prefs.edit().putString(SETTINGS_KEY, """{"lock":true}""").commit()
        factory.onDataSetChanged()
        assertEquals(0, factory.count) // no title leaves the app
    }
}
