import Foundation

/// 服务器地址配置：用 UserDefaults 持久化，首次启动需要用户输入 NAS/服务器 IP
struct ServerConfig {
    private static let keyHost = "momo_server_host"
    private static let keyPort = "momo_server_port"

    /// 主机（IP 或域名），不含协议与端口
    static var host: String {
        get { UserDefaults.standard.string(forKey: keyHost) ?? "" }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespaces), forKey: keyHost) }
    }

    /// 端口，默认 8083（飞书 NAS 宿主机映射端口）
    static var port: String {
        get {
            let p = UserDefaults.standard.string(forKey: keyPort) ?? ""
            return p.isEmpty ? "8083" : p
        }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespaces), forKey: keyPort) }
    }

    static var isConfigured: Bool {
        return !host.isEmpty
    }

    /// 大屏 TV 页面地址
    static var tvURL: URL? {
        guard isConfigured else { return nil }
        let h = host
        let p = port
        var comps = URLComponents()
        comps.scheme = "http"
        comps.host = h
        comps.port = Int(p) ?? 8083
        comps.path = "/tv/"
        return comps.url
    }

    /// 根地址（用于判断）
    static var baseURLString: String {
        return "http://\(host):\(port)"
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: keyHost)
        UserDefaults.standard.removeObject(forKey: keyPort)
    }
}
