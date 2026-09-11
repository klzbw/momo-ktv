import UIKit
#if canImport(MobileVLCKit)
import MobileVLCKit
#endif

/// VLC 播放器封装 - iOS 端（MobileVLCKit）
/// 支持 115 网盘自定义 UA、302 直连预解析、音轨切换（原唱/伴唱）
///
/// 三重保障确保 UA 生效：
///   1. VLCLibrary 级别 --http-user-agent
///   2. VLCMedia 级别 :http-user-agent
///   3. 播放前预解析 302 重定向，让 VLC 直接请求最终 115 CDN URL
class VLCPlayerManager: NSObject {
    static let shared = VLCPlayerManager()

    // MARK: - 状态
    private(set) var isPlaying = false
    private(set) var currentTime: Double = 0
    private(set) var duration: Double = 0
    private(set) var audioTrackNames: [String] = []
    private(set) var currentAudioTrackIndex: Int = 0

    var onTimeUpdate: ((Double, Double) -> Void)?
    var onStateChange: ((Bool) -> Void)?
    var onError: ((String) -> Void)?
    var onEnded: (() -> Void)?

    // MARK: - VLC 实例
    #if canImport(MobileVLCKit)
    private var library: VLCLibrary?
    var player: VLCMediaPlayer?
    private var media: VLCMedia?
    private var originalStreamURL: URL?
    #endif
    private var drawableViews = NSHashTable<UIView>.weakObjects()
    private var activeDrawable: UIView?
    private var timeObserverTimer: Timer?

    private var libraryInitialized = false
    private var isRestarting = false

    static let cloud115UserAgent = "Mozilla/5.0 115Browser/23.9.3.2"

    private override init() {
        super.init()
    }

    #if canImport(MobileVLCKit)
    private func setupLibrary() {
        guard !libraryInitialized else { return }
        libraryInitialized = true
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
        print("[VLC] VLCLibrary 初始化成功, UA=\(VLCPlayerManager.cloud115UserAgent)")
    }
    #endif

