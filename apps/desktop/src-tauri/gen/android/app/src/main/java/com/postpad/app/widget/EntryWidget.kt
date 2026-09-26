package com.postpad.app.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StyleSpan
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import android.widget.TextView
import com.postpad.app.R

/** Resizable widget pinned to one entry: its title, who delivered it and when, and its body. */
class EntryWidget : AppWidgetProvider() {
    override fun onUpdate(c: Context, m: AppWidgetManager, ids: IntArray) {
        render(c, m, ids)
        refreshInBackground(this, c)
    }

    override fun onReceive(c: Context, intent: Intent) {
        super.onReceive(c, intent)
        if (intent.action == PadWidget.ACTION_REFRESH) refreshInBackground(this, c)
    }

    override fun onDeleted(c: Context, ids: IntArray) { ids.forEach { WidgetStore.forget(c, it) } }

    companion object {
        fun render(c: Context, m: AppWidgetManager, ids: IntArray) {
            val entries = WidgetStore.entries(c)
            for (id in ids) {
                val entryId = WidgetStore.entryIdFor(c, id)
                val e = entries.firstOrNull { it.id == entryId }
                val v = RemoteViews(c.packageName, R.layout.widget_entry)
                v.setTextViewText(R.id.title, e?.title ?: c.getString(R.string.app_name))
                v.setTextViewText(R.id.meta, when {
                    e == null -> ""
                    e.markdown.isBlank() -> c.getString(R.string.widget_no_mail)
                    else -> listOfNotNull(e.source, WidgetStore.age(e.updatedAt)).joinToString(" · ")
                })
                val svc = Intent(c, EntryWidgetService::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                    data = Uri.parse("postpad://entry/$id")
                }
                @Suppress("DEPRECATION") v.setRemoteAdapter(R.id.list, svc)
                v.setEmptyView(R.id.list, R.id.empty)
                v.setTextViewText(R.id.empty, c.getString(when {
                    !WidgetStore.hasBox(c) -> R.string.widget_no_box
                    entryId == null -> R.string.widget_pick_entry
                    e == null -> R.string.widget_entry_gone
                    else -> R.string.widget_no_mail
                }))
                v.setOnClickPendingIntent(R.id.header, openApp(c, e?.id, id))
                v.setOnClickPendingIntent(R.id.refresh, refreshIntent(c, EntryWidget::class.java, id))
                v.setPendingIntentTemplate(R.id.list, openTemplate(c, id))
                m.updateAppWidget(id, v)
            }
            @Suppress("DEPRECATION") m.notifyAppWidgetViewDataChanged(ids, R.id.list)
        }
    }
}

class EntryWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = object : RemoteViewsFactory {
        val widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 0)
        var entryId: String? = null
        var lines: List<Line> = emptyList()
        override fun onCreate() {}
        override fun onDataSetChanged() {
            entryId = WidgetStore.entryIdFor(applicationContext, widgetId)
            lines = WidgetStore.entries(applicationContext).firstOrNull { it.id == entryId }?.let { WidgetStore.lines(it.markdown) } ?: emptyList()
        }
        override fun onDestroy() {}
        override fun getCount() = lines.size
        override fun getViewAt(i: Int): RemoteViews {
            val l = lines[i]
            val text = if (l.heading) SpannableString(l.text).apply { setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) } else l.text
            return RemoteViews(packageName, R.layout.widget_line).apply {
                setTextViewText(R.id.line, text)
                setOnClickFillInIntent(R.id.line, Intent().putExtra(WidgetStore.EXTRA_ENTRY, entryId))
            }
        }
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 1
        override fun getItemId(i: Int) = i.toLong()
        override fun hasStableIds() = false
    }
}

/** Shown when an entry widget is added (or reconfigured): pick which entry it pins. */
class EntryWidgetConfigure : Activity() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        widgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: widgetId
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return finish()
        setTitle(R.string.widget_pick_title)
        show()
        if (WidgetStore.entries(this).isEmpty() && WidgetStore.hasBox(this))
            Thread { if (WidgetStore.refresh(this)) runOnUiThread { show() } }.start()
    }

    private fun show() {
        val entries = WidgetStore.entries(this)
        if (entries.isEmpty()) {
            setContentView(TextView(this).apply {
                setText(if (WidgetStore.hasBox(this@EntryWidgetConfigure)) R.string.widget_no_entries else R.string.widget_no_box)
                setPadding(48, 48, 48, 48); textSize = 16f
            })
            return
        }
        setContentView(ListView(this).apply {
            adapter = ArrayAdapter(this@EntryWidgetConfigure, android.R.layout.simple_list_item_1, entries.map { it.title })
            setOnItemClickListener { _, _, pos, _ ->
                val c = this@EntryWidgetConfigure
                WidgetStore.setEntryFor(c, widgetId, entries[pos].id)
                EntryWidget.render(c, AppWidgetManager.getInstance(c), intArrayOf(widgetId))
                setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
                finish()
            }
        })
    }
}
