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
    /// 当前活动的视频输出视图（只有一个会被设置为VLC的drawable）
    private var activeDrawable: UIView?
    private var timeObserverTimer: Timer?
    private var lastDebugSecond: Int = -1

    private var libraryInitialized = false
    private var isRestarting = false  // 防止restart重复调用
    private var lastReportedState: Int = -1  // 状态变化去重，避免刷屏

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
            "--network-caching=500"
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

        // 播放开始后多次延迟重新设置drawable，确保视频输出正确初始化
        // VLC视频输出需要时间初始化，多次设置提高成功率（包括更长延迟）
        let delays: [Double] = [0.3, 0.8, 1.5, 2.5, 4.0, 6.0, 8.0]
        for (i, delay) in delays.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self else { return }
                self.refreshDrawables()
                self.log("播放后第\(i+1)次刷新drawable (\(delay)s)")
            }
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
        activeDrawable = nil
        onStateChange?(false)
        stopTimer()
        log("stop: 停止VLC播放")
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

    /// 切换播放/暂停
    func togglePlayPause() {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        if isPlaying {
            p.pause()
            isPlaying = false
            log("togglePlayPause: 暂停")
        } else {
            p.play()
            isPlaying = true
            log("togglePlayPause: 播放")
            // 播放恢复后重新设置视频输出（暂停可能导致视频层丢失）
            let delays: [Double] = [0.2, 0.6, 1.2, 2.0]
            for (i, delay) in delays.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.refreshDrawables()
                    self?.log("播放恢复后第\(i+1)次刷新drawable (\(delay)s)")
                }
            }
        }
        #endif
    }

    /// 设置音量 (0.0 - 1.0)
    func setVolume(_ volume: Float) {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        // VLC音量范围是0-100（100=100%音量），超过100会增益导致爆破声
        // 使用0-100范围，避免音量过大失真
        let vlcVolume = Int32(volume * 100)
        p.audio?.volume = vlcVolume
        log("setVolume: \(volume) (VLC: \(vlcVolume))")
        #endif
    }

    /// 重新演唱（回到开头并播放）
    func restart() {
        #if canImport(TVVLCKit)
        guard let p = player, let media = p.media, !isRestarting else { return }
        isRestarting = true
        let url = media.url
        log("restart: 停止并重新播放（网络流不支持seek，重新建立连接）")
        // 停止播放（网络流无法seek到0，必须重新建立连接）
        p.stop()
        isPlaying = false
        onStateChange?(false)
        activeDrawable = nil
        // 延迟0.5秒后重新播放
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            self.play(url: url)
            self.log("restart: 重新播放完成")
            // 重唱后多次延迟重新设置视频输出
            let delays: [Double] = [0.5, 1.2, 2.0, 3.5]
            for (i, delay) in delays.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.refreshDrawables()
                    if i == delays.count - 1 {
                        self?.isRestarting = false
                    }
                }
            }
        }
        #endif
    }

    /// 强制重置视频输出（先清除所有drawable，再重新设置，解决大屏视频不显示的问题）
    func forceResetDrawable() {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        // 先清除所有drawable
        p.drawable = nil
        activeDrawable = nil
        log("forceResetDrawable: 清除所有drawable")
        // 延迟后重新设置activeDrawable
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self, let p = self.player else { return }
            if let active = self.drawableViews.allObjects.last as? UIView {
                self.activeDrawable = active
                p.drawable = active
                self.log("forceResetDrawable: 重新设置drawable到最新视图")
            } else if let first = self.drawableViews.allObjects.first as? UIView {
                self.activeDrawable = first
                p.drawable = first
                self.log("forceResetDrawable: 重新设置drawable到第一个视图")
            }
        }
        #endif
    }

    func refreshAudioTracks() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        let names = player.audioTrackNames as? [String] ?? []
        // 过滤掉Disable，只保留实际音轨，并映射成中文名称
        var mappedNames: [String] = []
        for (i, name) in names.enumerated() {
            if name.lowercased() == "disable" { continue }
            if name.lowercased().contains("track 1") || name.lowercased().contains("track1") {
                mappedNames.append("原唱")
            } else if name.lowercased().contains("track 2") || name.lowercased().contains("track2") {
                mappedNames.append("伴唱")
            } else {
                mappedNames.append(name)
            }
        }
        if mappedNames.isEmpty {
            mappedNames = ["原唱", "伴唱"]
        }
        audioTrackNames = mappedNames
        // 只在当前索引无效时才从player读取
        let playerIndex = Int(player.currentAudioTrackIndex)
        if currentAudioTrackIndex < 0 || currentAudioTrackIndex >= mappedNames.count {
            // VLC的索引可能包含Disable(-1)，需要转换
            if playerIndex >= 0 && playerIndex < names.count {
                // 计算在过滤后的列表中的索引
                var filteredIndex = 0
                for i in 0...playerIndex {
                    if i < names.count && names[i].lowercased() != "disable" {
                        if i == playerIndex { break }
                        filteredIndex += 1
                    }
                }
                currentAudioTrackIndex = filteredIndex
            } else {
                currentAudioTrackIndex = 0
            }
        }
        log("音轨列表: \(audioTrackNames), 当前: \(currentAudioTrackIndex), player原始索引: \(playerIndex)")
        #endif
    }

    func setAudioTrack(index: Int) {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        // 获取VLC原始音轨列表，转换为实际索引（跳过Disable）
        let rawNames = player.audioTrackNames as? [String] ?? []
        var vlcIndex = 0
        var found = false
        var filteredCount = 0
        for (i, name) in rawNames.enumerated() {
            if name.lowercased() == "disable" { continue }
            if filteredCount == index {
                vlcIndex = i
                found = true
                break
            }
            filteredCount += 1
        }
        if found {
            player.currentAudioTrackIndex = Int32(vlcIndex)
            log("切换音轨: 映射索引\(index) -> VLC索引\(vlcIndex), \(rawNames[vlcIndex])")
        } else {
            player.currentAudioTrackIndex = Int32(index)
            log("切换音轨到: \(index)（未找到映射，直接设置）")
        }
        currentAudioTrackIndex = index
        #endif
    }

    /// 切换原唱/伴唱（在VLC模式下替代PlayerManager.toggleVoice）
    func toggleVoice() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        // 不调用refreshAudioTracks，避免重置currentAudioTrackIndex
        let count = max(audioTrackNames.count, 1)
        let nextIndex = (currentAudioTrackIndex + 1) % count
        log("toggleVoice: 当前\(currentAudioTrackIndex) -> 下一个\(nextIndex), 轨道数:\(count)")
        setAudioTrack(index: nextIndex)
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
        // 如果没有活动的drawable，或者活动的drawable不在数组中，设置这个为活动的
        let activeInArray = drawableViews.allObjects.contains(where: { $0 as AnyObject === activeDrawable })
        if activeDrawable == nil || !activeInArray {
            setActiveDrawable(view)
        }
    }

    /// 设置当前活动的视频输出视图（只有这个会被设置为VLC的drawable）
    func setActiveDrawable(_ view: UIView?) {
        activeDrawable = view
        #if canImport(TVVLCKit)
        if let p = player, let v = view {
            p.drawable = v
            log("setActiveDrawable: 设置视频输出")
        } else if view == nil {
            log("setActiveDrawable: 清除活动drawable")
        }
        #endif
    }

    /// 清除指定的活动drawable（如果它是当前活动的）
    func clearActiveDrawable(_ view: UIView) {
        if activeDrawable === view {
            activeDrawable = nil
            // 尝试找下一个可用的drawable
            if let next = drawableViews.allObjects.first(where: { $0 !== view }) as? UIView {
                setActiveDrawable(next)
            }
        }
        drawableViews.remove(view)
    }

    /// 重新设置活动的drawable（用于视频输出恢复）
    /// 先清除再设置，强制VLC重新创建视频输出层
    func refreshDrawables() {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        if let active = activeDrawable {
            // 先清除，再延迟设置，强制VLC重新创建视频输出层
            p.drawable = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak p, weak active] in
                guard let p = p, let active = active else { return }
                p.drawable = active
            }
            log("refreshDrawables: 清除并重新设置活动drawable")
        } else if let first = drawableViews.allObjects.first as? UIView {
            setActiveDrawable(first)
        } else {
            log("refreshDrawables: 没有可用的drawable")
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
        // 状态变化去重，避免Buffering状态反复刷屏
        if player.state.rawValue != lastReportedState {
            log("状态变化: \(player.state.rawValue)(\(stateName)), time=\(player.time.intValue)ms, length=\(player.media?.length.intValue ?? 0)ms")
            lastReportedState = player.state.rawValue
        }
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
