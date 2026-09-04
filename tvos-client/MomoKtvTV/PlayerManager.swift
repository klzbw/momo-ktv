import AVFoundation
import UIKit

// MARK: - 自定义Scheme资源加载器
/// 拦截AVPlayer的资源请求，手动用URLSession请求（保留自定义User-Agent），
/// 处理302重定向时确保UA不丢失。仍然是真正的直连，流量不经过NAS。
class CustomSchemeLoader: NSObject, AVAssetResourceLoaderDelegate, URLSessionDataDelegate, URLSessionTaskDelegate {
    static var associatedKey = 0
    private let originalURL: URL
    private let customHeaders: [String: String]
    private var dataTasks: [Int: URLSessionDataTask] = [:]
    private var loadingRequests: [Int: AVAssetResourceLoadingRequest] = [:]
    private var taskIdCounter: Int = 0
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    init(originalURL: URL, customHeaders: [String: String]) {
        self.originalURL = originalURL
        self.customHeaders = customHeaders
        super.init()
    }

    /// 把原始URL转换成自定义scheme的URL
    static func makeCustomSchemeURL(_ url: URL) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.scheme = "momo-custom"
        return components?.url ?? url
    }

    /// 把自定义scheme的URL还原成原始URL
    private func originalURL(from customURL: URL) -> URL {
        var components = URLComponents(url: customURL, resolvingAgainstBaseURL: false)
        components?.scheme = originalURL.scheme
        return components?.url ?? originalURL
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        guard let customURL = loadingRequest.request.url else { return false }
        let url = originalURL(from: customURL)

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        // 设置自定义请求头（包括User-Agent）
        for (key, value) in customHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }
        // 透传Range请求
        if let range = loadingRequest.dataRequest?.requestedOffset {
            let length = loadingRequest.dataRequest?.requestedLength ?? Int.max
            if range > 0 || length != Int.max {
                let end = (range + Int64(length) - 1)
                request.setValue("bytes=\(range)-\(end == Int64.max - 1 ? "" : String(end))", forHTTPHeaderField: "Range")
            }
        }

        let taskId = taskIdCounter
        taskIdCounter += 1
        loadingRequests[taskId] = loadingRequest

        let task = session.dataTask(with: request)
        task.taskDescription = String(taskId)
        dataTasks[taskId] = task
        task.resume()

        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        didCancel loadingRequest: AVAssetResourceLoadingRequest) {
        for (taskId, req) in loadingRequests where req === loadingRequest {
            dataTasks[taskId]?.cancel()
            dataTasks.removeValue(forKey: taskId)
            loadingRequests.removeValue(forKey: taskId)
            break
        }
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let taskId = Int(dataTask.taskDescription ?? ""),
              let loadingRequest = loadingRequests[taskId],
              let httpResponse = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }

        // 填充contentInformationRequest
        if let infoRequest = loadingRequest.contentInformationRequest {
            infoRequest.contentType = httpResponse.mimeType ?? "application/octet-stream"
            infoRequest.isByteRangeAccessSupported = httpResponse.statusCode == 206
            // 206响应时从Content-Range头提取整个文件长度
            if httpResponse.statusCode == 206,
               let contentRange = httpResponse.allHeaderFields["Content-Range"] as? String,
               let slashRange = contentRange.range(of: "/") {
                let totalLengthStr = contentRange[slashRange.upperBound...]
                infoRequest.contentLength = Int64(totalLengthStr) ?? httpResponse.expectedContentLength
            } else {
                infoRequest.contentLength = httpResponse.expectedContentLength
            }
        }

        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let taskId = Int(dataTask.taskDescription ?? ""),
              let loadingRequest = loadingRequests[taskId] else { return }
        loadingRequest.dataRequest?.respond(with: data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let taskId = Int(task.taskDescription ?? ""),
              let loadingRequest = loadingRequests[taskId] else { return }

        if let error = error {
            loadingRequest.finishLoading(with: error)
        } else {
            loadingRequest.finishLoading()
        }
        dataTasks.removeValue(forKey: taskId)
        loadingRequests.removeValue(forKey: taskId)
    }

    // MARK: - 重定向处理：关键！确保重定向后保留自定义UA
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        var newRequest = request
        // 重定向时重新设置自定义请求头（包括User-Agent）
        for (key, value) in customHeaders {
            newRequest.setValue(value, forHTTPHeaderField: key)
        }
        print("[CustomSchemeLoader] 302重定向，保留UA: \(request.url?.absoluteString.prefix(60) ?? "")")
        completionHandler(newRequest)
    }
}

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
    private var dualAccompParams: AVMutableAudioMixInputParameters?
    private var dualVocalTrack: AVMutableCompositionTrack?   // composition里的人声轨引用，创建新params用
    private var dualAccompTrack: AVMutableCompositionTrack?  // composition里的伴奏轨引用
    private var previousVocalLevel: Float = 1.0               // 上一次的人声音量，用于丝滑渐变的起始值
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
    /// 人声音量百分比（滑块/HUD用）：DUAL取连续值；非DUAL按实际音轨数线性映射，0档=100%(原唱)，末档=0%(伴奏)
    /// 五档时结果与旧映射[100,75,50,25,0]完全一致；2档/3档等其他档数也正确（修复2档MKV伴奏显示75%的bug）
    var vocalVolumePercent: Int {
        if dualEnabled { return Int((vocalLevel * 100).rounded()) }
        guard vocalTrackCount > 1 else { return 100 }
        let pct = 100 - Int(Double(vocalTrackIndex) / Double(vocalTrackCount - 1) * 100.0)
        return max(0, min(100, pct))
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
        setupPlayer(for: url, customHeaders: nil)
    }

    /// 支持自定义HTTP请求头的播放（用于115网盘直连，需要特定User-Agent否则403）
    /// 真正的302直连：先用URLSession获取重定向后的最终URL，再用AVURLAsset直接播放（无重定向，UA不丢失）
    func setupPlayer(for url: URL, customHeaders: [String: String]?) {
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

        guard let headers = customHeaders, !headers.isEmpty else {
            // 无自定义请求头：普通播放
            setupPlayerInternal(for: url, playerItem: AVPlayerItem(url: url))
            return
        }

        // 有自定义请求头（如115网盘）：先用URLSession获取302重定向后的最终URL
        // 然后用最终URL直接创建AVURLAsset（无重定向，UA不会丢失）
        print("[PlayerManager] 获取302重定向最终URL: \(url.absoluteString.prefix(80))...")
        var request = URLRequest(url: url)
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        let gen = loadGeneration
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self = self, self.loadGeneration == gen else { return }
            let finalURL = response?.url ?? url
            print("[PlayerManager] 最终URL: \(finalURL.absoluteString.prefix(80))...")
            DispatchQueue.main.async {
                let asset = AVURLAsset(url: finalURL, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
                let playerItem = AVPlayerItem(asset: asset)
                self.setupPlayerInternal(for: url, playerItem: playerItem)
            }
        }.resume()
    }

    /// 内部播放方法：设置状态并起播
    private func setupPlayerInternal(for url: URL, playerItem: AVPlayerItem) {
        cleanup()

        dualEnabled = false
        dualSongId = nil
        vocalLevel = 1
        vocalTrackIndex = 0
        loadGeneration += 1
        voiceGeneration += 1

        currentHLSURL = url

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
            // 用 setVolume(_:at:) 设置恒定音量（从0时刻起整条时间轴生效）
            aParams.setVolume(1.0, at: .zero)

            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.loadGeneration == gen else { return }
                let resumeAt = self.player?.currentTime().seconds ?? 0
                vParams.setVolume(self.vocalLevel, at: .zero)
                let mix = AVMutableAudioMix()
                mix.inputParameters = [vParams, aParams]
                self.dualAudioMix = mix
                self.dualVocalParams = vParams
                self.dualAccompParams = aParams
                self.dualVocalTrack = cVocal
                self.dualAccompTrack = cAcc
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
    /// 关键1：每次必须创建新的 AVMutableAudioMix 对象——重新赋值同一对象 AVFoundation
    ///        不会重新处理，导致音量调节/原唱伴奏切换实际无音频变化。
    /// 关键2：每次必须创建新的 AVMutableAudioMixInputParameters 对象——复用旧对象并多次
    ///        调用 setVolumeRamp 会累积多个音量渐变段，导致音量设置混乱/不生效。
    ///        用 trackID 创建新对象 + setVolume(_:at:) 设置恒定音量，干净可靠。
    private func applyDualVolume() {
        guard let vTrack = dualVocalTrack, let aTrack = dualAccompTrack else { return }
        let q = max(0, min(1, vocalLevel))
        // 每次创建新的 params 对象（用 composition 里的 track 引用），避免复用旧对象累积音量段
        let vParams = AVMutableAudioMixInputParameters(track: vTrack)
        let aParams = AVMutableAudioMixInputParameters(track: aTrack)
        // 丝滑渐变：从当前播放时间开始，0.3秒内从 previousVocalLevel 渐变到目标音量 q
        // 避免瞬时跳变，调节体验丝滑。timeRange 用有限值(0.3秒)，不会触发 positiveInfinity 崩溃。
        if let player = player, player.rate > 0 {
            let currentTime = player.currentTime()
            if currentTime.isValid && currentTime.seconds >= 0 {
                let rampDuration = CMTime(seconds: 0.3, preferredTimescale: 600)
                let rampRange = CMTimeRange(start: currentTime, duration: rampDuration)
                vParams.setVolumeRamp(fromStartVolume: previousVocalLevel, toEndVolume: q, timeRange: rampRange)
            } else {
                vParams.setVolume(q, at: .zero)
            }
        } else {
            vParams.setVolume(q, at: .zero)
        }
        aParams.setVolume(1.0, at: .zero)
        let newMix = AVMutableAudioMix()
        newMix.inputParameters = [vParams, aParams]
        dualAudioMix = newMix
        dualVocalParams = vParams
        dualAccompParams = aParams
        player?.currentItem?.audioMix = newMix
    }

    /// DUAL：连续设置人声音量 0(纯伴奏)...1(原唱)
    func setVocalLevel(_ x: Float) {
        guard dualEnabled else { return }  // 非DUAL模式(无双声道)不允许调节，避免UI显示变化但实际声音不变
        let q = max(0, min(1, x))
        previousVocalLevel = vocalLevel                           // 保存旧值，用于丝滑渐变的起始音量
        vocalLevel = (q * 100).rounded() / 100                   // 量化到 1%，消除浮点抖动
        applyDualVolume()
    }

    /// DUAL：遥控器上下键步进微调（delta 通常 ±0.05）
    func nudgeVocalLevel(_ delta: Float) { setVocalLevel(vocalLevel + delta) }

    // MARK: - Voice Toggle (原唱 / 半消 / 伴奏 多档 + 滑块)

    /// 遥控器一个键在当前歌曲的全部档位间循环：五档(原唱→75%→半消→25%→伴奏)
    /// 或三档/双档，边界由 HLS 实际音轨数 vocalTrackCount 决定。
    func toggleVoice() {
        if dualEnabled { setVocalLevel(vocalLevel > 0.5 ? 0 : 1); voiceGeneration += 1; return }
        if vocalTrackIndex == 0 {
            vocalTrackIndex = max(0, vocalTrackCount - 1)
        } else {
            vocalTrackIndex = 0
        }
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
        dualAccompParams = nil
        dualVocalTrack = nil
        dualAccompTrack = nil
        previousVocalLevel = 1.0
        vocalLevel = 1
    }


    // MARK: - 网络KTV（115网盘直连双FLAC）
    /// 播放网络KTV歌曲：直接用双FLAC混合模式，不需要HLS
    /// - Parameters:
    ///   - songId: 歌曲ID（sha256前16位）
    ///   - vocalURL: 人声FLAC完整URL
    ///   - accompURL: 伴奏FLAC完整URL
    func setupNetKtvPlayer(songId: String, vocalURL: URL, accompURL: URL) {
        // 清理当前播放器
        cleanup()

        // 设置DUAL模式
        dualEnabled = true
        dualSongId = nil  // activateDual会设置
        vocalLevel = 1
        vocalTrackIndex = 0
        vocalTrackCount = 5  // DUAL模式用5档展示
        loadGeneration += 1
        voiceGeneration += 1
        currentSongId = nil  // 网络KTV歌曲没有Int ID

        // 直接激活DUAL双FLAC混合
        activateDual(songId: 0, vocalFile: vocalURL, accompFile: accompURL)

        print("[PlayerManager] 网络KTV播放开始 songId=\(songId)")
    }

    /// 网络KTV歌曲是否正在播放
    var isNetKtvPlaying: Bool {
        dualEnabled && dualSongId != nil && currentSongId == nil
    }
}
