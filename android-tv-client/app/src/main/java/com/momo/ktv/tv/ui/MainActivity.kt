package com.momo.ktv.tv.ui

import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.widget.Button
import android.widget.SeekBar
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
    private lateinit var tvVoicePct: TextView
    private lateinit var tvQueueTitle: TextView
    private lateinit var rvQueue: RecyclerView
    private lateinit var btnPlayPause: Button
    private lateinit var btnVoice: Button
    private lateinit var btnPrev: Button
    private lateinit var btnNext: Button
    private lateinit var btnConfig: Button
    private lateinit var btnRequestSong: Button
    private lateinit var seekVoice: SeekBar

    private lateinit var queueAdapter: QueueAdapter
    private var queueItems: MutableList<QueueItem> = mutableListOf()

    /** 当前人声比例 0-100（UI 显示用，MKV 实际为两段式） */
    private var vocalPercent: Int = 100
    /** 防止拖动 slider 时回调自身造成循环 */
    private var suppressSliderCallback: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val serverURL = prefs.getString(KEY_SERVER_URL, "") ?: ""

        if (serverURL.isEmpty()) {
            startActivity(Intent(this, ServerConfigActivity::class.java))
            finish()
            return
        }

        try {
            setContentView(R.layout.activity_main)
            initClients(serverURL)
            initViews()
            initPlayer()
            connect()
        } catch (e: Throwable) {
            android.util.Log.e("MainActivity", "init crash", e)
            val tv = android.widget.TextView(this).apply {
                text = "初始化失败:\n${e.javaClass.simpleName}: ${e.message}\n\n${e.stackTraceToString().take(500)}"
                setTextColor(0xFFFF0000.toInt())
                setPadding(32, 32, 32, 32)
                textSize = 14f
            }
            setContentView(tv)
        }
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
        tvVoicePct = findViewById(R.id.tvVoicePct)
        tvQueueTitle = findViewById(R.id.tvQueueTitle)
        rvQueue = findViewById(R.id.rvQueue)
        btnPlayPause = findViewById(R.id.btnPlayPause)
        btnVoice = findViewById(R.id.btnVoice)
        btnPrev = findViewById(R.id.btnPrev)
        btnNext = findViewById(R.id.btnNext)
        btnConfig = findViewById(R.id.btnConfig)
        btnRequestSong = findViewById(R.id.btnRequestSong)
        seekVoice = findViewById(R.id.seekVoice)

        queueAdapter = QueueAdapter(
            items = queueItems,
            onItemClick = { item -> playQueueItem(item) },
            onTopClick = { item -> topQueueItem(item) },
            onRemoveClick = { item -> removeQueueItem(item) }
        )
        rvQueue.layoutManager = LinearLayoutManager(this)
        rvQueue.adapter = queueAdapter

        btnPlayPause.setOnClickListener { playerManager.togglePlayPause() }
        btnVoice.setOnClickListener {
            playerManager.toggleVoice()
            updateVoiceUI()
        }
        btnPrev.setOnClickListener { playPrevious() }
        btnNext.setOnClickListener { playNext() }
        btnConfig.setOnClickListener {
            startActivity(Intent(this, ServerConfigActivity::class.java))
        }
        btnRequestSong.setOnClickListener {
            startActivity(Intent(this, SongSearchActivity::class.java))
        }

        // 人声音量滑块：MKV 两段式，>50 切原唱轨(0)，<=50 切伴唱轨(1)
        seekVoice.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (suppressSliderCallback) return
                vocalPercent = progress
                tvVoicePct.text = "$progress%"
                tvVoice.text = "人声 ${if (progress > 50) "原唱" else "伴唱"} ($progress%)"
            }

            override fun onStartTrackingTouch(sb: SeekBar?) {}

            override fun onStopTrackingTouch(sb: SeekBar?) {
                // 吸附到端点：>50 吸附 100（原唱），否则吸附 0（伴唱）
                val snapped = if (vocalPercent > 50) 100 else 0
                suppressSliderCallback = true
                seekVoice.progress = snapped
                suppressSliderCallback = false
                vocalPercent = snapped
                tvVoicePct.text = "$snapped%"
                tvVoice.text = "人声 ${if (snapped > 50) "原唱" else "伴唱"} ($snapped%)"
                // 切换音轨
                val trackIndex = if (snapped > 50) 0 else 1
                playerManager.setAudioTrack(trackIndex)
            }
        })
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
                tvVoice.text = "人声 ${playerManager.getCurrentVoice()} (${count}轨)"
                btnVoice.visibility = if (count >= 2) View.VISIBLE else View.GONE
                seekVoice.visibility = if (count >= 2) View.VISIBLE else View.GONE
                tvVoicePct.visibility = if (count >= 2) View.VISIBLE else View.GONE
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
        // 重置滑块到原唱
        suppressSliderCallback = true
        seekVoice.progress = 100
        suppressSliderCallback = false
        vocalPercent = 100
        tvVoicePct.text = "100%"
        playerManager.playQueueItem(item)
        loadLyrics(item.songId)
    }

    /** 加载歌词并渲染 */
    private fun loadLyrics(songId: Int) {
        lifecycleScope.launch {
            val resp = apiClient.fetchLyrics(songId)
            withContext(Dispatchers.Main) {
                if (resp == null || resp.lyrics.isNullOrBlank()) {
                    lyricsView.setLyrics(null)
                } else {
                    lyricsView.setLyrics(resp.lyrics)
                }
            }
        }
    }

    private fun topQueueItem(item: QueueItem) {
        lifecycleScope.launch {
            val ok = apiClient.topQueue(item.queueId)
            withContext(Dispatchers.Main) {
                Toast.makeText(this@MainActivity,
                    if (ok) "已置顶" else "置顶失败", Toast.LENGTH_SHORT).show()
                if (ok) refreshQueue()
            }
        }
    }

    private fun removeQueueItem(item: QueueItem) {
        lifecycleScope.launch {
            val ok = apiClient.removeFromQueue(item.queueId)
            withContext(Dispatchers.Main) {
                Toast.makeText(this@MainActivity,
                    if (ok) "已删除" else "删除失败", Toast.LENGTH_SHORT).show()
                if (ok) refreshQueue()
            }
        }
    }

    private fun refreshQueue() {
        lifecycleScope.launch {
            val q = apiClient.fetchQueue()
            withContext(Dispatchers.Main) { updateQueue(q) }
        }
    }

    private fun updateVoiceUI() {
        tvVoice.text = "人声 ${playerManager.getCurrentVoice()} (${playerManager.getAudioTrackCount()}轨)"
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
            "voice" -> {
                playerManager.toggleVoice()
                updateVoiceUI()
            }
            "play_song" -> {
                val songId = (payload["song_id"] as? Double)?.toInt()
                if (songId != null) {
                    lifecycleScope.launch { apiClient.addToQueue(songId) }
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
