package com.sayan.todo

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
    private fun note(title: String) = notes.single { it.extras.getString(Notification.EXTRA_TITLE) == title }
    private fun press(n: Notification, label: String) = ReminderReceiver().onReceive(app, shadowOf(n.actions.single { it.title.toString() == label }.actionIntent).savedIntent)
    private fun event(id: String, day: String, time: String, vararg extra: Pair<String, Any>) = JSONObject().put("id", id).put("text", "Rdv $id").put("day", day).put("time", time)
        .put("remind", JSONArray(listOf(0))).put("updatedAt", 1).apply { extra.forEach { (k, v) -> put(k, v) } }

    @Before fun allowNotifications() = shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)

    @Test fun armsTheNextReminder() {
        val now = System.currentTimeMillis() / 60_000 * 60_000
        store(task("a", stamp(now + 3_600_000), "remind" to JSONArray(listOf(0, 10))))
        Reminders.schedule(app, now)
        assertEquals(now + 3_000_000, nextAlarmAt())
    }

    @Test fun ringsWithDoneSnoozeAndLaterButtons() {
        store(task("a", "2026-10-16T18:00"))
        prefs.edit().putLong("lastCheck", at("2026-10-16T17:00")).commit()
        Reminders.tick(app, at("2026-10-16T18:00"))
        val n = notes.single()
        assertEquals("Tâche a", n.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(listOf("Done", "+1 h", "Later…"), n.actions.map { it.title.toString() }) // a quiet task: +1 h, not +N min
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
        assertEquals(listOf("OK", "Directions", "Later…"), n.actions.map { it.title.toString() })
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

    @Test fun remindersAtTheSameTimeComeAsOneGroup() {
        store(*(1..5).map { task("t$it", "2026-10-16T09:00") }.toTypedArray())
        prefs.edit().putLong("lastCheck", at("2026-10-16T08:00")).commit()
        Reminders.tick(app, at("2026-10-16T09:00"))
        val (summary, children) = notes.partition { it.flags and Notification.FLAG_GROUP_SUMMARY != 0 }
        assertEquals(5, children.size) // each one with its own buttons
        assertTrue(children.all { it.group == summary.single().group && it.groupAlertBehavior == Notification.GROUP_ALERT_SUMMARY && it.actions.size == 3 })
        assertEquals("5 reminders", summary.single().extras.getString(Notification.EXTRA_TITLE))
        for (i in 1..5) Reminders.answered(app, "t$i")
        assertTrue(notes.isEmpty()) // the summary goes with the last one
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

    @Test fun callOrDirectionsTakeTheSnoozeButtonOfATask() {
        store(task("p", "2026-10-16T18:00", "text" to "Appeler Paul 06 12 34 56 78"), task("g", "2026-10-16T19:00", "place" to "Garage Martin"))
        prefs.edit().putLong("lastCheck", at("2026-10-16T17:00")).commit()
        Reminders.tick(app, at("2026-10-16T18:00"))
        Reminders.tick(app, at("2026-10-16T19:00"))
        assertEquals(listOf("Done", "Call", "Later…"), note("Appeler Paul 06 12 34 56 78").actions.map { it.title.toString() })
        assertEquals(listOf("Done", "Directions", "Later…"), note("Tâche g").actions.map { it.title.toString() })
    }

    @Test fun buttonsFollowWhatTheItemHas() {
        store(task("both", "2026-10-16T18:00", "text" to "Garage 06 12 34 56 78", "place" to "Garage Martin"), task("loud", "2026-10-16T18:00", "loud" to true),
            events = listOf(event("call", "2026-10-16", "18:00", "text" to "Rdv Paul 06 12 34 56 78"), event("plain", "2026-10-16", "18:00")))
        prefs.edit().putLong("lastCheck", at("2026-10-16T17:59")).commit()
        Reminders.tick(app, at("2026-10-16T18:00"))
        fun labels(title: String) = note(title).actions.map { it.title.toString() }
        assertEquals(listOf("Done", "Call", "Directions"), labels("Garage 06 12 34 56 78"))
        assertEquals(listOf("Done", "+10 min", "Later…"), labels("Tâche loud"))
        assertEquals(listOf("OK", "Call", "Later…"), labels("Rdv Paul 06 12 34 56 78")) // events get Call too
        assertEquals(listOf("OK", "+10 min", "Later…"), labels("Rdv plain"))
    }

    @Test fun plusOneHourSnoozesAndStartsTheNagOver() {
        prefs.edit().putString(SETTINGS_KEY, """{"nag":5,"nagTimes":2}""").putLong("lastCheck", at("2026-10-16T17:59")).commit()
        store(task("a", "2026-10-16T18:00"))
        Reminders.tick(app, at("2026-10-16T18:00"))
        assertTrue(JSONObject(prefs.getString("nags", "{}")!!).has("a"))
        val before = System.currentTimeMillis()
        press(note("Tâche a"), "+1 h")
        assertTrue(Reminders.snoozes(app)["a"]!! in before + 3_600_000..System.currentTimeMillis() + 3_600_000)
        assertFalse(JSONObject(prefs.getString("nags", "{}")!!).has("a"))
        assertTrue(notes.isEmpty())
    }

    @Test fun nagRemindsEventsTooAndASnoozeStartsItOver() {
        prefs.edit().putString(SETTINGS_KEY, """{"nag":5,"nagTimes":1}""").putLong("lastCheck", at("2026-10-16T17:59")).commit()
        store(events = listOf(event("e", "2026-10-16", "18:00")))
        Reminders.tick(app, at("2026-10-16T18:00"))
        assertEquals(at("2026-10-16T18:05"), Reminders.snoozes(app)["e"])
        Reminders.snooze(app, "e", at("2026-10-16T18:12")) // "+10 min" by hand
        Reminders.tick(app, at("2026-10-16T18:12"))
        assertEquals(at("2026-10-16T18:17"), Reminders.snoozes(app)["e"]) // counted again from 0, so one more
        Reminders.tick(app, at("2026-10-16T18:17"))
        assertNull(Reminders.snoozes(app)["e"])
    }

    @Test fun reRingSaysWhenItIsDue() {
        prefs.edit().putLong("lastCheck", at("2026-10-16T18:05")).commit()
        store(task("a", "2026-10-16T18:00"), events = listOf(event("e", "2026-10-16", "19:00", "remind" to JSONArray(listOf(60)))))
        Reminders.snooze(app, "a", at("2026-10-16T18:10")); Reminders.snooze(app, "e", at("2026-10-16T18:10"))
        Reminders.tick(app, at("2026-10-16T18:10"))
        assertTrue(note("Tâche a").extras.getString(Notification.EXTRA_TEXT)!!.endsWith("late by 10 min"))
        assertTrue(note("Rdv e").extras.getString(Notification.EXTRA_TEXT)!!.endsWith("in 50 min"))
    }

    @Test fun quietHoursOnlyVibrateButAlarmModeStillRings() {
        prefs.edit().putString(SETTINGS_KEY, """{"quietFrom":"22:00","quietTo":"07:00"}""").putLong("lastCheck", at("2026-10-16T22:59")).commit()
        store(task("a", "2026-10-16T23:00"), task("b", "2026-10-16T23:00", "loud" to true))
        Reminders.tick(app, at("2026-10-16T23:00"))
        assertEquals(Reminders.CH_QUIET, note("Tâche a").channelId)
        assertEquals(Reminders.CH_ALARM, note("Tâche b").channelId)
        val quiet = app.getSystemService(NotificationManager::class.java).getNotificationChannel(Reminders.CH_QUIET)
        assertNull(quiet.sound); assertTrue(quiet.shouldVibrate())
    }

    @Test fun alarmModeForEverythingAndStarredEvents() {
        prefs.edit().putString(SETTINGS_KEY, """{"loudAll":true}""").putLong("lastCheck", at("2026-10-16T17:59")).commit()
        store(task("a", "2026-10-16T18:00"))
        Reminders.tick(app, at("2026-10-16T18:00"))
        assertEquals(Reminders.CH_ALARM, notes.single().channelId)
        assertNotNull(notes.single().fullScreenIntent)
        assertEquals(listOf("Done", "+10 min", "Later…"), notes.single().actions.map { it.title.toString() })
        prefs.edit().putString(SETTINGS_KEY, "{}").commit()
        store(events = listOf(event("e", "2026-10-16", "19:00", "important" to true)))
        Reminders.tick(app, at("2026-10-16T19:00"))
        assertEquals(Reminders.CH_IMPORTANT, note("Rdv e").channelId)
    }

    @Test fun doneCanBeUndoneAndTheHistorySaysSo() {
        store(task("a", "2026-10-16T08:00", "repeat" to "daily"))
        receive(Reminders.DONE, "a")
        val ticked = items(loadDoc(prefs), "tasks").single()
        assertTrue(ticked.getString("due") > "2026-10-16T08:00")
        val undo = notes.single()
        assertEquals("✓ Done: Tâche a", undo.extras.getString(Notification.EXTRA_TITLE))
        press(undo, "Undo")
        val back = items(loadDoc(prefs), "tasks").single()
        assertEquals("2026-10-16T08:00", back.getString("due"))
        assertFalse(back.has("doneAt"))
        assertTrue(back.getLong("updatedAt") > ticked.getLong("updatedAt")) // wins over the ticked copy on the PC too
        val history = loadDoc(prefs).getJSONArray("history")
        assertTrue(history.getString(0).matches(Regex("""\d+:a""")))
        assertTrue(history.getString(1).matches(Regex("""\d+:a:x""")))
        assertTrue(notes.isEmpty())
    }

    @Test fun tomorrowMovesARepeatingTaskAndKeepsItsWeekday() {
        val today = System.currentTimeMillis().toLocal().toLocalDate()
        store(task("a", "${today}T09:30", "repeat" to "weekly"))
        receive(Reminders.TOMORROW, "a")
        val t = items(loadDoc(prefs), "tasks").single()
        assertEquals("${today.plusDays(1)}T09:30", t.getString("due"))
        assertEquals("weekly:${today.dayOfWeek.value}", t.getString("repeat"))
        assertTrue(Reminders.snoozes(app).isEmpty())
    }

    @Test fun aMissedPileMovesAllToTomorrow() {
        val now = System.currentTimeMillis() / 60_000 * 60_000
        store(*(1..5).map { task("t$it", stamp(now - it * 3_600_000L)) }.toTypedArray())
        prefs.edit().putLong("lastCheck", now - 6 * 3_600_000L).commit()
        Reminders.tick(app, now)
        press(notes.single(), "All to tomorrow")
        val tomorrow = now.toLocal().toLocalDate().plusDays(1).toString()
        assertTrue(items(loadDoc(prefs), "tasks").all { it.getString("due").startsWith(tomorrow) })
        assertTrue(notes.isEmpty())
    }

    @Test fun tickingInTheAppAnswersTheReminder() {
        store(task("a", "2026-10-16T18:00", "repeat" to "daily"), task("b", "2026-10-16T18:00"))
        prefs.edit().putLong("lastCheck", at("2026-10-16T17:59")).commit()
        Reminders.tick(app, at("2026-10-16T18:00"))
        assertEquals(setOf("a", "b"), Reminders.snoozes(app).keys) // would ring again at 18:10
        syncDoc(prefs, JSONObject().put("tasks", JSONArray().put(task("a", "2026-10-17T18:00", "repeat" to "daily", "updatedAt" to 5)))) // ticked in the app
        Reminders.edited(app, at("2026-10-16T18:02"))
        assertEquals(setOf("b"), Reminders.snoozes(app).keys)
        assertTrue(notes.none { it.extras.getString(Notification.EXTRA_TITLE) == "Tâche a" })
    }

    @Test fun restartArmsTheAlarmAgain() {
        store(task("a", stamp(System.currentTimeMillis() + 7_200_000)))
        receive(Intent.ACTION_BOOT_COMPLETED)
        assertNotNull(nextAlarmAt())
    }
}
