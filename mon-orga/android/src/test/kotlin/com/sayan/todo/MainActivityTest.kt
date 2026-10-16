package com.sayan.todo

import android.app.AlarmManager
import android.content.Intent
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.view.WindowManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class MainActivityTest {
    private fun bridgeOf(activity: MainActivity): (String, Array<Any>) -> Any? {
        val bridge = shadowOf(activity.web).getJavascriptInterface("Android")
        return { name, args -> bridge.javaClass.methods.first { it.name == name && it.parameterCount == args.size }.apply { isAccessible = true }.invoke(bridge, *args) }
    }

    @Test fun showsTheInterfaceAndStoresWhatItSaves() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        assertEquals(MainActivity.START, shadowOf(activity.web).lastLoadedUrl)
        val call = bridgeOf(activity)
        assertEquals("5.1.0", JSONObject(call("info", arrayOf()) as String).getString("version"))
        val merged = JSONObject(call("save", arrayOf("""{"tasks":[{"id":"a","text":"Pain","updatedAt":5}]}""")) as String)
        assertEquals("Pain", items(merged, "tasks").single().getString("text"))
        assertEquals("Pain", items(JSONObject(call("load", arrayOf()) as String), "tasks").single().getString("text"))
        assertEquals("Pain", items(loadDoc(activity.prefs()), "tasks").single().getString("text")) // what the reminders read
    }

    @Test fun sharedTextBecomesAnActionForThePage() {
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Acheter du pain demain")
        val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
        val call = bridgeOf(activity)
        val action = JSONObject(call("takeAction", arrayOf()) as String)
        assertEquals("share", action.getString("type"))
        assertEquals("Acheter du pain demain", action.getString("text"))
        assertNull(call("takeAction", arrayOf())) // taken once
    }

    @Test fun infoAndThemeForThePage() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val call = bridgeOf(activity)
        val info = JSONObject(call("info", arrayOf()) as String)
        assertTrue(info.getInt("a11yTimeout") >= 10_000)
        assertTrue(info.getBoolean("calendar") && info.getBoolean("camera"))
        if (Build.VERSION.SDK_INT >= 31) assertTrue(info.getJSONObject("dynamic").getString("primary").matches(Regex("#[0-9a-f]{6}")))
        call("theme", arrayOf(true))
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertEquals(0xFF141218.toInt(), (activity.window.decorView.background as ColorDrawable).color)
    }

    @Test fun calendarFilesPhotosAndVoiceNotesBecomeActions() {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        fun actionFor(intent: Intent) = JSONObject(bridgeOf(Robolectric.buildActivity(MainActivity::class.java, intent).setup().get())("takeAction", arrayOf()) as String)
        val ics = Uri.parse("content://files/rdv.ics")
        shadowOf(app.contentResolver).registerInputStream(ics, "BEGIN:VCALENDAR\nEND:VCALENDAR".byteInputStream())
        val opened = actionFor(Intent(Intent.ACTION_VIEW).setDataAndType(ics, "text/calendar"))
        assertEquals("ics", opened.getString("type"))
        assertTrue(opened.getString("text").startsWith("BEGIN:VCALENDAR"))
        val photo = Uri.parse("content://files/chat.png")
        shadowOf(app.contentResolver).registerInputStream(photo, byteArrayOf(1, 2, 3).inputStream())
        val shared = actionFor(Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, photo).putExtra(Intent.EXTRA_TEXT, "Mon chat"))
        assertEquals("image", shared.getString("type"))
        assertEquals("data:image/png;base64,AQID", shared.getString("src"))
        assertEquals("Mon chat", shared.getString("text"))
        assertEquals("voice-note", actionFor(Intent(MainActivity.VOICE_NOTE)).getString("type"))
    }

    @Test fun tappingAReminderAnswersIt() {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        Reminders.snooze(app, "a", System.currentTimeMillis() + 600_000)
        val activity = Robolectric.buildActivity(MainActivity::class.java, Intent(MainActivity.OPEN).putExtra(Reminders.EXTRA_ID, "a")).setup().get()
        assertTrue(Reminders.snoozes(app).isEmpty())
        assertEquals("a", JSONObject(bridgeOf(activity)("takeAction", arrayOf()) as String).getString("id"))
    }

    @Test fun syncCodeTestAlarmDiagnosticsAndBackup() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val call = bridgeOf(activity)
        val old = syncCode(activity)
        val fresh = JSONObject(call("syncNewCode", arrayOf()) as String).getString("code")
        assertNotEquals(old, fresh)
        assertEquals(fresh, syncCode(activity))
        val before = System.currentTimeMillis()
        call("testAlarmIn", arrayOf(2, false))
        val at = shadowOf(activity.getSystemService(AlarmManager::class.java)).nextScheduledAlarm!!.triggerAtTime
        assertTrue(at - before in 120_000L..125_000L)
        val rows = JSONArray(call("diagnostics", arrayOf()) as String)
        assertTrue((0 until rows.length()).any { rows.getJSONObject(it).getString("key") == "storage" })
        assertEquals("""{"folder":null,"last":0}""", call("backupInfo", arrayOf()))
    }

    @Test fun settingsReachTheRemindersAndTheLockHidesTheScreen() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        bridgeOf(activity)("saveSettings", arrayOf("""{"privateNotifs":true,"lock":true,"summary":"08:00"}"""))
        shadowOf(android.os.Looper.getMainLooper()).idle()
        val s = settings(activity.prefs())
        assertTrue(s.privateNotifs)
        assertEquals("08:00", s.summary.toString())
        assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
    }
}
