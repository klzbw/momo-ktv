import Foundation

/// REST API 客户端：歌曲列表、队列、sep-info、direct-stream 等
class KTVAPIClient {
    static let shared = KTVAPIClient(baseURL: "")

    private(set) var baseURL: String
    let clientId = UUID().uuidString
    let deviceId: String = {
        let key = "momo_ktv_device_id"
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let newId = "ios-\(UUID().uuidString.prefix(8))"
        UserDefaults.standard.set(newId, forKey: key)
        return newId
    }()

    /// 115 网盘专用 UA
    static let cloud115UserAgent = "Mozilla/5.0 115Browser/23.9.3.2"

    init(baseURL: String) {
        self.baseURL = baseURL.hasPrefix("http") ? baseURL : "http://\(baseURL)"
    }

    func updateBaseURL(_ url: String) {
        self.baseURL = url.hasPrefix("http") ? url : "http://\(url)"
    }

    var serverAddress: String {
        baseURL.replacingOccurrences(of: "http://", with: "")
            .replacingOccurrences(of: "https://", with: "")
    }

    func apiURL(_ path: String) -> URL? {
        URL(string: "\(baseURL)\(path)")
    }

    // MARK: - 歌曲
    func fetchSongs(query: String = "", page: Int = 1, pageSize: Int = 50,
                    completion: @escaping ([Song], Int) -> Void) {
        var params: [String] = ["page=\(page)", "pageSize=\(pageSize)"]
        if !query.isEmpty {
            params.append("q=\(query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")")
        }
        let path = "/api/songs?" + params.joined(separator: "&")
        guard let url = apiURL(path) else { completion([], 0); return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data else { completion([], 0); return }
            DispatchQueue.main.async {
                if let sr = try? JSONDecoder().decode(SearchResponse.self, from: data),
                   let items = sr.items {
                    completion(items, sr.total ?? items.count)
                } else if let songs = try? JSONDecoder().decode([Song].self, from: data) {
                    completion(songs, songs.count)
                } else {
                    completion([], 0)
                }
            }
        }.resume()
    }

    func fetchArtists(completion: @escaping ([Artist]) -> Void) {
        guard let url = apiURL("/api/artists") else { completion([]); return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data else { completion([]); return }
            DispatchQueue.main.async {
                completion((try? JSONDecoder().decode([Artist].self, from: data)) ?? [])
            }
        }.resume()
    }

    // MARK: - 队列
    func fetchQueue(completion: @escaping ([QueueItem]) -> Void) {
        guard let url = apiURL("/api/queue") else { completion([]); return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data else { completion([]); return }
            DispatchQueue.main.async {
                completion((try? JSONDecoder().decode([QueueItem].self, from: data)) ?? [])
            }
        }.resume()
    }

    func addToQueue(songId: Int, nickname: String = "iOS用户", completion: ((Bool) -> Void)? = nil) {
        guard let url = apiURL("/api/queue") else { completion?(false); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["song_id": songId, "nickname": nickname])
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async {
                completion?((resp as? HTTPURLResponse)?.statusCode == 200)
            }
        }.resume()
    }

    func removeFromQueue(queueId: Int, completion: ((Bool) -> Void)? = nil) {
        guard let url = apiURL("/api/queue/\(queueId)") else { completion?(false); return }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async { completion?((resp as? HTTPURLResponse)?.statusCode == 200) }
        }.resume()
    }

    func topQueue(queueId: Int, completion: ((Bool) -> Void)? = nil) {
        guard let url = apiURL("/api/queue/\(queueId)/top") else { completion?(false); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async { completion?((resp as? HTTPURLResponse)?.statusCode == 200) }
        }.resume()
    }

    // MARK: - 播放信息
    func fetchSepInfo(songId: Int, completion: @escaping (SepInfo?) -> Void) {
        guard let url = apiURL("/api/songs/\(songId)/sep-info") else { completion(nil); return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data else { completion(nil); return }
            DispatchQueue.main.async {
                completion(try? JSONDecoder().decode(SepInfo.self, from: data))
            }
        }.resume()
    }

    /// direct-stream URL：服务端 302 重定向到 115 CDN 直链
    func directStreamURL(filepath: String) -> URL? {
        let encoded = filepath.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? filepath
        return apiURL("/api/direct-stream/\(encoded)")
    }

    func coverURL(_ filename: String?) -> URL? {
        guard let filename = filename, !filename.isEmpty else { return nil }
        return apiURL("/cover/\(filename)")
    }

    func wsURL() -> URL? {
        URL(string: baseURL.replacingOccurrences(of: "http", with: "ws") + "/ws")
    }

    func fetchStats(completion: @escaping (Stats?) -> Void) {
        guard let url = apiURL("/api/stats") else { completion(nil); return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data = data else { completion(nil); return }
            DispatchQueue.main.async { completion(try? JSONDecoder().decode(Stats.self, from: data)) }
        }.resume()
    }
}
