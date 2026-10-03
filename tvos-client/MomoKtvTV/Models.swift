import SwiftUI
import Foundation

// feat(tvos-format-tag): 统一媒体扩展名→行内小标签映射表。
// 目的：点歌/歌曲列表行的"媒体格式小标签"统一按文件扩展名识别；
// 标签一律取大写扩展名；mpg/mpeg 归一为 MPG；新增 avi/rmvb。
// 与各模型 isVideoFile 的扩展名黑名单保持一致，仅做标签文案映射，不影响播放逻辑。
private let tvosMediaExtTagMap: [(ext: String, tag: String)] = [
    (".mkv", "MKV"), (".flac", "FLAC"), (".wav", "WAV"), (".mp3", "MP3"),
    (".m4a", "M4A"), (".ape", "APE"), (".aac", "AAC"), (".ogg", "OGG"),
    (".mp4", "MP4"),
    (".avi", "AVI"), (".rmvb", "RMVB"),                 // feat(tvos-format-tag): 常见视频容器
    (".mpg", "MPG"), (".mpeg", "MPG")                   // feat(tvos-format-tag): mpeg 归一 MPG
]

// feat(tvos-format-tag): 媒体格式小标签统一判定（按文件扩展名；media_type 经 isVideoFile 兜底）。
// filename 缺省 / .strm（不可判型）时按 isVideo 回退 MKV/FLAC；未识别扩展名走 VIDEO/AUDIO。
// isVideo 由各模型根据服务端 media_type + source_root + 扩展名综合得出，故已覆盖 media_type 维度。
func tvosMediaFormatTag(filename: String?, mediaType: String?, isVideo: Bool) -> String {
    guard let fn = filename?.lowercased() else { return isVideo ? "MKV" : "FLAC" }
    for pair in tvosMediaExtTagMap where fn.hasSuffix(pair.ext) { return pair.tag }
    if fn.hasSuffix(".strm") { return isVideo ? "MKV" : "FLAC" }
    return isVideo ? "VIDEO" : "AUDIO"
}

