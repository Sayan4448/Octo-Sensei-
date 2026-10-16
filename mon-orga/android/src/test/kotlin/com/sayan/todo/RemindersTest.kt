package com.sayan.todo

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.time.LocalDateTime

@RunWith(RobolectricTestRunner::class)
class RemindersTest {
    private val app = RuntimeEnvironment.getApplication()
    private val prefs get() = app.prefs()
    private val notes get() = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications
    private fun at(s: String) = LocalDateTime.parse(s).millis()
    private fun task(id: String, due: String, vararg extra: Pair<String, Any>) = JSONObject().put("id", id).put("text", "Tâche $id").put("due", due)
        .put("remind", JSONArray(listOf(0))).put("updatedAt", 1).apply { extra.forEach { (k, v) -> put(k, v) } }
    private fun store(vararg tasks: JSONObject, events: List<JSONObject> = emptyList()) =
        prefs.edit().putString(STATE_KEY, JSONObject().put("tasks", JSONArray(tasks.toList())).put("events", JSONArray(events)).toString()).commit()
    private fun receive(action: String, id: String? = null) = ReminderReceiver().onReceive(app, Intent(app, ReminderReceiver::class.java).setAction(action).putExtra(Reminders.EXTRA_ID, id))
    private fun nextAlarmAt() = shadowOf(app.getSystemService(AlarmManager::class.java)).nextScheduledAlarm?.triggerAtTime

