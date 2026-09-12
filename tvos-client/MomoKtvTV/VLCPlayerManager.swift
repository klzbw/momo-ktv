import UIKit
import AVFoundation
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC播放器封装 - 用于播放MKV等AVFoundation不支持的格式
/// 支持115网盘自定义UA、302直连预解析、音轨切换（原唱/伴唱）
///
/// 115 CDN 直链绑定 User-Agent：只有 115Browser/23.9.3.2 能访问，
/// VLC 默认 UA 会被 115 CDN 返回 403 invalid signature。
/// 本类通过三重保障确保 UA 生效：
///   1. VLCLibrary 级别 --http-user-agent
///   2. VLCMedia 级别 :http-user-agent
///   3. 播放前预解析 302 重定向，让 VLC 直接请求最终 115 CDN URL
///      （避免 VLC 跟随重定向时丢失自定义 UA）
class VLCPlayerManager: NSObject, ObservableObject {
    static let shared = VLCPlayerManager()

    // MARK: - 状态
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var duration: Double = 0
    @Published var debugLog: String = ""
    private(set) var audioTrackNames: [String] = []
    private(set) var currentAudioTrackIndex: Int = 0

    var onTimeUpdate: ((Double, Double) -> Void)?
    var onStateChange: ((Bool) -> Void)?
    var onError: ((String) -> Void)?
    /// 播放自然结束回调（VLC模式下用于自动播放下一首，与 AVPlayer 的 onPlaybackEnd 对齐）
    var onPlaybackEnd: (() -> Void)?

    // MARK: - VLC实例
    #if canImport(TVVLCKit)
    private var library: VLCLibrary?
    var player: VLCMediaPlayer?
    private var media: VLCMedia?
    /// 保存原始的 stream URL（direct-stream 或 share/stream，restart时用，避免用过期的115 CDN直链）
    private var originalStreamURL: URL?
    #endif
    private var drawableViews: NSHashTable<UIView> = NSHashTable.weakObjects()
    private var activeDrawable: UIView?
    private var timeObserverTimer: Timer?
    private var lastDebugSecond: Int = -1

    private var libraryInitialized = false
    private var isRestarting = false
    private var lastReportedState: Int = -1

    /// 115 网盘专用 UA（必须与 pan115 driver 调用 API 时使用的 UA 一致）
    static let cloud115UserAgent = "Mozilla/5.0 115Browser/23.9.3.2"

    private override init() {
        super.init()
    }

    #if canImport(TVVLCKit)
    private func setupLibrary() {
        guard !libraryInitialized else { return }
        libraryInitialized = true
        // 115网盘需要特定UA，否则CDN返回403
        // 多重保障：library级别 + 后续media级别
        let options = [
            "--http-user-agent=\(VLCPlayerManager.cloud115UserAgent)",
            "--http-referrer=https://115.com/",
            "--no-video-title-show",
            "--network-caching=1000",
            "--live-caching=1000",
            "--file-caching=1000"
        ]
        let lib = VLCLibrary(options: options)
        library = lib
        player = VLCMediaPlayer(library: lib)
        player?.delegate = self
        log("VLCLibrary初始化成功, UA=\(VLCPlayerManager.cloud115UserAgent)")
    }
    #endif

