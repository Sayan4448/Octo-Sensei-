package com.sayan.todo

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import androidx.appcompat.app.AlertDialog
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.timepicker.MaterialTimePicker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import com.google.android.material.R as M

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w393dp-h852dp-xhdpi")
class MainActivityTest {
    @Test
    fun tasksNotesAndEventsWorkAndSurviveRestart() {
        var activity = launch()

        // Tasks: newest on top, long press edits or deletes, ticked ones sink and can be cleared.
        for (text in listOf("Sortir les poubelles", "Ranger le linge", "Appeler le plombier", "Tâche à supprimer")) {
            activity.findViewById<EditText>(R.id.taskInput).setText(text)
            activity.click(R.id.addTask)
        }
        row(activity, R.id.tasksList, 0).performLongClick()
        idle()
        clickDialog(AlertDialog.BUTTON_NEUTRAL) // Supprimer
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        row(activity, R.id.tasksList, 0).performLongClick()
        idle()
        fillDialog("Appeler le plombier !")
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        row(activity, R.id.tasksList, 0).performClick() // tick: sinks below the open ones
        idle()
        assertEquals(listOf(Task("Ranger le linge"), Task("Sortir les poubelles"), Task("Appeler le plombier !", done = true)), items(activity, R.id.tasksList))
        activity.click(R.id.clearDone)
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        row(activity, R.id.tasksList, 0).performClick()
        idle()

        // Notes: new, edit, and Back saves instead of discarding.
        activity.tab(R.id.tab_notes)
        activity.click(R.id.addNote)
        fillDialog("Courses :\n- lait")
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        row(activity, R.id.notesList, 0).performClick()
        idle()
        fillDialog("Courses :\n- lait\n- pain")
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        activity.click(R.id.addNote)
        fillDialog("Code Wi-Fi : 1234")
        ShadowDialog.getLatestDialog().cancel()
        idle()
        activity.click(R.id.addNote)
        fillDialog("À jeter")
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        row(activity, R.id.notesList, 0).performClick()
        idle()
        clickDialog(AlertDialog.BUTTON_NEUTRAL) // Supprimer
        clickDialog(AlertDialog.BUTTON_POSITIVE)

        // Agenda: all-day event, backing out of the time picker keeps the name, editing sets a time.
        activity.tab(R.id.tab_agenda)
        activity.click(R.id.addEvent)
        fillDialog("Anniv de mamie 🎂")
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        timePickerButton(activity, M.id.material_timepicker_cancel_button).performClick() // "Toute la journée"
        idle()
        activity.click(R.id.addEvent)
        fillDialog("Dentiste")
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        timePicker(activity).dialog!!.cancel()
        idle()
        assertEquals("Dentiste", firstEditText(ShadowDialog.getLatestDialog().window!!.decorView)!!.text.toString())
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        timePickerButton(activity, M.id.material_timepicker_ok_button).performClick()
        idle()
        row(activity, R.id.eventsList, 0).performClick() // the all-day one sorts first
        idle()
        fillDialog("Anniv de mamie 🎂🎉")
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        timePickerButton(activity, M.id.material_timepicker_cancel_button).performClick()
        idle()
        activity.click(R.id.addEvent)
        fillDialog("À jeter")
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        timePickerButton(activity, M.id.material_timepicker_cancel_button).performClick()
        idle()
        row(activity, R.id.eventsList, 1).performClick() // all-day events first, in insertion order: Anniv, À jeter, Dentiste
        idle()
        assertEquals("À jeter", firstEditText(ShadowDialog.getLatestDialog().window!!.decorView)!!.text.toString())
        clickDialog(AlertDialog.BUTTON_NEUTRAL) // Supprimer
        clickDialog(AlertDialog.BUTTON_POSITIVE)

        activity = launch()
        assertEquals(listOf(Task("Sortir les poubelles"), Task("Ranger le linge", done = true)), items(activity, R.id.tasksList))
        assertEquals(listOf("Code Wi-Fi : 1234", "Courses :\n- lait\n- pain"), items(activity, R.id.notesList))
        val events = items(activity, R.id.eventsList).map { it as Event }
        assertEquals(listOf("Anniv de mamie 🎂🎉", "Dentiste"), events.map { it.text })
        assertEquals(listOf(LocalDate.now(), LocalDate.now()), events.map { it.day })
        assertEquals(null, events[0].time)
        assertNotNull(events[1].time)
    }

    @Test
    fun noteDraftSurvivesRecreation() { // e.g. the phone switches to dark mode while typing
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        controller.get().tab(R.id.tab_notes)
        controller.get().click(R.id.addNote)
        fillDialog("Code wifi 1234")
        val before = ShadowDialog.getLatestDialog()
        controller.recreate()
        idle()
        val reopened = ShadowDialog.getLatestDialog()
        assertNotSame(before, reopened) // the old dialog object still holds the text, so it must be a new one
        assertEquals("Code wifi 1234", firstEditText(reopened.window!!.decorView)!!.text.toString())
    }

    @Test
    fun loadsTasksSavedByV1() {
        prefs().putString("tasks", "0Courses\n1Sport").commit()
        assertEquals(listOf(Task("Courses"), Task("Sport", done = true)), items(launch(), R.id.tasksList))
    }

