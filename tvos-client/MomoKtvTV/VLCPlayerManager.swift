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

    private var libraryInitialized = false

    private override init() {
        super.init()
        // 不在init时初始化VLC，避免APP启动时崩溃
        // 改为懒加载：第一次播放时才调用setupLibrary()
    }

    #if canImport(TVVLCKit)
    private func setupLibrary() {
        guard !libraryInitialized else { return }
        libraryInitialized = true
        // 115网盘需要特定UA，否则CDN返回403
        // 只保留最基本的选项，避免不支持的选项导致崩溃
        let options = [
            "--http-user-agent=Mozilla/5.0 115Browser/23.9.3.2",
            "--no-video-title-show",
            "--network-caching=1000"
        ]
        let lib = VLCLibrary(options: options)
        library = lib
        player = VLCMediaPlayer(library: lib)
        player?.delegate = self
        log("VLCLibrary初始化成功")
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
        // 懒加载：第一次播放时才初始化VLC，避免APP启动崩溃
        setupLibrary()

        guard let player = player else {
            onError?("VLC播放器未初始化")
            return
        }

        cleanup()

        log("▶️ 完整URL: \(url.absoluteString)")
        log("URL scheme: \(url.scheme ?? "nil"), host: \(url.host ?? "nil")")

        let media = VLCMedia(url: url)
        // 在media级别也设置UA，确保115 CDN能识别
        // library级别的--http-user-agent在tvOS上可能不生效，这里用media级别
        let uaOption = ":http-user-agent=Mozilla/5.0 115Browser/23.9.3.2"
        media.addOption(uaOption)
        log("已设置media UA选项: \(uaOption)")
        self.media = media
        player.media = media

        // 设置视频输出到所有已注册的view
        // 注意：VLC是懒加载的，VLCVideoView注册时player可能为nil，
        // 所以这里需要重新注册所有drawable
        let views = drawableViews.allObjects
        for view in views {
            player.drawable = view
        }
        log("已注册drawable数量: \(views.count)")
        if views.isEmpty {
            log("⚠️ 警告：没有已注册的视频输出视图，视频将无法显示！")
        }

        // 打印URL是否包含proxy参数（调试用）
        if url.absoluteString.contains("proxy=1") {
            log("使用代理模式（服务端转发，占NAS带宽）")
        } else {
            log("使用302直连模式（不占NAS带宽，VLC直接访问115 CDN）")
        }

        player.play()
        isPlaying = true
        onStateChange?(true)

        // 播放开始后延迟重新设置drawable，确保视频输出正确初始化
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self, let p = self.player else { return }
            let views = self.drawableViews.allObjects
            for view in views {
                p.drawable = view
            }
            self.log("播放后重新设置drawable: \(views.count)个视图")
        }

        // 延迟2秒后刷新音轨信息
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.refreshAudioTracks()
        }
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

    /// 切换原唱/伴唱（在VLC模式下替代PlayerManager.toggleVoice）
    func toggleVoice() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        refreshAudioTracks()
        let nextIndex = (currentAudioTrackIndex + 1) % max(audioTrackNames.count, 1)
        setAudioTrack(index: nextIndex)
        log("toggleVoice: 当前\(currentAudioTrackIndex) -> 下一个\(nextIndex), 轨道数:\(audioTrackNames.count)")
        #endif
    }

    /// 当前音轨标签（用于UI显示）
    var voiceLabel: String {
        if audioTrackNames.isEmpty {
            return currentAudioTrackIndex == 0 ? "原唱" : "伴唱"
        }
        if currentAudioTrackIndex < audioTrackNames.count {
            return audioTrackNames[currentAudioTrackIndex]
        }
        return "原唱"
    }

    // MARK: - 视频输出视图

    func addDrawable(_ view: UIView) {
        drawableViews.add(view)
        #if canImport(TVVLCKit)
        // 如果VLC已初始化，立即设置；否则等play()时统一注册
        if let p = player {
            p.drawable = view
            log("addDrawable: 立即设置视频输出")
        } else {
            log("addDrawable: VLC未初始化，已保存视图，play()时统一注册")
        }
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
