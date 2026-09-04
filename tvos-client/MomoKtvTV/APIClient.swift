import Foundation
import Combine

class KTVAPIClient: ObservableObject {
    @Published var songs: [Song] = []
    @Published var queue: [QueueItem] = []
    @Published var artists: [Artist] = []
    @Published var favorites: [Song] = []
    @Published var history: [Song] = []
    @Published var charts: [Song] = []
    @Published var newest: [Song] = []
    @Published var isConnected = false
    @Published var connectionError: String?
    @Published var stats: Stats?
    @Published var currentUser: String?
    @Published var autoplayEnabled = true
    @Published var autoplayLocalOnly = false
    // MARK: - 网络KTV（115网盘直连双FLAC）
    @Published var netKtvSongs: [NetKtvSong] = []
    @Published var netKtvLoading = false
    @Published var netKtvError: String?

    private var baseURL: String
    private var wsTask: URLSessionWebSocketTask?
    private var sessionCookie: String?
    /// Unique per-app ID; attached to outgoing WS control messages so we can
    /// ignore our own messages echoed back by the server broadcast.
    let clientId = UUID().uuidString
    /// Persistent device ID for player role announcement and progress reporting.
    /// Stored in UserDefaults so it survives app restarts — the server uses it
    /// to identify "the current playing device" and only accept progress reports
    /// from the active player (see server index.js 'progress' handler).
    let deviceId: String = {
        let key = "momo_ktv_device_id"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let newId = "tvos-\(UUID().uuidString.prefix(8))"
        UserDefaults.standard.set(newId, forKey: key)
        return newId
    }()

    var serverAddress: String { baseURL.replacingOccurrences(of: "http://", with: "") }

    init(baseURL: String) {
        self.baseURL = baseURL.hasPrefix("http") ? baseURL : "http://\(baseURL)"
    }

    func updateBaseURL(_ url: String) {
        self.baseURL = url.hasPrefix("http") ? url : "http://\(url)"
        disconnectWebSocket()
        connectWebSocket()
        fetchAll()
    }

    func apiURL(_ path: String) -> URL? {
        URL(string: "\(baseURL)\(path)")
    }

    func fetchAll() {
        fetchSongs()
        fetchQueue()
        fetchArtists()
        fetchStats()
        fetchAutoplaySettings()
    }

