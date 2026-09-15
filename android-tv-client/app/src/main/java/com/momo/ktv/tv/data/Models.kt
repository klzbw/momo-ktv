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
    val dual: Boolean = false,
    @SerializedName("hasVocal") val hasVocal: Boolean = false,
    @SerializedName("hasAccomp") val hasAccomp: Boolean = false,
    @SerializedName("vocalUrl") val vocalUrl: String? = null,
    @SerializedName("accompUrl") val accompUrl: String? = null,
    @SerializedName("isNetKtvMkv") val isNetKtvMkv: Boolean = false,
    @SerializedName("isVideo") val isVideo: Boolean = false,
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

// ==================== 歌词 ====================
/** /api/songs/:id/lyrics 响应 */
data class LyricsResponse(
    val id: Int,
    val title: String? = null,
    val artist: String? = null,
    val lyrics: String? = null,
    val word: String? = null,
    val source: String? = null,
    @SerializedName("align_status") val alignStatus: String? = null
)

/** 单行歌词（解析后） */
data class LyricsLine(
    val timeMs: Long,
    val text: String
) {
    companion object {
        /** 解析 LRC 字符串为带时间戳的行列表 */
        fun parseLRC(lrcText: String): List<LyricsLine> {
            if (lrcText.isBlank()) return emptyList()
            val result = mutableListOf<LyricsLine>()
            // 支持 [mm:ss.xx] / [mm:ss.xxx] / [mm:ss]
            val regex = Regex("""\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)""")
            for (rawLine in lrcText.lines()) {
                val line = rawLine.trim()
                if (line.isEmpty()) continue
                val matches = regex.findAll(line)
                var hasTag = false
                for (m in matches) {
                    hasTag = true
                    val min = m.groupValues[1].toIntOrNull() ?: 0
                    val sec = m.groupValues[2].toIntOrNull() ?: 0
                    val msPart = m.groupValues[3]
                    val ms = when {
                        msPart.isEmpty() -> 0L
                        msPart.length == 2 -> msPart.toLong() * 10
                        msPart.length == 3 -> msPart.toLong()
                        else -> msPart.toLongOrNull() ?: 0L
                    }
                    val content = m.groupValues[4].trim()
                    if (content.isNotEmpty()) {
                        result.add(LyricsLine((min * 60L + sec) * 1000L + ms, content))
                    }
                }
                if (!hasTag) continue
            }
            return result.sortedBy { it.timeMs }
        }
    }
}

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