    // MARK: - 302 重定向预解析
    private class RedirectCatcher: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil) // 禁止自动跟随
        }
    }
    private let redirectCatcher = RedirectCatcher()
    private lazy var noRedirectSession: URLSession = {
        URLSession(configuration: .default, delegate: redirectCatcher, delegateQueue: nil)
    }()

    private func resolveRedirect(for url: URL, completion: @escaping (URL) -> Void) {
        guard url.absoluteString.contains("direct-stream") else {
            completion(url)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        request.setValue(VLCPlayerManager.cloud115UserAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("bytes=0-0", forHTTPHeaderField: "Range")

        let task = noRedirectSession.dataTask(with: request) { _, response, error in
            if let _ = error {
                DispatchQueue.main.async { completion(url) }
                return
            }
            if let httpResp = response as? HTTPURLResponse,
               (300...399).contains(httpResp.statusCode),
               let location = httpResp.allHeaderFields["Location"] as? String,
               let finalURL = URL(string: location) {
                print("[VLC] 302 预解析成功 -> \(finalURL.absoluteString.prefix(80))")
                DispatchQueue.main.async { completion(finalURL) }
                return
            }
            DispatchQueue.main.async { completion(url) }
        }
        task.resume()
    }

    // MARK: - 播放控制
    func play(url: URL) {
        #if canImport(MobileVLCKit)
        setupLibrary()
        guard let player = player else { onError?("VLC 未初始化"); return }
        resolveRedirect(for: url) { [weak self] finalURL in
            self?.startPlayback(player: player, url: finalURL, originalURL: url)
        }
        #else
        onError?("MobileVLCKit 未集成")
        #endif
    }

    #if canImport(MobileVLCKit)
    private func startPlayback(player: VLCMediaPlayer, url: URL, originalURL: URL) {
        cleanup()
        originalStreamURL = originalURL

        let media = VLCMedia(url: url)
        media.addOption(":http-user-agent=\(VLCPlayerManager.cloud115UserAgent)")
        media.addOption(":http-referrer=https://115.com/")
        self.media = media
        player.media = media

        if let active = activeDrawable {
            player.drawable = active
        }

        player.play()
        isPlaying = true
        onStateChange?(true)

        // 延迟刷新音轨
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.refreshAudioTracks()
        }
        startTimer()
    }
    #endif

    func pause() {
        #if canImport(MobileVLCKit)
        player?.pause()
        isPlaying = false
        onStateChange?(false)
        #endif
    }

    func resume() {
        #if canImport(MobileVLCKit)
        player?.play()
        isPlaying = true
        onStateChange?(true)
        #endif
    }

    func togglePlayPause() {
        if isPlaying { pause() } else { resume() }
    }

    func stop() {
        #if canImport(MobileVLCKit)
        player?.stop()
        isPlaying = false
        activeDrawable = nil
        onStateChange?(false)
        stopTimer()
        #endif
    }

    func seek(to seconds: Double) {
        #if canImport(MobileVLCKit)
        guard let player = player else { return }
        player.time = VLCTime(int: Int32(seconds * 1000))
        currentTime = seconds
        #endif
    }

    func setVolume(_ volume: Float) {
        #if canImport(MobileVLCKit)
        player?.audio?.volume = Int32(volume * 100)
        #endif
    }

    // MARK: - 音轨切换
    func refreshAudioTracks() {
        #if canImport(MobileVLCKit)
        guard let player = player else { return }
        let names = player.audioTrackNames as? [String] ?? []
        var mapped: [String] = []
        for name in names {
            if name.lowercased() == "disable" { continue }
            if name.lowercased().contains("track 1") || name.lowercased().contains("track1") {
                mapped.append("原唱")
            } else if name.lowercased().contains("track 2") || name.lowercased().contains("track2") {
                mapped.append("伴唱")
            } else {
                mapped.append(name)
            }
        }
        if mapped.isEmpty { mapped = ["原唱", "伴唱"] }
        audioTrackNames = mapped
        if currentAudioTrackIndex >= mapped.count { currentAudioTrackIndex = 0 }
        #endif
    }

    func setAudioTrack(index: Int) {
        #if canImport(MobileVLCKit)
        guard let player = player else { return }
        let rawNames = player.audioTrackNames as? [String] ?? []
        var vlcIndex = 0
        var filteredCount = 0
        for (i, name) in rawNames.enumerated() {
            if name.lowercased() == "disable" { continue }
            if filteredCount == index { vlcIndex = i; break }
            filteredCount += 1
        }
        player.currentAudioTrackIndex = Int32(vlcIndex)
        currentAudioTrackIndex = index
        #endif
    }

    func toggleVoice() {
        let count = max(audioTrackNames.count, 1)
        setAudioTrack(index: (currentAudioTrackIndex + 1) % count)
    }

    var voiceLabel: String {
        if audioTrackNames.isEmpty { return currentAudioTrackIndex == 0 ? "原唱" : "伴唱" }
        return currentAudioTrackIndex < audioTrackNames.count ? audioTrackNames[currentAudioTrackIndex] : "原唱"
    }

    // MARK: - 视频输出
    func addDrawable(_ view: UIView) {
        drawableViews.add(view)
        if activeDrawable == nil { setActiveDrawable(view) }
    }

    func setActiveDrawable(_ view: UIView?) {
        activeDrawable = view
        #if canImport(MobileVLCKit)
        if let v = view {
            player?.drawable = v
        } else {
            player?.drawable = nil
        }
        #endif
    }

    func removeDrawable(_ view: UIView) {
        drawableViews.remove(view)
        if activeDrawable === view {
            activeDrawable = nil
            if let next = drawableViews.allObjects.first as? UIView {
                setActiveDrawable(next)
            }
        }
    }

    // MARK: - 内部
    private func startTimer() {
        stopTimer()
        timeObserverTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.updateTime()
        }
    }

    private func stopTimer() {
        timeObserverTimer?.invalidate()
        timeObserverTimer = nil
    }

    private func updateTime() {
        #if canImport(MobileVLCKit)
        guard let player = player else { return }
        let current = Double(player.time.intValue) / 1000.0
        let total = Double(player.media?.length.intValue ?? 0) / 1000.0
        if current != currentTime || total != duration {
            currentTime = current
            duration = total
            onTimeUpdate?(currentTime, duration)
        }
        #endif
    }

    private func cleanup() {
        stopTimer()
        #if canImport(MobileVLCKit)
        player?.stop()
        media = nil
        #endif
        currentTime = 0
        duration = 0
        audioTrackNames = []
        currentAudioTrackIndex = 0
    }
}

#if canImport(MobileVLCKit)
extension VLCPlayerManager: VLCMediaPlayerDelegate {
    func mediaPlayerStateChanged(_ aNotification: Notification) {
        guard let player = player else { return }
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
            onEnded?()
        case .error:
            onError?("VLC 播放错误")
        default:
            break
        }
    }

    func mediaPlayerTimeChanged(_ aNotification: Notification) {
        updateTime()
    }
}
#endif
