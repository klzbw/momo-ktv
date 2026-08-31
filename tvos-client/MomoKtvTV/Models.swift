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

    var displayTitle: String { title ?? filename ?? "未知歌曲" }
    var displayArtist: String { artist ?? "未知歌手" }
    var hasMultiTrack: Bool { (audio_tracks ?? 1) >= 2 }
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

    var id: Int { queue_id }
    var displayTitle: String { title ?? filename ?? "未知歌曲" }
    var displayArtist: String { artist ?? "未知歌手" }
    var isPlaying: Bool { status == "playing" }
    var isTop: Bool { (is_top ?? 0) == 1 }
    var hasMultiTrack: Bool { (audio_tracks ?? 1) >= 2 }
    /// 是否视频歌曲（MKV/MP4 等）。服务端 media_type 历史数据大量为空，用扩展名兜底；
    /// 视频歌自带画面与内嵌字幕，不再叠加 App 歌词层。
    var isVideoFile: Bool {
        guard let fn = filename?.lowercased() else { return false }
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
