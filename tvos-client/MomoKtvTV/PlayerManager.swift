import AVFoundation
import UIKit

/// Shared player manager - holds a single AVPlayer and AVPlayerLayer.
/// The layer moves between small preview and fullscreen views via currentHostView.
class PlayerManager: ObservableObject {
    static let shared = PlayerManager()

    @Published var currentTime: Double = 0
    @Published var duration: Double = 0
    @Published var isPlaying: Bool = false
    @Published var currentSongId: Int?
    /// 当前演唱音轨索引：0=原唱，1=半消（人声压低），2=纯伴奏。
    /// AI 分离完成的纯音频有三档；老式双音轨 MV 只有 0/1；单音轨歌恒为 0。
    @Published var vocalTrackIndex: Int = 0
    /// 兼容旧代码的二元语义：是否处于原唱档
    var isOriginalVoice: Bool { vocalTrackIndex == 0 }
    /// 当前档位的中文名（用于反馈提示）
    var vocalTrackLabel: String {
        switch vocalTrackIndex {
        case 1: return "半消"
        case 2: return "伴唱"
        default: return "原唱"
        }
    }
    var onPlaybackEnd: (() -> Void)?

    private(set) var player: AVPlayer?
    private(set) var playerLayer: AVPlayerLayer?
    /// Current host view that displays the player layer
    weak var currentHostView: UIView?

    private var timeObserver: Any?
    private var statusObserver: NSKeyValueObservation?
    private var itemStatusObserver: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    /// Progress reporting timer — fires every 1s while a song is loaded.
    /// Calls onProgressReport so the API client can broadcast currentTime
    /// to the server, which relays it to mobile remote controllers.
    private var progressTimer: Timer?
    /// Callback invoked every 1s with current playback progress.
    /// Set by ContentView to wire PlayerManager -> KTVAPIClient.sendProgress.
    var onProgressReport: ((_ currentTime: Double, _ paused: Bool, _ voice: String) -> Void)?

    /// Voice toggle generation. Every toggle / new song increments it so that
    /// delayed retry blocks from a previous toggle are invalidated and cannot
    /// fight the newer selection (root cause of the multi-click + stutter bug).
    private var voiceGeneration: Int = 0

    private init() {}

    func setupPlayer(for url: URL) {
        if let existingURL = (player?.currentItem?.asset as? AVURLAsset)?.url,
           existingURL == url {
            attachLayerToCurrentHost()
            return
        }

        cleanup()

        // New song defaults to original voice (track 0), matching web _loadedTrack = 0
        vocalTrackIndex = 0
        voiceGeneration += 1

        let playerItem = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: playerItem)
        self.player = player

        let layer = AVPlayerLayer(player: player)
        layer.videoGravity = .resizeAspect
        self.playerLayer = layer

        // Auto-attach to current host view
        attachLayerToCurrentHost()

