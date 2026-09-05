import UIKit
import AVFoundation
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC播放器封装 - 用于播放MKV等AVFoundation不支持的格式
/// 支持115网盘自定义UA、302直连、音轨切换（原唱/伴唱）
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
        let options = [
            "--http-user-agent=Mozilla/5.0 115Browser/23.9.3.2",
            "--no-video-title-show",
            "--network-caching=1000",
            "--file-caching=1000"
        ]
        let lib = VLCLibrary(options: options)
        library = lib
        player = VLCMediaPlayer(library: lib)
        player?.delegate = self
        print("[VLCPlayer] VLCLibrary初始化成功")
    }
    #endif

    // MARK: - 播放控制

    /// 播放URL（支持115网盘302直连，VLC自动跟随重定向并保留UA）
    func play(url: URL) {
        #if canImport(TVVLCKit)
        guard let player = player else {
            onError?("VLC播放器未初始化")
            return
        }

        cleanup()

        let media = VLCMedia(url: url)
        self.media = media
        player.media = media

        // 设置视频输出到所有已注册的view
        for view in drawableViews.allObjects {
            player.drawable = view
        }

        player.play()
        isPlaying = true
        onStateChange?(true)
        print("[VLCPlayer] ▶️ 开始播放: \(url.lastPathComponent)")
        print("[VLCPlayer] media状态: \(media.state.rawValue), 时长: \(media.length.intValue)ms")
        print("[VLCPlayer] player状态: \(player.state.rawValue)")

        startTimer()
        // 延迟2秒后再次检查状态（VLC异步加载）
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self = self, let p = self.player else { return }
            print("[VLCPlayer] 2秒后状态: \(p.state.rawValue), time: \(p.time.intValue)ms, length: \(p.media?.length.intValue ?? 0)ms")
            if let audioNames = p.audioTrackNames as? [String] {
                print("[VLCPlayer] 音频轨道数: \(audioNames.count), 名称: \(audioNames)")
            }
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
        if let names = player.audioTrackNames as? [String] {
            audioTrackNames = names
        }
        if audioTrackNames.isEmpty {
            audioTrackNames = ["原唱", "伴唱"]
        }
        currentAudioTrackIndex = Int(player.currentAudioTrackIndex)
        print("[VLCPlayer] 音轨列表: \(audioTrackNames), 当前: \(currentAudioTrackIndex)")
        #endif
    }

    func setAudioTrack(index: Int) {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        player.currentAudioTrackIndex = Int32(index)
        currentAudioTrackIndex = index
        print("[VLCPlayer] 切换音轨到: \(index)")
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
            print("[VLCPlayer] 时间更新: current=\(currentMs)ms(\(current)s), total=\(totalMs)ms(\(total)s), state=\(player.state.rawValue)")
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
        print("[VLCPlayer] 状态变化: \(player.state.rawValue)(\(stateName)), time=\(player.time.intValue)ms, length=\(player.media?.length.intValue ?? 0)ms")
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
