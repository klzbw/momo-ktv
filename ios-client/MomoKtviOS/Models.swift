import Foundation

// MARK: - 歌曲
struct Song: Codable {
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

    var displayTitle: String { title ?? filename ?? "未知歌曲" }
    var displayArtist: String { artist ?? "未知歌手" }
    var hasMultiTrack: Bool { (audio_tracks ?? 1) >= 2 }
    var isVideoFile: Bool {
        if media_type == "video" { return true }
        if source_root == "netktv-mkv" { return true }
        guard let fn = filename?.lowercased() else { return false }
        return [".mkv", ".mp4", ".m4v", ".mov", ".ts", ".m2ts", ".webm", ".avi"]
            .contains { fn.hasSuffix($0) }
    }
    var isNetworkSong: Bool { source_root?.hasPrefix("netktv") == true }
    var mediaTypeLabel: String { isVideoFile ? "MKV" : "FLAC" }
    var durationText: String {
        guard let d = duration else { return "" }
        return String(format: "%d:%02d", d / 60, d % 60)
    }
}

// MARK: - 队列项
struct QueueItem: Codable {
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
    let filepath: String?

    var id: Int { queue_id }
    var displayTitle: String { title ?? filename ?? "未知歌曲" }
    var displayArtist: String { artist ?? "未知歌手" }
    var isPlaying: Bool { status == "playing" }
    var isTop: Bool { (is_top ?? 0) == 1 }
    var hasMultiTrack: Bool { (audio_tracks ?? 1) >= 2 }
    var isVideoFile: Bool {
        if media_type == "video" { return true }
        if source_root == "netktv-mkv" { return true }
        guard let fn = filename?.lowercased() else { return false }
        return [".mkv", ".mp4", ".m4v", ".mov", ".ts", ".m2ts", ".webm", ".avi"]
            .contains { fn.hasSuffix($0) }
    }
    var isNetworkSong: Bool { source_root?.hasPrefix("netktv") == true }
}

// MARK: - 艺术家
struct Artist: Codable {
    let name: String?
    let count: Int?
}

// MARK: - 统计
struct Stats: Codable {
    let songCount: Int?
    let songCountLocal: Int?
    let songCountNetwork: Int?
    let queueCount: Int?
    let totalPlays: Int?
}

// MARK: - 分离信息
struct SepInfo: Codable {
    let isNetKtvMkv: Bool?
    let videoUrl: String?
    let audioTracks: [AudioTrackInfo]?
}

struct AudioTrackInfo: Codable {
    let index: Int?
    let name: String?
    let language: String?
}

// MARK: - 搜索响应
struct SearchResponse: Codable {
    let items: [Song]?
    let total: Int?
}

// MARK: - WebSocket 消息
struct WSMessage {
    let type: String
    let action: String?
    let data: Any?
    let clientId: String?
    let deviceId: String?
    let deviceName: String?
    let role: String?
    let currentTime: Double?
    let paused: Bool?
    let voice: String?
    let queueId: Int?
}
