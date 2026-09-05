import UIKit
import AVFoundation
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC播放器封装 - 用于播放MKV等AVFoundation不支持的格式
/// 支持115网盘自定义UA、302直连、音轨切换（原唱/伴唱）
class VLCPlayerManager: NSObject, ObservableObject {
    static let shared = VLCPlayerManager()

    // MARK: - 状态
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var duration: Double = 0
    @Published var debugLog: String = ""  // 调试日志，实时显示在界面上
    private(set) var audioTrackNames: [String] = []
    private(set) var currentAudioTrackIndex: Int = 0

    var onTimeUpdate: ((Double, Double) -> Void)?
    var onStateChange: ((Bool) -> Void)?
    var onError: ((String) -> Void)?

    // MARK: - VLC实例
    #if canImport(TVVLCKit)
    private var library: VLCLibrary?
    private var player: VLCMediaPlayer?
    private var media: VLCMedia?
    #endif
    private var drawableViews: NSHashTable<UIView> = NSHashTable.weakObjects()
    private var timeObserverTimer: Timer?
    private var lastDebugSecond: Int = -1

    private override init() {
        super.init()
        #if canImport(TVVLCKit)
        setupLibrary()
        #endif
    }

    #if canImport(TVVLCKit)
    private func setupLibrary() {
        // 115网盘需要特定UA，否则CDN返回403
        // --no-video-title-show 隐藏VLC默认标题显示
        // --http-reconnect 网络中断自动重连
        // --no-http-referrer 不发送referrer
        let options = [
            "--http-user-agent=Mozilla/5.0 115Browser/23.9.3.2",
            "--no-video-title-show",
            "--network-caching=3000",
            "--file-caching=3000",
            "--http-reconnect",
            "--no-http-referrer",
            "--no-http-forward-cookies"
        ]
        let lib = VLCLibrary(options: options)
        library = lib
        player = VLCMediaPlayer(library: lib)
        player?.delegate = self
        log("VLCLibrary初始化成功, options: \(options)")
    }
    #endif

