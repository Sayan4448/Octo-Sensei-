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
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.abs

// One exact alarm, always set at the next thing to ring. When it fires, everything due since the last check rings
// (so reminders missed while the phone was off ring at start-up), then the next one is armed.
object Reminders {
    const val TICK = "com.sayan.todo.TICK"
    const val DONE = "com.sayan.todo.DONE"
    const val UNDO = "com.sayan.todo.UNDO"
    const val SNOOZE = "com.sayan.todo.SNOOZE"
    const val TOMORROW = "com.sayan.todo.TOMORROW"
    const val ALL_TOMORROW = "com.sayan.todo.ALL_TOMORROW"
    const val STOP = "com.sayan.todo.STOP"
    const val TEST = "com.sayan.todo.TEST"
    const val LATER = "com.sayan.todo.LATER" // LATER, CALL and ROUTE open SnoozeActivity
    const val CALL = "com.sayan.todo.CALL"
    const val ROUTE = "com.sayan.todo.ROUTE"
    const val EXTRA_ID = "id"
    const val CH_REMINDERS = "reminders"
    const val CH_IMPORTANT = "important"
    const val CH_ALARM = "alarm"
    const val CH_QUIET = "quiet"
    const val CH_SUMMARY = "summary"
    private const val GROUP = "rings"
    private const val MISSED_WINDOW = 12 * 3_600_000L