    @Before fun allowNotifications() = shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)

    @Test fun armsTheNextReminder() {
        val now = System.currentTimeMillis() / 60_000 * 60_000
        store(task("a", stamp(now + 3_600_000), "remind" to JSONArray(listOf(0, 10))))
        Reminders.schedule(app, now)
        assertEquals(now + 3_000_000, nextAlarmAt())
    }

    @Test fun ringsWithDoneLaterAndTomorrowButtons() {
        store(task("a", "2026-10-16T18:00"))
        prefs.edit().putLong("lastCheck", at("2026-10-16T17:00")).commit()
        Reminders.tick(app, at("2026-10-16T18:00"))
        val n = notes.single()
        assertEquals("Tâche a", n.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(listOf("Done", "+10 min", "Tomorrow"), n.actions.map { it.title.toString() })
        assertEquals(Reminders.CH_REMINDERS, n.channelId)
    }

    @Test fun alarmModeRingsUntilAnswered() {
        store(task("a", "2026-10-16T18:00", "loud" to true))
        prefs.edit().putLong("lastCheck", at("2026-10-16T17:00")).commit()
        Reminders.tick(app, at("2026-10-16T18:00"))
        val n = notes.single()
        assertEquals(Reminders.CH_ALARM, n.channelId)
        assertTrue(n.flags and Notification.FLAG_INSISTENT != 0)
        assertNotNull(n.fullScreenIntent)
    }

    @Test fun eventsRingBeforeTheyStart() {
        store(events = listOf(JSONObject().put("id", "e").put("text", "Dentiste").put("day", "2026-10-20").put("time", "14:00").put("end", "15:00").put("place", "Lyon").put("remind", JSONArray(listOf(15))).put("updatedAt", 1)))
        prefs.edit().putLong("lastCheck", at("2026-10-20T13:00")).commit()
        Reminders.tick(app, at("2026-10-20T13:45"))
        val n = notes.single()
        assertEquals("Dentiste", n.extras.getString(Notification.EXTRA_TITLE))
        assertTrue(n.extras.getString(Notification.EXTRA_TEXT)!!.contains("Lyon"))
        assertEquals(listOf("+10 min", "OK"), n.actions.map { it.title.toString() })
    }

    @Test fun doneMovesARepeatingTaskAndCountsIt() {
        store(task("a", "2026-10-16T08:00", "repeat" to "daily"))
        receive(Reminders.DONE, "a")
        val t = items(loadDoc(prefs), "tasks").single()
        assertTrue(t.getString("due") > "2026-10-16T08:00")
        assertTrue(t.getString("due").endsWith("T08:00"))
        assertTrue(loadDoc(prefs).getJSONArray("history").getString(0).endsWith(":a"))
    }

    @Test fun laterRingsAgainAndTomorrowPostpones() {
        val now = System.currentTimeMillis()
        store(task("a", stamp(now)))
        receive(Reminders.SNOOZE, "a")
        val snooze = Reminders.snoozes(app)["a"]!!
        assertTrue(snooze in now + 9 * 60_000..now + 11 * 60_000)
        assertEquals(snooze, nextAlarmAt())
        receive(Reminders.TOMORROW, "a")
        assertEquals(now.toLocal().toLocalDate().plusDays(1).toString(), items(loadDoc(prefs), "tasks").single().getString("due").take(10))
        assertTrue(Reminders.snoozes(app).isEmpty())
    }

    @Test fun nagsUntilTheLimit() {
        prefs.edit().putString(SETTINGS_KEY, """{"nag":5,"nagTimes":2}""").putLong("lastCheck", at("2026-10-16T17:59")).commit()
        store(task("a", "2026-10-16T18:00"))
        Reminders.tick(app, at("2026-10-16T18:00"))
        assertEquals(at("2026-10-16T18:05"), Reminders.snoozes(app)["a"])
        Reminders.tick(app, at("2026-10-16T18:05"))
        assertEquals(at("2026-10-16T18:10"), Reminders.snoozes(app)["a"])
        Reminders.tick(app, at("2026-10-16T18:10"))
        assertTrue(Reminders.snoozes(app).isEmpty())
    }

    @Test fun remindersAtTheSameTimeRingOneByOne() {
        store(*(1..5).map { task("t$it", "2026-10-16T09:00") }.toTypedArray())
        prefs.edit().putLong("lastCheck", at("2026-10-16T08:00")).commit()
        Reminders.tick(app, at("2026-10-16T09:00"))
        assertEquals(5, notes.size)
    }

    @Test fun missedRemindersAreGrouped() {
        store(*(1..5).map { task("t$it", "2026-10-16T0$it:00") }.toTypedArray())
        prefs.edit().putLong("lastCheck", at("2026-10-16T00:00")).commit()
        Reminders.tick(app, at("2026-10-16T09:00"))
        assertEquals("5 missed reminders", notes.single().extras.getString(Notification.EXTRA_TITLE))
    }

    @Test fun morningSummaryOncePerDay() {
        prefs.edit().putString(SETTINGS_KEY, """{"summary":"08:00"}""").putLong("lastCheck", at("2026-10-16T07:00")).commit()
        store(task("a", "2026-10-16T18:00", "remind" to JSONArray()))
        Reminders.tick(app, at("2026-10-16T08:00"))
        val n = notes.single()
        assertEquals(Reminders.CH_SUMMARY, n.channelId)
        assertTrue(n.extras.getString(Notification.EXTRA_TITLE)!!.startsWith("Your day"))
        Reminders.showSummary(app, loadDoc(prefs), settings(prefs), at("2026-10-16T08:30"))
        assertEquals(1, notes.size)
    }

    @Test fun discreetNotificationsHideTheTask() {
        prefs.edit().putString(SETTINGS_KEY, """{"privateNotifs":true,"lang":"fr"}""").putLong("lastCheck", at("2026-10-16T17:00")).commit()
        store(task("a", "2026-10-16T18:00"))
        Reminders.tick(app, at("2026-10-16T18:00"))
        val n = notes.single()
        assertEquals(Notification.VISIBILITY_PRIVATE, n.visibility)
        assertEquals("Rappel Mon Orga", n.publicVersion.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("Fait", n.actions[0].title.toString()) // the language chosen in the app
    }

    @Test fun restartArmsTheAlarmAgain() {
        store(task("a", stamp(System.currentTimeMillis() + 7_200_000)))
        receive(Intent.ACTION_BOOT_COMPLETED)
        assertNotNull(nextAlarmAt())
    }
}
