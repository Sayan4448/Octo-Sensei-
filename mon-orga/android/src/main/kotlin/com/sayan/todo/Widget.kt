package com.sayan.todo

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

// Home-screen widget: today's tasks (the round button ticks one) then events, a tap opens the item, "+" adds a task,
// the mic dictates one. With the lock or discreet notifications on, it only says how many there are.
class TodayWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) = Widget.update(ctx)
}

object Widget {
    fun hidden(s: Settings) = s.lock || s.privateNotifs
    fun lines(ctx: Context): List<Line> = today(loadDoc(ctx.prefs()), System.currentTimeMillis()).sortedBy { !it.task }

    @Suppress("DEPRECATION") // setRemoteAdapter(Intent): the list API that works from Android 8
    fun update(ctx: Context) {
        val manager = AppWidgetManager.getInstance(ctx) ?: return
        val ids = manager.getAppWidgetIds(ComponentName(ctx, TodayWidget::class.java))
        if (ids.isEmpty()) return
        val s = settings(ctx.prefs()); val t = Reminders.texts(ctx, s)
        val lines = lines(ctx)
        val views = RemoteViews(ctx.packageName, R.layout.widget_today)
        views.setTextViewText(R.id.widget_title, t.getString(R.string.widget_title) + if (lines.isNotEmpty()) " · ${lines.size}" else "")
        views.setTextViewText(R.id.widget_empty, if (hidden(s) && lines.isNotEmpty()) counts(t, lines) else t.getString(R.string.widget_empty))
        views.setRemoteAdapter(R.id.widget_list, Intent(ctx, WidgetService::class.java))
        views.setEmptyView(R.id.widget_list, R.id.widget_empty)
        // Each row fills in DONE or OPEN and its id; SnoozeActivity relays them.
        views.setPendingIntentTemplate(R.id.widget_list, PendingIntent.getActivity(ctx, 44, Intent(ctx, SnoozeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0))
        views.setOnClickPendingIntent(R.id.widget_title, Reminders.openApp(ctx, null))
        views.setOnClickPendingIntent(R.id.widget_empty, Reminders.openApp(ctx, null))
        views.setOnClickPendingIntent(R.id.widget_add, open(ctx, MainActivity.ADD_TASK))
        views.setOnClickPendingIntent(R.id.widget_voice, open(ctx, MainActivity.VOICE))
        manager.updateAppWidget(ids, views)
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list)
    }

    private fun open(ctx: Context, action: String) = PendingIntent.getActivity(ctx, action.hashCode(),
        Intent(ctx, MainActivity::class.java).setAction(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    // "3 tasks today · 1 event"
    fun counts(t: Context, lines: List<Line>): String = listOf(lines.count { it.task } to R.plurals.widget_tasks, lines.count { !it.task } to R.plurals.widget_events)
        .filter { it.first > 0 }.joinToString(" · ") { (n, plural) -> t.resources.getQuantityString(plural, n, n) }
}

// The widget's rows.
class WidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = object : RemoteViewsFactory {
        private var lines = emptyList<Line>()
        override fun onDataSetChanged() { lines = if (Widget.hidden(settings(prefs()))) emptyList() else Widget.lines(this@WidgetService) }
        override fun getViewAt(position: Int): RemoteViews {
            val views = RemoteViews(packageName, R.layout.widget_row)
            val l = lines.getOrNull(position) ?: return views
            val t = Reminders.texts(this@WidgetService)
            val time = l.time?.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(t.resources.configuration.locales[0]))
            views.setTextViewText(R.id.row_text, (time?.let { "$it  " } ?: "") + l.text)
            views.setTextColor(R.id.row_text, getColor(if (l.late) R.color.late else R.color.on_surface))
            views.setViewVisibility(R.id.row_check, if (l.task) View.VISIBLE else View.INVISIBLE)
            views.setContentDescription(R.id.row_check, t.getString(R.string.act_done) + " : " + l.text)
            views.setOnClickFillInIntent(R.id.row_check, Intent(Reminders.DONE).putExtra(Reminders.EXTRA_ID, l.id))
            views.setOnClickFillInIntent(R.id.row_text, Intent(MainActivity.OPEN).putExtra(Reminders.EXTRA_ID, l.id))
            return views
        }
        override fun getCount() = lines.size
        override fun onCreate() {}
        override fun onDestroy() {}
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 1
        override fun getItemId(position: Int) = position.toLong()
        override fun hasStableIds() = false
    }
}

// Quick Settings tile "New task": the app opens on the new task's field, keyboard up.
class AddTaskTile : TileService() {
    override fun onClick() = unlockAndRun {
        val i = Intent(this, MainActivity::class.java).setAction(MainActivity.ADD_TASK).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 43, i, PendingIntent.FLAG_IMMUTABLE))
        else @Suppress("DEPRECATION") startActivityAndCollapse(i)
    }
}
