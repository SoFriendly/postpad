package com.postpad.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import com.postpad.app.MainActivity
import com.postpad.app.R

/** Resizable widget: the pad's entries (title, age, sender, one-line summary). Tap one to open it. */
class PadWidget : AppWidgetProvider() {
    override fun onUpdate(c: Context, m: AppWidgetManager, ids: IntArray) {
        render(c, m, ids)
        refreshInBackground(this, c)
    }

    override fun onReceive(c: Context, intent: Intent) {
        super.onReceive(c, intent)
        if (intent.action == ACTION_REFRESH) refreshInBackground(this, c)
    }

    companion object {
        const val ACTION_REFRESH = "com.postpad.app.widget.REFRESH"

        fun render(c: Context, m: AppWidgetManager, ids: IntArray) {
            for (id in ids) {
                val v = RemoteViews(c.packageName, R.layout.widget_pad)
                v.setTextViewText(R.id.synced, WidgetStore.syncedLabel(c))
                val svc = Intent(c, PadWidgetService::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                    data = Uri.parse("postpad://pad/$id")
                }
                @Suppress("DEPRECATION") v.setRemoteAdapter(R.id.list, svc)
                v.setEmptyView(R.id.list, R.id.empty)
                v.setTextViewText(R.id.empty, c.getString(if (WidgetStore.hasBox(c)) R.string.widget_no_entries else R.string.widget_no_box))
                v.setOnClickPendingIntent(R.id.header, openApp(c, null, id))
                v.setOnClickPendingIntent(R.id.refresh, refreshIntent(c, PadWidget::class.java, id))
                v.setPendingIntentTemplate(R.id.list, openTemplate(c, id))
                m.updateAppWidget(id, v)
            }
            @Suppress("DEPRECATION") m.notifyAppWidgetViewDataChanged(ids, R.id.list)
        }
    }
}

class PadWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = object : RemoteViewsFactory {
        var items: List<WEntry> = emptyList()
        override fun onCreate() {}
        override fun onDataSetChanged() { items = WidgetStore.entries(applicationContext) }
        override fun onDestroy() {}
        override fun getCount() = items.size
        override fun getViewAt(i: Int): RemoteViews {
            val e = items[i]
            return RemoteViews(packageName, R.layout.widget_pad_item).apply {
                setTextViewText(R.id.title, e.title)
                setTextViewText(R.id.age, WidgetStore.age(e.updatedAt))
                val summary = if (e.markdown.isBlank()) getString(R.string.widget_no_mail) else WidgetStore.summary(e.markdown)
                setTextViewText(R.id.summary, listOfNotNull(e.source, summary).joinToString(" · "))
                setOnClickFillInIntent(R.id.item, Intent().putExtra(WidgetStore.EXTRA_ENTRY, e.id))
            }
        }
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 1
        override fun getItemId(i: Int) = items[i].id.hashCode().toLong()
        override fun hasStableIds() = true
    }
}

/* ---- shared widget plumbing ---------------------------------------------- */

/** Fetch the pad off the main thread, then redraw every widget. */
internal fun refreshInBackground(receiver: android.content.BroadcastReceiver, c: Context) {
    val pending = receiver.goAsync()
    Thread {
        try { if (WidgetStore.refresh(c)) WidgetStore.updateAll(c) } finally { pending.finish() }
    }.start()
}

internal fun openApp(c: Context, entryId: String?, requestCode: Int): PendingIntent {
    val i = Intent(c, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        if (entryId != null) putExtra(WidgetStore.EXTRA_ENTRY, entryId)
    }
    return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

/** List items fill in the entry id, so the template must be mutable. */
internal fun openTemplate(c: Context, requestCode: Int): PendingIntent {
    val i = Intent(c, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP }
    return PendingIntent.getActivity(c, 10_000 + requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
}

internal fun refreshIntent(c: Context, provider: Class<*>, requestCode: Int): PendingIntent =
    PendingIntent.getBroadcast(c, 20_000 + requestCode, Intent(c, provider).setAction(PadWidget.ACTION_REFRESH),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
