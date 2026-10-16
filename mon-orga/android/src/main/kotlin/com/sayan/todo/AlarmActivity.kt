package com.sayan.todo

import android.app.Activity
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

// Full screen over the lock screen for "ring like an alarm clock" reminders; the sound stops with any answer.
class AlarmActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        else @Suppress("DEPRECATION") window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_alarm)
        val s = settings(prefs()); val t = Reminders.texts(this, s)
        val id = intent.getStringExtra(Reminders.EXTRA_ID) ?: return finish()
        val task = intent.getBooleanExtra("task", false)
        // Lock or discreet notifications on and the phone locked: no title, and "Done" asks to unlock first.
        val keyguard = getSystemService(KeyguardManager::class.java)
        val hidden = (s.privateNotifs || s.lock) && keyguard.isKeyguardLocked
        findViewById<TextView>(R.id.alarm_time).text = intent.getLongExtra("when", System.currentTimeMillis()).toLocal().toLocalTime()
            .format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(t.resources.configuration.locales[0]))
        findViewById<TextView>(R.id.alarm_title).text = if (hidden) t.getString(R.string.notif_private) else intent.getStringExtra("title").orEmpty()
        fun unlocked(run: () -> Unit) = if (!hidden) run() else keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = run()
        })
        fun send(action: String) { sendBroadcast(Intent(this, ReminderReceiver::class.java).setAction(action).putExtra(Reminders.EXTRA_ID, id)); finish() }
        fun button(viewId: Int, label: String, click: () -> Unit) = findViewById<Button>(viewId).apply { text = label; setOnClickListener { click() } }
        button(R.id.alarm_done, t.getString(if (task) R.string.act_done else R.string.act_ok)) { if (task) unlocked { send(Reminders.DONE) } else send(Reminders.STOP) }
        button(R.id.alarm_snooze, t.getString(R.string.act_snooze, s.snooze)) { send(Reminders.SNOOZE) }
        button(R.id.alarm_hour, t.getString(R.string.act_snooze_h, 1)) { send(Reminders.SNOOZE_HOUR) }.visibility = if (s.snooze == 60) View.GONE else View.VISIBLE
        button(R.id.alarm_later, t.getString(R.string.act_later)) { unlocked { startActivity(SnoozeActivity.intent(this, id)); finish() } }
        button(R.id.alarm_stop, t.getString(R.string.act_stop)) { send(Reminders.STOP) }
    }

    companion object {
        fun intent(ctx: Context, a: Alarm, task: Boolean): PendingIntent = PendingIntent.getActivity(ctx, ("alarm" + a.id).hashCode(),
            Intent(ctx, AlarmActivity::class.java).putExtra(Reminders.EXTRA_ID, a.id).putExtra("title", a.title).putExtra("when", a.occurrence).putExtra("task", task)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}

// "Later…": big choices for one reminder, from its notification or the alarm screen. It also relays the taps that must
// open a screen (Call, Directions, the widget's rows): Android lets a notification or a widget start an activity, not a receiver.
class SnoozeActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra(Reminders.EXTRA_ID) ?: return finish()
        when (intent.action) {
            Reminders.CALL, Reminders.ROUTE -> {
                Reminders.answered(this, id)
                go(Intent(if (intent.action == Reminders.CALL) Intent.ACTION_DIAL else Intent.ACTION_VIEW, intent.data))
                return finish()
            }
            Reminders.DONE -> { sendBroadcast(Intent(this, ReminderReceiver::class.java).setAction(Reminders.DONE).putExtra(Reminders.EXTRA_ID, id)); return finish() }
            MainActivity.OPEN -> { go(Intent(this, MainActivity::class.java).setAction(MainActivity.OPEN).putExtra(Reminders.EXTRA_ID, id)); return finish() }
        }
        val s = settings(prefs())
        if (!s.privateNotifs && !s.lock) {
            if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(true) else @Suppress("DEPRECATION") window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        }
        val doc = loadDoc(prefs()); val item = findItem(doc, id) ?: return finish()
        val task = isTask(doc, id); val t = Reminders.texts(this, s)
        val now = System.currentTimeMillis(); val today = now.toLocal().toLocalDate()
        val hm = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(t.resources.configuration.locales[0])
        // Minutes and "tonight" only snooze this phone; "tomorrow" moves a task (seen everywhere) and snoozes an event.
        val choices = mutableListOf<Pair<String, () -> Unit>>()
        for (m in listOf(10, 30, 60, 180)) {
            choices += t.getString(if (m % 60 == 0) R.string.act_snooze_h else R.string.act_snooze, if (m % 60 == 0) m / 60 else m) to
                { Reminders.snooze(this, id, System.currentTimeMillis() + m * 60_000L) }
        }
        if (now.toLocal().hour < 18) choices += t.getString(R.string.tonight_at, hm.format(EVENING)) to { Reminders.snooze(this, id, today.atTime(EVENING).millis()) }
        choices += t.getString(R.string.tomorrow_at, hm.format(MORNING)) to {
            if (task) Reminders.moveTask(this, id, System.currentTimeMillis()) { tomorrowMorning(it, now) }
            else Reminders.snooze(this, id, today.plusDays(1).atTime(MORNING).millis())
        }
        if (task) choices += t.getString(R.string.same_time_tomorrow) to { Reminders.moveTask(this, id, System.currentTimeMillis()) { postponeTask(it, now) } }
        val dp = resources.displayMetrics.density
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding((24 * dp).toInt(), (20 * dp).toInt(), (24 * dp).toInt(), (16 * dp).toInt()) }
        list.addView(TextView(this).apply { text = item.optString("text"); textSize = 20f; setPadding(0, 0, 0, (12 * dp).toInt()) })
        for ((label, run) in choices) list.addView(Button(this).apply {
            text = label; textSize = 20f; isAllCaps = false; minHeight = (64 * dp).toInt()
            setOnClickListener { run(); finish() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        setContentView(ScrollView(this).apply { addView(list) })
    }

    private fun go(i: Intent) = try { startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (e: ActivityNotFoundException) { Toast.makeText(this, Reminders.texts(this).getString(R.string.no_app), Toast.LENGTH_SHORT).show() }

    companion object {
        private val EVENING: LocalTime = LocalTime.of(19, 0)
        fun intent(ctx: Context, id: String): Intent = Intent(ctx, SnoozeActivity::class.java).setAction(Reminders.LATER).putExtra(Reminders.EXTRA_ID, id)
    }
}
