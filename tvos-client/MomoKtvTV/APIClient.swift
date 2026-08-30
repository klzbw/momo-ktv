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

    private var baseURL: String
    private var wsTask: URLSessionWebSocketTask?
    private var sessionCookie: String?
    /// Unique per-app ID; attached to outgoing WS control messages so we can
    /// ignore our own messages echoed back by the server broadcast.
    let clientId = UUID().uuidString

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

    private func apiURL(_ path: String) -> URL? {
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
        // Newest = songs sorted by id desc (latest added)
        guard let url = apiURL("/api/songs") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                if let data = data, let songs = try? JSONDecoder().decode([Song].self, from: data) {
                    self?.newest = Array(songs.sorted(by: { $0.id > $1.id }).prefix(50))
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
    func coverURL(_ filename: String?) -> URL? {
        guard let filename = filename, !filename.isEmpty else { return nil }
        return apiURL("/cover/\(filename)")
    }

    // MARK: - WebSocket
    var onControlMessage: ((String, [String: Any]) -> Void)?

    func connectWebSocket() {
        guard let wsURL = URL(string: baseURL.replacingOccurrences(of: "http", with: "ws") + "/ws") else { return }
        wsTask = URLSession.shared.webSocketTask(with: wsURL)
        wsTask?.resume()
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
        }
    }

    func sendWSControl(_ type: String, _ payload: [String: Any] = [:]) {
        var msg = ["type": "control", "action": type, "clientId": clientId] as [String: Any]
        msg.merge(payload) { _, new in new }
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        wsTask?.send(.string(text)) { _ in }
    }

    func disconnectWebSocket() { wsTask?.cancel(); wsTask = nil }
    deinit { disconnectWebSocket() }
}

