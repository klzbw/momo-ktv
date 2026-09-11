package com.momo.ktv.tv.player

import android.content.Context
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import com.momo.ktv.tv.data.ApiClient
import com.momo.ktv.tv.data.QueueItem
import com.momo.ktv.tv.data.WebSocketClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * ExoPlayer 封装：
 * - 使用 DefaultHttpDataSource 播放 115 网盘直连 MKV（自定义 UA + Referer + 302跟随）
 * - 多音轨切换（原唱/伴唱）通过 DefaultTrackSelector
 * - 播放进度定时上报 WebSocket
 */
class PlayerManager(
    private val context: Context,
    private val apiClient: ApiClient,
    private val wsClient: WebSocketClient,
    private val scope: CoroutineScope
) {
    companion object {
        private const val TAG = "PlayerManager"
        const val CLOUD115_UA = "Mozilla/5.0 115Browser/23.9.3.2"
    }

    private val trackSelector = DefaultTrackSelector(context)
    private val dataSourceFactory = DefaultHttpDataSource.Factory()
        .setUserAgent(CLOUD115_UA)
        .setDefaultRequestProperties(mapOf("Referer" to "https://115.com/"))
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(15000)
        .setReadTimeoutMs(30000)
    private val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)

    val player: ExoPlayer = ExoPlayer.Builder(context)
        .setTrackSelector(trackSelector)
        .setMediaSourceFactory(mediaSourceFactory)
        .build()

    private var progressJob: Job? = null
    private var currentQueueId: Int? = null
    private var currentVoice = "原唱"
    private var audioTrackCount = 0

    var onPlaybackStateChanged: ((Boolean) -> Unit)? = null
    var onProgressChanged: ((Long, Long) -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var onTracksChanged: ((Int) -> Unit)? = null
    var onPlaybackEnded: (() -> Unit)? = null

    init {
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    Player.STATE_READY -> {
                        Log.d(TAG, "STATE_READY, playing=${player.playWhenReady}")
                        onPlaybackStateChanged?.invoke(player.playWhenReady)
                        refreshAudioTracks()
                    }
                    Player.STATE_ENDED -> {
                        Log.d(TAG, "STATE_ENDED")
                        onPlaybackStateChanged?.invoke(false)
                        onPlaybackEnded?.invoke()
                    }
                    Player.STATE_BUFFERING -> Log.d(TAG, "STATE_BUFFERING")
                    else -> {}
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "Player error: ${error.message}", error)
                onError?.invoke(error.message ?: "播放错误")
            }

            override fun onTracksChanged(tracks: Tracks) {
                refreshAudioTracks()
            }
        })
    }

    fun playQueueItem(item: QueueItem) {
        currentQueueId = item.queueId
        currentVoice = "原唱"
        val filepath = item.filepath ?: return
        val url = apiClient.directStreamURL(filepath)
        Log.d(TAG, "playQueueItem: ${item.displayTitle}, url=$url")
        playURL(url)
    }

    fun playURL(url: String) {
        stopProgressReporting()
        val mediaItem = MediaItem.fromUri(url)
        player.setMediaItem(mediaItem)
        player.prepare()
        player.playWhenReady = true
        startProgressReporting()
    }

    fun pause() {
        player.playWhenReady = false
        wsClient.sendPlaybackState(paused = true, voice = currentVoice)
    }

    fun resume() {
        player.playWhenReady = true
        wsClient.sendPlaybackState(paused = false, voice = currentVoice)
    }

    fun togglePlayPause() {
        if (player.playWhenReady) pause() else resume()
    }

    fun seekTo(positionMs: Long) {
        player.seekTo(positionMs)
    }

    fun stop() {
        stopProgressReporting()
        player.stop()
        currentQueueId = null
    }

    fun release() {
        stopProgressReporting()
        player.release()
    }

    // ==================== 多音轨切换 ====================

    private fun refreshAudioTracks() {
        val tracks = player.currentTracks
        var count = 0
        for (group in tracks.groups) {
            if (group.type == androidx.media3.common.C.TRACK_TYPE_AUDIO) {
                count += group.length
            }
        }
        audioTrackCount = count
        Log.d(TAG, "Audio tracks: $count")
        onTracksChanged?.invoke(count)
    }

    /**
     * 切换音轨。index 0 = 原唱，index 1 = 伴唱。
     * 使用 DefaultTrackSelector.SelectionOverride 兼容 Media3 各版本。
     */
    fun setAudioTrack(index: Int) {
        if (index < 0 || index >= audioTrackCount) {
            Log.w(TAG, "Invalid audio track index: $index (count=$audioTrackCount)")
            return
        }
        try {
            // 找到音频 renderer
            var audioRendererIndex = -1
            for (i in 0 until player.rendererCount) {
                if (player.getRendererType(i) == androidx.media3.common.C.TRACK_TYPE_AUDIO) {
                    audioRendererIndex = i
                    break
                }
            }
            if (audioRendererIndex < 0) return

            val mappedInfo = trackSelector.currentMappedTrackInfo ?: return
            val trackGroups = mappedInfo.getTrackGroups(audioRendererIndex)
            if (trackGroups.length == 0) return

            val override = DefaultTrackSelector.SelectionOverride(0, index)
            trackSelector.setParameters(
                trackSelector.buildUponParameters()
                    .setSelectionOverride(audioRendererIndex, trackGroups.get(0), override)
            )
            currentVoice = if (index == 0) "原唱" else "伴唱"
            Log.d(TAG, "Set audio track: $index ($currentVoice)")
            wsClient.sendPlaybackState(paused = !player.playWhenReady, voice = currentVoice)
        } catch (e: Exception) {
            Log.e(TAG, "setAudioTrack error: ${e.message}")
        }
    }

    fun toggleVoice() {
        val next = if (currentVoice == "原唱") 1 else 0
        setAudioTrack(next)
    }

    fun getCurrentVoice(): String = currentVoice
    fun getAudioTrackCount(): Int = audioTrackCount

    // ==================== 进度上报 ====================

    private fun startProgressReporting() {
        stopProgressReporting()
        progressJob = scope.launch(Dispatchers.Main) {
            while (isActive) {
                val current = player.currentPosition
                val duration = player.duration
                if (duration > 0) {
                    onProgressChanged?.invoke(current, duration)
                    wsClient.sendProgress(
                        queueId = currentQueueId,
                        currentTime = current / 1000.0,
                        paused = !player.playWhenReady,
                        voice = currentVoice
                    )
                }
                delay(1000)
            }
        }
    }

    private fun stopProgressReporting() {
        progressJob?.cancel()
        progressJob = null
    }

    fun getCurrentPosition(): Long = player.currentPosition
    fun getDuration(): Long = player.duration
    fun isPlaying(): Boolean = player.playWhenReady && player.playbackState == Player.STATE_READY
}
