package com.momo.ktv.tv

import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class ServerConfigActivity : AppCompatActivity() {

    private lateinit var serverInput: EditText
    private lateinit var connectButton: Button
    private lateinit var statusText: TextView
    private lateinit var prefs: SharedPreferences
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_server_config)

        prefs = getSharedPreferences("momo_ktv", MODE_PRIVATE)

        serverInput = findViewById(R.id.serverInput)
        connectButton = findViewById(R.id.connectButton)
        statusText = findViewById(R.id.statusText)

        // 恢复上次的服务器地址
        val savedServer = prefs.getString("server_address", "")
        if (!savedServer.isNullOrEmpty()) {
            serverInput.setText(savedServer)
        }

        // 回车键连接
        serverInput.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_DONE ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER)) {
                connectToServer()
                true
            } else false
        }

        connectButton.setOnClickListener {
            connectToServer()
        }

        // 如果已有保存的服务器，自动尝试连接
        if (!savedServer.isNullOrEmpty()) {
            handler.postDelayed({
                connectToServer()
            }, 500)
        }
    }

    private fun connectToServer() {
        var server = serverInput.text.toString().trim()
        if (server.isEmpty()) {
            statusText.text = "请输入服务器地址"
            return
        }

        // 补全协议
        if (!server.startsWith("http://") && !server.startsWith("https://")) {
            server = "http://$server"
        }

        connectButton.isEnabled = false
        connectButton.text = getString(R.string.connecting)
        statusText.text = ""

        executor.execute {
            try {
                val url = URL("$server/api/stats")
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.requestMethod = "GET"
                val code = conn.responseCode
                conn.disconnect()

                if (code == 200) {
                    // 保存服务器地址
                    prefs.edit().putString("server_address", server).apply()

                    handler.post {
                        connectButton.isEnabled = true
                        connectButton.text = getString(R.string.connect_button)
                        statusText.text = "连接成功！"
                        statusText.setTextColor(getColor(R.color.accent_cyan))

                        // 跳转到主界面
                        handler.postDelayed({
                            val intent = Intent(this, MainActivity::class.java)
                            intent.putExtra("server_url", server)
                            startActivity(intent)
                            finish()
                        }, 300)
                    }
                } else {
                    handler.post {
                        connectButton.isEnabled = true
                        connectButton.text = getString(R.string.connect_button)
                        statusText.text = "服务器响应异常 (HTTP $code)"
                    }
                }
            } catch (e: Exception) {
                handler.post {
                    connectButton.isEnabled = true
                    connectButton.text = getString(R.string.connect_button)
                    statusText.text = getString(R.string.connection_failed)
                }
            }
        }
    }
}
