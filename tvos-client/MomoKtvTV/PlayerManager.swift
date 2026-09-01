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
    /// 当前演唱音轨索引。AI 分离完成的纯音频有五档：
    /// 0=原唱 1=人声75% 2=半消(50%) 3=人声25% 4=纯伴奏；老式三档/双音轨按实际音轨数自适应；单音轨恒为 0。
    @Published var vocalTrackIndex: Int = 0
    /// 当前歌曲 HLS 里实际可选的音轨条数（读到 master 的 audio options 后回填，驱动循环边界与滑块）
    @Published var vocalTrackCount: Int = 1
    /// 兼容旧代码的二元语义：是否处于原唱档
    var isOriginalVoice: Bool { vocalTrackIndex == 0 }
    /// 当前档位的中文名（用于反馈提示与按钮标题）
    var vocalTrackLabel: String {
        switch vocalTrackCount {
        case 5:
            switch vocalTrackIndex {
            case 0: return "原唱"
            case 1: return "人声75%"
            case 2: return "半消"
            case 3: return "人声25%"
            default: return "伴奏"
            }
        case 3:
            return vocalTrackIndex == 0 ? "原唱" : (vocalTrackIndex == 1 ? "半消" : "伴唱")
        case 2:
            return vocalTrackIndex == 0 ? "原唱" : "伴唱"
        default: return "原唱"
        }
    }
    /// 人声音量百分比（滑块用）：五档映射 100/75/50/25/0
    var vocalVolumePercent: Int {
        let pct = [100, 75, 50, 25, 0]
        return (vocalTrackIndex >= 0 && vocalTrackIndex < pct.count) ? pct[vocalTrackIndex] : 0
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
            // 同一首歌再次播放（重唱/随机重播）时，必须回到曲首0秒并重新播放，
            // 否则会从上一次暂停位置继续，导致MKV等视频歌不从曲首播放
            player?.seek(to: CMTime.zero)
            player?.play()
            isPlaying = true
            currentTime = 0
            return
        }

        cleanup()

        // New song defaults to original voice (track 0), matching web _loadedTrack = 0
        vocalTrackIndex = 0
        voiceGeneration += 1

        let playerItem = AVPlayerItem(url: url)
        // 增加前向缓冲到 30 秒，减少网络波动导致的卡顿
        // （默认缓冲时长由系统决定，在局域网 HLS 场景下可能偏短）
        playerItem.preferredForwardBufferDuration = 30
        let player = AVPlayer(playerItem: playerItem)
        self.player = player

        let layer = AVPlayerLayer(player: player)
        layer.videoGravity = .resizeAspect
        self.playerLayer = layer

        // Auto-attach to current host view
        attachLayerToCurrentHost()

        // Time observer
        // 20Hz 刷新当前时间：逐字歌词靠 KaraokeWord 内的 0.05s 线性补间做到视觉平滑，
        // 不需要更高频地全量重绘整个播放页(过高频率叠加描边/阴影会拖卡整个 app)。
        // 仅本地 UI 刷新频率，上报服务端的 progressTimer 仍保持 1 秒一次，不增加网络负担。
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.05, preferredTimescale: 1000),
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

        // 修复随机播放不从开头开始：HLS event 类型在转码完成前没有 #EXT-X-ENDLIST，
        // AVPlayer 误认为是直播流，从"最新分片"开始播放而不是从开头。
        // 这里在 item 准备好后强制 seek 到 0，确保从歌曲开头播放。
        // 分两次 seek：立即一次(可能被忽略)，0.5秒后 item 准备好时再一次(确保生效)
        player.seek(to: CMTime.zero)
        currentTime = 0
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self, self.player === player else { return }
            self.player?.seek(to: CMTime.zero)
            self.currentTime = 0
        }

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

    // MARK: - Voice Toggle (原唱 / 半消 / 伴奏 多档 + 滑块)

    /// 遥控器一个键在当前歌曲的全部档位间循环：五档(原唱→75%→半消→25%→伴奏)
    /// 或三档/双档，边界由 HLS 实际音轨数 vocalTrackCount 决定。
    func toggleVoice() {
        // 音轨尚未探测到时至少允许在 0/1 之间走，options 到位后 trySelect 会回填真实档数并收敛
        let bound = max(2, vocalTrackCount)
        vocalTrackIndex = (vocalTrackIndex + 1) % bound
        voiceGeneration += 1
        applyVoiceMode()
    }

    /// 直接选到指定档位（滑块吸附/快捷按钮用），index 即音轨序号，越界由选择阶段收敛
    func selectVocalTrack(_ index: Int) {
        let clamped = max(0, min(4, index))
        guard clamped != vocalTrackIndex else { return }
        vocalTrackIndex = clamped
        voiceGeneration += 1
        applyVoiceMode()
    }

    /// 快捷直达：原唱(第0档) / 纯伴奏(最后一档)
    func setVoiceMode(_ original: Bool) {
        vocalTrackIndex = original ? 0 : max(0, vocalTrackCount - 1)
        voiceGeneration += 1
        applyVoiceMode()
    }

    private func applyVoiceMode() {
        guard let playerItem = player?.currentItem else { return }
        let gen = voiceGeneration

        // Try immediately. trySelectAudioTrack reads the current
        // vocalTrackIndex fresh on every call, so it never acts on a stale target.
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

        // 回填真实档数，驱动循环边界、按钮标签与滑块段数（在主线程更新 @Published）
        let n = options.count
        if vocalTrackCount != n { vocalTrackCount = n }
        if vocalTrackIndex >= n { vocalTrackIndex = n - 1 }
        // 档位索引与 audio rendition 序号一一对应（五档/三档/双档统一），直接收敛选择
        let targetIndex = min(max(vocalTrackIndex, 0), n - 1)
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
