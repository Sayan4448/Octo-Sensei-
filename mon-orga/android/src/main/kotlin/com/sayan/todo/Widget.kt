package com.sayan.todo

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

// Home-screen widget: today's tasks and events, a tap opens the app, "+" adds a task.
class TodayWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) = Widget.update(ctx)
}

object Widget {
    fun update(ctx: Context) {
        val manager = AppWidgetManager.getInstance(ctx) ?: return
        val ids = manager.getAppWidgetIds(ComponentName(ctx, TodayWidget::class.java))
        if (ids.isEmpty()) return
        val t = Reminders.texts(ctx)
        val lines = today(loadDoc(ctx.prefs()), System.currentTimeMillis())
        val views = RemoteViews(ctx.packageName, R.layout.widget_today)
        views.setTextViewText(R.id.widget_title, t.getString(R.string.widget_title) + if (lines.isNotEmpty()) " · ${lines.size}" else "")
        views.setTextViewText(R.id.widget_body, if (lines.isEmpty()) t.getString(R.string.widget_empty)
            else lines.take(6).joinToString("\n") { Reminders.lineText(t, it) } + if (lines.size > 6) "\n" + t.getString(R.string.more_n, lines.size - 6) else "")
        views.setOnClickPendingIntent(R.id.widget_body, Reminders.openApp(ctx, null))
        views.setOnClickPendingIntent(R.id.widget_title, Reminders.openApp(ctx, null))
        views.setOnClickPendingIntent(R.id.widget_add, PendingIntent.getActivity(ctx, 41,
            Intent(ctx, MainActivity::class.java).setAction(MainActivity.ADD_TASK).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        manager.updateAppWidget(ids, views)
    }
}
