package com.sayan.todo

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
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
        val t = Reminders.texts(this)
        val id = intent.getStringExtra(Reminders.EXTRA_ID) ?: return finish()
        val task = intent.getBooleanExtra("task", false)
        findViewById<TextView>(R.id.alarm_time).text = intent.getLongExtra("when", System.currentTimeMillis()).toLocal().toLocalTime()
            .format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(t.resources.configuration.locales[0]))
        findViewById<TextView>(R.id.alarm_title).text = intent.getStringExtra("title").orEmpty()
        fun button(viewId: Int, label: String, action: String, visible: Boolean = true) = findViewById<Button>(viewId).apply {
            text = label; visibility = if (visible) Button.VISIBLE else Button.GONE
            setOnClickListener { sendBroadcast(Intent(this@AlarmActivity, ReminderReceiver::class.java).setAction(action).putExtra(Reminders.EXTRA_ID, id)); finish() }
        }
        button(R.id.alarm_done, t.getString(R.string.act_done), Reminders.DONE, task)
        button(R.id.alarm_snooze, t.getString(R.string.act_snooze, settings(prefs()).snooze), Reminders.SNOOZE)
        button(R.id.alarm_stop, t.getString(R.string.act_stop), Reminders.STOP)
    }

    companion object {
        fun intent(ctx: Context, a: Alarm, task: Boolean): PendingIntent = PendingIntent.getActivity(ctx, ("alarm" + a.id).hashCode(),
            Intent(ctx, AlarmActivity::class.java).putExtra(Reminders.EXTRA_ID, a.id).putExtra("title", a.title).putExtra("when", a.occurrence).putExtra("task", task)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