        // Time observer
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            self?.currentTime = time.seconds
            if let dur = player.currentItem?.duration.seconds, !dur.isNaN {
                self?.duration = dur
            }
        }

        // Rate observer
        statusObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.isPlaying = player.timeControlStatus == .playing
            }
        }

        // Item status observer - apply voice mode when item is ready to play
        // (HLS audio renditions are not available until the item is ready)
        itemStatusObserver = playerItem.observe(\.status, options: [.new]) { [weak self] _, _ in
            if playerItem.status == .readyToPlay {
                DispatchQueue.main.async {
                    self?.applyVoiceMode()
                }
            }
        }

        // Playback end observer
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: playerItem,
            queue: .main
        ) { [weak self] _ in
            self?.onPlaybackEnd?()
        }

        player.play()
        isPlaying = true

        // Apply voice mode immediately (may no-op if tracks not loaded yet;
        // the itemStatusObserver + retries will pick it up)
        applyVoiceMode()

        // Start progress reporting timer — fires every 1s while playing.
        // The timer calls onProgressReport which sends currentTime to the
        // server; mobile remote controllers interpolate between these reports
        // to show a smoothly moving progress bar synced to the TV.
        startProgressTimer()
    }

    private func startProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self, self.player != nil else { return }
            let cur = self.player?.currentTime().seconds ?? self.currentTime
            let paused = !(self.player?.timeControlStatus == .playing)
            let voice: String = self.vocalTrackIndex == 0 ? "original" : (self.vocalTrackIndex == 1 ? "half" : "accompaniment")
            self.onProgressReport?(cur, paused, voice)
        }
    }

    private func stopProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = nil
    }

    /// Attach player layer to the current host view
    func attachLayerToCurrentHost() {
        guard let layer = playerLayer, let host = currentHostView else { return }
        if layer.superlayer != host.layer {
            layer.removeFromSuperlayer()
            host.layer.addSublayer(layer)
        }
        layer.frame = host.bounds
    }

    /// Update layer frame when host view layout changes
    func updateLayerFrame() {
        guard let layer = playerLayer, let host = currentHostView else { return }
        layer.frame = host.bounds
    }

    func play() {
        player?.play()
        isPlaying = true
    }

    func pause() {
        player?.pause()
        isPlaying = false
    }

    func togglePlayPause() {
        guard let player = player else { return }
        if player.timeControlStatus == .playing {
            pause()
        } else {
            play()
        }
    }

    func seek(to seconds: Double) {
        player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
        currentTime = seconds
    }

    func restart() {
        seek(to: 0)
        play()
    }

    func setVolume(_ volume: Float) {
        player?.volume = volume
    }

    // MARK: - Voice Toggle (原唱 / 半消 / 伴唱)
    var currentAudioTracks: Int = 1

    /// 遥控器一个键在三档间循环：原唱 -> 半消 -> 伴唱 -> 原唱。
    /// 实际只有两档(老MV)时 select 阶段会把"半消/伴唱"都映射到第1条音轨。
    func toggleVoice() {
        vocalTrackIndex = (vocalTrackIndex + 1) % 3
        voiceGeneration += 1
        applyVoiceMode()
    }

    /// 直接选到指定档位（0原唱/1半消/2伴唱），供三档按钮或连续滑块落点使用
    func selectVocalTrack(_ index: Int) {
        vocalTrackIndex = max(0, min(2, index))
        voiceGeneration += 1
        applyVoiceMode()
    }

    func setVoiceMode(_ original: Bool) {
        vocalTrackIndex = original ? 0 : 2
        voiceGeneration += 1
        applyVoiceMode()
    }

    private func applyVoiceMode() {
        guard let playerItem = player?.currentItem else { return }
        let gen = voiceGeneration

        // Try immediately. trySelectAudioTrack reads the current
        // isOriginalVoice fresh on every call, so it never acts on a stale target.
        trySelectAudioTrack(for: playerItem)

        // Retry as HLS audio tracks load asynchronously. Fewer, longer-spaced
        // attempts than before to avoid re-triggering audio rendition loads
        // (which caused stutter). Each retry checks voiceGeneration so that a
        // newer toggle cancels all stale retries.
        let delays: [Double] = [0.5, 1.5, 3.0]
        for delay in delays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self,
                      self.voiceGeneration == gen,
                      let item = self.player?.currentItem else { return }
                self.trySelectAudioTrack(for: item)
            }
        }
    }

    private func trySelectAudioTrack(for playerItem: AVPlayerItem) {
        guard let audioGroup = playerItem.asset.mediaSelectionGroup(forMediaCharacteristic: .audible) else { return }
        let options = audioGroup.options
        guard !options.isEmpty else { return }

        let n = options.count
        // 三档(AI分离)精确对应 0/1/2；老式双音轨MV：半消(1)与伴唱(2)都落到第1条伴奏轨；
        // 单音轨歌没有可切的音轨，直接返回。每次都按当前 vocalTrackIndex 现算，不捕获旧值。
        let targetIndex: Int
        if n >= 3 { targetIndex = min(vocalTrackIndex, n - 1) }
        else if n == 2 { targetIndex = vocalTrackIndex == 0 ? 0 : 1 }
        else { return }
        let targetOption = options[targetIndex]

        if playerItem.selectedMediaOption(in: audioGroup) != targetOption {
            playerItem.select(targetOption, in: audioGroup)
        }
    }

    func cleanup() {
        stopProgressTimer()
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
            timeObserver = nil
        }
        statusObserver?.invalidate()
        statusObserver = nil
        itemStatusObserver?.invalidate()
        itemStatusObserver = nil
        if let endObserver = endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }
        playerLayer?.removeFromSuperlayer()
        playerLayer = nil
        player?.pause()
        player = nil
        isPlaying = false
        currentTime = 0
        duration = 0
    }
}
