package com.sayan.todo

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

// One exact alarm, always set at the next thing to ring. When it fires, everything due since the last check rings
// (so reminders missed while the phone was off ring at start-up), then the next one is armed.
object Reminders {
    const val TICK = "com.sayan.todo.TICK"
    const val DONE = "com.sayan.todo.DONE"
    const val SNOOZE = "com.sayan.todo.SNOOZE"
    const val TOMORROW = "com.sayan.todo.TOMORROW"
    const val STOP = "com.sayan.todo.STOP"
    const val TEST = "com.sayan.todo.TEST"
    const val EXTRA_ID = "id"
    const val CH_REMINDERS = "reminders"
    const val CH_IMPORTANT = "important"
    const val CH_ALARM = "alarm"
    const val CH_SUMMARY = "summary"
    private const val MISSED_WINDOW = 12 * 3_600_000L

    fun snoozes(ctx: Context): MutableMap<String, Long> = longs(ctx, "snoozes")
    private fun nags(ctx: Context): MutableMap<String, Long> = longs(ctx, "nags")
    private fun longs(ctx: Context, key: String): MutableMap<String, Long> {
        val o = runCatching { JSONObject(ctx.prefs().getString(key, null) ?: "{}") }.getOrDefault(JSONObject())
        return o.keys().asSequence().associateWith { o.optLong(it) }.toMutableMap()
    }
    private fun putLongs(ctx: Context, key: String, map: Map<String, Long>) = ctx.prefs().edit().putString(key, JSONObject(map).toString()).apply()

    fun local(ctx: Context): Local { val s = settings(ctx.prefs()); return Local(snoozes(ctx), s.summary, s.focusUntil, s.focusTitle) }