    @Test
    fun reminderRingsAtDueTimeThenArmsTheNextOne() {
        val ctx = RuntimeEnvironment.getApplication()
        val due = LocalDateTime.now().plusHours(1).withSecond(0).withNano(0)
        val tasks = listOf(Task("Sortir les poubelles", due = due), Task("Déjà fait", done = true, due = due), Task("Plus tard", due = due.plusDays(1)))
        prefs().putString("tasks", encodeTasks(tasks)).commit()
        val alarms = shadowOf(ctx.getSystemService(AlarmManager::class.java))
        val millis = { d: LocalDateTime -> d.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli() }

        Reminders.schedule(ctx, tasks)
        assertEquals(millis(due), alarms.peekNextScheduledAlarm()!!.triggerAtTime)

        ReminderReceiver().onReceive(ctx, Intent().putExtra(Reminders.EXTRA_DUE, due.toString()))
        val shown = shadowOf(ctx.getSystemService(NotificationManager::class.java)).allNotifications
        assertEquals(listOf("Sortir les poubelles"), shown.map { it.extras.getString(Notification.EXTRA_TITLE) })
        assertEquals(millis(due.plusDays(1)), alarms.peekNextScheduledAlarm()!!.triggerAtTime)

        ReminderReceiver().onReceive(ctx, Intent()) // reboot: nothing rings, the earliest due still ahead is re-armed
        assertEquals(1, shadowOf(ctx.getSystemService(NotificationManager::class.java)).size())
        assertEquals(millis(due), alarms.peekNextScheduledAlarm()!!.triggerAtTime)

        Reminders.schedule(ctx, tasks.map { it.copy(done = true) })
        assertNull(alarms.peekNextScheduledAlarm())
    }

    @Test
    fun screenshotsLight() = screenshots("light")

    @Test
    @Config(qualifiers = "+night")
    fun screenshotsDark() = screenshots("dark")

    // Sample data, then every tab and both dialogs, saved to build/screenshots/ to eyeball the design.
    private fun screenshots(theme: String) {
        val today = LocalDate.now()
        prefs()
            .putString("tasks", encodeTasks(listOf(
                Task("Ranger le linge 🧺"), Task("Préparer la réunion de lundi", due = today.plusDays(1).atTime(9, 0)),
                Task("Acheter un cadeau pour mamie", due = today.minusDays(1).atTime(18, 0)), Task("Appeler le plombier", done = true),
            )))
            .putString("notes", encodeNotes(listOf("Courses\n- lait\n- pain\n- chocolat (beaucoup)", "Code Wi-Fi : 1234-ABCD", "Idées week-end\nRando, ciné, sieste 😴")))
            .putString("events", encodeEvents(listOf(
                Event(today, LocalTime.of(9, 0), "Dentiste 🦷"), Event(today, null, "Anniv de mamie 🎂"),
                Event(today.plusDays(2), LocalTime.of(18, 30), "Foot ⚽"), Event(today.plusDays(5), null, "Réunion parents-profs"),
            )))
            .commit()
        val activity = launch()
        screenshot(activity.window.decorView, "$theme-1-taches")
        row(activity, R.id.tasksList, 1).performLongClick()
        idle()
        screenshot(ShadowDialog.getLatestDialog().window!!.decorView, "$theme-6-tache")
        clickDialog(AlertDialog.BUTTON_NEGATIVE)
        activity.tab(R.id.tab_notes)
        screenshot(activity.window.decorView, "$theme-2-notes")
        activity.tab(R.id.tab_agenda)
        screenshot(activity.window.decorView, "$theme-3-agenda")
        activity.click(R.id.addEvent)
        fillDialog("Foot ⚽")
        screenshot(ShadowDialog.getLatestDialog().window!!.decorView, "$theme-4-dialogue")
        clickDialog(AlertDialog.BUTTON_POSITIVE)
        screenshot(timePicker(activity).dialog!!.window!!.decorView, "$theme-5-heure")
    }

    private fun prefs() = RuntimeEnvironment.getApplication().getSharedPreferences("todo", 0).edit()

    private fun launch() = Robolectric.buildActivity(MainActivity::class.java).setup().get()

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun MainActivity.click(id: Int) {
        findViewById<View>(id).performClick()
        idle()
    }

    private fun MainActivity.tab(itemId: Int) {
        findViewById<BottomNavigationView>(R.id.nav).selectedItemId = itemId
        idle()
    }

    private fun row(activity: MainActivity, listId: Int, i: Int): View = activity.findViewById<LinearLayout>(listId).getChildAt(i)

    private fun items(activity: MainActivity, listId: Int): List<Any> =
        activity.findViewById<LinearLayout>(listId).let { list -> (0 until list.childCount).map { list.getChildAt(it).tag } }

    private fun fillDialog(text: String) = firstEditText(ShadowDialog.getLatestDialog().window!!.decorView)!!.setText(text)

    private fun clickDialog(button: Int) {
        (ShadowDialog.getLatestDialog() as AlertDialog).getButton(button).performClick()
        idle()
    }

    private fun timePicker(activity: MainActivity) = activity.supportFragmentManager.findFragmentByTag("time") as MaterialTimePicker

    private fun timePickerButton(activity: MainActivity, id: Int): Button = timePicker(activity).requireView().findViewById(id)

    private fun firstEditText(view: View): EditText? = when (view) {
        is EditText -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { firstEditText(view.getChildAt(it)) }
        else -> null
    }

    private fun screenshot(root: View, name: String) {
        idle()
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(Canvas(bitmap))
        File("build/screenshots").apply { mkdirs() }.resolve("$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
