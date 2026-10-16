package com.sayan.todo

import android.content.Intent
import android.view.WindowManager
import org.json.JSONObject
import org.junit.Assert.assertEquals
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
        assertEquals("5.0.0", JSONObject(call("info", arrayOf()) as String).getString("version"))
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
