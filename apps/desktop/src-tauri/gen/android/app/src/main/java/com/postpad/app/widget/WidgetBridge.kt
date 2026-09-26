package com.postpad.app.widget

import android.content.Context
import android.webkit.JavascriptInterface

/**
 * Exposed to the app's web UI as `window.PostPadWidgets`. The app calls sync() after every
 * pad fetch (and with an empty key when it leaves the PO Box); takeOpenEntry() hands the
 * web UI the entry a widget tap asked to open.
 */
class WidgetBridge(private val c: Context) {
    @JavascriptInterface
    fun sync(base: String, key: String, entriesJson: String) {
        WidgetStore.save(c, base, key, if (key.isEmpty()) null else entriesJson)
        WidgetStore.updateAll(c)
    }

    @JavascriptInterface
    fun takeOpenEntry(): String = (pendingEntry ?: "").also { pendingEntry = null }

    companion object {
        @Volatile var pendingEntry: String? = null
    }
}