    private func log(_ message: String) {
        let timestamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        let line = "[\(timestamp)] \(message)"
        print(line)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.debugLog = line + "\n" + self.debugLog
            let lines = self.debugLog.components(separatedBy: "\n")
            if lines.count > 50 {
                self.debugLog = lines.prefix(50).joined(separator: "\n")
            }
        }
    }

    // MARK: - 302 重定向预解析

    /// 用于捕获302重定向的URLSession代理（禁止自动跟随重定向）
    private class RedirectCatcher: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            // 返回nil禁止自动跟随重定向，保留原始302响应以便读取Location头
            completionHandler(nil)
        }
    }
    private let redirectCatcher = RedirectCatcher()
    private lazy var noRedirectSession: URLSession = {
        URLSession(configuration: .default, delegate: redirectCatcher, delegateQueue: nil)
    }()

    /// 预解析 URL 的 302 重定向，返回最终 URL。
    /// 使用自定义URLSession禁止自动跟随重定向，确保能读取到302的Location头。
    /// （URLSession.shared默认会自动跟随302，导致返回最终响应而非302）
    ///
    /// 触发条件（两类 URL 都会 302 到 115 CDN 直链）：
    /// - /api/direct-stream/...  （netktv-mkv，115 网盘直链）
    /// - /api/share/stream/...   （share-115 分享链接，Alist /d/ 代理）
    /// 必须在客户端先解析，否则 VLC 自行跟随重定向时可能丢失自定义 UA，
    /// 导致 115 CDN 返回 403 invalid signature。
    private func resolveRedirect(for url: URL, completion: @escaping (URL) -> Void) {
        let urlStr = url.absoluteString
        let needsResolve = urlStr.contains("direct-stream") || urlStr.contains("share/stream")
        guard needsResolve else {
            completion(url)
            return
        }

        log("预解析302重定向: \(url.absoluteString)")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        request.setValue(VLCPlayerManager.cloud115UserAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("bytes=0-0", forHTTPHeaderField: "Range")  // 只取1字节，快速获取302

        let task = noRedirectSession.dataTask(with: request) { [weak self] _, response, error in
            if let error = error {
                self?.log("预解析失败(\(error.localizedDescription))，使用原始URL")
                DispatchQueue.main.async { completion(url) }
                return
            }
            if let httpResp = response as? HTTPURLResponse {
                self?.log("预解析状态: \(httpResp.statusCode)")
                // 302/301重定向：从Location头获取最终URL
                if (300...399).contains(httpResp.statusCode),
                   let location = httpResp.allHeaderFields["Location"] as? String,
                   let finalURL = URL(string: location) {
                    self?.log("预解析成功(\(httpResp.statusCode))，最终URL: \(finalURL.absoluteString.prefix(80))...")
                    DispatchQueue.main.async { completion(finalURL) }
                    return
                }
                // 200：可能服务端直接返回内容（非重定向模式），用原始URL让VLC处理
                if httpResp.statusCode == 200 {
                    self?.log("预解析返回200（非重定向），使用原始URL")
                } else {
                    self?.log("预解析返回\(httpResp.statusCode)，使用原始URL")
                }
            }
            DispatchQueue.main.async { completion(url) }
        }
        task.resume()
    }

    // MARK: - 播放控制

    /// 播放URL（支持115网盘302直连，预解析重定向后VLC直接访问115 CDN）
    func play(url: URL) {
        #if canImport(TVVLCKit)
        setupLibrary()

        guard let player = player else {
            onError?("VLC播放器未初始化")
            return
        }

        // 预解析302重定向，得到最终115 CDN URL后再播放
        resolveRedirect(for: url) { [weak self] finalURL in
            guard let self = self else { return }
            self.startPlayback(player: player, url: finalURL, originalURL: url)
        }
        #else
        onError?("MobileVLCKit未集成")
        #endif
    }

    #if canImport(TVVLCKit)
    private func startPlayback(player: VLCMediaPlayer, url: URL, originalURL: URL) {
        cleanup()
        // 保存原始URL供restart使用（115 CDN直链有过期时间，restart时必须用原始URL重新获取）
        self.originalStreamURL = originalURL

        log("▶️ 播放URL: \(url.absoluteString.prefix(120))")
        if url != originalURL {
            log("   (原始URL已预解析为115 CDN直链)")
        }
        log("URL scheme: \(url.scheme ?? "nil"), host: \(url.host ?? "nil")")

        // 三重UA保障：
        // 1. library级别 --http-user-agent (setupLibrary中设置)
        // 2. media级别 :http-user-agent
        // 3. 预解析302让VLC直接请求最终URL（避免重定向丢UA）
        let media = VLCMedia(url: url)
        media.addOption(":http-user-agent=\(VLCPlayerManager.cloud115UserAgent)")
        media.addOption(":http-referrer=https://115.com/")
        log("已设置media UA: \(VLCPlayerManager.cloud115UserAgent)")
        self.media = media
        player.media = media

        // 设置视频输出
        let views = drawableViews.allObjects
        for view in views {
            player.drawable = view
        }
        log("已注册drawable数量: \(views.count)")
        if views.isEmpty {
            log("⚠️ 警告：没有已注册的视频输出视图！")
        }

        let is115Cloud = url.absoluteString.contains("115cdn") || url.absoluteString.contains("direct-stream") || url.absoluteString.contains("share/stream")
        if is115Cloud {
            log("使用115网盘直连模式（不占NAS带宽，VLC直接访问115 CDN）")
        }

        player.play()
        isPlaying = true
        onStateChange?(true)

        // 多次延迟刷新drawable
        let delays: [Double] = [0.3, 0.8, 1.5, 2.5, 4.0, 6.0, 8.0]
        for (i, delay) in delays.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self else { return }
                self.refreshDrawables()
            }
        }

        // 延迟刷新音轨
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.refreshAudioTracks()
        }
        // 延迟4秒打印状态（仅日志，不自动重试，避免循环）
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) { [weak self] in
            guard let self = self, let p = self.player else { return }
            self.log("4秒后状态: \(p.state.rawValue), 视频轨:\(p.videoTrackNames.count), 音频轨:\(p.audioTrackNames.count)")
            if p.state == .error || p.videoTrackNames.count == 0 {
                self.log("⚠️ VLC播放异常（视频轨0或错误状态），请检查网络和115登录状态")
            }
        }
        log("▶️ 开始播放: \(url.lastPathComponent)")

        startTimer()
    }
    #endif

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
            log("togglePlayPause: 恢复播放")
            // 恢复播放时多次刷新 drawable：VLC 暂停过久后视频输出层可能失效，
            // 不刷新会导致只有声音无画面（黑屏）。密集刷新覆盖 VLC 异步恢复的各个阶段。
            let delays: [Double] = [0.1, 0.3, 0.6, 1.0, 1.5, 2.0, 3.0]
            for (i, delay) in delays.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.refreshDrawables()
                }
            }
        }
        #endif
    }

    func setVolume(_ volume: Float) {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        let vlcVolume = Int32(volume * 100)
        p.audio?.volume = vlcVolume
        log("setVolume: \(volume) (VLC: \(vlcVolume))")
        #endif
    }

    func restart() {
        #if canImport(TVVLCKit)
        guard !isRestarting else { return }
        // 优先使用保存的原始 stream URL（direct-stream 或 share/stream，115 CDN直链会过期，不能用media.url）
        let url = originalStreamURL ?? player?.media?.url
        guard let url = url, let p = player else { return }
        isRestarting = true
        log("restart: 停止并重新播放 (URL: \(url.lastPathComponent))")
        p.stop()
        isPlaying = false
        onStateChange?(false)
        activeDrawable = nil
        // 延迟0.5秒后重新播放（等待连接完全关闭）
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            self.play(url: url)
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

    /// 保留播放进度的软重启：stop后重新play并seek回原位置。
    /// 用于大小屏互切时强制VLC重新初始化视频输出层。
    /// TVVLCKit在播放中动态切换drawable不可靠（只有声音无视频），
    /// 必须stop+play重建视频输出。此方法保留进度，用户感知只是短暂缓冲。
    func restartPreservingPosition() {
        #if canImport(TVVLCKit)
        guard !isRestarting else { return }
        let url = originalStreamURL ?? player?.media?.url
        guard let url = url, let p = player else { return }
        // 保存当前播放时间
        let savedTime = p.time
        isRestarting = true
        log("restartPreservingPosition: 保存时间=\(savedTime.intValue/1000)s, 停止并重新播放")
        p.stop()
        isPlaying = false
        onStateChange?(false)
        activeDrawable = nil
        // 延迟0.5秒重新播放
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            self.play(url: url)
            // 等待缓冲后多次seek到保存的时间
            let seekDelays: [Double] = [0.8, 1.2, 1.8, 2.5]
            for (i, delay) in seekDelays.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    guard let self = self, let p = self.player else { return }
                    if p.state == .playing || p.state == .buffering {
                        p.time = savedTime
                        if i == 0 {
                            self.log("restartPreservingPosition: seek到\(savedTime.intValue/1000)s")
                        }
                    }
                    if i == seekDelays.count - 1 {
                        self.isRestarting = false
                        self.log("restartPreservingPosition: 完成")
                    }
                }
            }
        }
        #endif
    }

    func forceResetDrawable() {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        p.drawable = nil
        activeDrawable = nil
        log("forceResetDrawable: 清除所有drawable")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self, let p = self.player else { return }
            if let active = self.drawableViews.allObjects.last as? UIView {
                self.activeDrawable = active
                p.drawable = active
            } else if let first = self.drawableViews.allObjects.first as? UIView {
                self.activeDrawable = first
                p.drawable = first
            }
        }
        #endif
    }

    func refreshAudioTracks() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        let names = player.audioTrackNames as? [String] ?? []
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
        let playerIndex = Int(player.currentAudioTrackIndex)
        if currentAudioTrackIndex < 0 || currentAudioTrackIndex >= mappedNames.count {
            if playerIndex >= 0 && playerIndex < names.count {
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
        log("音轨列表: \(audioTrackNames), 当前: \(currentAudioTrackIndex)")
        #endif
    }

    func setAudioTrack(index: Int) {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
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
            log("切换音轨: 映射\(index) -> VLC\(vlcIndex), \(rawNames[vlcIndex])")
        } else {
            player.currentAudioTrackIndex = Int32(index)
        }
        currentAudioTrackIndex = index
        #endif
    }

    func toggleVoice() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        let count = max(audioTrackNames.count, 1)
        let nextIndex = (currentAudioTrackIndex + 1) % count
        log("toggleVoice: \(currentAudioTrackIndex) -> \(nextIndex), 轨道数:\(count)")
        setAudioTrack(index: nextIndex)
        #endif
    }

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
        let activeInArray = drawableViews.allObjects.contains(where: { $0 as AnyObject === activeDrawable })
        if activeDrawable == nil || !activeInArray {
            setActiveDrawable(view)
        }
    }

    /// 设置活动drawable并强制刷新视频输出（统一入口，全屏和小屏都用这个）
    /// 先设nil再多次延迟设置，强制VLC重新创建视频输出层，
    /// 解决大小屏互切时只有声音无视频的问题。
    func setActiveDrawable(_ view: UIView?) {
        activeDrawable = view
        #if canImport(TVVLCKit)
        if let v = view {
            ensureVideoOutput(for: v)
        } else {
            player?.drawable = nil
        }
        #endif
    }

    /// 兼容旧接口：全屏提升，内部调用ensureVideoOutput
    func promoteToFullscreen(_ view: UIView) {
        log("promoteToFullscreen: 提升视图为活动drawable")
        setActiveDrawable(view)
    }

    /// 强制确保视频输出到指定视图：先清除，再在多个时间点重新设置，
    /// 每次都是nil→设置，强制VLC销毁并重建视频渲染层。
    /// 这是解决"切换视图后只有声音无视频"的核心方法。
    private func ensureVideoOutput(for view: UIView) {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        // 立即清除
        p.drawable = nil
        // 多个时间点重新设置，覆盖VLC异步初始化的各个阶段
        let delays: [Double] = [0.05, 0.15, 0.3, 0.5, 0.8, 1.2, 1.8]
        for (i, delay) in delays.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak p, weak view, weak self] in
                guard let p = p, let view = view, let self = self else { return }
                // 只在这个视图仍然是活动drawable时才设置
                guard self.activeDrawable === view else { return }
                p.drawable = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { [weak p, weak view] in
                    guard let p = p, let view = view else { return }
                    p.drawable = view
                    if i < 3 {  // 前3次打日志，避免刷屏
                        self.log("ensureVideoOutput: 第\(i+1)/\(delays.count)次刷新drawable")
                    }
                }
            }
        }
        #endif
    }

    func clearActiveDrawable(_ view: UIView) {
        let wasActive = activeDrawable === view
        drawableViews.remove(view)
        if wasActive {
            activeDrawable = nil
            // 清除后，如果还有其他视图，主动确保视频输出切换到下一个
            if let next = drawableViews.allObjects.first(where: { $0 !== view }) as? UIView {
                log("clearActiveDrawable: 切换到下一个视图")
                setActiveDrawable(next)
            } else {
                player?.drawable = nil
                log("clearActiveDrawable: 无可用视图，清除drawable")
            }
        }
    }

    func refreshDrawables() {
        #if canImport(TVVLCKit)
        if let active = activeDrawable {
            ensureVideoOutput(for: active)
        } else if let first = drawableViews.allObjects.first as? UIView {
            setActiveDrawable(first)
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
        if Int(current) % 5 == 0 && Int(current) != lastDebugSecond {
            lastDebugSecond = Int(current)
            log("时间: \(current)s / \(total)s, state=\(player.state.rawValue)")
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
        if player.state.rawValue != lastReportedState {
            log("状态: \(stateName)(\(player.state.rawValue)), 时长:\(player.media?.length.intValue ?? 0)ms")
            lastReportedState = player.state.rawValue
        }
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
            // VLC 播放自然结束：触发自动播放下一首（修复 VLC 模式下播完不自动切歌）
            onPlaybackEnd?()
        case .error:
            log("❌ VLC错误! 视频轨:\(player.videoTrackNames.count) 音频轨:\(player.audioTrackNames.count)")
            if let media = player.media {
                log("❌ URL: \(media.url?.absoluteString ?? "nil")")
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
