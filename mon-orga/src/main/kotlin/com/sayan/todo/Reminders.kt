package com.sayan.todo

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import java.time.LocalDateTime
import java.time.ZoneId

object Reminders {
    const val EXTRA_DUE = "due"
    private const val CHANNEL = "rappels"

    // One alarm at a time, for the earliest open task still in the future; re-armed after every save,
    // every ring and every reboot, so no per-task bookkeeping is needed.
    fun schedule(ctx: Context, tasks: List<Task>, after: LocalDateTime = LocalDateTime.now()) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val due = nextDue(tasks, after)
        if (due == null) return am.cancel(pending(ctx, null))
        val at = due.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        // Exact alarms need a permission on Android 12; without it, ring a little late rather than not at all.
        if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(ctx, due))
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(ctx, due))
    }

    fun notify(ctx: Context, task: Task) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Rappels de tâches", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_tasks)
            .setContentTitle(task.text)
            .setContentText("C'est le moment !")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(task.text.hashCode(), notification)
    }

    // Extras are ignored when matching, so the same PendingIntent is updated or cancelled whatever the due.
    private fun pending(ctx: Context, due: LocalDateTime?) = PendingIntent.getBroadcast(
        ctx, 0, Intent(ctx, ReminderReceiver::class.java).putExtra(EXTRA_DUE, due?.toString()),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

// Rings for the tasks due at the alarm's time, then arms the next one. Also runs after a reboot (no due extra).
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val tasks = decodeTasks(ctx.getSharedPreferences("todo", Context.MODE_PRIVATE).getString("tasks", "")!!)
        val due = intent.getStringExtra(Reminders.EXTRA_DUE)?.let(LocalDateTime::parse)
        if (due != null) tasks.filter { !it.done && it.due == due }.forEach { Reminders.notify(ctx, it) }
        val now = LocalDateTime.now()
        Reminders.schedule(ctx, tasks, maxOf(due ?: now, now)) // never re-arm a due that just rang
    }
}
