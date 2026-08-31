package com.momo.ktv.tv

import android.annotation.SuppressLint
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var loadingProgress: ProgressBar
    private lateinit var prefs: SharedPreferences
    private var serverUrl: String = ""
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences("momo_ktv", MODE_PRIVATE)

        // 获取服务器地址
        serverUrl = intent.getStringExtra("server_url")
            ?: prefs.getString("server_address", "")
            ?: ""

        if (serverUrl.isEmpty()) {
            // 没有服务器地址，回到配置页面
            startActivity(Intent(this, ServerConfigActivity::class.java))
            finish()
            return
        }

        webView = findViewById(R.id.webView)
        loadingProgress = findViewById(R.id.loadingProgress)

        setupWebView()

        // 加载网页TV端
        val tvUrl = if (serverUrl.endsWith("/")) {
            "${serverUrl}tv/"
        } else {
            "$serverUrl/tv/"
        }
        webView.loadUrl(tvUrl)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings: WebSettings = webView.settings

        // 基础设置
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.setSupportZoom(false)

        // 缓存设置
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // 媒体播放设置
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        // 文件访问
        settings.allowFileAccess = true
        settings.allowContentAccess = true

        // WebViewClient
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                loadingProgress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                loadingProgress.visibility = View.GONE
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false
                // 同域名的链接在WebView内打开
                if (url.contains(serverUrl) || url.startsWith("/")) {
                    return false
                }
                // 外部链接用系统浏览器打开
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (e: Exception) {
                    // 忽略
                }
                return true
            }
        }

        // WebChromeClient（处理全屏视频）
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (customView != null) {
                    callback?.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                (window.decorView as FrameLayout).addView(
                    customView,
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )
                webView.visibility = View.GONE
            }

            override fun onHideCustomView() {
                if (customView == null) return
                (window.decorView as FrameLayout).removeView(customView)
                customView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                webView.visibility = View.VISIBLE
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // 处理遥控器按键
        when (keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                if (customView != null) {
                    // 全屏视频时，返回键退出全屏
                    webView.webChromeClient?.onHideCustomView()
                    return true
                }
                if (webView.canGoBack()) {
                    webView.goBack()
                    return true
                }
                // 不能返回时，回到服务器配置页面（长按返回可退出）
                return super.onKeyDown(keyCode, event)
            }
            KeyEvent.KEYCODE_MENU -> {
                // 菜单键：重新加载页面
                webView.reload()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        if (customView != null) {
            (window.decorView as FrameLayout).removeView(customView)
            customView = null
        }
        webView.destroy()
        super.onDestroy()
    }
}
