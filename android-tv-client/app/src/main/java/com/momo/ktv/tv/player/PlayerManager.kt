package com.momo.ktv.tv.player

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
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
 * - 使用 Custom115DataSource 播放 115 网盘直连 MKV（UA + 302 + Range）
 * - 多音轨切换（原唱/伴唱）通过 DefaultTrackSelector
 * - 播放进度定时上报 WebSocket
 * - 播放状态变化回调
 */
class PlayerManager(
    private val context: Context,
    private val apiClient: ApiClient,
    private val wsClient: WebSocketClient,
    private val scope: CoroutineScope
) {
    companion object {
        private const val TAG = "PlayerManager"
    }

    private val trackSelector = DefaultTrackSelector(context)
    private val dataSourceFactory = Custom115DataSource.Factory()
    private val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)

    val player: ExoPlayer = ExoPlayer.Builder(context)
        .setTrackSelector(trackSelector)
        .setMediaSourceFactory(mediaSourceFactory)
        .build()

    private var progressJob: Job? = null
    private var currentQueueId: Int? = null
    private var currentVoice = "原唱"
    private var audioTrackCount = 0

    // 回调
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
                    Player.STATE_BUFFERING -> {
                        Log.d(TAG, "STATE_BUFFERING")
                    }
                    Player.STATE_IDLE -> {}
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

    /**
     * 播放指定队列项。
     * filepath 用于拼接 direct-stream URL，ExoPlayer 通过 Custom115DataSource 跟随 302。
     */
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
        val mediaItem = MediaItem.fromUri(Uri.parse(url))
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

    // ==================== 多音轨切换（原唱/伴唱） ====================

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
     * 切换音轨。index 0 = 原唱，index 1 = 伴唱（MKV 约定音轨顺序）。
     */
    fun setAudioTrack(index: Int) {
        if (index < 0 || index >= audioTrackCount) {
            Log.w(TAG, "Invalid audio track index: $index (count=$audioTrackCount)")
            return
        }
        val builder = trackSelector.buildUponParameters()
        var audioIndex = 0
        val tracks = player.currentTracks
        for (group in tracks.groups) {
            if (group.type == androidx.media3.common.C.TRACK_TYPE_AUDIO) {
                for (i in 0 until group.length) {
                    if (audioIndex == index) {
                        builder.setOverrideForType(
                            androidx.media3.exoplayer.trackselection.TrackSelectionOverride(
                                group.mediaTrackGroup,
                                listOf(i)
                            )
                        )
                        currentVoice = if (index == 0) "原唱" else "伴唱"
                        Log.d(TAG, "Set audio track: $index ($currentVoice)")
                        wsClient.sendPlaybackState(paused = !player.playWhenReady, voice = currentVoice)
                        trackSelector.setParameters(builder)
                        return
                    }
                    audioIndex++
                }
            }
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
