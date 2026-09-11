package com.momo.ktv.tv.ui

import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.momo.ktv.tv.R
import com.momo.ktv.tv.data.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ServerConfigActivity : AppCompatActivity() {
    companion object {
        private const val PREFS_NAME = "momo_ktv_prefs"
        private const val KEY_SERVER_URL = "server_url"
    }

    private lateinit var prefs: SharedPreferences
    private lateinit var etServerURL: EditText
    private lateinit var btnSave: Button
    private lateinit var btnTest: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_server_config)

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        etServerURL = findViewById(R.id.etServerURL)
        btnSave = findViewById(R.id.btnSave)
        btnTest = findViewById(R.id.btnTest)

        etServerURL.setText(prefs.getString(KEY_SERVER_URL, "192.168.1.100:3000"))

        btnTest.setOnClickListener {
            val url = etServerURL.text.toString().trim()
            if (url.isEmpty()) {
                Toast.makeText(this, "请输入服务器地址", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            testConnection(url)
        }

        btnSave.setOnClickListener {
            val url = etServerURL.text.toString().trim()
            if (url.isEmpty()) {
                Toast.makeText(this, "请输入服务器地址", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            prefs.edit().putString(KEY_SERVER_URL, url).apply()
            Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }
    }

    private fun testConnection(url: String) {
        btnTest.isEnabled = false
        btnTest.text = "测试中..."
        lifecycleScope.launch {
            val api = ApiClient(url)
            val stats = withContext(Dispatchers.IO) {
                try {
                    api.fetchStats()
                } catch (e: Exception) {
                    null
                }
            }
            withContext(Dispatchers.Main) {
                btnTest.isEnabled = true
                btnTest.text = "测试连接"
                if (stats != null) {
                    Toast.makeText(
                        this@ServerConfigActivity,
                        "连接成功！歌曲: ${stats.totalSongs ?: 0}",
                        Toast.LENGTH_SHORT
                    ).show()
                } else {
                    Toast.makeText(
                        this@ServerConfigActivity,
                        "连接失败，请检查地址",
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        }
    }
}
