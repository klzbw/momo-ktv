import Foundation



struct Song: Codable, Identifiable, Hashable {

    let id: Int

    let title: String?

    let artist: String?

    let filename: String?

    let filepath: String?

    let cover: String?

    let duration: Int?

    let audio_tracks: Int?

    let play_count: Int?

    let category: String?

    let genre: String?

    let language: String?

    let source: String?

    let media_type: String?

    let is_network: Int?

    let source_root: String?

    /// 来源类型：local / cloud / strm（服务端可能不返回，用 source_root 兜底推断）
    let source_type: String?

    /// 网盘直连播放 URL（服务端可能直接返回完整 http URL）
    let cloud_url: String?

    var displayTitle: String { title ?? filename ?? "未知歌曲" }

    var displayArtist: String { artist ?? "未知歌手" }

    var hasMultiTrack: Bool { (audio_tracks ?? 1) >= 2 }

    /// 是否视频歌曲。.strm 文件名不能判型（netktv-mkv 用 .strm 后缀），优先用服务端

    /// media_type/source_root，再按扩展名兜底。

    var isVideoFile: Bool {

        if media_type == "video" { return true }

        if source_root == "netktv-mkv" || source_root == "share-115" { return true }

        guard let fn = filename?.lowercased() else { return false }

        let videoExts = [".mkv",".mp4",".m4v",".mov",".ts",".m2ts",".webm",".avi",

                         ".rmvb",".rm",".wmv",".flv",".mpg",".mpeg",".mts"]

        return videoExts.contains { fn.hasSuffix($0) }

    }

    /// 是否网络歌曲（115网盘直连）。用于列表/播放界面显示"云"标识。
    /// netktv-* / share-115 均为115网盘来源，不走本地HLS。
    var isNetworkSong: Bool {
        // 优先用 source_type 字段，兼容旧版用 source_root 推断
        if let st = source_type {
            if st == "cloud" || st == "strm" { return true }
        }
        guard let sr = source_root else { return false }
        return sr.hasPrefix("netktv") || sr == "share-115" || sr.hasPrefix("cloud")
    }

    /// 是否网盘直连来源（需要走 VLC/MSE 直连播放，不走 NAS HLS 转码）
    var isCloudDirectSource: Bool {
        if let st = source_type, st == "cloud" { return true }
        if let cu = cloud_url, cu.hasPrefix("http") { return true }
        guard let sr = source_root else { return false }
        return sr.hasPrefix("netktv") || sr == "share-115" || sr.hasPrefix("cloud")
    }

    /// 媒体类型标签：视频歌曲显示"MKV"，音频歌曲显示"FLAC"
    var mediaTypeLabel: String { isVideoFile ? "MKV" : "FLAC" }
    /// 媒体类型图标：视频用 film，音频用 music.note
    var mediaTypeIcon: String { isVideoFile ? "film" : "music.note" }

    var durationText: String {

        guard let d = duration else { return "" }

        return String(format: "%d:%02d", d / 60, d % 60)

    }

}



struct QueueItem: Codable, Identifiable, Hashable {

    let queue_id: Int

    let nickname: String?

    let is_top: Int?

    let status: String?

    let song_id: Int

    let title: String?

    let artist: String?

    let filename: String?

    let cover: String?

    let duration: Int?

    let audio_tracks: Int?

    let media_type: String?

    let source_root: String?

    /// 来源类型：local / cloud / strm
    let source_type: String?

    /// 网盘直连播放 URL
    let cloud_url: String?

    var id: Int { queue_id }

    var displayTitle: String { title ?? filename ?? "未知歌曲" }

    var displayArtist: String { artist ?? "未知歌手" }

    var isPlaying: Bool { status == "playing" }

    var isTop: Bool { (is_top ?? 0) == 1 }


    /// 媒体类型标签：视频歌曲显示"MKV"，音频歌曲显示"FLAC"