    /// 记录调试日志（同时print和保存到debugLog供界面显示）
    private func log(_ message: String) {
        let timestamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        let line = "[\(timestamp)] \(message)"
        print(line)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.debugLog = line + "\n" + self.debugLog
            // 最多保留50行
            let lines = self.debugLog.components(separatedBy: "\n")
            if lines.count > 50 {
                self.debugLog = lines.prefix(50).joined(separator: "\n")
            }
        }
    }

    // MARK: - 播放控制

    /// 播放URL（支持115网盘302直连，VLC自动跟随重定向并保留UA）
    func play(url: URL) {
        #if canImport(TVVLCKit)
        guard let player = player else {
            onError?("VLC播放器未初始化")
            return
        }

        cleanup()

        log("▶️ 完整URL: \(url.absoluteString)")
        log("URL scheme: \(url.scheme ?? "nil"), host: \(url.host ?? "nil")")

        let media = VLCMedia(url: url)
        // 在media级别也设置UA，确保115 CDN能识别
        media.addOption("--http-user-agent=Mozilla/5.0 115Browser/23.9.3.2")
        media.addOption("--no-http-referrer")
        self.media = media
        player.media = media

        // 设置视频输出到所有已注册的view
        for view in drawableViews.allObjects {
            player.drawable = view
        }
        log("已注册drawable数量: \(drawableViews.allObjects.count)")

        player.play()
        isPlaying = true
        onStateChange?(true)
        log("▶️ 开始播放: \(url.lastPathComponent)")
        log("media状态: \(media.state.rawValue), 时长: \(media.length.intValue)ms")
        log("player状态: \(player.state.rawValue)")
        log("player可播放: \(player.isSeekable), 可暂停: \(player.canPause)")

        startTimer()
        // 延迟2秒后再次检查状态（VLC异步加载）
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self = self, let p = self.player else { return }
            log("2秒后状态: \(p.state.rawValue), time: \(p.time.intValue)ms, length: \(p.media?.length.intValue ?? 0)ms")
            log("2秒后 可播放: \(p.isSeekable), 可暂停: \(p.canPause)")
            let audioNames = p.audioTrackNames as? [String] ?? []
            let videoNames = p.videoTrackNames as? [String] ?? []
            log("2秒后 视频轨道: \(videoNames.count), 音频轨道: \(audioNames.count)")
            log("音频轨道名称: \(audioNames)")
            log("视频轨道名称: \(videoNames)")
        }
        #else
        onError?("MobileVLCKit未集成")
        #endif
    }

    func pause() {
        #if canImport(TVVLCKit)
        player?.pause()
        isPlaying = false
        onStateChange?(false)
        #endif
    }

    func resume() {
        #if canImport(TVVLCKit)
        player?.play()
        isPlaying = true
        onStateChange?(true)
        #endif
    }

    func stop() {
        #if canImport(TVVLCKit)
        player?.stop()
        isPlaying = false
        onStateChange?(false)
        stopTimer()
        #endif
    }

    func seek(to seconds: Double) {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        player.time = VLCTime(int: Int32(seconds * 1000))
        currentTime = seconds
        #endif
    }

    // MARK: - 音轨切换（原唱/伴唱）

    func refreshAudioTracks() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        let names = player.audioTrackNames as? [String] ?? []
        audioTrackNames = names
        if audioTrackNames.isEmpty {
            audioTrackNames = ["原唱", "伴唱"]
        }
        currentAudioTrackIndex = Int(player.currentAudioTrackIndex)
        log("音轨列表: \(audioTrackNames), 当前: \(currentAudioTrackIndex)")
        #endif
    }

    func setAudioTrack(index: Int) {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        player.currentAudioTrackIndex = Int32(index)
        currentAudioTrackIndex = index
        log("切换音轨到: \(index)")
        #endif
    }

    // MARK: - 视频输出视图

    func addDrawable(_ view: UIView) {
        drawableViews.add(view)
        #if canImport(TVVLCKit)
        player?.drawable = view
        #endif
    }

    func removeDrawable(_ view: UIView) {
        drawableViews.remove(view)
    }

    // MARK: - 内部

    private func startTimer() {
        stopTimer()
        timeObserverTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.updateTime()
        }
    }

    private func stopTimer() {
        timeObserverTimer?.invalidate()
        timeObserverTimer = nil
    }

    private func updateTime() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        let currentMs = player.time.intValue
        let totalMs = player.media?.length.intValue ?? 0
        let current = Double(currentMs) / 1000.0
        let total = Double(totalMs) / 1000.0
        // 每5秒打印一次调试信息
        if Int(current) % 5 == 0 && Int(current) != lastDebugSecond {
            lastDebugSecond = Int(current)
            log("时间更新: current=\(currentMs)ms(\(current)s), total=\(totalMs)ms(\(total)s), state=\(player.state.rawValue)")
        }
        if current != currentTime || total != duration {
            currentTime = current
            duration = total
            onTimeUpdate?(currentTime, duration)
        }
        #endif
    }

    private func cleanup() {
        stopTimer()
        #if canImport(TVVLCKit)
        player?.stop()
        media = nil
        #endif
        currentTime = 0
        duration = 0
        audioTrackNames = []
        currentAudioTrackIndex = 0
    }
}

#if canImport(TVVLCKit)
extension VLCPlayerManager: VLCMediaPlayerDelegate {
    func mediaPlayerStateChanged(_ aNotification: Notification) {
        guard let player = player else { return }
        let stateNames = ["Idle", "Opening", "Buffering", "Ended", "Error", "Playing", "Paused", "Stopped"]
        let stateName = player.state.rawValue < stateNames.count ? stateNames[Int(player.state.rawValue)] : "Unknown"
        log("状态变化: \(player.state.rawValue)(\(stateName)), time=\(player.time.intValue)ms, length=\(player.media?.length.intValue ?? 0)ms")
        // VLCMediaPlayerState: 0=Idle,1=Opening,2=Buffering,3=Ended,4=Error,5=Playing,6=Paused,7=Stopped
        switch player.state {
        case .playing:
            isPlaying = true
            onStateChange?(true)
            refreshAudioTracks()
        case .paused:
            isPlaying = false
            onStateChange?(false)
        case .ended:
            isPlaying = false
            onStateChange?(false)
        case .error:
            log("❌ VLC错误! media状态: \(player.media?.state.rawValue ?? -1), media时长: \(player.media?.length.intValue ?? 0)ms")
            log("❌ 可播放: \(player.isSeekable), 可暂停: \(player.canPause), 视频轨道数: \(player.videoTrackNames.count)")
            if let media = player.media {
                log("❌ media URL: \(media.url?.absoluteString ?? "nil")")
                log("❌ media 类型: \(media.mediaType.rawValue)")
            }
            onError?("VLC播放错误")
        default:
            break
        }
    }

    func mediaPlayerTimeChanged(_ aNotification: Notification) {
        updateTime()
    }
}
#endif
