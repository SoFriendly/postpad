package com.postpad.app.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.text.format.DateUtils
import com.postpad.app.R
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale

/** One pad entry, as the widgets need it. */
data class WEntry(val id: String, val title: String, val updatedAt: String, val markdown: String, val source: String?)

/** A widget line of an entry body: markdown flattened to text, headings marked. */
data class Line(val text: String, val heading: Boolean)

/**
 * The widgets' cache of the pad plus what they need to refresh it themselves.
 * Written by the app (WidgetBridge.sync) whenever it syncs, and by the widgets'
 * own background refresh (GET /v1/pad with the saved box key).
 */
object WidgetStore {
    const val EXTRA_ENTRY = "com.postpad.app.ENTRY"
    private const val PREFS = "postpad_widgets"
    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun save(c: Context, base: String, key: String, entriesJson: String?) {
        prefs(c).edit().apply {
            putString("base", base.trimEnd('/'))
            putString("key", key)
            if (entriesJson != null) putString("entries", entriesJson) else remove("entries")
            putLong("synced", System.currentTimeMillis())
        }.apply()
    }

    fun hasBox(c: Context) = !prefs(c).getString("key", null).isNullOrEmpty()
    fun syncedAt(c: Context) = prefs(c).getLong("synced", 0)
    fun entryIdFor(c: Context, widgetId: Int): String? = prefs(c).getString("entry_$widgetId", null)
    fun setEntryFor(c: Context, widgetId: Int, entryId: String) = prefs(c).edit().putString("entry_$widgetId", entryId).apply()
    fun forget(c: Context, widgetId: Int) = prefs(c).edit().remove("entry_$widgetId").apply()

    fun entries(c: Context): List<WEntry> = try {
        val a = JSONArray(prefs(c).getString("entries", "[]"))
        (0 until a.length()).map { i ->
            val o = a.getJSONObject(i)
            WEntry(o.getString("id"), o.optString("title"), o.optString("updated_at"), o.optString("markdown"),
                if (o.isNull("source")) null else o.optString("source"))
        }
    } catch (e: Exception) { emptyList() }

    /** Fetch the whole pad with the saved key. Blocking: call off the main thread. */
    fun refresh(c: Context): Boolean {
        val p = prefs(c)
        val base = p.getString("base", null) ?: return false
        val key = p.getString("key", null)?.takeIf { it.isNotEmpty() } ?: return false
        return try {
            val conn = (URL("$base/v1/pad").openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000; readTimeout = 8000
                setRequestProperty("Authorization", "Bearer $key")
            }
            if (conn.responseCode != 200) return false
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val entries = JSONObject(body).getJSONArray("entries")
            p.edit().putString("entries", entries.toString()).putLong("synced", System.currentTimeMillis()).apply()
            true
        } catch (e: Exception) { false }
    }

    /** Redraw every PostPad widget from the cache (no network). */
    fun updateAll(c: Context) {
        val m = AppWidgetManager.getInstance(c)
        val pad = m.getAppWidgetIds(ComponentName(c, PadWidget::class.java))
        if (pad.isNotEmpty()) PadWidget.render(c, m, pad)
        val one = m.getAppWidgetIds(ComponentName(c, EntryWidget::class.java))
        if (one.isNotEmpty()) EntryWidget.render(c, m, one)
    }

    fun age(iso: String): CharSequence {
        val t = parseIso(iso) ?: return ""
        return DateUtils.getRelativeTimeSpanString(t, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE)
    }

    fun syncedLabel(c: Context): String {
        val t = syncedAt(c)
        if (t == 0L) return ""
        return c.getString(R.string.widget_synced, DateUtils.getRelativeTimeSpanString(t, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE))
    }

    private fun parseIso(s: String): Long? =
        listOf("yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX").firstNotNullOfOrNull { f ->
            try { SimpleDateFormat(f, Locale.US).parse(s)?.time } catch (e: Exception) { null }
        }

    /** Entry body as widget lines: markers dropped, bullets kept, tables as spaced columns. */
    fun lines(md: String): List<Line> {
        val out = mutableListOf<Line>()
        var fence = false
        for (raw in md.lines()) {
            val l = raw.trimEnd()
            if (l.trimStart().startsWith("```")) { fence = !fence; continue }
            if (fence) { out += Line(l, false); continue }
            if (Regex("^\\s*\\|?\\s*:?-{3,}").containsMatchIn(l)) continue // table separator row
            val heading = l.trimStart().startsWith("#")
            var t = l.replace(Regex("^\\s*#{1,6}\\s*"), "").replace(Regex("^\\s*[-*+]\\s+"), "• ")
                .replace("**", "").replace("__", "").replace("`", "")
            if (t.contains("|")) t = t.trim().trim('|').split("|").joinToString("   ") { it.trim() }
            if (t.isBlank() && (out.isEmpty() || out.last().text.isBlank())) continue
            out += Line(t, heading)
        }
        return out.dropLastWhile { it.text.isBlank() }
    }

    /** One-line summary: the first non-heading line (agent cards open with a "## <icon> <name>" heading). */
    fun summary(md: String): String =
        lines(md).firstOrNull { !it.heading && it.text.isNotBlank() }?.text ?: lines(md).firstOrNull()?.text ?: ""
}