    /// 是否网络歌曲（115网盘直连）
    /// netktv-* / share-115 均为115网盘来源，不走本地HLS。
    var isNetworkSong: Bool {
        if let st = source_type {
            if st == "cloud" || st == "strm" { return true }
        }
        guard let sr = source_root else { return false }
        return sr.hasPrefix("netktv") || sr == "share-115" || sr.hasPrefix("cloud")
    }

    /// 是否网盘直连来源
    var isCloudDirectSource: Bool {
        if let st = source_type, st == "cloud" { return true }
        if let cu = cloud_url, cu.hasPrefix("http") { return true }
        guard let sr = source_root else { return false }
        return sr.hasPrefix("netktv") || sr == "share-115" || sr.hasPrefix("cloud")
    }

    var mediaTypeLabel: String { isVideoFile ? "MKV" : "FLAC" }
    /// 媒体类型图标：视频用 film，音频用 music.note
    var mediaTypeIcon: String { isVideoFile ? "film" : "music.note" }

    var hasMultiTrack: Bool { (audio_tracks ?? 1) >= 2 }

    /// 是否视频歌曲（MKV/MP4 等）。服务端 media_type 历史数据大量为空，用扩展名兜底；

    /// 视频歌自带画面与内嵌字幕，不再叠加 App 歌词层。

    var isVideoFile: Bool {

        // 服务端 media_type/source_root 优先（.strm 文件名不能判型）

        if media_type == "video" { return true }

        if source_root == "netktv-mkv" || source_root == "share-115" { return true }

        guard let fn = filename?.lowercased() else { return false }

        // netktv-mkv 文件名形如 netktv_mkv_<pickcode>.strm，按前缀识别为视频

        if fn.hasPrefix("netktv_mkv_") { return true }

        let videoExts = [".mkv",".mp4",".m4v",".mov",".ts",".m2ts",".webm",".avi",

                         ".rmvb",".rm",".wmv",".flv",".mpg",".mpeg",".mts"]

        return videoExts.contains { fn.hasSuffix($0) }

    }

}



struct Artist: Codable, Identifiable, Hashable {

    let artist: String

    let count: Int

    var id: String { artist }

    var displayName: String { artist.isEmpty ? "未知歌手" : artist }

}



struct Category: Identifiable, Hashable {

    let id = UUID()

    let name: String

    let icon: String

    let type: CategoryType

}



enum CategoryType: String {

    case newest, charts, favorites, history, artists, category, order

}



struct Stats: Codable {

    let songCount: Int?

    let queueCount: Int?

    let totalPlays: Int?

    let appVersion: String?

}



struct AutoplaySettings: Codable {

    var enabled: Bool

    var localOnly: Bool

}





// MARK: - 网络KTV（115网盘直连双FLAC）

/// 网络KTV歌曲列表响应模型

struct NetKtvSongsResponse: Codable {

    let total: Int

    let songs: [NetKtvSong]

}



/// 网络KTV歌曲模型：从服务端 /api/netktv/songs 获取

struct NetKtvSong: Codable, Identifiable, Hashable {

    let id: String              // sha256前16位目录名

    let artist: String

    let title: String

    let vocal_file: String

    let accompaniment_file: String

    let vocal_size: Int

    let accompaniment_size: Int

    let total_size: Int

    let vocal_url: String       // 相对路径，如 /api/netktv/stream/<id>/vocals

    let accompaniment_url: String



    var displayTitle: String { title.isEmpty ? "未知歌曲" : title }

    var displayArtist: String { artist.isEmpty ? "未知歌手" : artist }

    var totalSizeText: String {

        let mb = Double(total_size) / 1024.0 / 1024.0

        return String(format: "%.1f MB", mb)

    }

}



/// 网络KTV歌曲信息：从 /api/netktv/info/:id 获取

struct NetKtvSongInfo: Codable {

    let id: String

    let vocal_duration: Double?

    let accompaniment_duration: Double?

    let sync: Bool?

}

