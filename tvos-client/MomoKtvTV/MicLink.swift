import Foundation
import Combine
import AVFoundation

// MARK: - 手机麦克风 → 电视 实时音频链路
//
// 数据流：手机网页(/mic, role=mic)采集麦克风 PCM → Node 服务(/mic)转发 →
// 本类以 role=tv 在局域网用 WebSocket 连到同一台 Node，收到二进制 PCM16 帧后
// 交给 MicAudioEngine 播放。伴奏仍由 PlayerManager 的 AVPlayer 播放，二者在
// 系统音频会话里自动混合，最终一起从电视输出（人声叠加在伴奏上）。
//
// 采样率由手机连接后通过 {type:"config",sampleRate} 告知，引擎按它动态建格式，
// 因此手机端无需重采样；换不同采样率的手机时自动重建播放节点。

/// 负责把收到的 PCM16 单声道数据低延迟播放出来
final class MicAudioEngine {
    private let engine = AVAudioEngine()
    private var player: AVAudioPlayerNode?
    private var playFormat: AVAudioFormat?
    private var sampleRate: Double = 48000
    private let queue = DispatchQueue(label: "com.momo.mic.audio")
    private var gain: Float = 1.0
    private var isRunning = false
    /// 已 schedule 但尚未播放完的采样数，用于发现播放队列积压（延迟越滚越大）
    private var queuedFrames: Int = 0
    /// 积压高水位：超过约 200ms 就清空旧缓冲、只留最新音频，把人声延迟拉回一帧
    private var maxQueuedFrames: Int { return max(1024, Int(sampleRate * 0.2)) }

    func setGain(_ g: Float) {
        queue.async {
            self.gain = g
            self.player?.volume = g
        }
    }

    /// 按手机采样率（重新）搭建节点；采样率没变则不重建，避免断音
    func configure(sampleRate sr: Double) {
        queue.async {
            guard sr > 0 else { return }
            if self.isRunning, abs(self.sampleRate - sr) < 1.0 { return }
            self.sampleRate = sr
            self.rebuildLocked()
        }
    }

    func start() {
        queue.async {
            if self.isRunning {
                try? self.engine.start()
                self.player?.play()
                return
            }
            self.configureSession()
            self.rebuildLocked()
        }
    }

    func stop() {
        queue.async {
            self.player?.stop()
            self.engine.stop()
            self.isRunning = false
        }
    }

    private func configureSession() {
        #if os(tvOS)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback)
            try session.setActive(true)
        } catch {
            // 共享会话配置失败不致命：AVAudioEngine.start 仍会尝试激活
        }
        #endif
    }

    /// 调用方已在串行队列内
    private func rebuildLocked() {
        if isRunning {
            player?.stop()
            engine.stop()
        }
        if let old = player { engine.detach(old) }

        let node = AVAudioPlayerNode()
        engine.attach(node)
        guard let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                     sampleRate: sampleRate,
                                     channels: 1,
                                     interleaved: false) else { return }
        engine.connect(node, to: engine.mainMixerNode, format: fmt)
        engine.mainMixerNode.outputVolume = 1.0
        node.volume = gain
        player = node
        playFormat = fmt
        self.queuedFrames = 0

        do {
            try engine.start()
            node.play()
            isRunning = true
        } catch {
            isRunning = false
        }
    }

    /// 接收一帧 Int16 小端、单声道 PCM，转 Float32 后排入播放
    func enqueuePCM16(_ data: Data) {
        queue.async {
            guard self.isRunning,
                  let node = self.player,
                  let fmt = self.playFormat else { return }
            let frameCount = data.count / 2
            guard frameCount > 0,
                  let buffer = AVAudioPCMBuffer(pcmFormat: fmt,
                                                frameCapacity: AVAudioFrameCount(frameCount)) else { return }
            buffer.frameLength = AVAudioFrameCount(frameCount)
            guard let channel = buffer.floatChannelData?[0] else { return }

            data.withUnsafeBytes { raw in
                let src = raw.bindMemory(to: Int16.self)
                for i in 0..<frameCount {
                    let sample = Int16(littleEndian: src[i])
                    var v = Float(sample) / 32768.0 * self.gain
                    if v > 1 { v = 1 } else if v < -1 { v = -1 }
                    channel[i] = v
                }
            }
            // 防延迟累积：排队音频超过高水位时，stop 会清掉所有未播放的旧缓冲，
            // 再从当前最新一帧开始播，把延迟立刻拉回（实时麦克风优先低延迟而非连续性）
            if self.queuedFrames > self.maxQueuedFrames {
                node.stop()
                self.queuedFrames = 0
                node.play()
            }
            self.queuedFrames += frameCount
            let scheduledFrames = frameCount
            node.scheduleBuffer(buffer, completionHandler: { [weak self] in
                self?.queue.async { self?.queuedFrames -= scheduledFrames }
            })
            if !node.isPlaying { node.play() }
        }
    }
}

