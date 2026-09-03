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

    // MARK: DUAL 双FLAC（人声轨 + 伴奏轨本地混合，连续调人声增益实现消音）
    /// 是否处于双FLAC混合模式（true=连续人声音量；false=HLS 五档/声道老方案）
    @Published var dualEnabled: Bool = false
    /// DUAL 人声音量 0(纯伴奏)...1(原唱)，连续可调
    @Published var vocalLevel: Float = 1
    /// DUAL 当前歌曲 id，用于排查与展示
    private(set) var dualSongId: Int?
    private var dualAudioMix: AVMutableAudioMix?
    private var dualVocalParams: AVMutableAudioMixInputParameters?
    private var dualAccompParams: AVMutableAudioMixInputParameters?  // 伴奏轨params，applyDualVolume重建mix时需要
    /// 加载代号：setupPlayer/activateDual 时递增，过期的异步结果直接丢弃
    private var loadGeneration: Int = 0
    /// 记录当前歌曲的 HLS 地址：DUAL 升级后 asset 变为 Composition，重唱判断仍需它
    private var currentHLSURL: URL?

    /// 兼容旧代码的二元语义：是否处于原唱档
    var isOriginalVoice: Bool {
        dualEnabled ? vocalLevel > 0.5 : vocalTrackIndex == 0
    }
    /// 上报给服务端/手机遥控的原伴状态字符串（DUAL 与人声音量、HLS 与档位统一出口）
    var voiceStateString: String {
        if dualEnabled {
            return vocalLevel > 0.5 ? "original" : (vocalLevel <= 0.001 ? "accompaniment" : "half")
        }
        return vocalTrackIndex == 0 ? "original" : (vocalTrackIndex == 1 ? "half" : "accompaniment")
    }
    /// 当前档位的中文名（用于反馈提示与按钮标题）
    var vocalTrackLabel: String {
        if dualEnabled {
            if vocalLevel >= 0.999 { return "原唱" }
            if vocalLevel <= 0.001 { return "伴奏" }
            return "人声\(Int((vocalLevel * 100).rounded()))%"
        }
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
    /// 人声音量百分比（滑块用）：DUAL 取连续值；五档映射 100/75/50/25/0
    var vocalVolumePercent: Int {
        if dualEnabled { return Int((vocalLevel * 100).rounded()) }
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
    /// 播放卡死检测：记录上一次检测时的 currentTime，如果连续3秒不变且isPlaying=true则判定卡死
    private var stuckCheckTimer: Timer?
    private var lastStuckCheckTime: Double = -1
    private var stuckCounter: Int = 0

    private init() {}

    func setupPlayer(for url: URL) {
        // 同一首歌再次播放（重唱/随机重播）：HLS 的 asset 是 AVURLAsset，DUAL 升级后是
        // AVMutableComposition，故同时用记录的 currentHLSURL 判断；命中直接回曲首，
        // 避免 DUAL 歌曲重唱被 cleanup 打回 HLS 却无人重新升级。
        let sameByAsset = (player?.currentItem?.asset as? AVURLAsset)?.url == url
        if (sameByAsset || currentHLSURL == url), player != nil {
            attachLayerToCurrentHost()
            player?.seek(to: CMTime.zero)
            player?.play()
            isPlaying = true
            currentTime = 0
            return
        }

        cleanup()

        // HLS 先起播：复位为五档/声道老方案与人声；若该歌已 AI 分离，
        // ContentView 随后会调 activateDual 把双FLAC无缝升级上来（失败就停留在 HLS）。
        dualEnabled = false
        dualSongId = nil
        vocalLevel = 1
        vocalTrackIndex = 0
        loadGeneration += 1
        voiceGeneration += 1

        currentHLSURL = url
        let playerItem = AVPlayerItem(url: url)
        // 增加前向缓冲到 30 秒，减少网络波动导致的卡顿
        playerItem.preferredForwardBufferDuration = 30
        installPlayerItem(playerItem, isDual: false)

        // Apply voice mode immediately (may no-op if tracks not loaded yet;
        // the itemStatusObserver + retries will pick it up)
        applyVoiceMode()
    }

    /// 用给定 AVPlayerItem 建立播放器、观察者并起播。
    /// HLS 远端 item 与 DUAL 本地合成 item 共用同一套播放/进度/卡死恢复逻辑。
    private func installPlayerItem(_ playerItem: AVPlayerItem, isDual: Bool) {
        teardownPlayer() // 先拆除旧 item（HLS→DUAL 无缝替换时尤其必要），观察者不残留
        let player = AVPlayer(playerItem: playerItem)
        self.player = player

        let layer = AVPlayerLayer(player: player)
        layer.videoGravity = .resizeAspect
        self.playerLayer = layer

        attachLayerToCurrentHost()

        // 20Hz 刷新当前时间：逐字歌词靠 0.05s 线性补间做到视觉平滑；progress 上报仍 1s 一次
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.05, preferredTimescale: 1000),
            queue: .main
        ) { [weak self] time in
            self?.currentTime = time.seconds
            if let dur = player.currentItem?.duration.seconds, !dur.isNaN {
                self?.duration = dur
            }
        }

        statusObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.isPlaying = player.timeControlStatus == .playing
            }
        }

        // Item ready：HLS 选回演唱音轨；DUAL 应用当前人声增益
        itemStatusObserver = playerItem.observe(\.status, options: [.new]) { [weak self] _, _ in
            if playerItem.status == .readyToPlay {
                DispatchQueue.main.async {
                    if isDual { self?.applyDualVolume() } else { self?.applyVoiceMode() }
                }
            }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: playerItem,
            queue: .main
        ) { [weak self] _ in
            self?.onPlaybackEnd?()
        }

        player.play()
        isPlaying = true

        // 仅 HLS 首次起播需要强制从曲首（HLS event 未写 ENDLIST 时 AVPlayer 会误当直播从末尾起播）。
        // DUAL 切换(isDual=true)时必须跳过此强制 seek，否则会覆盖 activateDual 的 seek(to: resumeAt)，
        // 导致切换后进度被拉回曲首、0.5秒后再次 seek to zero 使暂停失效/一直"重新演唱"。
        if !isDual {
            player.seek(to: CMTime.zero)
            currentTime = 0
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self = self, self.player === player else { return }
                self.player?.seek(to: CMTime.zero)
                self.currentTime = 0
            }
        }

        if isDual { applyDualVolume() } else { applyVoiceMode() }

        startProgressTimer()
        startStuckCheck()
    }

    /// 播放卡死检测：每秒检查currentTime是否前进，连续3秒不前进且isPlaying则自动恢复
    private func startStuckCheck() {
        stuckCheckTimer?.invalidate()
        lastStuckCheckTime = -1
        stuckCounter = 0
        stuckCheckTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self, let player = self.player else { return }
            let cur = player.currentTime().seconds
            // 只在播放状态下检测
            guard self.isPlaying && player.timeControlStatus == .playing else {
                self.lastStuckCheckTime = cur
                self.stuckCounter = 0
                return
            }
            if self.lastStuckCheckTime >= 0 && abs(cur - self.lastStuckCheckTime) < 0.01 {
                self.stuckCounter += 1
                if self.stuckCounter >= 3 {
                    print("[PlayerManager] playback stuck at \(cur)s, auto recovery")
                    self.stuckCounter = 0
                    // 恢复策略：先seek到前1秒再play；如果item failed则重建
                    if player.currentItem?.status == .failed {
                        // DUAL 的 asset 是 Composition，取 AVURLAsset 为 nil，用记录的 HLS 地址兜底回退起播
                        if let url = (player.currentItem?.asset as? AVURLAsset)?.url ?? self.currentHLSURL {
                            self.setupPlayer(for: url)
                            self.seek(to: max(0, cur - 1))
                        }
                    } else {
                        player.seek(to: CMTime(seconds: max(0, cur - 1), preferredTimescale: 600))
                        player.play()
                    }
                }
            } else {
                self.stuckCounter = 0
            }
            self.lastStuckCheckTime = cur
        }
    }

    private func startProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self, self.player != nil else { return }
            let cur = self.player?.currentTime().seconds ?? self.currentTime
            let paused = !(self.player?.timeControlStatus == .playing)
            let voice: String = self.voiceStateString
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
        guard let player = player else { return }
        // 如果 currentItem 已经 failed，先重建再播放
        if player.currentItem?.status == .failed {
            print("[PlayerManager] currentItem failed, attempting recovery")
            if let url = (player.currentItem?.asset as? AVURLAsset)?.url ?? currentHLSURL {
                let curTime = player.currentTime().seconds
                setupPlayer(for: url)
                seek(to: max(0, curTime - 1))
            }
            return
        }
        player.play()
        isPlaying = true
        // 播放后0.5秒检查：如果rate仍为0且不是暂停，尝试seek恢复
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self, let p = self.player else { return }
            if p.rate == 0 && self.isPlaying && p.timeControlStatus != .paused {
                print("[PlayerManager] play stuck, seek recovery")
                let t = p.currentTime().seconds
                p.seek(to: CMTime(seconds: max(0, t - 0.5), preferredTimescale: 600))
                p.play()
            }
        }
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

    // MARK: - DUAL 双FLAC（人声轨 + 伴奏轨本地混合，连续人声增益）

    /// HLS 先起播后，若该歌已 AI 分离：把下载好的人声/伴奏 FLAC 合成为一个双音轨
    /// AVPlayerItem 无缝替换当前播放并继承进度。tvOS 上 AVPlayer.volume 不可用，
    /// 故用 AVMutableComposition + AVMutableAudioMix 分别控制两轨音量实现消音。
    /// 视频歌(MKV/MP4)由调用方按扩展名排除，不会走到这里，保持原 HLS 多档方案。
    func activateDual(songId: Int, vocalFile: URL, accompFile: URL) {
        let gen = loadGeneration + 1
        loadGeneration = gen
        DispatchQueue.global(qos: .userInitiated).async {
            let vocalAsset = AVURLAsset(url: vocalFile)
            let accompAsset = AVURLAsset(url: accompFile)
            guard let vTrack = vocalAsset.tracks(withMediaType: .audio).first,
                  let aTrack = accompAsset.tracks(withMediaType: .audio).first else {
                print("[PlayerManager] DUAL 缺少音频轨，保留 HLS song=\(songId)"); return
            }
            let vDur = vocalAsset.duration, aDur = accompAsset.duration
            guard vDur.isValid, !vDur.isIndefinite, aDur.isValid, !aDur.isIndefinite else {
                print("[PlayerManager] DUAL 时长无效，保留 HLS song=\(songId)"); return
            }
            let composition = AVMutableComposition()
            guard let cVocal = composition.addMutableTrack(withMediaType: .audio,
                                                          preferredTrackID: kCMPersistentTrackID_Invalid),
                  let cAcc = composition.addMutableTrack(withMediaType: .audio,
                                                         preferredTrackID: kCMPersistentTrackID_Invalid) else { return }
            do {
                // 两轨都从 0 严格对齐，取较短时长，避免其中一轨尾部溢出
                let dur = CMTimeMinimum(vDur, aDur)
                try cVocal.insertTimeRange(CMTimeRange(start: .zero, duration: dur), of: vTrack, at: .zero)
                try cAcc.insertTimeRange(CMTimeRange(start: .zero, duration: dur), of: aTrack, at: .zero)
            } catch {
                print("[PlayerManager] DUAL 合成失败，保留 HLS: \(error)"); return
            }
            let vParams = AVMutableAudioMixInputParameters(track: cVocal)
            let aParams = AVMutableAudioMixInputParameters(track: cAcc)
            // 用 setVolumeRamp 设置全时间轴持续音量（比 setVolume(at:) 更可靠，后者在某些tvOS版本不生效）
            // 注意：timeRange 不能用 .positiveInfinity，AVFoundation 要求有效有限范围，否则 exc_bad_access 崩溃
            let fullRange = CMTimeRange(start: .zero, duration: CMTime(seconds: 86400, preferredTimescale: 600))
            aParams.setVolumeRamp(fromStartVolume: 1.0, toEndVolume: 1.0, timeRange: fullRange)

            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.loadGeneration == gen else { return }
                let resumeAt = self.player?.currentTime().seconds ?? 0
                vParams.setVolumeRamp(fromStartVolume: self.vocalLevel, toEndVolume: self.vocalLevel, timeRange: fullRange)
                let mix = AVMutableAudioMix()
                mix.inputParameters = [vParams, aParams]
                self.dualAudioMix = mix
                self.dualVocalParams = vParams
                self.dualAccompParams = aParams
                self.dualSongId = songId
                let item = AVPlayerItem(asset: composition)
                item.audioMix = mix
                self.dualEnabled = true
                self.voiceGeneration += 1
                self.installPlayerItem(item, isDual: true)
                // DUAL 切换后继承原播放进度：延迟 0.3s 等 item 准备好再 seek，避免 seek 被忽略
                if resumeAt > 0.5 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                        guard let self = self, self.dualEnabled, self.dualSongId == songId else { return }
                        self.seek(to: resumeAt)
                    }
                }
                print("[PlayerManager] DUAL 双FLAC已启用 song=\(songId) resumeAt=\(resumeAt)")
            }
        }
    }

    /// 把当前人声增益写回合成 item（滑块/遥控器每次变动都调用）
    /// 关键：每次必须创建新的 AVMutableAudioMix 对象——重新赋值同一对象 AVFoundation
    /// 不会重新处理，导致音量调节/原唱伴奏切换实际无音频变化。
    private func applyDualVolume() {
        guard let vParams = dualVocalParams, let aParams = dualAccompParams else { return }
        let q = max(0, min(1, vocalLevel))
        // timeRange 不能用 .positiveInfinity，否则 exc_bad_access 崩溃
        let fullRange = CMTimeRange(start: .zero, duration: CMTime(seconds: 86400, preferredTimescale: 600))
        vParams.setVolumeRamp(fromStartVolume: q, toEndVolume: q, timeRange: fullRange)
        aParams.setVolumeRamp(fromStartVolume: 1.0, toEndVolume: 1.0, timeRange: fullRange)
        let newMix = AVMutableAudioMix()
        newMix.inputParameters = [vParams, aParams]
        dualAudioMix = newMix
        player?.currentItem?.audioMix = newMix
    }

    /// DUAL：连续设置人声音量 0(纯伴奏)...1(原唱)
    func setVocalLevel(_ x: Float) {
        let q = max(0, min(1, x))
        vocalLevel = (q * 100).rounded() / 100                   // 量化到 1%，消除浮点抖动
        guard dualEnabled else { return }
        applyDualVolume()
    }

    /// DUAL：遥控器上下键步进微调（delta 通常 ±0.05）
    func nudgeVocalLevel(_ delta: Float) { setVocalLevel(vocalLevel + delta) }

    // MARK: - Voice Toggle (原唱 / 半消 / 伴奏 多档 + 滑块)

    /// 遥控器一个键在当前歌曲的全部档位间循环：五档(原唱→75%→半消→25%→伴奏)
    /// 或三档/双档，边界由 HLS 实际音轨数 vocalTrackCount 决定。
    func toggleVoice() {
        // DUAL 双FLAC：只在 原唱(1)/纯伴奏(0) 两态切换，连续细调交给垂直音量条
        if dualEnabled { setVocalLevel(vocalLevel > 0.5 ? 0 : 1); voiceGeneration += 1; return }
        // 音轨尚未探测到时至少允许在 0/1 之间走，options 到位后 trySelect 会回填真实档数并收敛
        let bound = max(2, vocalTrackCount)
        vocalTrackIndex = (vocalTrackIndex + 1) % bound
        voiceGeneration += 1
        applyVoiceMode()
    }

    /// 直接选到指定档位（滑块吸附/快捷按钮用），index 即音轨序号，越界由选择阶段收敛
    func selectVocalTrack(_ index: Int) {
        if dualEnabled {
            // 档位位置线性映射到连续人声增益：0档=原唱(1)…末档=纯伴奏(0)
            let total = max(2, vocalTrackCount)
            setVocalLevel(1 - Float(max(0, min(4, index))) / Float(total - 1))
            return
        }
        let clamped = max(0, min(4, index))
        guard clamped != vocalTrackIndex else { return }
        vocalTrackIndex = clamped
        voiceGeneration += 1
        applyVoiceMode()
    }

    /// 快捷直达：原唱(第0档) / 纯伴奏(最后一档)
    func setVoiceMode(_ original: Bool) {
        if dualEnabled { setVocalLevel(original ? 1 : 0); return }
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

    /// 仅拆除当前 AVPlayer 及其观察者/定时器/图层，不重置 DUAL 等业务状态；换 item 前复用
    private func teardownPlayer() {
        stopProgressTimer()
        stuckCheckTimer?.invalidate()
        stuckCheckTimer = nil
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
    }

    func cleanup() {
        teardownPlayer()
        isPlaying = false
        currentTime = 0
        duration = 0
        // 复位 DUAL（本地缓存的 FLAC 文件保留，二次点歌秒开）
        dualEnabled = false
        dualSongId = nil
        dualAudioMix = nil
        dualVocalParams = nil
        vocalLevel = 1
    }
}