    // MARK: - Auth
    func login(username: String, password: String, remember: Bool = true, completion: @escaping (Bool, String?) -> Void) {
        guard let url = apiURL("/api/tv-auth/login") else { completion(false, "URL错误"); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["username": username, "password": password, "remember": remember])
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, error in
            DispatchQueue.main.async {
                if let error = error { completion(false, error.localizedDescription); return }
                if let httpResp = resp as? HTTPURLResponse, httpResp.statusCode == 200 {
                    self?.currentUser = username
                    completion(true, nil)
                } else {
                    if let data = data, let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let err = d["error"] as? String {
                        completion(false, err)
                    } else {
                        completion(false, "登录失败")
                    }
                }
            }
        }.resume()
    }

    func checkSession(completion: @escaping (Bool, Bool, String?) -> Void) {
        guard let url = apiURL("/api/tv-auth/session") else { completion(false, false, nil); return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            DispatchQueue.main.async {
                if let data = data, let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    let authed = d["authed"] as? Bool ?? false
                    let hasUsers = d["hasUsers"] as? Bool ?? false
                    let username = d["username"] as? String
                    completion(authed, hasUsers, username)
                } else {
                    completion(false, false, nil)
                }
            }
        }.resume()
    }

    // MARK: - Songs
    func fetchSongs(query: String = "", artist: String = "", completion: (() -> Void)? = nil) {
        var path = "/api/songs"
        var params: [String] = []
        if !query.isEmpty { params.append("q=\(query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")") }
        if !artist.isEmpty { params.append("artist=\(artist.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")") }
        if !params.isEmpty { path += "?" + params.joined(separator: "&") }
        guard let url = apiURL(path) else { completion?(); return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            DispatchQueue.main.async {
                if let error = error { self?.connectionError = error.localizedDescription; self?.isConnected = false; completion?(); return }
                guard let data = data else { completion?(); return }
                do {
                    self?.songs = try JSONDecoder().decode([Song].self, from: data)
                    self?.isConnected = true
                    self?.connectionError = nil
                } catch { self?.connectionError = "解析失败: \(error.localizedDescription)" }
                completion?()
            }
        }.resume()
    }

    /// 服务端分页搜索（照搬网页端逻辑）：调用 /api/songs?q=&page=&pageSize=
    /// 服务端返回 {items: [Song], total: Int}，客户端只渲染当前页，避免本地过滤11177首
    func searchSongs(query: String, page: Int = 1, pageSize: Int = 40, completion: @escaping ([Song], Int) -> Void) {
        var params: [String] = []
        if !query.isEmpty {
            params.append("q=\(query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")")
        }
        params.append("page=\(page)")
        params.append("pageSize=\(pageSize)")
        let path = "/api/songs?" + params.joined(separator: "&")
        guard let url = apiURL(path) else { completion([], 0); return }
        URLSession.shared.dataTask(with: url) { data, _, error in
            DispatchQueue.main.async {
                guard let data = data, error == nil else { completion([], 0); return }
                // 优先解析 {items: [Song], total: Int} 格式（网页端同款）
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let itemsRaw = json["items"],
                   let itemsData = try? JSONSerialization.data(withJSONObject: itemsRaw),
                   let songs = try? JSONDecoder().decode([Song].self, from: itemsData) {
                    let total = (json["total"] as? Int) ?? songs.count
                    completion(songs, total)
                } else if let songs = try? JSONDecoder().decode([Song].self, from: data) {
                    // 兼容旧格式：直接返回数组
                    completion(songs, songs.count)
                } else {
                    completion([], 0)
                }
            }
        }.resume()
    }

    func fetchSongsByLetter(_ letter: String) {
        guard let url = apiURL("/api/songs/letter/\(letter)") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                if let data = data { self?.songs = (try? JSONDecoder().decode([Song].self, from: data)) ?? [] }
            }
        }.resume()
    }

    // MARK: - Artists
    func fetchArtists(completion: (() -> Void)? = nil) {
        guard let url = apiURL("/api/artists") else { completion?(); return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                if let data = data { self?.artists = (try? JSONDecoder().decode([Artist].self, from: data)) ?? [] }
                completion?()
            }
        }.resume()
    }

    // MARK: - Queue
    func fetchQueue() {
        guard let url = apiURL("/api/queue") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                if let data = data { self?.queue = (try? JSONDecoder().decode([QueueItem].self, from: data)) ?? [] }
            }
        }.resume()
    }

    func addToQueue(songId: Int, nickname: String = "TV用户", completion: ((Bool) -> Void)? = nil) {
        guard let url = apiURL("/api/queue") else { completion?(false); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["song_id": songId, "nickname": nickname])
        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    self?.connectionError = error.localizedDescription
                    completion?(false)
                } else if let httpResp = response as? HTTPURLResponse, httpResp.statusCode == 200 {
                    self?.fetchQueue()
                    completion?(true)
                } else {
                    completion?(false)
                }
            }
        }.resume()
    }

    func nextSong() {
        guard let url = apiURL("/api/queue/next") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                self?.fetchQueue()
            }
        }.resume()
    }

    func restartSong() {
        sendWSControl("repeat")
    }

    /// 把歌词时间轴偏移固化到服务端：平移歌词里所有时间标签并写回数据库，之后任何设备拿到的都是校准后的歌词
    func saveLyricsOffset(songId: Int, offset: Double) {
        guard let url = apiURL("/api/songs/\(songId)/lyrics/offset") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["offset": offset])
        URLSession.shared.dataTask(with: req) { _, _, _ in }.resume()
    }

    func toggleVoice() {
        sendWSControl("voice")
    }

    func setEQ(_ name: String) {
        sendWSControl("eq", ["name": name])
    }

    func adjustVolume(_ delta: Float) {
        sendWSControl("volume", ["delta": delta])
    }

    func togglePlayPause() {
        sendWSControl("play_pause")
    }

    func topSong(queueId: Int) {
        guard let url = apiURL("/api/queue/\(queueId)/top") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in self?.fetchQueue() }.resume()
    }

    func removeFromQueue(queueId: Int) {
        guard let url = apiURL("/api/queue/\(queueId)") else { return }
        var req = URLRequest(url: url); req.httpMethod = "DELETE"
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in self?.fetchQueue() }.resume()
    }

    // MARK: - Favorites / History / Charts
    func fetchFavorites(device: String = "tvos") {
        guard let url = apiURL("/api/favorites?device=\(device)") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async { if let data = data { self?.favorites = (try? JSONDecoder().decode([Song].self, from: data)) ?? [] } }
        }.resume()
    }

    func toggleFavorite(songId: Int, device: String = "tvos") {
        if favorites.contains(where: { $0.id == songId }) {
            guard let url = apiURL("/api/favorites/\(songId)?device=\(device)") else { return }
            var req = URLRequest(url: url); req.httpMethod = "DELETE"
            URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in self?.fetchFavorites(device: device) }.resume()
        } else {
            guard let url = apiURL("/api/favorites/\(songId)") else { return }
            var req = URLRequest(url: url); req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["device": device])
            URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in self?.fetchFavorites(device: device) }.resume()
        }
    }

    func fetchHistory() {
        guard let url = apiURL("/api/history") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async { if let data = data { self?.history = (try? JSONDecoder().decode([Song].self, from: data)) ?? [] } }
        }.resume()
    }

    func fetchCharts() {
        guard let url = apiURL("/api/charts") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async { if let data = data { self?.charts = (try? JSONDecoder().decode([Song].self, from: data)) ?? [] } }
        }.resume()
    }

    func fetchNewest() {
        // 最新入库：调用专门的 /api/songs/newest 接口，服务端直接按 id 降序取前50首，
        // 避免拉回全部歌曲(50000+)再排序导致的大数据量传输和解析失败
        guard let url = apiURL("/api/songs/newest?limit=50") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                if let data = data, let songs = try? JSONDecoder().decode([Song].self, from: data) {
                    self?.newest = songs
                }
            }
        }.resume()
    }

    // MARK: - Stats / Settings
    func fetchStats() {
        guard let url = apiURL("/api/stats") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async { if let data = data { self?.stats = try? JSONDecoder().decode(Stats.self, from: data) } }
        }.resume()
    }

    func fetchAutoplaySettings() {
        guard let url = apiURL("/api/settings/autoplay") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                if let data = data, let d = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self?.autoplayEnabled = d["enabled"] as? Bool ?? true
                    self?.autoplayLocalOnly = d["localOnly"] as? Bool ?? false
                }
            }
        }.resume()
    }

    func setAutoplay(enabled: Bool, localOnly: Bool) {
        guard let url = apiURL("/api/settings/autoplay") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["enabled": enabled, "localOnly": localOnly])
        URLSession.shared.dataTask(with: req).resume()
        autoplayEnabled = enabled
        autoplayLocalOnly = localOnly
    }

    func scanLibrary() {
        guard let url = apiURL("/api/scan") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: - Voice switch report
    func reportVoiceSwitch(songId: Int, mode: String, to: String) {
        guard let url = apiURL("/api/voice/switch") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["song_id": songId, "mode": mode, "to": to])
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: - URLs
    func hlsURL(songId: Int, track: Int? = nil) -> URL? {
        if let track = track {
            return apiURL("/hls/\(songId)/master.m3u8?track=\(track)")
        }
        return apiURL("/hls/\(songId)/master.m3u8")
    }
    func streamURL(songId: Int, track: Int = 0) -> URL? { apiURL("/stream/\(songId)?track=\(track)") }

    // MARK: - AI 分离双轨（DUAL：人声 FLAC + 伴奏 FLAC，本地混合后独立调人声音量）
    struct SepInfo: Codable {
        let dual: Bool?
        let hasVocal: Bool?
        let hasAccomp: Bool?
        let sepStatus: String?
        let vocalUrl: String?
        let accompUrl: String?
        let isNetKtv: Bool?
        let videoUrl: String?
        let isNetKtvMkv: Bool?
        let isVideo: Bool?
        let audioTracks: Int?
        /// 三者齐备才允许走双FLAC混合
        var isDual: Bool { dual == true && hasVocal == true && hasAccomp == true }
        /// 网络KTV歌曲：直接用网络URL，不下载到本地
        var isNetworkDual: Bool { isDual && isNetKtv == true }
        /// 网络KTV MKV视频：单文件多音轨，直接播放videoUrl
        var isNetworkMkv: Bool { isNetKtvMkv == true && videoUrl != nil }
    }

    /// 查询某首歌的 AI 分离状态与双轨相对路径（失败/未分离回 nil，调用方走 HLS 兜底）
    func fetchSepInfo(songId: Int, completion: @escaping (SepInfo?) -> Void) {
        guard let url = apiURL("/api/songs/\(songId)/sep-info") else { completion(nil); return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            DispatchQueue.main.async {
                if let data = data, let info = try? JSONDecoder().decode(SepInfo.self, from: data) {
                    completion(info)
                } else { completion(nil) }
            }
        }.resume()
    }

    /// 触发某首歌的 AI 人声分离入队（已分离/分离中服务端会去重）。
    /// 入队成功后调用方应轮询 fetchSepInfo，dual=true 时下载双轨并 activateDual 无缝切换。
    func enqueueSeparation(songId: Int, completion: @escaping (Bool) -> Void) {
        guard let url = self.apiURL("/api/separate/enqueue") else { completion(false); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["song_ids": [songId], "type": "separate"])
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { completion(ok) }
        }.resume()
    }

    /// 把人声/伴奏两个 FLAC 下载到本地缓存（按 歌曲+类型 命名，已存在直接复用，二次点歌秒开）。
    /// 全部成功后回主线程返回两个本地文件 URL；任一失败回 (nil,nil)，由调用方回退 HLS。
    func downloadDualTracks(songId: Int, vocalPath: String, accompPath: String,
                            completion: @escaping (URL?, URL?) -> Void) {
        let fm = FileManager.default
        guard let cache = try? fm.url(for: .cachesDirectory, in: .userDomainMask,
                                     appropriateFor: nil, create: true) else {
            DispatchQueue.main.async { completion(nil, nil) }; return
        }
        let dir = cache.appendingPathComponent("dual", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let vocalLocal = dir.appendingPathComponent("\(songId)_vocal.flac")
        let accompLocal = dir.appendingPathComponent("\(songId)_accomp.flac")

        func dl(_ remote: URL?, _ local: URL, done: @escaping (Bool) -> Void) {
            if fm.fileExists(atPath: local.path) { done(true); return }      // 已缓存，直接复用
            guard let remote = remote else { done(false); return }
            URLSession.shared.downloadTask(with: remote) { tmp, _, _ in
                guard let tmp = tmp else { done(false); return }
                do {
                    if fm.fileExists(atPath: local.path) { try? fm.removeItem(at: local) }
                    try fm.moveItem(at: tmp, to: local)
                    done(true)
                } catch { done(false) }
            }.resume()
        }
        dl(self.apiURL(vocalPath), vocalLocal) { okV in
            guard okV else { DispatchQueue.main.async { completion(nil, nil) }; return }
            dl(self.apiURL(accompPath), accompLocal) { okA in
                DispatchQueue.main.async { completion(okA ? vocalLocal : nil, okA ? accompLocal : nil) }
            }
        }
    }

    func coverURL(_ filename: String?) -> URL? {
        guard let filename = filename, !filename.isEmpty else { return nil }
        return apiURL("/cover/\(filename)")
    }

    // MARK: - WebSocket
    var onControlMessage: ((String, [String: Any]) -> Void)?
    var onLyricsUpdated: ((Int) -> Void)?  // 逐字歌词重新生成完成，无缝替换当前歌词
    /// 手机遥控氛围特效 / 祝福弹幕回调
    var onAtmosphere: ((String) -> Void)?
    var onBlessing: ((String, String) -> Void)?
    /// 完整 http(s) 基址，用于拼接 /sounds 等静态资源
    var httpBaseURL: String { baseURL }

    func connectWebSocket() {
        guard let wsURL = URL(string: baseURL.replacingOccurrences(of: "http", with: "ws") + "/ws") else { return }
        wsTask = URLSession.shared.webSocketTask(with: wsURL)
        wsTask?.resume()
        // Announce ourselves as the player (TV) once connected. The server
        // maintains a single active player; only its progress reports are
        // accepted and broadcast to controllers (mobile remote).
        wsTask?.send(.string(JSONString(["type": "role_announce", "deviceId": deviceId, "deviceName": "Apple TV", "role": "player"]))) { _ in }
        receiveWS()
    }

    private func receiveWS() {
        wsTask?.receive { [weak self] result in
            switch result {
            case .success(let msg):
                if case .string(let text) = msg { self?.handleWS(text) }
                self?.receiveWS()
            case .failure:
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self?.connectWebSocket() }
            }
        }
    }

    private func handleWS(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        if type == "queue",
           let qData = try? JSONSerialization.data(withJSONObject: json["data"] as Any) {
            DispatchQueue.main.async { self.queue = (try? JSONDecoder().decode([QueueItem].self, from: qData)) ?? [] }
        } else if type == "control",
                  let action = json["action"] as? String {
            let payload = json.filter { $0.key != "type" && $0.key != "action" } as? [String: Any] ?? [:]
            DispatchQueue.main.async { self.onControlMessage?(action, payload) }
        } else if type == "atmosphere", let kind = json["kind"] as? String {
            DispatchQueue.main.async { self.onAtmosphere?(kind) }
        } else if type == "blessing", let text = json["text"] as? String {
            let from = json["from"] as? String ?? ""
            DispatchQueue.main.async { self.onBlessing?(text, from) }
        } else if type == "lyrics_updated" {
            // 逐字歌词重新生成完成：无缝替换当前歌曲歌词（不清空、不中断播放）
            if let songId = json["songId"] as? Int {
                DispatchQueue.main.async { self.onLyricsUpdated?(songId) }
            }
        } else if type == "lyrics_style" {
            // 遥控端实时改歌词字色/描边色/描边粗细/左右翻转：走可观察单例，立即驱动 LyricsView 重绘（同时持久化）
            let color = json["color"] as? String
            let stroke = json["stroke"] as? String
            let widthVal = (json["width"] as? Double).map { CGFloat($0) }
            let scaleVal = (json["fontScale"] as? Double).map { CGFloat($0) }
            let posVal = (json["posV"] as? Double).map { CGFloat($0) }
            let flipVal = json["dualFlip"] as? Bool
            DispatchQueue.main.async { LyricsStyleStore.shared.apply(color: color, stroke: stroke, width: widthVal, scale: scaleVal, posV: posVal, dualFlip: flipVal) }
        }
    }

    func sendWSControl(_ type: String, _ payload: [String: Any] = [:]) {
        var msg = ["type": "control", "action": type, "clientId": clientId] as [String: Any]
        msg.merge(payload) { _, new in new }
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        wsTask?.send(.string(text)) { _ in }
    }

    /// Report current playback progress to the server. Only the active player
    /// (this TV) should call this; the server broadcasts it to all controllers
    /// (mobile remote) so their progress bars can interpolate and stay in sync.
    /// Called every 1s by PlayerManager's progress timer.
    func sendProgress(queueId: Int?, currentTime: Double, paused: Bool, voice: String) {
        var msg: [String: Any] = ["type": "progress", "deviceId": deviceId, "currentTime": currentTime, "paused": paused, "voice": voice]
        if let qid = queueId { msg["queueId"] = qid }
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        wsTask?.send(.string(text)) { _ in }
    }

    /// Report playback state (paused + original/accompaniment) to the server
    /// so mobile remote buttons stay in sync. Called on play/pause and voice toggle.
    func sendPlaybackState(paused: Bool, voice: String) {
        let msg: [String: Any] = ["type": "state", "paused": paused, "voice": voice]
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        wsTask?.send(.string(text)) { _ in }
    }

    private func JSONString(_ obj: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    func disconnectWebSocket() { wsTask?.cancel(); wsTask = nil }
    deinit { disconnectWebSocket() }

    // MARK: - 网络KTV API
    /// 获取网络KTV歌曲列表
    func fetchNetKtvSongs(completion: ((Bool, String?) -> Void)? = nil) {
        guard let url = apiURL("/api/netktv/songs") else {
            completion?(false, "URL错误")
            return
        }
        DispatchQueue.main.async { self.netKtvLoading = true; self.netKtvError = nil }
        URLSession.shared.dataTask(with: url) { [weak self] data, resp, error in
            DispatchQueue.main.async {
                self?.netKtvLoading = false
                if let error = error {
                    self?.netKtvError = error.localizedDescription
                    completion?(false, error.localizedDescription)
                    return
                }
                guard let data = data else {
                    self?.netKtvError = "无数据"
                    completion?(false, "无数据")
                    return
                }
                do {
                    let result = try JSONDecoder().decode(NetKtvSongsResponse.self, from: data)
                    self?.netKtvSongs = result.songs
                    completion?(true, nil)
                } catch {
                    self?.netKtvError = "解析失败: \(error.localizedDescription)"
                    completion?(false, "解析失败: \(error.localizedDescription)")
                }
            }
        }.resume()
    }

    /// 获取网络KTV歌曲的串流完整URL
    func netKtvStreamURL(song: NetKtvSong, type: String) -> URL? {
        let path = type == "vocals" ? song.vocal_url : song.accompaniment_url
        return URL(string: "\(baseURL)\(path)")
    }

    /// 获取网络KTV歌曲信息（时长、同步状态）
    func fetchNetKtvSongInfo(songId: String, completion: @escaping (NetKtvSongInfo?) -> Void) {
        guard let url = apiURL("/api/netktv/info/\(songId)") else {
            completion(nil)
            return
        }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data,
                  let info = try? JSONDecoder().decode(NetKtvSongInfo.self, from: data) else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            DispatchQueue.main.async { completion(info) }
        }.resume()
    }
}