    fun schedule(ctx: Context, now: Long = System.currentTimeMillis()) {
        val prefs = ctx.prefs()
        if (!prefs.contains("lastCheck")) prefs.edit().putLong("lastCheck", now).apply()
        val from = maxOf(prefs.getLong("lastCheck", now), now - MISSED_WINDOW)
        val next = nextAlarm(loadDoc(prefs), local(ctx), from)
        val am = ctx.getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(ctx, 0, Intent(ctx, ReminderReceiver::class.java).setAction(TICK), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        if (next == null) return am.cancel(pi)
        val at = maxOf(next, now)
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    }

    // After an edit in the app: what was due in the last minutes still rings, a task just dated in the past does not.
    fun edited(ctx: Context, now: Long = System.currentTimeMillis()) {
        val prefs = ctx.prefs()
        prefs.edit().putLong("lastCheck", maxOf(prefs.getLong("lastCheck", now), now - 5 * 60_000L)).apply()
        schedule(ctx, now)
    }

    fun tick(ctx: Context, now: Long) {
        val prefs = ctx.prefs(); val s = settings(prefs)
        val from = maxOf(prefs.getLong("lastCheck", now), now - MISSED_WINDOW)
        val doc = loadDoc(prefs); val snoozes = snoozes(ctx); val nags = nags(ctx)
        val due = alarms(doc, Local(snoozes, s.summary, s.focusUntil, s.focusTitle), from, now)
        prefs.edit().putLong("lastCheck", now).apply()
        snoozes.entries.removeAll { it.value <= now }
        val rings = due.filter { it.kind == "task" || it.kind == "event" }.distinctBy { it.id }
        if (rings.size > 4) showMissed(ctx, rings, s) else rings.forEach { show(ctx, it, doc, s, now) }
        if (s.nag > 0) for (a in rings.filter { it.kind == "task" }) { // "remind me again until I answer"
            val count = if (a.snoozed) (nags[a.id] ?: 0) + 1 else 0
            if (count < s.nagTimes) { snoozes[a.id] = now + s.nag * 60_000L; nags[a.id] = count } else nags.remove(a.id)
        }
        if (due.any { it.kind == "summary" }) showSummary(ctx, doc, s, now)
        due.firstOrNull { it.kind == "focus" }?.let { showFocusDone(ctx, it.title, s) }
        putLongs(ctx, "snoozes", snoozes); putLongs(ctx, "nags", nags)
        schedule(ctx, now)
        Widget.update(ctx)
    }

    fun snooze(ctx: Context, id: String, at: Long) { val m = snoozes(ctx); m[id] = at; putLongs(ctx, "snoozes", m); cancel(ctx, id); schedule(ctx) }

    // The item was answered: no more snooze or nag, notification gone.
    fun answered(ctx: Context, id: String) {
        val m = snoozes(ctx); m.remove(id); putLongs(ctx, "snoozes", m)
        val n = nags(ctx); n.remove(id); putLongs(ctx, "nags", n)
        cancel(ctx, id); schedule(ctx)
    }

    fun cancel(ctx: Context, id: String) = NotificationManagerCompat.from(ctx).cancel(id.hashCode())

    fun test(ctx: Context, loud: Boolean) {
        val pi = PendingIntent.getBroadcast(ctx, 7, Intent(ctx, ReminderReceiver::class.java).setAction(TEST).putExtra("loud", loud), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        ctx.getSystemService(AlarmManager::class.java).set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 5000, pi)
    }

    // ---------- notifications ----------

    // Notification texts follow the language chosen in the app, not only the phone's.
    fun texts(ctx: Context, s: Settings = settings(ctx.prefs())): Context {
        if (s.lang != "fr" && s.lang != "en") return ctx
        val conf = Configuration(ctx.resources.configuration); conf.setLocale(Locale.forLanguageTag(s.lang))
        return ctx.createConfigurationContext(conf)
    }

    fun channels(ctx: Context, t: Context = texts(ctx)) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_REMINDERS, t.getString(R.string.ch_reminders), NotificationManager.IMPORTANCE_HIGH).apply { enableVibration(true) })
        nm.createNotificationChannel(NotificationChannel(CH_IMPORTANT, t.getString(R.string.ch_important), NotificationManager.IMPORTANCE_HIGH).apply {
            enableVibration(true); vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 600)
        })
        nm.createNotificationChannel(NotificationChannel(CH_ALARM, t.getString(R.string.ch_alarm), NotificationManager.IMPORTANCE_HIGH).apply {
            enableVibration(true); vibrationPattern = longArrayOf(0, 800, 400, 800, 400, 800)
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            setBypassDnd(true) // honoured only if the user allows it for this channel
        })
        nm.createNotificationChannel(NotificationChannel(CH_SUMMARY, t.getString(R.string.ch_summary), NotificationManager.IMPORTANCE_LOW))
    }

    private fun canNotify(ctx: Context) = Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    @Suppress("MissingPermission") // checked by canNotify
    private fun post(ctx: Context, id: Int, n: Notification) { if (canNotify(ctx)) NotificationManagerCompat.from(ctx).notify(id, n) }

    fun openApp(ctx: Context, id: String?): PendingIntent = PendingIntent.getActivity(ctx, (id ?: "app").hashCode(),
        Intent(ctx, MainActivity::class.java).setAction(MainActivity.OPEN).putExtra(EXTRA_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun action(ctx: Context, act: String, id: String): PendingIntent = PendingIntent.getBroadcast(ctx, (act + id).hashCode(),
        Intent(ctx, ReminderReceiver::class.java).setAction(act).putExtra(EXTRA_ID, id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun timeText(t: Context, at: Long, now: Long): String {
        val d = at.toLocal(); val today = now.toLocal().toLocalDate()
        val time = d.toLocalTime().format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(t.resources.configuration.locales[0]))
        return when (d.toLocalDate()) {
            today -> time
            today.plusDays(1) -> t.getString(R.string.tomorrow_at, time)
            else -> d.toLocalDate().format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(t.resources.configuration.locales[0])) + " · " + time
        }
    }

    fun show(ctx: Context, a: Alarm, doc: JSONObject, s: Settings, now: Long) {
        val item = findItem(doc, a.id) ?: return
        val t = texts(ctx, s); channels(ctx, t)
        val task = a.kind == "task"
        val allDay = if (task) item.str("due")?.length == 10 else item.str("time") == null
        val parts = mutableListOf<String>()
        parts += if (allDay) t.getString(R.string.all_day) else timeText(t, a.occurrence, now)
        if (!task) { item.str("end")?.let { parts[0] = parts[0] + " – " + it }; item.str("place")?.let { parts += it } }
        if (task && a.occurrence < now - 60_000) parts[0] = t.getString(R.string.late_since, parts[0])
        val steps = item.optJSONArray("steps")?.let { s2 -> (0 until s2.length()).mapNotNull { s2.optJSONObject(it) }.filter { !it.optBoolean("done") }.map { "☐ " + it.optString("text") } }.orEmpty()
        val body = (listOf(parts.joinToString(" · ")) + steps.take(5) + listOfNotNull(item.str("details")?.lines()?.first())).joinToString("\n")
        val channel = if (a.loud) CH_ALARM else if (a.important) CH_IMPORTANT else CH_REMINDERS
        val b = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat).setColor(0xFF6750A4.toInt())
            .setContentTitle(a.title).setContentText(parts.joinToString(" · "))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(if (a.loud) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_REMINDER)
            .setPriority(if (a.loud || a.important) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openApp(ctx, a.id)).setAutoCancel(true)
            .setWhen(a.occurrence).setShowWhen(true)
            .setVisibility(if (s.privateNotifs) NotificationCompat.VISIBILITY_PRIVATE else NotificationCompat.VISIBILITY_PUBLIC)
            .setPublicVersion(NotificationCompat.Builder(ctx, channel).setSmallIcon(R.drawable.ic_stat).setContentTitle(t.getString(R.string.notif_private)).build())
        if (task) b.addAction(R.drawable.ic_check, t.getString(R.string.act_done), action(ctx, DONE, a.id))
        b.addAction(R.drawable.ic_snooze, t.getString(R.string.act_snooze, s.snooze), action(ctx, SNOOZE, a.id))
        if (task) b.addAction(R.drawable.ic_forward, t.getString(R.string.act_tomorrow), action(ctx, TOMORROW, a.id))
        else b.addAction(R.drawable.ic_check, t.getString(R.string.act_ok), action(ctx, STOP, a.id))
        if (a.loud) b.setFullScreenIntent(AlarmActivity.intent(ctx, a, task), true).setOngoing(true).setDeleteIntent(action(ctx, STOP, a.id))
        val n = b.build()
        if (a.loud) n.flags = n.flags or Notification.FLAG_INSISTENT // the sound repeats until answered
        post(ctx, a.id.hashCode(), n)
    }

    private fun showMissed(ctx: Context, rings: List<Alarm>, s: Settings) {
        val t = texts(ctx, s); channels(ctx, t)
        val style = NotificationCompat.InboxStyle()
        rings.take(7).forEach { style.addLine(it.title) }
        if (rings.size > 7) style.setSummaryText(t.getString(R.string.more_n, rings.size - 7))
        post(ctx, "missed".hashCode(), NotificationCompat.Builder(ctx, CH_REMINDERS).setSmallIcon(R.drawable.ic_stat).setColor(0xFF6750A4.toInt())
            .setContentTitle(t.resources.getQuantityString(R.plurals.missed, rings.size, rings.size)).setStyle(style)
            .setContentIntent(openApp(ctx, null)).setAutoCancel(true)
            .setVisibility(if (s.privateNotifs) NotificationCompat.VISIBILITY_PRIVATE else NotificationCompat.VISIBILITY_PUBLIC).build())
    }

    fun showSummary(ctx: Context, doc: JSONObject, s: Settings, now: Long) {
        val prefs = ctx.prefs(); val day = now.toLocal().toLocalDate().toString()
        if (prefs.getString("lastSummary", null) == day) return
        prefs.edit().putString("lastSummary", day).apply()
        val lines = today(doc, now); if (lines.isEmpty()) return
        val t = texts(ctx, s); channels(ctx, t)
        val style = NotificationCompat.InboxStyle()
        lines.take(7).forEach { style.addLine(lineText(t, it)) }
        if (lines.size > 7) style.setSummaryText(t.getString(R.string.more_n, lines.size - 7))
        val late = lines.count { it.late }
        val title = t.resources.getQuantityString(R.plurals.summary_title, lines.size, lines.size) + if (late > 0) " · " + t.resources.getQuantityString(R.plurals.late, late, late) else ""
        post(ctx, "summary".hashCode(), NotificationCompat.Builder(ctx, CH_SUMMARY).setSmallIcon(R.drawable.ic_stat).setColor(0xFF6750A4.toInt())
            .setContentTitle(title).setContentText(lines.take(3).joinToString(", ") { it.text }).setStyle(style)
            .setContentIntent(openApp(ctx, null)).setAutoCancel(true)
            .setVisibility(if (s.privateNotifs) NotificationCompat.VISIBILITY_PRIVATE else NotificationCompat.VISIBILITY_PUBLIC).build())
    }

    fun lineText(t: Context, l: Line): String {
        val time = l.time?.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(t.resources.configuration.locales[0]))
        return (if (l.late) "⚠ " else if (l.task) "☐ " else "• ") + (time?.let { "$it  " } ?: "") + l.text
    }

    private fun showFocusDone(ctx: Context, title: String, s: Settings) {
        val t = texts(ctx, s); channels(ctx, t)
        post(ctx, "focus".hashCode(), NotificationCompat.Builder(ctx, CH_REMINDERS).setSmallIcon(R.drawable.ic_stat).setColor(0xFF6750A4.toInt())
            .setContentTitle(t.getString(R.string.focus_done)).setContentText(t.getString(R.string.focus_text, title))
            .setContentIntent(openApp(ctx, null)).setAutoCancel(true).build())
    }

    fun showTest(ctx: Context, loud: Boolean) {
        val s = settings(ctx.prefs()); val t = texts(ctx, s); channels(ctx, t)
        val now = System.currentTimeMillis()
        val a = Alarm(now, "test", "event", now, t.getString(R.string.test_title), loud, false)
        val b = NotificationCompat.Builder(ctx, if (loud) CH_ALARM else CH_REMINDERS).setSmallIcon(R.drawable.ic_stat).setColor(0xFF6750A4.toInt())
            .setContentTitle(a.title).setContentText(t.getString(R.string.test_text))
            .setCategory(if (loud) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_MAX).setAutoCancel(true).setContentIntent(openApp(ctx, null))
            .addAction(R.drawable.ic_check, t.getString(R.string.act_ok), action(ctx, STOP, "test"))
        if (loud) b.setFullScreenIntent(AlarmActivity.intent(ctx, a, false), true).setOngoing(true).setDeleteIntent(action(ctx, STOP, "test"))
        val n = b.build(); if (loud) n.flags = n.flags or Notification.FLAG_INSISTENT
        post(ctx, "test".hashCode(), n)
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val now = System.currentTimeMillis()
        val id = intent.getStringExtra(Reminders.EXTRA_ID)
        val prefs = ctx.prefs()
        when (intent.action) {
            Reminders.TICK -> return Reminders.tick(ctx, now)
            Reminders.TEST -> return Reminders.showTest(ctx, intent.getBooleanExtra("loud", false))
            Reminders.DONE -> if (id != null) {
                editItem(prefs, id, now) { task, doc ->
                    completeTask(task, now)
                    (doc.optJSONArray("history") ?: JSONArray().also { doc.put("history", it) }).put("$now:$id")
                }
                Reminders.answered(ctx, id)
            }
            Reminders.SNOOZE -> if (id != null) Reminders.snooze(ctx, id, now + settings(prefs).snooze * 60_000L)
            Reminders.TOMORROW -> if (id != null) {
                val task = findItem(loadDoc(prefs), id)
                if (task?.str("repeat") != null) Reminders.snooze(ctx, id, now + 86_400_000L) // a repeating task keeps its series
                else { editItem(prefs, id, now) { t, _ -> postponeTask(t, now) }; Reminders.answered(ctx, id) }
            }
            Reminders.STOP -> if (id != null) Reminders.answered(ctx, id)
            else -> Reminders.schedule(ctx, now) // start-up, update, clock or time-zone change
        }
        Widget.update(ctx)
    }
}

