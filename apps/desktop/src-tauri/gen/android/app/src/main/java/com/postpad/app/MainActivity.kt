package com.postpad.app

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import com.postpad.app.widget.WidgetBridge
import com.postpad.app.widget.WidgetStore

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    intent?.getStringExtra(WidgetStore.EXTRA_ENTRY)?.let { WidgetBridge.pendingEntry = it }
  }

  // The web UI syncs the pad to the home-screen widgets through window.PostPadWidgets.
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(WidgetBridge(applicationContext), "PostPadWidgets")
  }

  // A widget tap while the app is running: hand the entry to the web UI.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    intent.getStringExtra(WidgetStore.EXTRA_ENTRY)?.let {
      WidgetBridge.pendingEntry = it
      webView?.evaluateJavascript("window.dispatchEvent(new Event('postpad-widget-open'))", null)
    }
  }
}