/// 电视端麦克风链路单例：负责 WebSocket 连接、信令解析与状态发布
final class MicLink: ObservableObject {
    static let shared = MicLink()

    @Published var isOn = false            // 电视端是否开启了"麦克风模式"
    @Published var socketConnected = false // 是否已连上服务端 /mic
    @Published var phoneCount = 0          // 正在推流的手机数量（当前版本 0/1）
    @Published var gain: Float = 1.0 {
        didSet { engine.setGain(gain) }
    }

    private var task: URLSessionWebSocketTask?
    private var serverAddress: String?
    private var reconnectWork: DispatchWorkItem?
    private let engine = MicAudioEngine()
    private var userStopped = false

    private init() {}

    // MARK: 对外控制
    /// 开启麦克风模式：启动本地播放引擎并连接服务器
    func turnOn(_ address: String) {
        userStopped = false
        DispatchQueue.main.async { self.isOn = true }
        engine.start()
        openSocket(address)
    }

    /// 关闭：断开连接、停止引擎
    func turnOff() {
        userStopped = true
        reconnectWork?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        engine.stop()
        DispatchQueue.main.async {
            self.isOn = false
            self.phoneCount = 0
            self.socketConnected = false
        }
    }

    func toggle(_ address: String) {
        if isOn { turnOff() } else { turnOn(address) }
    }

    /// 切歌/全屏视图重建时，若仍处于开启状态则保持连接（地址变化则重连）
    func keepAlive(_ address: String) {
        guard isOn, !userStopped else { return }
        engine.start()
        if !socketConnected { openSocket(address) }
    }

    func nudgeGain(_ delta: Float) {
        let v = max(0.2, min(2.0, gain + delta))
        DispatchQueue.main.async { self.gain = v }
    }

    // MARK: WebSocket
    private func openSocket(_ address: String) {
        guard !address.isEmpty else { return }
        if address != serverAddress {
            task?.cancel(with: .goingAway, reason: nil)
            task = nil
        }
        serverAddress = address
        guard task == nil else { return }
        guard let url = URL(string: "ws://\(address)/mic?role=tv") else { return }
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop()
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .data(let bytes):
                    self.engine.enqueuePCM16(bytes)
                case .string(let text):
                    self.handleSignal(text)
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure:
                DispatchQueue.main.async { self.socketConnected = false }
                guard !self.userStopped else { return }
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        reconnectWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, !self.userStopped, let addr = self.serverAddress else { return }
            self.task = nil
            self.openSocket(addr)
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    private func handleSignal(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }
        DispatchQueue.main.async {
            switch type {
            case "hello", "presence":
                self.socketConnected = true
                if type == "presence" {
                    self.phoneCount = (json["phones"] as? NSNumber)?.intValue ?? 0
                }
            case "config":
                let sr = (json["sampleRate"] as? NSNumber)?.doubleValue ?? 48000
                self.engine.configure(sampleRate: sr)
            case "busy":
                break
            default:
                break
            }
        }
    }
}