    fun snoozes(ctx: Context): MutableMap<String, Long> = longs(ctx, "snoozes")
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
        exact(am, maxOf(next, now), pi)
    }

    private fun exact(am: AlarmManager, at: Long, pi: PendingIntent) =
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)

    // After an edit in the app: what was due in the last minutes still rings, a task just dated in the past does not.
    fun edited(ctx: Context, now: Long = System.currentTimeMillis()) {
        val prefs = ctx.prefs()
        prefs.edit().putLong("lastCheck", maxOf(prefs.getLong("lastCheck", now), now - 5 * 60_000L)).apply()
        schedule(ctx, now)
    }

    fun tick(ctx: Context, now: Long) {
        val prefs = ctx.prefs(); val s = settings(prefs)
        val from = maxOf(prefs.getLong("lastCheck", now), now - MISSED_WINDOW)
        val doc = loadDoc(prefs); val snoozes = snoozes(ctx); val nags = longs(ctx, "nags"); val first = longs(ctx, "nagFirst")
        val due = alarms(doc, Local(snoozes, s.summary, s.focusUntil, s.focusTitle), from, now)
        prefs.edit().putLong("lastCheck", now).apply()
        snoozes.entries.removeAll { it.value <= now }
        val rings = due.filter { it.kind == "task" || it.kind == "event" }.distinctBy { it.id }
        // Several at the same time come as one group (one sound), each with its buttons; alarm-mode ones still ring one by one.
        // A pile missed while the phone was off comes as one notification.
        val (late, onTime) = rings.partition { it.at < now - 120_000 }
        val together = onTime.filter { !it.loud && !s.loudAll }.takeIf { it.size > 1 }.orEmpty()
        onTime.forEach { show(ctx, it, doc, s, now, grouped = it in together) }
        if (together.isNotEmpty()) showGroup(ctx, together, s, now)
        if (late.size > 3) showMissed(ctx, late, doc, s, now) else late.forEach { show(ctx, it, doc, s, now) }
        for (a in rings) { // "remind me again until I answer"; a manual snooze starts the count again
            val count = if (a.snoozed) nags[a.id]?.plus(1) ?: 0L else 0L
            if (count == 0L) first[a.id] = now
            val at = nagAt(s.nag, s.nagTimes, count.toInt(), first[a.id] ?: now, now)
            if (at != null) { snoozes[a.id] = at; nags[a.id] = count } else { nags.remove(a.id); first.remove(a.id) }
        }
        if (due.any { it.kind == "summary" }) showSummary(ctx, doc, s, now)
        due.firstOrNull { it.kind == "focus" }?.let { showFocusDone(ctx, it.title, s, now) }
        putLongs(ctx, "snoozes", snoozes); putLongs(ctx, "nags", nags); putLongs(ctx, "nagFirst", first)
        schedule(ctx, now)
        Widget.update(ctx)
        Backup.later(ctx, now)
    }

    fun snooze(ctx: Context, id: String, at: Long) { val m = snoozes(ctx); m[id] = at; putLongs(ctx, "snoozes", m); forgetNag(ctx, id); cancel(ctx, id); schedule(ctx) }

    // The item was answered: no more snooze or nag, notification gone.
    fun answered(ctx: Context, id: String) {
        val m = snoozes(ctx); m.remove(id); putLongs(ctx, "snoozes", m)
        forgetNag(ctx, id); cancel(ctx, id); schedule(ctx)
    }

    private fun forgetNag(ctx: Context, id: String) = listOf("nags", "nagFirst").forEach { k -> putLongs(ctx, k, longs(ctx, k).apply { remove(id) }) }

    // A task moved from a notification ("Tomorrow", "Later…"): stored like an edit in the app; its old date no longer rings.
    fun moveTask(ctx: Context, id: String, now: Long, change: (JSONObject) -> Unit) {
        if (isTask(loadDoc(ctx.prefs()), id)) editItem(ctx.prefs(), id, now) { t, _ -> change(t) }
        answered(ctx, id); Widget.update(ctx)
    }

    fun cancel(ctx: Context, id: String) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.cancel(id.hashCode())
        // The group of reminders that rang together goes with its last one.
        if (nm.activeNotifications.none { it.notification.group == GROUP && it.id != GROUP.hashCode() }) nm.cancel(GROUP.hashCode())
    }

    // A test reminder in 5 s, or in `minutes` on a real exact alarm (to check it rings with the phone locked).
    fun test(ctx: Context, loud: Boolean, minutes: Int = 0) {
        val pi = PendingIntent.getBroadcast(ctx, 7, Intent(ctx, ReminderReceiver::class.java).setAction(TEST).putExtra("loud", loud), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val am = ctx.getSystemService(AlarmManager::class.java); val now = System.currentTimeMillis()
        if (minutes > 0) exact(am, now + minutes * 60_000L, pi) else am.set(AlarmManager.RTC_WAKEUP, now + 5000, pi)
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
        // Quiet hours: reminders that are not "alarm mode" only vibrate.
        nm.createNotificationChannel(NotificationChannel(CH_QUIET, t.getString(R.string.ch_quiet), NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null); enableVibration(true) })
        nm.createNotificationChannel(NotificationChannel(CH_SUMMARY, t.getString(R.string.ch_summary), NotificationManager.IMPORTANCE_LOW))
    }

    private fun canNotify(ctx: Context) = Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    @Suppress("MissingPermission") // checked by canNotify
    private fun post(ctx: Context, id: Int, n: Notification) { if (canNotify(ctx)) NotificationManagerCompat.from(ctx).notify(id, n) }

    private fun notif(ctx: Context, channel: String) = NotificationCompat.Builder(ctx, channel).setSmallIcon(R.drawable.ic_stat).setColor(0xFF6750A4.toInt())

    // Discreet mode: the lock screen shows only "Mon Orga reminder"; otherwise the phone's own setting applies.
    private fun NotificationCompat.Builder.discreet(ctx: Context, s: Settings, t: Context, channel: String) = apply {
        if (s.privateNotifs) setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(notif(ctx, channel).setContentTitle(t.getString(R.string.notif_private)).build())
    }

    fun openApp(ctx: Context, id: String?): PendingIntent = PendingIntent.getActivity(ctx, (id ?: "app").hashCode(),
        Intent(ctx, MainActivity::class.java).setAction(MainActivity.OPEN).putExtra(EXTRA_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun action(ctx: Context, act: String, id: String): PendingIntent = PendingIntent.getBroadcast(ctx, (act + id).hashCode(),
        Intent(ctx, ReminderReceiver::class.java).setAction(act).putExtra(EXTRA_ID, id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    // Buttons that open a screen (Later…, Call, Directions) go through SnoozeActivity: a notification may start an activity, not a receiver.
    fun screen(ctx: Context, act: String, id: String, data: Uri? = null): PendingIntent = PendingIntent.getActivity(ctx, (act + id).hashCode(),
        Intent(ctx, SnoozeActivity::class.java).setAction(act).setData(data).putExtra(EXTRA_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun timeText(t: Context, at: Long, now: Long): String {
        val d = at.toLocal(); val today = now.toLocal().toLocalDate()
        val time = d.toLocalTime().format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(t.resources.configuration.locales[0]))
        return when (d.toLocalDate()) {
            today -> time
            today.plusDays(1) -> t.getString(R.string.tomorrow_at, time)
            else -> d.toLocalDate().format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(t.resources.configuration.locales[0])) + " · " + time
        }
    }

    // "in 50 min", "late by 2 h 05"
    private fun relative(t: Context, ms: Long): String {
        val m = (abs(ms) + 30_000) / 60_000
        val d = when {
            m < 60 -> t.getString(R.string.dur_min, m)
            m < 1440 -> if (m % 60 == 0L) t.getString(R.string.dur_h, m / 60) else t.getString(R.string.dur_hm, m / 60, m % 60)
            else -> (m / 1440).toInt().let { t.resources.getQuantityString(R.plurals.dur_days, it, it) }
        }
        return t.getString(if (ms >= 0) R.string.in_time else R.string.late_by, d)
    }

    // When a timed item itself is due (a re-ring after a snooze or a nag comes later): the task's date, the event's occurrence.
    private fun dueOf(item: JSONObject, task: Boolean, now: Long): Long? = runCatching {
        if (task) return@runCatching dueTime(item.str("due")!!).millis()
        val start = item.str("day") + "T" + item.str("time")
        nextOccurrence(start, item.str("repeat"), item.date("until"), item.days("skip"), now - MISSED_WINDOW) ?: dueTime(start).millis()
    }.getOrNull()

    fun show(ctx: Context, a: Alarm, doc: JSONObject, s: Settings, now: Long, grouped: Boolean = false) {
        val item = findItem(doc, a.id) ?: return
        val t = texts(ctx, s); channels(ctx, t)
        val task = a.kind == "task"; val loud = a.loud || s.loudAll
        val allDay = if (task) item.str("due")?.length == 10 else item.str("time") == null
        val due = if (a.snoozed && !allDay) dueOf(item, task, now) else null // a re-ring says when: "14:30 · in 50 min"
        var head = if (allDay) t.getString(R.string.all_day) else timeText(t, due ?: a.occurrence, now)
        if (!task) item.str("end")?.let { head += " – $it" }
        if (due != null) head += " · " + relative(t, due - now)
        else if (task && a.occurrence < now - 60_000) head = t.getString(R.string.late_since, head)
        val place = item.str("place")
        val line = listOfNotNull(head, place).joinToString(" · ")
        val steps = item.optJSONArray("steps")?.let { s2 -> (0 until s2.length()).mapNotNull { s2.optJSONObject(it) }.filter { !it.optBoolean("done") }.map { "☐ " + it.optString("text") } }.orEmpty()
        val body = (listOf(line) + steps.take(5) + listOfNotNull(item.str("details")?.lines()?.first())).joinToString("\n")
        val channel = when { loud -> CH_ALARM; s.quiet(now) -> CH_QUIET; a.important -> CH_IMPORTANT; else -> CH_REMINDERS }
        val b = notif(ctx, channel)
            .setContentTitle(a.title).setContentText(line)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(if (loud) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_REMINDER)
            .setPriority(if (loud || a.important) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openApp(ctx, a.id)).setAutoCancel(true) // a tap answers too (MainActivity)
            .setWhen(a.occurrence).setShowWhen(true)
            .discreet(ctx, s, t, channel)
        if (grouped) b.setGroup(GROUP).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_SUMMARY)
        // Tasks: Done, Call / Directions / +N min, Later…  Events: OK, +N min, Directions / Later…
        val call = if (task) phoneIn(item.optString("text")) else null
        val route = place?.let { screen(ctx, ROUTE, a.id, Uri.parse("geo:0,0?q=" + Uri.encode(it))) }
        b.addAction(R.drawable.ic_check, t.getString(if (task) R.string.act_done else R.string.act_ok), action(ctx, if (task) DONE else STOP, a.id))
        when {
            call != null -> b.addAction(R.drawable.ic_forward, t.getString(R.string.act_call), screen(ctx, CALL, a.id, Uri.parse("tel:$call")))
            task && route != null -> b.addAction(R.drawable.ic_forward, t.getString(R.string.act_route), route)
            else -> b.addAction(R.drawable.ic_snooze, t.getString(R.string.act_snooze, s.snooze), action(ctx, SNOOZE, a.id))
        }
        if (!task && route != null) b.addAction(R.drawable.ic_forward, t.getString(R.string.act_route), route)
        else b.addAction(R.drawable.ic_forward, t.getString(R.string.act_later), screen(ctx, LATER, a.id))
        if (loud) b.setFullScreenIntent(AlarmActivity.intent(ctx, a, task), true).setOngoing(true).setDeleteIntent(action(ctx, STOP, a.id))
        val n = b.build()
        if (loud) n.flags = n.flags or Notification.FLAG_INSISTENT // the sound repeats until a button or a tap answers
        post(ctx, a.id.hashCode(), n)
    }

    // The summary of reminders that rang together: the only one that makes a sound.
    private fun showGroup(ctx: Context, rings: List<Alarm>, s: Settings, now: Long) {
        val t = texts(ctx, s)
        val channel = when { s.quiet(now) -> CH_QUIET; rings.any { it.important } -> CH_IMPORTANT; else -> CH_REMINDERS }
        val style = NotificationCompat.InboxStyle().also { st -> rings.take(7).forEach { st.addLine(it.title) } }
        post(ctx, GROUP.hashCode(), notif(ctx, channel).setGroup(GROUP).setGroupSummary(true).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_SUMMARY)
            .setContentTitle(t.resources.getQuantityString(R.plurals.rang_together, rings.size, rings.size)).setContentText(rings.joinToString(", ") { it.title })
            .setStyle(style).setCategory(NotificationCompat.CATEGORY_REMINDER).setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openApp(ctx, null)).setAutoCancel(true).discreet(ctx, s, t, channel).build())
    }

    // After "Done" from a notification, the alarm screen or the widget: "✓ Done: …" with Undo, for 10 seconds.
    fun showUndo(ctx: Context, id: String, before: JSONObject) {
        val s = settings(ctx.prefs()); val t = texts(ctx, s); channels(ctx, t)
        val undo = PendingIntent.getBroadcast(ctx, (UNDO + id).hashCode(), Intent(ctx, ReminderReceiver::class.java).setAction(UNDO).putExtra(EXTRA_ID, id)
            .putExtra("before", before.toString()), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        post(ctx, id.hashCode(), notif(ctx, CH_REMINDERS).setSilent(true).setTimeoutAfter(10_000)
            .setContentTitle(t.getString(if (s.sober) R.string.undo_done_sober else R.string.undo_done, before.optString("text")))
            .setContentIntent(openApp(ctx, id)).setAutoCancel(true)
            .addAction(R.drawable.ic_forward, t.getString(R.string.act_undo), undo)
            .discreet(ctx, s, t, CH_REMINDERS).build())
    }

    private fun showMissed(ctx: Context, rings: List<Alarm>, doc: JSONObject, s: Settings, now: Long) {
        val t = texts(ctx, s); channels(ctx, t)
        val style = NotificationCompat.InboxStyle()
        rings.take(7).forEach { style.addLine(it.title) }
        if (rings.size > 7) style.setSummaryText(t.getString(R.string.more_n, rings.size - 7))
        val channel = if (s.quiet(now)) CH_QUIET else CH_REMINDERS
        val b = notif(ctx, channel).setContentTitle(t.resources.getQuantityString(R.plurals.missed, rings.size, rings.size)).setStyle(style)
            .setContentIntent(openApp(ctx, null)).setAutoCancel(true).discreet(ctx, s, t, channel)
        // "All to tomorrow", like the button of the late section: the overdue tasks of the pile move one day.
        val late = rings.filter { a -> a.kind == "task" && findItem(doc, a.id)?.let { isLate(it, now) } == true }.map { it.id }
        if (late.isNotEmpty()) b.addAction(R.drawable.ic_forward, t.getString(R.string.act_all_tomorrow), PendingIntent.getBroadcast(ctx, ALL_TOMORROW.hashCode(),
            Intent(ctx, ReminderReceiver::class.java).setAction(ALL_TOMORROW).putExtra("ids", late.toTypedArray()), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        post(ctx, "missed".hashCode(), b.build())
    }

    fun showSummary(ctx: Context, doc: JSONObject, s: Settings, now: Long) {
        val prefs = ctx.prefs(); val day = now.toLocal().toLocalDate().toString()
        if (prefs.getString("lastSummary", null) == day) return
        prefs.edit().putString("lastSummary", day).apply()
        val lines = today(doc, now); if (lines.isEmpty()) return
        val t = texts(ctx, s); channels(ctx, t)
        val style = NotificationCompat.InboxStyle()
        lines.take(7).forEach { style.addLine(lineText(t, it, s.sober)) }
        if (lines.size > 7) style.setSummaryText(t.getString(R.string.more_n, lines.size - 7))
        val late = lines.count { it.late }
        val title = t.resources.getQuantityString(if (s.sober) R.plurals.summary_title_sober else R.plurals.summary_title, lines.size, lines.size) +
            if (late > 0) " · " + t.resources.getQuantityString(R.plurals.late, late, late) else ""
        post(ctx, "summary".hashCode(), notif(ctx, CH_SUMMARY)
            .setContentTitle(title).setContentText(lines.take(3).joinToString(", ") { it.text }).setStyle(style)
            .setContentIntent(openApp(ctx, null)).setAutoCancel(true).discreet(ctx, s, t, CH_SUMMARY).build())
    }

    fun lineText(t: Context, l: Line, sober: Boolean = false): String {
        val time = l.time?.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(t.resources.configuration.locales[0]))?.let { "$it  " }.orEmpty()
        return if (sober) "• " + time + l.text + if (l.late) " " + t.getString(R.string.overdue) else ""
        else (if (l.late) "⚠ " else if (l.task) "☐ " else "• ") + time + l.text
    }

    private fun showFocusDone(ctx: Context, title: String, s: Settings, now: Long) {
        val t = texts(ctx, s); channels(ctx, t)
        val channel = if (s.quiet(now)) CH_QUIET else CH_REMINDERS
        val head = when { s.focusPause && s.sober -> R.string.focus_pause_sober; s.focusPause -> R.string.focus_pause; s.sober -> R.string.focus_done_sober; else -> R.string.focus_done }
        post(ctx, "focus".hashCode(), notif(ctx, channel)
            .setContentTitle(t.getString(head)).setContentText(if (s.focusPause) null else t.getString(R.string.focus_text, title))
            .setContentIntent(openApp(ctx, null)).setAutoCancel(true).discreet(ctx, s, t, channel).build())
    }

    fun showTest(ctx: Context, loud: Boolean) {
        val s = settings(ctx.prefs()); val t = texts(ctx, s); channels(ctx, t)
        val now = System.currentTimeMillis()
        val a = Alarm(now, "test", "event", now, t.getString(R.string.test_title), loud, false)
        val b = notif(ctx, if (loud) CH_ALARM else CH_REMINDERS)
            .setContentTitle(a.title).setContentText(t.getString(if (s.sober) R.string.test_text_sober else R.string.test_text))
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
                val doc = loadDoc(prefs); val before = findItem(doc, id)?.takeIf { isTask(doc, id) && !it.optBoolean("done") }
                val done = before != null && editItem(prefs, id, now) { task, d -> completeTask(task, now); d.history().put("$now:$id") }
                Reminders.answered(ctx, id)
                if (done) Reminders.showUndo(ctx, id, before!!)
            }
            // Back as it was before "Done" (newer than the ticked copy, so it wins everywhere); the history cancels that tick.
            Reminders.UNDO -> if (id != null) {
                val before = intent.getStringExtra("before")?.let { runCatching { JSONObject(it) }.getOrNull() }
                if (before != null) editItem(prefs, id, now) { t, doc ->
                    val ticked = t.optLong("updatedAt")
                    t.keys().asSequence().toList().forEach { t.remove(it) }
                    before.keys().forEach { t.put(it, before.get(it)) }
                    t.put("updatedAt", ticked)
                    doc.history().put("$now:$id:x")
                }
                Reminders.answered(ctx, id)
            }
            Reminders.SNOOZE -> if (id != null) Reminders.snooze(ctx, id, now + settings(prefs).snooze * 60_000L)
            Reminders.TOMORROW -> if (id != null) Reminders.moveTask(ctx, id, now) { postponeTask(it, now) }
            Reminders.ALL_TOMORROW -> {
                val doc = loadDoc(prefs)
                for (x in intent.getStringArrayExtra("ids").orEmpty()) {
                    if (findItem(doc, x)?.let { !it.optBoolean("done") && isLate(it, now) } == true) Reminders.moveTask(ctx, x, now) { postponeTask(it, now) }
                }
                Reminders.cancel(ctx, "missed")
            }
            Reminders.STOP -> if (id != null) Reminders.answered(ctx, id)
            else -> Reminders.schedule(ctx, now) // start-up, update, clock or time-zone change
        }
        Widget.update(ctx)
    }
}