// feat(tvos-format-tag): 媒体格式小标签统一配色。
// 视频系（MKV/MP4/AVI/RMVB/MPG）偏红；无损（FLAC/WAV/APE）冷色；有损（MP3/M4A/AAC/OGG）暖色。
func tvosMediaFormatColor(_ tag: String) -> Color {
    switch tag {
    case "MKV", "MP4", "AVI", "RMVB", "MPG", "VIDEO": return Color(red: 1.0, green: 0.3, blue: 0.3)
    case "FLAC": return Color(red: 0.0, green: 0.6, blue: 1.0)
    case "WAV": return Color(red: 0.0, green: 0.7, blue: 0.5)
    case "APE": return Color(red: 0.5, green: 0.4, blue: 0.9)
    case "MP3": return Color(red: 1.0, green: 0.6, blue: 0.0)
    case "M4A", "AAC": return Color(red: 0.9, green: 0.5, blue: 0.2)
    case "OGG": return Color(red: 0.3, green: 0.7, blue: 0.3)
    default: return Color.gray
    }
}



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

    /// 网盘驱动类型：pan115 / quark / aliyun / baidu / cmcc / xunlei（服务端返回）
    let cloud_driver: String?

    var displayTitle: String { title ?? filename ?? "未知歌曲" }

    var displayArtist: String { artist ?? "未知歌手" }

    var hasMultiTrack: Bool { (audio_tracks ?? 1) >= 2 }

    /// 是否视频歌曲。.strm 文件名不能判型（netktv-mkv 用 .strm 后缀），优先用服务端

    /// media_type/source_root，再按扩展名兜底。

    var isVideoFile: Bool {

        if media_type == "video" { return true }

        if let sr = source_root, (sr == "netktv-mkv" || sr == "share-115" || sr.hasPrefix("cloud-mkv")) { return true }

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

    /// 媒体格式标签：feat(tvos-format-tag) 统一走 tvosMediaFormatTag，
    /// 在 flac/wav/mkv/mp4 基础上补 mpg/mpeg→MPG、avi→AVI、rmvb→RMVB（mp3/ape 已在映射表内）。
    var mediaTypeLabel: String {
        tvosMediaFormatTag(filename: filename, mediaType: media_type, isVideo: isVideoFile)
    }
    /// 媒体格式颜色：feat(tvos-format-tag) 统一走 tvosMediaFormatColor（含 MPG/AVI/RMVB 视频色）
    var mediaTypeColor: Color {
        tvosMediaFormatColor(mediaTypeLabel)
    }

    /// 网盘类型标识：优先用 cloud_driver，其次用 source_root 推断
    var cloudDiskLabel: String {
        guard isNetworkSong else { return "" }
        // 优先用服务端返回的driver类型
        if let driver = cloud_driver {
            switch driver {
            case "pan115": return "115"
            case "quark": return "夸克"
            case "aliyun": return "阿里"
            case "baidu": return "百度"
            case "cmcc": return "移动"
            case "xunlei": return "迅雷"
            default: break
            }
        }
        guard let sr = source_root else { return "" }
        // 旧版来源
        if sr.hasPrefix("netktv") { return "云" }
        if sr == "share-115" { return "115" }
        if sr == "strm-shared" { return "共享" }
        // 新版 cloud-{mkv|flac}-{accountId}
        if sr.hasPrefix("cloud-") {
            let parts = sr.split(separator: "-")
            if parts.count >= 3, let accountId = Int(parts[2]) {
                switch accountId {
                case 1, 58: return "115"
                case 62: return "夸克"
                case 64, 66: return "移动"
                default: return "网盘#\(accountId)"
                }
            }
        }
        return "云"
    }

    /// 网盘颜色：不同网盘用不同颜色区分
    var cloudDiskColor: Color {
        switch cloudDiskLabel {
        case "115": return Color(red: 1.0, green: 0.55, blue: 0.0)  // 橙色
        case "夸克": return Color(red: 0.0, green: 0.5, blue: 1.0)   // 蓝色
        case "移动": return Color(red: 0.0, green: 0.7, blue: 0.3)   // 绿色
        case "阿里": return Color(red: 0.6, green: 0.3, blue: 0.9)   // 紫色
        case "百度": return Color(red: 0.1, green: 0.4, blue: 0.9)   // 深蓝
        case "迅雷": return Color(red: 0.9, green: 0.2, blue: 0.2)   // 红色
        case "共享": return Color(red: 0.6, green: 0.3, blue: 0.9)   // 紫色-共享
        default: return Color.gray
        }
    }

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

    /// 网盘驱动类型：pan115 / quark / aliyun / baidu / cmcc / xunlei
    let cloud_driver: String?

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

    /// 媒体格式标签：feat(tvos-format-tag) 统一走 tvosMediaFormatTag，
    /// 在 flac/wav/mkv/mp4 基础上补 mpg/mpeg→MPG、avi→AVI、rmvb→RMVB（mp3/ape 已在映射表内）。
    var mediaTypeLabel: String {
        tvosMediaFormatTag(filename: filename, mediaType: media_type, isVideo: isVideoFile)
    }
    /// 媒体格式颜色：feat(tvos-format-tag) 统一走 tvosMediaFormatColor（含 MPG/AVI/RMVB 视频色）
    var mediaTypeColor: Color {
        tvosMediaFormatColor(mediaTypeLabel)
    }

    /// 网盘类型标识：优先用 cloud_driver，其次用 source_root 推断
    var cloudDiskLabel: String {
        guard isNetworkSong else { return "" }
        if let driver = cloud_driver {
            switch driver {
            case "pan115": return "115"
            case "quark": return "夸克"
            case "aliyun": return "阿里"
            case "baidu": return "百度"
            case "cmcc": return "移动"
            case "xunlei": return "迅雷"
            default: break
            }
        }
        guard let sr = source_root else { return "" }
        if sr.hasPrefix("netktv") { return "云" }
        if sr == "share-115" { return "115" }
        if sr == "strm-shared" { return "共享" }
        if sr.hasPrefix("cloud-") {
            let p = sr.split(separator: "-")
            if p.count >= 3, let aid = Int(p[2]) {
                switch aid {
                case 1, 58: return "115"
                case 62: return "夸克"
                case 64, 66: return "移动"
                default: return "网盘#\(aid)"
                }
            }
        }
        return "云"
    }
    /// 网盘颜色：不同网盘用不同颜色区分
    var cloudDiskColor: Color {
        switch cloudDiskLabel {
        case "115": return Color(red: 1.0, green: 0.55, blue: 0.0)
        case "夸克": return Color(red: 0.0, green: 0.5, blue: 1.0)
        case "移动": return Color(red: 0.0, green: 0.7, blue: 0.3)
        case "阿里": return Color(red: 0.6, green: 0.3, blue: 0.9)
        case "百度": return Color(red: 0.1, green: 0.4, blue: 0.9)
        case "迅雷": return Color(red: 0.9, green: 0.2, blue: 0.2)
        case "共享": return Color(red: 0.6, green: 0.3, blue: 0.9)
        default: return Color.gray
        }
    }

    var hasMultiTrack: Bool { (audio_tracks ?? 1) >= 2 }

    /// 是否视频歌曲（MKV/MP4 等）。服务端 media_type 历史数据大量为空，用扩展名兜底；

    /// 视频歌自带画面与内嵌字幕，不再叠加 App 歌词层。

    var isVideoFile: Bool {

        // 服务端 media_type/source_root 优先（.strm 文件名不能判型）

        if media_type == "video" { return true }

        if let sr = source_root, (sr == "netktv-mkv" || sr == "share-115" || sr.hasPrefix("cloud-mkv")) { return true }

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

