import Foundation
#if canImport(Starscream)
import Starscream
#endif

/// WebSocket 客户端：使用 Starscream 兼容 iOS 12+
/// 消息类型：control / queue / state / progress / role_announce / player_changed
class KTVWebSocketClient {
    static let shared = KTVWebSocketClient()

    #if canImport(Starscream)
    private var socket: WebSocket?
    #endif
    private var isConnected = false
    private var reconnectTimer: Timer?
    private var apiClient: KTVAPIClient?

    // 回调
    var onQueueUpdate: (([QueueItem]) -> Void)?
    var onControl: ((String, [String: Any]) -> Void)?
    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?

    private init() {}

    func connect(apiClient: KTVAPIClient) {
        self.apiClient = apiClient
        guard let wsURL = apiClient.wsURL() else { return }
        disconnect()

        #if canImport(Starscream)
        var request = URLRequest(url: wsURL)
        request.timeoutInterval = 10
        socket = WebSocket(request: request)
        socket?.delegate = self
        socket?.connect()
        #else
        // Fallback: 轮询模式（无 Starscream 时）
        startPolling()
        #endif
    }

    func disconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        #if canImport(Starscream)
        socket?.disconnect()
        socket = nil
        #endif
        isConnected = false
    }

    // MARK: - 发送消息
    func sendRoleAnnounce() {
        let msg: [String: Any] = [
            "type": "role_announce",
            "deviceId": apiClient?.deviceId ?? "",
            "deviceName": "iOS",
            "role": "player"
        ]
        send(msg)
    }

    func sendControl(_ action: String, payload: [String: Any] = [:]) {
        var msg: [String: Any] = [
            "type": "control",
            "action": action,
            "clientId": apiClient?.clientId ?? ""
        ]
        msg.merge(payload) { _, new in new }
        send(msg)
    }

    func sendProgress(queueId: Int?, currentTime: Double, paused: Bool, voice: String) {
        var msg: [String: Any] = [
            "type": "progress",
            "deviceId": apiClient?.deviceId ?? "",
            "currentTime": currentTime,
            "paused": paused,
            "voice": voice
        ]
        if let qid = queueId { msg["queueId"] = qid }
        send(msg)
    }

    func sendPlaybackState(paused: Bool, voice: String) {
        let msg: [String: Any] = [
            "type": "state",
            "paused": paused,
            "voice": voice
        ]
        send(msg)
    }

    private func send(_ msg: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        #if canImport(Starscream)
        socket?.write(string: text)
        #endif
    }

    // MARK: - 消息处理
    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "queue":
            if let qData = try? JSONSerialization.data(withJSONObject: json["data"] as Any),
               let queue = try? JSONDecoder().decode([QueueItem].self, from: qData) {
                DispatchQueue.main.async { self.onQueueUpdate?(queue) }
            }
        case "control":
            guard let action = json["action"] as? String else { return }
            let msgClientId = json["clientId"] as? String
            guard msgClientId != apiClient?.clientId else { return }
            let payload = json.filter { $0.key != "type" && $0.key != "action" && $0.key != "clientId" }
            DispatchQueue.main.async { self.onControl?(action, payload) }
        default:
            break
        }
    }

    // MARK: - 轮询降级（无 Starscream 时）
    private func startPolling() {
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.apiClient?.fetchQueue { queue in
                DispatchQueue.main.async { self?.onQueueUpdate?(queue) }
            }
        }
        onConnected?()
    }

    private func scheduleReconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: false) { [weak self] _ in
            if let api = self?.apiClient { self?.connect(apiClient: api) }
        }
    }
}

#if canImport(Starscream)
extension KTVWebSocketClient: WebSocketDelegate {
    func didReceive(event: WebSocketEvent, client: WebSocketClient) {
        switch event {
        case .connected(let headers):
            isConnected = true
            DispatchQueue.main.async { self.onConnected?() }
            sendRoleAnnounce()
        case .disconnected(let reason, let code):
            isConnected = false
            DispatchQueue.main.async { self.onDisconnected?() }
            print("[WS] disconnected: \(code) \(reason)")
            scheduleReconnect()
        case .text(let text):
            handleMessage(text)
        case .binary(let data):
            if let text = String(data: data, encoding: .utf8) { handleMessage(text) }
        case .error(let error):
            isConnected = false
            print("[WS] error: \(error.localizedDescription)")
            DispatchQueue.main.async { self.onDisconnected?() }
            scheduleReconnect()
        case .cancelled:
            isConnected = false
        default:
            break
        }
    }
}
#endif
