package com.momo.ktv.tv.data

import com.google.gson.annotations.SerializedName

// ==================== 歌曲 ====================
data class Song(
    val id: Int,
    val title: String? = null,
    val artist: String? = null,
    val filename: String? = null,
    val filepath: String? = null,
    val cover: String? = null,
    val duration: Int? = null,
    @SerializedName("audio_tracks") val audioTracks: Int? = null,
    @SerializedName("play_count") val playCount: Int? = null,
    val category: String? = null,
    val genre: String? = null,
    val language: String? = null,
    val source: String? = null,
    @SerializedName("media_type") val mediaType: String? = null,
    @SerializedName("is_network") val isNetwork: Int? = null,
    @SerializedName("source_root") val sourceRoot: String? = null
) {
    val displayTitle: String get() = title ?: filename ?: "未知歌曲"
    val displayArtist: String get() = artist ?: "未知歌手"
    val hasMultiTrack: Boolean get() = (audioTracks ?: 1) >= 2
    val isVideoFile: Boolean
        get() {
            if (mediaType == "video") return true
            if (sourceRoot == "netktv-mkv") return true
            val fn = filename?.lowercase() ?: return false
            return listOf(".mkv", ".mp4", ".m4v", ".mov", ".ts", ".m2ts", ".webm", ".avi")
                .any { fn.endsWith(it) }
        }
    val isNetworkSong: Boolean get() = sourceRoot?.startsWith("netktv") == true
    val mediaTypeLabel: String get() = if (isVideoFile) "MKV" else "FLAC"
    val durationText: String
        get() {
            val d = duration ?: return ""
            return "%d:%02d".format(d / 60, d % 60)
        }
}

// ==================== 队列 ====================
data class QueueItem(
    @SerializedName("queue_id") val queueId: Int,
    val nickname: String? = null,
    @SerializedName("is_top") val isTop: Int? = null,
    val status: String? = null,
    @SerializedName("song_id") val songId: Int,
    val title: String? = null,
    val artist: String? = null,
    val filename: String? = null,
    val cover: String? = null,
    val duration: Int? = null,
    @SerializedName("audio_tracks") val audioTracks: Int? = null,
    @SerializedName("media_type") val mediaType: String? = null,
    @SerializedName("source_root") val sourceRoot: String? = null,
    val filepath: String? = null
) {
    val id: Int get() = queueId
    val displayTitle: String get() = title ?: filename ?: "未知歌曲"
    val displayArtist: String get() = artist ?: "未知歌手"
    val isPlaying: Boolean get() = status == "playing"
    val isTopFlag: Boolean get() = (isTop ?: 0) == 1
    val hasMultiTrack: Boolean get() = (audioTracks ?: 1) >= 2
    val isVideoFile: Boolean
        get() {
            if (mediaType == "video") return true
            if (sourceRoot == "netktv-mkv") return true
            val fn = filename?.lowercase() ?: return false
            return listOf(".mkv", ".mp4", ".m4v", ".mov", ".ts", ".m2ts", ".webm", ".avi")
                .any { fn.endsWith(it) }
        }
    val isNetworkSong: Boolean get() = sourceRoot?.startsWith("netktv") == true
}

// ==================== 艺术家 ====================
data class Artist(
    val name: String? = null,
    val count: Int? = null
)

// ==================== 统计 ====================
data class Stats(
    @SerializedName("total_songs") val totalSongs: Int? = null,
    @SerializedName("total_artists") val totalArtists: Int? = null,
    @SerializedName("queue_length") val queueLength: Int? = null
)

// ==================== 分离信息 ====================
data class SepInfo(
    @SerializedName("isNetKtvMkv") val isNetKtvMkv: Boolean = false,
    @SerializedName("videoUrl") val videoUrl: String? = null,
    @SerializedName("audioTracks") val audioTracks: List<AudioTrackInfo>? = null
)

data class AudioTrackInfo(
    val index: Int? = null,
    val name: String? = null,
    val language: String? = null
)

// ==================== 搜索响应 ====================
data class SearchResponse(
    val items: List<Song>? = null,
    val total: Int? = null
)

// ==================== WebSocket 消息 ====================
data class WSMessage(
    val type: String,
    val action: String? = null,
    val data: Any? = null,
    @SerializedName("clientId") val clientId: String? = null,
    @SerializedName("deviceId") val deviceId: String? = null,
    @SerializedName("deviceName") val deviceName: String? = null,
    val role: String? = null,
    @SerializedName("currentTime") val currentTime: Double? = null,
    val paused: Boolean? = null,
    val voice: String? = null,
    @SerializedName("queueId") val queueId: Int? = null
)
