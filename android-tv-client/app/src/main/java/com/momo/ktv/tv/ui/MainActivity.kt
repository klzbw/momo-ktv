package com.momo.ktv.tv.ui

import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.momo.ktv.tv.R
import com.momo.ktv.tv.data.ApiClient
import com.momo.ktv.tv.data.QueueItem
import com.momo.ktv.tv.data.Song
import com.momo.ktv.tv.data.WebSocketClient
import com.momo.ktv.tv.lyrics.LyricsView
import com.momo.ktv.tv.player.PlayerManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {
    companion object {
        private const val TAG = "MainActivity"
        private const val PREFS_NAME = "momo_ktv_prefs"
        private const val KEY_SERVER_URL = "server_url"
    }

    private lateinit var prefs: SharedPreferences
    private lateinit var apiClient: ApiClient
    private lateinit var wsClient: WebSocketClient
    private lateinit var playerManager: PlayerManager

    private lateinit var playerView: PlayerView
    private lateinit var lyricsView: LyricsView
    private lateinit var tvSongInfo: TextView
    private lateinit var tvVoice: TextView
    private lateinit var tvQueueTitle: TextView
    private lateinit var rvQueue: RecyclerView
    private lateinit var btnPlayPause: Button
    private lateinit var btnVoice: Button
    private lateinit var btnPrev: Button
    private lateinit var btnNext: Button
    private lateinit var btnConfig: Button

    private lateinit var queueAdapter: QueueAdapter
    private var queueItems: MutableList<QueueItem> = mutableListOf()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val serverURL = prefs.getString(KEY_SERVER_URL, "") ?: ""

        if (serverURL.isEmpty()) {
            startActivity(Intent(this, ServerConfigActivity::class.java))
            finish()
            return
        }

        initClients(serverURL)
        initViews()
        initPlayer()
        connect()
    }

    private fun initClients(serverURL: String) {
        apiClient = ApiClient(serverURL)
        wsClient = WebSocketClient(apiClient, lifecycleScope)
        wsClient.onQueueUpdate = { items ->
            runOnUiThread { updateQueue(items) }
        }
        wsClient.onControl = { action, payload ->
            runOnUiThread { handleControl(action, payload) }
        }
        wsClient.onConnected = {
            runOnUiThread {
                Toast.makeText(this, "已连接服务器", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun initViews() {
        playerView = findViewById(R.id.playerView)
        lyricsView = findViewById(R.id.lyricsView)
        tvSongInfo = findViewById(R.id.tvSongInfo)
        tvVoice = findViewById(R.id.tvVoice)
        tvQueueTitle = findViewById(R.id.tvQueueTitle)
        rvQueue = findViewById(R.id.rvQueue)
        btnPlayPause = findViewById(R.id.btnPlayPause)
        btnVoice = findViewById(R.id.btnVoice)
        btnPrev = findViewById(R.id.btnPrev)
        btnNext = findViewById(R.id.btnNext)
        btnConfig = findViewById(R.id.btnConfig)

        queueAdapter = QueueAdapter(queueItems) { item ->
            playQueueItem(item)
        }
        rvQueue.layoutManager = LinearLayoutManager(this)
        rvQueue.adapter = queueAdapter

        btnPlayPause.setOnClickListener { playerManager.togglePlayPause() }
        btnVoice.setOnClickListener {
            playerManager.toggleVoice()
            tvVoice.text = "声道: ${playerManager.getCurrentVoice()}"
        }
        btnPrev.setOnClickListener { playPrevious() }
        btnNext.setOnClickListener { playNext() }
        btnConfig.setOnClickListener {
            startActivity(Intent(this, ServerConfigActivity::class.java))
        }
    }

    private fun initPlayer() {
        playerManager = PlayerManager(this, apiClient, wsClient, lifecycleScope)
        playerView.player = playerManager.player
        playerView.useController = false

        playerManager.onPlaybackStateChanged = { playing ->
            runOnUiThread {
                btnPlayPause.text = if (playing) "暂停" else "播放"
            }
        }
        playerManager.onProgressChanged = { current, duration ->
            runOnUiThread {
                lyricsView.updateProgress(current)
            }
        }
        playerManager.onError = { err ->
            runOnUiThread {
                Toast.makeText(this, "播放错误: $err", Toast.LENGTH_LONG).show()
            }
        }
        playerManager.onTracksChanged = { count ->
            runOnUiThread {
                tvVoice.text = "声道: ${playerManager.getCurrentVoice()} (${count}轨)"
                btnVoice.visibility = if (count >= 2) View.VISIBLE else View.GONE
            }
        }
        playerManager.onPlaybackEnded = {
            runOnUiThread { playNext() }
        }
    }

    private fun connect() {
        wsClient.connect()
        lifecycleScope.launch {
            val queue = apiClient.fetchQueue()
            withContext(Dispatchers.Main) { updateQueue(queue) }
        }
    }

    private fun updateQueue(items: List<QueueItem>) {
        queueItems.clear()
        queueItems.addAll(items)
        queueAdapter.notifyDataSetChanged()
        tvQueueTitle.text = "点歌队列 (${items.size})"
        // 自动播放正在播放的项
        val playing = items.firstOrNull { it.isPlaying }
        if (playing != null && !playerManager.isPlaying()) {
            playQueueItem(playing)
        }
    }

    private fun playQueueItem(item: QueueItem) {
        if (item.filepath.isNullOrEmpty()) {
            Toast.makeText(this, "歌曲无文件路径", Toast.LENGTH_SHORT).show()
            return
        }
        tvSongInfo.text = "${item.displayTitle} - ${item.displayArtist}"
        lyricsView.clear()
        playerManager.playQueueItem(item)
        // 尝试获取歌词
        lifecycleScope.launch {
            val sepInfo = apiClient.fetchSepInfo(item.songId)
            // 歌词可通过 /api/lyrics/{songId} 获取（如果服务端支持）
        }
    }

    private fun playPrevious() {
        val currentIdx = queueItems.indexOfFirst { it.isPlaying }
        if (currentIdx > 0) {
            playQueueItem(queueItems[currentIdx - 1])
        }
    }

    private fun playNext() {
        val currentIdx = queueItems.indexOfFirst { it.isPlaying }
        if (currentIdx >= 0 && currentIdx < queueItems.size - 1) {
            playQueueItem(queueItems[currentIdx + 1])
        } else if (queueItems.isNotEmpty()) {
            playQueueItem(queueItems.first())
        }
    }

    private fun handleControl(action: String, payload: Map<String, Any>) {
        Log.d(TAG, "Control: $action, payload=$payload")
        when (action) {
            "play" -> playerManager.resume()
            "pause" -> playerManager.pause()
            "toggle" -> playerManager.togglePlayPause()
            "next" -> playNext()
            "prev" -> playPrevious()
            "seek" -> {
                val time = (payload["time"] as? Double)?.times(1000)?.toLong()
                if (time != null) playerManager.seekTo(time)
            }
            "voice" -> playerManager.toggleVoice()
            "play_song" -> {
                val songId = (payload["song_id"] as? Double)?.toInt()
                if (songId != null) {
                    lifecycleScope.launch {
                        apiClient.addToQueue(songId)
                    }
                }
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                playerManager.togglePlayPause()
                true
            }
            KeyEvent.KEYCODE_MEDIA_NEXT -> { playNext(); true }
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> { playPrevious(); true }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                playerManager.togglePlayPause()
                true
            }
            else -> super.onKeyDown(keyCode, event)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        playerManager.release()
        wsClient.disconnect()
    }
}
