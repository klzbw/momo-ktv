import SwiftUI
import AVKit
import CoreImage


// MARK: - 小屏歌词独立视图（10Hz Timer 驱动，避免 ContentView 观察 20Hz 的 playerManager.currentTime 导致整页高频重绘）
struct CompactLyricsView: View {
    let lyrics: SongLyrics
    @State private var displayTime: Double = 0
    // 小屏用 10Hz 刷新足够：字小、逐字效果在 0.1s 间隔下依然流畅，且 GPU 负载减半
    private let timer = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    var body: some View {
        LyricsView(lyrics: lyrics, currentTime: displayTime, compact: true)
            .onReceive(timer) { _ in
                // 直接读取单例的当前时间，不通过 @ObservedObject 订阅，避免 20Hz 触发本视图之外的重绘
                displayTime = PlayerManager.shared.currentTime
            }
    }
}

struct ContentView: View {
    @StateObject private var api: KTVAPIClient
    @AppStorage("serverAddress") private var serverAddress: String = ""
    @AppStorage("appTheme") private var appThemeRaw: Int = 1
    // 连接流程：connected=false 时处于"连接确认 / 输入地址"阶段；冷启动回到该阶段，从后台返回则自动连接
    @State private var connected = false
    @State private var showSetupInput = false
    @State private var hasBeenBackground = false
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingPlayer = false
    @State private var activePanel: PanelType? = nil
    @State private var activePage: PageType? = nil
    @State private var selectedArtist: String = ""
    @State private var currentTheme: AppTheme = .theme1
    @State private var isPlaying = false
    @State private var isOriginalVoice = true
    @State private var showSongIntro = false
    @State private var introSong: QueueItem?
    @State private var volume: Float = 0.7
    @State private var showQR = false
    @State private var shouldResumePlaying = true
    @State private var lastAutoNextQueueId: Int? = nil
    @State private var recentRandomSongIds: Set<Int> = []  // 最近随机播放过的歌曲ID，避免连续重复
    @FocusState private var searchNavFocused: Bool
    @FocusState private var queueNavFocused: Bool
    @FocusState private var settingsNavFocused: Bool
    @State private var lastNavButton: String? = nil
    private let playerManager = PlayerManager.shared
    private let vlcManager = VLCPlayerManager.shared
    @State private var isUsingVLC = false
    @State private var showDebugLog = false
    @StateObject private var previewLyrics = LyricsLoader()  // 首页小窗预览歌词

    enum PanelType { case search, queue, settings, eq }
    enum PageType { case order, artists, artistSongs, charts, favorites, history, newest, category }

    init() {
        let addr = UserDefaults.standard.string(forKey: "serverAddress") ?? ""
        _api = StateObject(wrappedValue: KTVAPIClient(baseURL: addr.isEmpty ? "http://192.168.3.16:8083" : addr))
    }

    var body: some View {
        Group {
            if connected && !serverAddress.isEmpty {
                ZStack {
                    mainContent
                        .disabled(activePage != nil)

                    if let page = activePage {
                        pageView(page)
                            .zIndex(1)
                    }

                    // VLC调试日志覆盖层（长按视频区域1秒切换显示）
                    if showDebugLog {
                        VStack {
                            Spacer()
                            DebugLogOverlay(log: vlcManager.debugLog) {
                                showDebugLog = false
                            }
                        }
                        .zIndex(2)
                        .transition(.move(edge: .bottom))
                    }
                }
            } else if showSetupInput || serverAddress.isEmpty {
                // 首次使用（无历史地址）或用户选择"输入新地址"：进入 IP 输入页
                SetupView(serverAddress: $serverAddress, onSave: { connectCurrent() })
            } else {
                // 每次进入 App / 从后台返回：先弹连接确认，可一键直连上次地址或改新地址
                ConnectConfirmView(savedAddress: serverAddress,
                                   onDirect: { connectCurrent() },
                                   onChangeIP: { showSetupInput = true })
            }
        }
        .onExitCommand {
            if activePage != nil {
                activePage = nil
            }
        }
        .onAppear {
            currentTheme = AppTheme(rawValue: appThemeRaw) ?? .theme1
            // 不自动连接：有上次地址先弹"直接连接 / 改新地址"确认；没有记录才直接进入输入页
            connected = false
            showSetupInput = serverAddress.isEmpty
        }
        .onChange(of: scenePhase) { phase in
            // 全退后台再次进入 App：重新弹出服务器连接确认（保留上次地址，可直连或改新 IP）
            switch phase {
            case .background:
                hasBeenBackground = true
            case .active:
                if hasBeenBackground {
                    hasBeenBackground = false
                    if !serverAddress.isEmpty {
                        // 从后台返回时直接自动连接上次服务器，不再弹连接确认页让用户手动点击，
                        // 解决"清出后台后app连接服务器慢"的问题
                        showSetupInput = false
                        showingPlayer = false
                        connectCurrent()
                    }
                }
            default:
                break
            }
            }
        .onChange(of: showingPlayer) { isPresented in
            if isPresented {
                // Entering fullscreen: record state, shared player keeps playing
                shouldResumePlaying = playerManager.isPlaying
            } else {
                // Exiting fullscreen: shared player continues, just sync state
                isPlaying = playerManager.isPlaying
            }
        }
        .fullScreenCover(isPresented: $showingPlayer) {
            if let playing = api.queue.first(where: { $0.isPlaying }) {
                FullPlayerView(
                    song: playing,
                    onNext: { advancePlayback() },
                    onClose: { showingPlayer = false },
                    api: api
                )
            }
        }
        .overlay {
            ZStack {
                TVFeedbackOverlay(topPad: 84)
                AtmosphereOverlay()
            }
        }
    }

    // MARK: - Main Content (exact web layout)
    private var mainContent: some View {
        ZStack {
            // Theme-based background
            if appThemeRaw == 2 {
                // Theme 2: Dark Neon (simulates theme2-bg.jpg)
                AppTheme.neonBg.ignoresSafeArea()
                RadialGradient(colors: [WebColors.ac.opacity(0.25), .clear],
                               center: UnitPoint(x: 0.2, y: 0.3), startRadius: 0, endRadius: 500)
                    .ignoresSafeArea()
                RadialGradient(colors: [WebColors.pink.opacity(0.2), .clear],
                               center: UnitPoint(x: 0.8, y: 0.7), startRadius: 0, endRadius: 450)
                    .ignoresSafeArea()
                RadialGradient(colors: [WebColors.ac2.opacity(0.15), .clear],
                               center: UnitPoint(x: 0.5, y: 1.0), startRadius: 0, endRadius: 400)
                    .ignoresSafeArea()
            } else if appThemeRaw == 3 {
                // Theme 3: Carousel style
                Color(hex: 0x050a15).ignoresSafeArea()
                RadialGradient(colors: [AppTheme.s3Accent.opacity(0.15), .clear],
                               center: UnitPoint(x: 0.3, y: 0.4), startRadius: 0, endRadius: 500)
                    .ignoresSafeArea()
                RadialGradient(colors: [AppTheme.s3Accent2.opacity(0.12), .clear],
                               center: UnitPoint(x: 0.7, y: 0.6), startRadius: 0, endRadius: 450)
                    .ignoresSafeArea()
            } else {
                // Theme 1: Default (exact #bg)
                WebColors.bg.ignoresSafeArea()
                RadialGradient(colors: [WebColors.ac.opacity(0.12), .clear],
                               center: UnitPoint(x: 0.1, y: 0.5), startRadius: 0, endRadius: 400)
                    .ignoresSafeArea()
                RadialGradient(colors: [WebColors.ac2.opacity(0.12), .clear],
                               center: UnitPoint(x: 0.9, y: 0.2), startRadius: 0, endRadius: 400)
                    .ignoresSafeArea()
            }

            VStack(spacing: 0) {
                topBar
                nextUpBar
                mainGrid
            }
            .allowsHitTesting(activePanel == nil)
            .disabled(activePanel != nil)

            if let panel = activePanel {
                panelView(panel)
                    .zIndex(1)
                    .transition(.opacity)
            }
        }
        .onExitCommand {
            if activePanel != nil {
                activePanel = nil
            }
        }
        .onChange(of: activePanel == nil) { closed in
            // 弹窗关闭后，把焦点恢复到打开它的那个导航按钮
            if closed, let target = lastNavButton {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    switch target {
                    case "search": searchNavFocused = true
                    case "queue": queueNavFocused = true
                    case "settings": settingsNavFocused = true
                    default: break
                    }
                }
            }
        }
        .onPlayPauseCommand {
            if api.queue.contains(where: { $0.isPlaying }) {
                showingPlayer = true
            }
        }
    }

    // MARK: - Top Bar (exact #topbar)
    private var topBar: some View {
        HStack(spacing: 8) {
            // Logo
            HStack(spacing: 6) {
                Image(systemName: "music.note")
                    .font(.system(size: 24))
                    .foregroundStyle(LinearGradient(colors: [WebColors.ac2, WebColors.ac, WebColors.pink],
                                                    startPoint: .leading, endPoint: .trailing))
                Text("墨墨爱K歌")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(.white)
            }
            .padding(.trailing, 4)

            NavButton(icon: "magnifyingglass", title: "搜索", badge: nil, externalFocus: $searchNavFocused) { lastNavButton = "search"; activePanel = .search }
            NavButton(icon: "list.bullet", title: "已点", badge: api.queue.count > 0 ? api.queue.count : nil, externalFocus: $queueNavFocused) { lastNavButton = "queue"; activePanel = .queue }
            NavButton(icon: "gearshape", title: "设置", badge: nil, externalFocus: $settingsNavFocused) { lastNavButton = "settings"; activePanel = .settings }

            Spacer()

            // Connection status
            HStack(spacing: 6) {
                Circle()
                    .fill(api.isConnected ? Color.green : Color.orange)
                    .frame(width: 10, height: 10)
                Text(api.isConnected ? "已连接" : "未连接")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(WebColors.sub)
            }
            .padding(.horizontal, 10)

            // Clock
            VStack(alignment: .trailing, spacing: 2) {
                Text(currentTime)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(.white)
                Text(currentDate)
                    .font(.system(size: 14))
                    .foregroundColor(WebColors.sub)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(WebColors.topbarBg)
        .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .bottom)
        .focusSection()
    }

    // MARK: - Next Up Bar（常驻滚动横条，对齐网页 #next-up-bar，小屏不消失）
    private var nextUpBar: some View {
        TVTickerBar(text: tickerText, fontSize: 22)
    }

    /// 主界面滚动横条文案（正在播放/下一首/待播提醒/队列数量/欢迎语）
    private var tickerText: String {
        var parts: [String] = []
        if let cur = api.queue.first(where: { $0.isPlaying }) {
            parts.append("♪ 正在播放：《\(cur.displayTitle)》 \(cur.displayArtist)")
        } else {
            parts.append("🎤 快来点歌开唱吧～")
        }
        let waiting = api.queue.filter { !$0.isPlaying }
        if let next = waiting.first {
            parts.append("🎵 下一首：《\(next.displayTitle)》 \(next.displayArtist)")
        }
        if waiting.count < 3 { parts.append("🎤 待播曲目不多啦，继续点歌吧～") }
        parts.append("📋 队列里还有 \(waiting.count) 首歌")
        parts.append("🎤 墨墨爱K歌——歌声有约，快乐无限")
        return parts.joined(separator: "        ")
    }

    // MARK: - Main Grid (4-column 5-row layout, video spans 2x3)
    private var mainGrid: some View {
        GeometryReader { geo in
            HStack(spacing: 12) {
                // Left column: contains video + controls + quick cards
                VStack(spacing: 10) {
                    // Video panel - 3 rows (60% height)
                    nowPanel
                        .frame(height: geo.size.height * 0.58)

                    // Controls - 1 row (22% height)
                    mvCtrl
                        .frame(height: geo.size.height * 0.22)

                    // Quick cards - 1 row (20% height)
                    bottomQuickCards
                        .frame(height: geo.size.height * 0.20)
                }
                .frame(width: geo.size.width * 0.54)

                // Middle column: 4 vertical buttons
                midCards
                    .frame(width: geo.size.width * 0.26)

                // Right column: queue (narrow)
                rightQueue
                    .frame(width: geo.size.width * 0.20)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .focusSection()
    }

    // MARK: - Bottom Quick Cards (hot charts, recent, favorites, newest)
    private var bottomQuickCards: some View {
        HStack(spacing: 6) {
            quickCard(title: "热歌排行", icon: "chart.line.uptrend.xyaxis", gradient: LinearGradient(colors: [Color(hex: 0xff4f9b), Color(hex: 0xff6b6b)], startPoint: .leading, endPoint: .trailing)) { activePage = .charts }
            quickCard(title: "最近唱过", icon: "clock.fill", gradient: LinearGradient(colors: [Color(hex: 0x8e44f7), Color(hex: 0xc736f7)], startPoint: .leading, endPoint: .trailing)) { activePage = .history }
            quickCard(title: "我的收藏", icon: "heart.fill", gradient: LinearGradient(colors: [Color(hex: 0xff8c42), Color(hex: 0xffb347)], startPoint: .leading, endPoint: .trailing)) { activePage = .favorites }
            quickCard(title: "最新入库", icon: "tray.full.fill", gradient: LinearGradient(colors: [Color(hex: 0x1a7bff), Color(hex: 0x36d9f7)], startPoint: .leading, endPoint: .trailing)) { activePage = .newest }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .focusSection()
    }

    private func quickCard(title: String, icon: String, gradient: LinearGradient, action: @escaping () -> Void) -> some View {
        TVTightButton(action: action) { focused in
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 40, weight: .bold))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                Spacer()
                Image(systemName: icon)
                    .font(.system(size: 34, weight: .bold))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white.opacity(0.95))
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Group { if focused { Color.white } else { gradient.opacity(0.7) } })
            .cornerRadius(12)
            .padding(2)
            .background(focused ? Color.white.opacity(0.15) : Color.clear)
            .cornerRadius(14)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - QR Code View (exact #now-qr-code2)
    private var qrCodeView: some View {
        VStack(spacing: 6) {
            if let qrImage = generateQRCode(from: "http://\(api.serverAddress)/m") {
                Image(uiImage: qrImage)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 96, height: 96)
            } else {
                Image(systemName: "qrcode")
                    .font(.system(size: 60))
                    .frame(width: 96, height: 96)
            }
            Text("扫码点歌")
                .font(.system(size: 11))
                .foregroundColor(.black)
        }
    }

    private func generateQRCode(from string: String) -> UIImage? {
        guard let data = string.data(using: .ascii),
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let cgImage = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }

    // MARK: - Now Panel (exact #now-panel with video preview)
    private var nowPanel: some View {
        TVTightButton(action: {
            if api.queue.contains(where: { $0.isPlaying }) {
                showingPlayer = true
            }
        }) { focused in
            ZStack {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.black)

            if let playing = api.queue.first(where: { $0.isPlaying }),
               isUsingVLC || api.hlsURL(songId: playing.song_id) != nil {
                let hlsURL = api.hlsURL(songId: playing.song_id)
                // Video preview using shared player (AVPlayer) or VLC player
                // Use id to force rebuild when returning from fullscreen
                if isUsingVLC {
                    VLCVideoView(vlcManager: vlcManager)
                        .id("preview-vlc-\(showingPlayer ? "fs" : "normal")")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .onAppear {
                            // VLC模式：视频已在playSong中设置，这里只加载歌词
                            if playing.isVideoFile { previewLyrics.lyrics = .empty }
                            else if previewLyrics.lyrics.isEmpty { previewLyrics.load(server: api.serverAddress, songId: playing.song_id) }
                        }

                } else if let hlsURL = hlsURL {
                    SharedVideoView(playerManager: playerManager)
                        .id("preview-\(showingPlayer ? "fs" : "normal")")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .onAppear {
                            playerManager.vocalTrackCount = playing.audio_tracks ?? 1
                            playerManager.setupPlayer(for: hlsURL)
                            playerManager.setVolume(volume)
                            prepareDualIfNeeded(playing)
                            if playing.isVideoFile { previewLyrics.lyrics = .empty }
                            else if previewLyrics.lyrics.isEmpty { previewLyrics.load(server: api.serverAddress, songId: playing.song_id) }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                playerManager.attachLayerToCurrentHost()
                            }
                        }
                }

                // 纯音频歌：小窗也显示动态背景 + 逐字歌词，与全屏 FullPlayerView 一致
                if !playing.isVideoFile {
                    AudioBackgroundView(server: api.serverAddress)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .allowsHitTesting(false)
                    CompactLyricsView(lyrics: previewLyrics.lyrics)
                        .allowsHitTesting(false)
                }

                // Song intro animation (exact #song-intro)
                if showSongIntro, let intro = introSong {
                    songIntroView(song: intro)
                        .transition(.opacity)
                }

                // Bottom gradient info (exact #now-info)
                VStack {
                    Spacer()
                    VStack(alignment: .leading, spacing: 4) {
                        Text(playing.displayTitle)
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Text(playing.displayArtist)
                            .font(.system(size: 17))
                            .foregroundColor(WebColors.sub)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(LinearGradient(colors: [Color.black.opacity(0.85), .clear],
                                               startPoint: .bottom, endPoint: .top))
                }
            } else {
                // Idle state (exact #now-idle)
                VStack(spacing: 10) {
                    Text("墨墨爱K歌")
                        .font(.system(size: 36, weight: .heavy))
                        .foregroundStyle(LinearGradient(colors: [WebColors.ac2, WebColors.ac, WebColors.pink],
                                                        startPoint: .leading, endPoint: .trailing))
                    Text("扫码点歌 · 大屏沉浸演唱")
                        .font(.system(size: 14))
                        .foregroundColor(WebColors.sub)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RadialGradient(colors: [WebColors.ac.opacity(0.2), .clear],
                                   center: UnitPoint(x: 0.3, y: 0.5), startRadius: 0, endRadius: 200)
                    .overlay(WebColors.navy)
                )
            }

            // QR Code corner (exact #now-qr-corner)
            if showQR {
                VStack {
                    HStack {
                        Spacer()
                        qrCodeView
                            .padding(10)
                            .background(Color.white.opacity(0.95))
                            .cornerRadius(10)
                            .padding(10)
                    }
                    Spacer()
                }
                .transition(.opacity)
            }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            .cornerRadius(16)
            .padding(2)
            .background(focused ? Color.white.opacity(0.15) : Color.clear)
            .cornerRadius(18)
        }
        .onChange(of: api.queue.first(where: { $0.isPlaying })?.song_id) { newId in
            // Reset auto-next guard when song changes
            lastAutoNextQueueId = nil
            if let playing = api.queue.first(where: { $0.isPlaying }) {
                // 小窗预览歌词：视频歌清空，纯音频歌加载
                if playing.isVideoFile { previewLyrics.lyrics = .empty }
                else { previewLyrics.load(server: api.serverAddress, songId: playing.song_id) }
                introSong = playing
                showSongIntro = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    showSongIntro = false
                }
                // Setup new song in shared player
                // 先检测歌曲类型：网络KTV歌曲直接走DUAL双FLAC模式，本地歌曲走HLS
                let sid = playing.song_id
                api.fetchSepInfo(songId: sid) { info in
                    DispatchQueue.main.async {
                        // 快切歌保护：当前仍在播放同一首才继续
                        guard self.api.queue.first(where: { $0.isPlaying })?.song_id == sid else { return }

                        // 网络KTV MKV视频：使用VLC播放器播放（AVFoundation不支持MKV容器）
                        // VLC内置115专用UA，自动跟随302重定向，真正直连不占NAS带宽
                        if let info = info, info.isNetworkMkv,
                           let videoPath = info.videoUrl,
                           let videoURL = self.api.apiURL(videoPath) {
                            self.isUsingVLC = true
                            self.playerManager.cleanup()
                            self.vlcManager.play(url: videoURL)
                            self.vlcManager.onStateChange = { playing in
                                DispatchQueue.main.async {
                                    self.playerManager.isPlaying = playing
                                }
                            }
                            self.vlcManager.onTimeUpdate = { current, total in
                                DispatchQueue.main.async {
                                    self.playerManager.currentTime = current
                                    self.playerManager.duration = total
                                }
                            }
                            print("[ContentView] 网络KTV MKV视频播放(VLC播放器): \(videoPath)")
                            return
                        }

                        // 网络KTV歌曲：直接走DUAL双FLAC模式，不走HLS
                        if let info = info, info.isNetworkDual,
                           let vocalPath = info.vocalUrl, let accompPath = info.accompUrl,
                           let vURL = self.api.apiURL(vocalPath),
                           let aURL = self.api.apiURL(accompPath) {
                            self.playerManager.vocalTrackCount = 2
                            self.playerManager.setupNetKtvPlayer(songId: String(sid), vocalURL: vURL, accompURL: aURL)
                            self.playerManager.setVolume(volume)
                            return
                        }

                        // 本地歌曲：走原有的HLS播放流程
                        if let url = self.api.hlsURL(songId: sid) {
                            self.playerManager.vocalTrackCount = playing.audio_tracks ?? 1
                            self.playerManager.setupPlayer(for: url)
                            self.playerManager.setVolume(volume)
                            self.prepareDualIfNeeded(playing)
                        }
                    }
                }
            } else {
                // No song playing
                isUsingVLC = false
                vlcManager.stop()
                playerManager.cleanup()
            }
            isPlaying = playerManager.isPlaying
            shouldResumePlaying = true
        }
        .focusSection()
    }

    /// 纯音频且已 AI 分离的歌：HLS 先起播，随后升级为 DUAL 连续人声音量；
    /// 网络KTV歌曲(isNetKtv)直接用网络URL，不下载到本地；本地分离歌曲先下载再激活。
    /// MKV/MP4 等视频歌直接跳过，保持原 HLS 多档/声道方案。
    private func prepareDualIfNeeded(_ playing: QueueItem) {
        guard !playing.isVideoFile else { return }
        let sid = playing.song_id
        api.fetchSepInfo(songId: sid) { info in
            guard let info = info, info.isDual,
                  let vocalPath = info.vocalUrl, let accompPath = info.accompUrl else { return }

            // 网络KTV歌曲：直接用网络URL，不下载到本地
            if info.isNetworkDual {
                guard let vURL = self.api.apiURL(vocalPath),
                      let aURL = self.api.apiURL(accompPath) else { return }
                // 快切歌保护：当前仍在播放同一首才升级
                guard self.api.queue.first(where: { $0.isPlaying })?.song_id == sid else { return }
                self.playerManager.activateDual(songId: sid, vocalFile: vURL, accompFile: aURL)
                return
            }

            // 本地分离歌曲：先下载到本地再激活
            self.api.downloadDualTracks(songId: sid, vocalPath: vocalPath, accompPath: accompPath) { vFile, aFile in
                guard let vFile = vFile, let aFile = aFile else { return }
                // 快切歌保护：当前仍在播放同一首才升级（PlayerManager 内部另有 generation 校验）
                guard self.api.queue.first(where: { $0.isPlaying })?.song_id == sid else { return }
                self.playerManager.activateDual(songId: sid, vocalFile: vFile, accompFile: aFile)
            }
        }
    }

    private func setupControlHandler() {
        api.onControlMessage = { [weak api] action, payload in
            guard let api = api else { return }
            switch action {
            case "play_pause":
                if isUsingVLC {
                    vlcManager.togglePlayPause()
                    isPlaying = vlcManager.isPlaying
                    FeedbackCenter.shared.show(vlcManager.isPlaying ? "开始播放" : "暂停播放",
                                           icon: vlcManager.isPlaying ? "play.fill" : "pause.fill")
                } else {
                    playerManager.togglePlayPause()
                    isPlaying = playerManager.isPlaying
                    FeedbackCenter.shared.show(playerManager.isPlaying ? "开始播放" : "暂停播放",
                                           icon: playerManager.isPlaying ? "play.fill" : "pause.fill")
                }
            case "repeat":
                if isUsingVLC {
                    vlcManager.restart()
                } else {
                    playerManager.restart()
                }
                api.restartSong()
                FeedbackCenter.shared.show("重新演唱", icon: "gobackward")
            case "voice":
                // Server broadcasts control messages back to ALL clients including
                // the sender; ignore our own echo so we don't toggle twice.
                if (payload["clientId"] as? String) != api.clientId {
                    playerManager.toggleVoice()
                }
                FeedbackCenter.shared.show(playerManager.vocalTrackLabel, icon: "mic.fill")
            case "eq":
                if let name = payload["name"] as? String {
                    let labels = ["flat": "标准", "vocal": "人声增强", "bass": "低音增强", "bright": "明亮清晰"]
                    FeedbackCenter.shared.show("均衡器：\(labels[name] ?? name)", icon: "slider.horizontal.3")
                }
            case "volume":
                // JSON 数字经 JSONSerialization 桥接为 NSNumber，直接 as? Float 在部分情况下
                // 会得到 nil，导致手机遥控音量无效；统一用 NSNumber.floatValue 读取。
                let delta = (payload["delta"] as? NSNumber)?.floatValue
                    ?? Float(payload["delta"] as? Double ?? 0)
                guard delta != 0 else { return }
                volume = max(0, min(1, volume + delta))
                if isUsingVLC { vlcManager.setVolume(volume) } else { playerManager.setVolume(volume) }
                FeedbackCenter.shared.show("音量 \(Int(volume * 100))%",
                                           icon: delta > 0 ? "speaker.plus" : "speaker.minus")
            case "next":
                FeedbackCenter.shared.show("切到下一首", icon: "forward.end.fill")
                advancePlayback()
            case "fullscreen":
                if api.queue.contains(where: { $0.isPlaying }) { showingPlayer = true }
            case "home":
                showingPlayer = false
                activePanel = nil
                activePage = nil
            case "bg_next":
                // 遥控端切换动态背景：循环 AudioBgMode 写入 UserDefaults，FullPlayerView 的 @AppStorage 自动响应
                let curRaw = UserDefaults.standard.string(forKey: "momoBgMode") ?? AudioBgMode.flow.rawValue
                let nextMode = AudioBgMode.from(curRaw).next
                UserDefaults.standard.set(nextMode.rawValue, forKey: "momoBgMode")
                FeedbackCenter.shared.show("背景：\(nextMode.display)", icon: "sparkles")
            case "bg_set":
                // 遥控端指定背景模式索引
                if let idx = (payload["index"] as? NSNumber)?.intValue {
                    let all = AudioBgMode.allCases
                    let mode = all[((idx % all.count) + all.count) % all.count]
                    UserDefaults.standard.set(mode.rawValue, forKey: "momoBgMode")
                    FeedbackCenter.shared.show("背景：\(mode.display)", icon: "sparkles")
                }
            case "lyrics_mode":
                // 遥控端切换歌词双排/滚动模式
                let lmRaw = UserDefaults.standard.string(forKey: "momoLyricsMode") ?? "dual"
                UserDefaults.standard.set(lmRaw == "dual" ? "scroll" : "dual", forKey: "momoLyricsMode")
            case "lyrics_offset":
                // 遥控端歌词快慢校准：转发给正在显示的全屏播放器
                let delta = (payload["delta"] as? NSNumber)?.doubleValue
                    ?? Double(payload["delta"] as? Double ?? 0)
                if delta != 0 {
                    NotificationCenter.default.post(name: .momoLyricsOffset, object: nil,
                                                    userInfo: ["delta": delta])
                }
            default:
                break
            }
        }
    }

    private func setupAtmosphereHandler() {
        AtmosphereCenter.shared.serverBase = api.httpBaseURL
        api.onAtmosphere = { kind in AtmosphereCenter.shared.trigger(kind) }
        api.onBlessing = { text, from in AtmosphereCenter.shared.bless(text, from: from) }
    }

    private func setupPlaybackEndHandler() {
        playerManager.onPlaybackEnd = {
            DispatchQueue.main.async {
                guard let curSong = self.api.queue.first(where: { $0.isPlaying }) else {
                    if self.showingPlayer { self.showingPlayer = false }
                    return
                }
                // Prevent duplicate next calls for the same song
                if self.lastAutoNextQueueId == curSong.id { return }
                self.lastAutoNextQueueId = curSong.id
                // 队列里还有已点就播下一首；已点播完则自动从曲库随机选一首续播，
                // 不再直接停住 / 退出全屏（修复"已点歌曲播完后无法自动随机播放"）
                self.advancePlayback()
            }
        }
    }

    /// 统一推进播放：队列里有待播已点 → 切下一首；已点队列清空 → 自动随机挑一首续播。
    /// 手动切歌、遥控切歌、自然播完三处都走这里，保证行为一致。
    /// 统一推进播放：队列里有待播已点 → 切下一首；已点队列清空 → 自动随机挑一首续播。
    /// 手动切歌、遥控切歌、自然播完三处都走这里，保证行为一致。
    private func advancePlayback() {
        // 1) 还有等待中的已点歌曲，直接切下一首
        if api.queue.contains(where: { !$0.isPlaying }) {
            api.nextSong()
            return
        }
        // 2) 已点队列已空：从曲库随机挑一首（排除最近播放过的，避免连续重复）
        let currentId = api.queue.first(where: { $0.isPlaying })?.song_id
        func pick(from list: [Song]) {
            // 排除当前歌曲和最近随机播放过的歌曲（最多保留20首历史）
            var pool = list.filter { $0.id != currentId && !self.recentRandomSongIds.contains($0.id) }
            // 如果排除后为空（曲库太小），退化为只排除当前歌曲
            if pool.isEmpty { pool = list.filter { $0.id != currentId } }
            // 如果还是为空（只有一首歌），用全部列表
            let finalPool = pool.isEmpty ? list : pool
            guard let song = finalPool.randomElement() else {
                // 曲库确实为空、无歌可续播时才退出全屏
                if self.showingPlayer { self.showingPlayer = false }
                return
            }
            // 记录到最近播放历史
            self.recentRandomSongIds.insert(song.id)
            if self.recentRandomSongIds.count > 20 {
                self.recentRandomSongIds.removeFirst()
            }
            // 先把随机歌以 waiting 入队，延迟一点再切歌，确保队列已更新（避免卡顿/无歌曲）
            self.api.addToQueue(songId: song.id) { ok in
                if ok {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        self.api.nextSong()
                    }
                } else {
                    // 入队失败，从历史中移除并重试一次
                    self.recentRandomSongIds.remove(song.id)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        self.advancePlayback()
                    }
                }
            }
        }
        if api.songs.isEmpty {
            // 曲库尚未加载到内存，先拉取再随机挑选
            api.fetchSongs { pick(from: self.api.songs) }
        } else {
            pick(from: self.api.songs)
        }
    }

    /// 用当前 serverAddress 建立连接并进入主界面（"直接连接"与"输入新地址后连接"共用）。
    private func connectCurrent() {
        guard !serverAddress.isEmpty else { showSetupInput = true; return }
        // updateBaseURL 内部会断开旧 WebSocket、用目标地址重连并 fetchAll 拉取全部数据
        api.updateBaseURL(serverAddress)
        setupControlHandler()
        setupAtmosphereHandler()
        setupPlaybackEndHandler()
        setupProgressReporting()
        showSetupInput = false
        connected = true
    }

    /// Wire PlayerManager's 1s progress timer to API client's sendProgress.
    /// The server only accepts progress from the active player (this TV,
    /// announced via role_announce on WS connect) and broadcasts it to all
    /// controllers — mobile remote then interpolates for its progress bar.
    private func setupProgressReporting() {
        // ContentView is a struct (value type), so [weak self] is not allowed.
        // Capture api (a class instance) directly instead.
        let apiRef = api
        playerManager.onProgressReport = { currentTime, paused, voice in
            let playing = apiRef.queue.first(where: { $0.isPlaying })
            apiRef.sendProgress(queueId: playing?.queue_id, currentTime: currentTime, paused: paused, voice: voice)
        }
    }

    // MARK: - Song Intro View (exact #song-intro)
    private func songIntroView(song: QueueItem) -> some View {
        HStack(spacing: 22) {
            // Mic icon with pulse rings (exact .si-mic + .si-ring)
            ZStack {
                Circle()
                    .stroke(Color.white.opacity(0.45), lineWidth: 1.5)
                    .frame(width: 76, height: 76)
                    .scaleEffect(1.3)
                    .opacity(0.0)
                    .animation(.easeOut(duration: 2.4).repeatForever(autoreverses: false), value: UUID())
                Circle()
                    .fill(LinearGradient(colors: [WebColors.ac, WebColors.pink],
                                         startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1)))
                    .frame(width: 76, height: 76)
                    .overlay(Circle().stroke(Color.white.opacity(0.25), lineWidth: 1))
                Image(systemName: "mic.fill")
                    .font(.system(size: 32))
                    .foregroundColor(.white)
            }

            // Text (exact .si-text)
            VStack(alignment: .leading, spacing: 10) {
                Text(song.displayTitle)
                    .font(.system(size: 30, weight: .heavy))
                    .lineLimit(1)
                    .foregroundStyle(LinearGradient(colors: [.white, WebColors.ac2],
                                                    startPoint: .leading, endPoint: .trailing))
                Text(song.displayArtist)
                    .font(.system(size: 16))
                    .foregroundColor(.white)
                    .padding(.horizontal, 16).padding(.vertical, 5)
                    .background(Color.white.opacity(0.14))
                    .cornerRadius(999)
                    .overlay(RoundedRectangle(cornerRadius: 999).stroke(Color.white.opacity(0.2), lineWidth: 1))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(colors: [WebColors.ac.opacity(0.35), .clear],
                           center: UnitPoint(x: 0.22, y: 0.5), startRadius: 0, endRadius: 200)
            .overlay(LinearGradient(colors: [WebColors.navy, WebColors.bg],
                                    startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1)))
        )
    }

    // MARK: - MV Ctrl (compact 7-button row, exact web style)
    private var mvCtrl: some View {
        HStack(spacing: 6) {
            MVButton(icon: "slider.horizontal.3", title: "均衡器") { activePanel = .eq }
            MVButton(icon: "mic", title: isUsingVLC ? vlcManager.voiceLabel : playerManager.vocalTrackLabel) {
                if isUsingVLC {
                    // VLC模式：使用VLC音轨切换
                    vlcManager.toggleVoice()
                    showToast(vlcManager.voiceLabel)
                } else {
                    playerManager.toggleVoice()
                    api.toggleVoice()
                    showToast(playerManager.vocalTrackLabel)
                }
                // Sync voice state to server so mobile remote original/accompaniment
                // button highlight stays in sync with the TV.
                api.sendPlaybackState(paused: !playerManager.isPlaying, voice: isUsingVLC ? vlcManager.voiceLabel : playerManager.voiceStateString)
            }
            MVButton(icon: "speaker.minus", title: "音量-") {
                volume = max(0, volume - 0.1)
                if isUsingVLC { vlcManager.setVolume(volume) } else { playerManager.setVolume(volume) }
                showToast("音量: \(Int(volume * 100))%")
            }
            MVButton(icon: (isUsingVLC ? vlcManager.isPlaying : playerManager.isPlaying) ? "pause.fill" : "play.fill",
                    title: (isUsingVLC ? vlcManager.isPlaying : playerManager.isPlaying) ? "暂停" : "播放", isCenter: true) {
                if isUsingVLC {
                    vlcManager.togglePlayPause()
                    isPlaying = vlcManager.isPlaying
                    FeedbackCenter.shared.show(vlcManager.isPlaying ? "开始播放" : "暂停播放",
                                           icon: vlcManager.isPlaying ? "play.fill" : "pause.fill")
                } else {
                    playerManager.togglePlayPause()
                    isPlaying = playerManager.isPlaying
                    FeedbackCenter.shared.show(playerManager.isPlaying ? "开始播放" : "暂停播放",
                                           icon: playerManager.isPlaying ? "play.fill" : "pause.fill")
                }
                // Sync playback state to server so mobile remote play/pause
                // button icon stays in sync with the TV.
                api.sendPlaybackState(paused: !(isUsingVLC ? vlcManager.isPlaying : playerManager.isPlaying),
                    voice: isUsingVLC ? vlcManager.voiceLabel : playerManager.voiceStateString)
            }
            MVButton(icon: "speaker.plus", title: "音量+") {
                volume = min(1, volume + 0.1)
                if isUsingVLC { vlcManager.setVolume(volume) } else { playerManager.setVolume(volume) }
                showToast("音量: \(Int(volume * 100))%")
            }
            MVButton(icon: "forward.end.fill", title: "切歌") { FeedbackCenter.shared.show("切到下一首", icon: "forward.end.fill"); advancePlayback() }
            MVButton(icon: "gobackward", title: "重唱") {
                if isUsingVLC {
                    vlcManager.restart()
                } else {
                    playerManager.restart()
                }
                api.restartSong()
                FeedbackCenter.shared.show("重新演唱", icon: "gobackward")
            }
            MVButton(icon: "ladybug", title: "调试") {
                showDebugLog.toggle()
                FeedbackCenter.shared.show(showDebugLog ? "调试日志已开启" : "调试日志已关闭", icon: "ladybug")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color.white.opacity(0.04))
        .cornerRadius(14)
        .focusSection()
    }

    // MARK: - Mid Cards (vertical column, 4 buttons fill height)
    private var midCards: some View {
        VStack(spacing: 8) {
            bigRequestButton(title: "歌名点歌", icon: "music.note.list", gradient: LinearGradient(colors: [Color(hex: 0xff4f9b), Color(hex: 0xff6b6b)], startPoint: .leading, endPoint: .trailing)) { activePage = .order }
            bigRequestButton(title: "歌手点歌", icon: "mic.fill", gradient: LinearGradient(colors: [Color(hex: 0x8e44f7), Color(hex: 0xc736f7)], startPoint: .leading, endPoint: .trailing)) { activePage = .artists }
            bigRequestButton(title: "分类点歌", icon: "square.grid.2x2.fill", gradient: LinearGradient(colors: [Color(hex: 0xff8c42), Color(hex: 0xffb347)], startPoint: .leading, endPoint: .trailing)) { activePage = .category }
            bigRequestButton(title: "扫码点歌", icon: "qrcode", gradient: LinearGradient(colors: [Color(hex: 0x1a7bff), Color(hex: 0x36d9f7)], startPoint: .leading, endPoint: .trailing)) { showQR.toggle() }
        }
        .frame(maxHeight: .infinity)
        .focusSection()
    }

    private func bigRequestButton(title: String, icon: String, gradient: LinearGradient, action: @escaping () -> Void) -> some View {
        TVTightButton(action: action) { focused in
            HStack(spacing: 10) {
                Text(title)
                    .font(.system(size: 52, weight: .bold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                Spacer()
                Image(systemName: icon)
                    .font(.system(size: 52, weight: .bold))
                    .foregroundColor(.white.opacity(0.95))
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(gradient.opacity(focused ? 1.0 : 0.7))
            .cornerRadius(16)
            .padding(2)
            .background(focused ? Color.white : Color.clear)
            .cornerRadius(18)
        }
        .frame(maxWidth: .infinity)
    }

    private func queueRow(item: QueueItem, index: Int) -> some View {
        TVTightButton(action: {
            // Queue item tap - could play this song if API supports it
        }) { focused in
            HStack(spacing: 12) {
                if item.isPlaying {
                    Image(systemName: "play.circle.fill")
                        .foregroundColor(WebColors.ac2)
                        .font(.system(size: 26))
                        .frame(width: 32)
                } else {
                    Text("\(index + 1)")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.sub)
                        .frame(width: 32)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.displayTitle)
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Text(item.displayArtist)
                            .font(.system(size: 20, weight: .medium))
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e).opacity(0.7) : WebColors.sub)
                            .lineLimit(1)
                        if item.isNetworkSong {
                            Label("云", systemImage: "cloud.fill")
                                .font(.system(size: 12, weight: .medium))
                                .padding(.horizontal, 5).padding(.vertical, 0)
                                .background(Color(hex: 0x0288d1).opacity(0.25))
                                .foregroundColor(Color(hex: 0x4fc3f7))
                                .cornerRadius(3)
                        }
                        Label(item.mediaTypeLabel, systemImage: item.mediaTypeIcon)
                            .font(.system(size: 12, weight: .medium))
                            .padding(.horizontal, 5).padding(.vertical, 0)
                            .background(item.isVideoFile ? Color(hex: 0x0288d1).opacity(0.2) : Color(hex: 0x2e7d32).opacity(0.2))
                            .foregroundColor(item.isVideoFile ? Color(hex: 0x4fc3f7) : Color(hex: 0x81c784))
                            .cornerRadius(3)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 16)
            .background(
                item.isPlaying ? WebColors.ac.opacity(0.3) :
                focused ? Color.white : Color.clear
            )
            .cornerRadius(10)
            .padding(2)
            .background(focused ? Color.white.opacity(0.12) : Color.clear)
            .cornerRadius(12)
        }
    }

    // MARK: - Right Queue (exact #right-queue)
    private var rightQueue: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("♪ 已点队列")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundColor(WebColors.ac2)
                Spacer()
                Text("\(api.queue.count)首")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundColor(WebColors.sub)
            }

            if api.queue.isEmpty {
                Spacer()
                Text("暂无点歌")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundColor(WebColors.sub)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 16)
                Spacer()
            } else {
                ScrollView {
                    VStack(spacing: 5) {
                        ForEach(Array(api.queue.prefix(15).enumerated()), id: \.element.id) { idx, item in
                            queueRow(item: item, index: idx)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .frame(maxHeight: .infinity)
        .background(
            Group {
                if appThemeRaw == 2 {
                    AppTheme.neonPanel
                } else if appThemeRaw == 3 {
                    Color(hex: 0x0a1525).opacity(0.6)
                } else {
                    LinearGradient(colors: [Color(hex: 0x0d0050), Color(hex: 0x1a0060), Color(hex: 0x2a0080)],
                                   startPoint: UnitPoint(x: 0.2, y: 0), endPoint: UnitPoint(x: 0.8, y: 1))
                }
            }
        )
        .cornerRadius(16)
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(
            appThemeRaw == 2 ? WebColors.ac.opacity(0.3) : Color.white.opacity(0.08), lineWidth: 1))
        .focusSection()
    }

    // MARK: - Panel Views
    @ViewBuilder
    private func panelView(_ panel: PanelType) -> some View {
        switch panel {
        case .search:
            SearchPanel(api: api, onClose: { activePanel = nil },
                        onAdd: { song in api.addToQueue(songId: song.id); showToast("已点: \(song.displayTitle)") })
        case .queue:
            QueuePanel(api: api, onClose: { activePanel = nil }, onPlay: { activePanel = nil; showingPlayer = true })
        case .settings:
            SettingsPanel(api: api, onClose: { activePanel = nil }, onThemeChange: { t in
                currentTheme = t
                appThemeRaw = t.rawValue
            })
        case .eq:
            EQPanel(onClose: { activePanel = nil })
        }
    }

    // MARK: - Page Views
    @ViewBuilder
    private func pageView(_ page: PageType) -> some View {
        switch page {
        case .order:
            OrderSongsPage(api: api, onBack: { activePage = nil },
                          onAdd: { song in api.addToQueue(songId: song.id); showToast("已点: \(song.displayTitle)") })
        case .artists:
            ArtistsPage(api: api, onBack: { activePage = nil }, onArtistSelect: { artist in
                selectedArtist = artist
                activePage = .artistSongs
            })
        case .artistSongs:
            ArtistSongsPage(api: api, artist: selectedArtist, onBack: { activePage = .artists },
                            onAdd: { song in api.addToQueue(songId: song.id); showToast("已点: \(song.displayTitle)") })
        case .charts:
            ChartsPage(api: api, onBack: { activePage = nil },
                       onAdd: { song in api.addToQueue(songId: song.id); showToast("已点: \(song.displayTitle)") })
        case .favorites:
            FavoritesPage(api: api, onBack: { activePage = nil },
                          onAdd: { song in api.addToQueue(songId: song.id); showToast("已点: \(song.displayTitle)") })
        case .history:
            HistoryPage(api: api, onBack: { activePage = nil },
                        onAdd: { song in api.addToQueue(songId: song.id); showToast("已点: \(song.displayTitle)") })
        case .newest:
            NewestPage(api: api, onBack: { activePage = nil },
                       onAdd: { song in api.addToQueue(songId: song.id); showToast("已点: \(song.displayTitle)") })
        case .category:
            CategoryPage(api: api, onBack: { activePage = nil },
                         onAdd: { song in api.addToQueue(songId: song.id); showToast("已点: \(song.displayTitle)") })
        }
    }

    // MARK: - Clock
    private var currentTime: String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: Date())
    }
    private var currentDate: String {
        let f = DateFormatter()
        f.dateFormat = "M月d日 EEE"
        f.locale = Locale(identifier: "zh_CN")
        return f.string(from: Date())
    }

    // MARK: - Toast（统一走全局大屏反馈中心）
    private func showToast(_ msg: String) {
        FeedbackCenter.shared.show(msg)
    }
}

// MARK: - Order Songs Page (歌名点歌 - left list + right alphabet panel)
struct OrderSongsPage: View {
    let api: KTVAPIClient
    let onBack: () -> Void
    let onAdd: (Song) -> Void
    @State private var currentPage = 0
    @State private var inputText = "" // Pinyin initials (ABC) or digits (123)
    @State private var keyboardMode: KeyboardMode = .abc
    @State private var songPinyin: [Int: String] = [:] // Precomputed pinyin initials
    @State private var isCacheReady = false
    @State private var filteredSongs: [Song] = []   // 过滤结果（@State避免每次UI渲染重新过滤）
    @State private var searchDebounceTimer: Timer?   // 输入防抖
    @State private var lastFilterQuery = ""           // 增量过滤：上次查询
    @State private var lastFilterIndices: [Int] = []  // 增量过滤：上次结果索引
    private let pageSize = 32
    private enum KeyboardMode { case abc, num }
    // 歌名键盘 ABC 模式：6 行，最后一行 Z 跨 2 列、DEL 跨 3 列，填满整行
    private let abcRows: [[(String, Int)]] = [
        [("A",1),("B",1),("C",1),("D",1),("E",1)],
        [("F",1),("G",1),("H",1),("I",1),("J",1)],
        [("K",1),("L",1),("M",1),("N",1),("O",1)],
        [("P",1),("Q",1),("R",1),("S",1),("T",1)],
        [("U",1),("V",1),("W",1),("X",1),("Y",1)],
        [("Z",2),("DEL",3)]
    ]
    // 歌名键盘数字模式：3 行，DEL 跨 5 列填满整行
    private let numRows: [[(String, Int)]] = [
        [("1",1),("2",1),("3",1),("4",1),("5",1)],
        [("6",1),("7",1),("8",1),("9",1),("0",1)],
        [("DEL",5)]
    ]
    private var activeRows: [[(String, Int)]] { keyboardMode == .abc ? abcRows : numRows }

    private func computePinyinInitials(_ text: String) -> String {
        var result = ""
        for char in text {
            if char.isLetter && char.isASCII {
                result.append(char.uppercased())
            } else if char.isLetter {
                result.append(pinyinFirstLetter(char))
            }
        }
        return result
    }

    private static var pinyinCharCache: [Character: String] = [:]
    private static let pinyinCacheLock = NSLock()

    private func pinyinFirstLetter(_ char: Character) -> String {
        OrderSongsPage.pinyinCacheLock.lock()
        if let cached = OrderSongsPage.pinyinCharCache[char] {
            OrderSongsPage.pinyinCacheLock.unlock()
            return cached
        }
        OrderSongsPage.pinyinCacheLock.unlock()

        let mutable = NSMutableString(string: String(char)) as CFMutableString
        CFStringTransform(mutable, nil, kCFStringTransformToLatin, false)
        CFStringTransform(mutable, nil, kCFStringTransformStripDiacritics, false)
        let pinyin = mutable as String
        let result = pinyin.first.map { String($0).uppercased() } ?? "#"

        OrderSongsPage.pinyinCacheLock.lock()
        OrderSongsPage.pinyinCharCache[char] = result
        OrderSongsPage.pinyinCacheLock.unlock()

        return result
    }

    private func buildCache() {
        let songs = api.songs
        guard !songs.isEmpty else { return }
        isCacheReady = false
        DispatchQueue.global(qos: .userInitiated).async {
            var cache: [Int: String] = [:]
            for song in songs {
                cache[song.id] = computePinyinInitials(song.displayTitle)
            }
            DispatchQueue.main.async {
                self.songPinyin = cache
                self.isCacheReady = true
                // 缓存就绪后重新过滤（如果当前有输入）
                if !self.inputText.isEmpty {
                    self.lastFilterQuery = ""
                    self.applyFilter()
                }
            }
        }
    }

    /// 防抖过滤：输入停止100ms后后台线程过滤
    private func debounceFilter() {
        searchDebounceTimer?.invalidate()
        searchDebounceTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: false) { _ in
            self.currentPage = 0
            self.applyFilter()
        }
    }

    /// 后台线程过滤+增量过滤（ABC模式新字母在上次结果上继续过滤）
    private func applyFilter() {
        let q = inputText
        let songs = api.songs
        let pinyin = songPinyin
        let cacheReady = isCacheReady
        let mode = keyboardMode

        // 增量过滤：ABC模式下，新query是旧query的前缀扩展时，在上次结果索引基础上过滤
        let sourceIndices: [Int]
        if mode == .abc && !q.isEmpty && !lastFilterQuery.isEmpty && q.hasPrefix(lastFilterQuery) && lastFilterIndices.count > 0 {
            sourceIndices = lastFilterIndices
        } else {
            sourceIndices = Array(0..<songs.count)
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let resultIndices: [Int]
            if q.isEmpty {
                resultIndices = Array(0..<songs.count)
            } else if mode == .abc {
                if cacheReady {
                    resultIndices = sourceIndices.filter { i in
                        guard let p = pinyin[songs[i].id] else { return false }
                        return p.hasPrefix(q)
                    }
                } else {
                    resultIndices = []
                }
            } else {
                resultIndices = sourceIndices.filter { i in
                    songs[i].displayTitle.localizedCaseInsensitiveContains(q)
                }
            }
            let result = resultIndices.map { songs[$0] }
            DispatchQueue.main.async {
                self.filteredSongs = result
                self.lastFilterQuery = q
                self.lastFilterIndices = resultIndices
            }
        }
    }

    var pagedSongs: [Song] {
        let start = currentPage * pageSize
        let end = min(start + pageSize, filteredSongs.count)
        return start < filteredSongs.count ? Array(filteredSongs[start..<end]) : []
    }

    var totalPages: Int { max(1, (filteredSongs.count + pageSize - 1) / pageSize) }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                HStack(spacing: 8) {
                    Image(systemName: "music.note")
                        .font(.system(size: 24))
                        .foregroundColor(WebColors.ac2)
                    Text("立即点歌")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundColor(.white)
                }
                Spacer()
                TVTightButton(action: onBack) { focused in
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.left")
                        Text("返回")
                    }
                    .font(.system(size: 18, weight: .medium))
                    .padding(.horizontal, 20).padding(.vertical, 8)
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                    .background(focused ? Color.white : Color.white.opacity(0.1))
                    .cornerRadius(999)
                }
            }
            .padding(.horizontal, 24).padding(.vertical, 14)
            .background(WebColors.topbarBg)

            // Main content: left song list + right alphabet panel
            HStack(spacing: 0) {
                // Left: song list (2 cols)
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                              spacing: 10) {
                        ForEach(Array(pagedSongs.enumerated()), id: \.element.id) { idx, song in
                            songRow(song, index: currentPage * pageSize + idx)
                                .gridCellColumns(
                                    (idx == pagedSongs.count - 1 && pagedSongs.count % 2 == 1) ? 2 : 1
                                )
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .frame(maxWidth: .infinity)
                .focusSection()

                // Right: search panel (keyboard)
                VStack(spacing: 0) {
                    // Panel header: search icon + title/input + mode toggle button
                    HStack {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 20))
                            .foregroundColor(WebColors.sub)
                        Text(inputText.isEmpty ? "歌名搜索" : inputText)
                            .font(.system(size: 22, weight: .bold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Spacer()
                        // 单按钮切换：ABC 模式显示"123"，123 模式显示"ABC"
                        TVTightButton(action: {
                            keyboardMode = (keyboardMode == .abc ? .num : .abc)
                            inputText = ""
                            lastFilterQuery = ""
                            lastFilterIndices = []
                            debounceFilter()
                        }) { focused in
                            Text(keyboardMode == .abc ? "123" : "ABC")
                                .font(.system(size: 18, weight: .bold))
                                .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                                .padding(.horizontal, 18).padding(.vertical, 7)
                                .background(focused ? Color.white : Color.white.opacity(0.15))
                                .cornerRadius(999)
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 14)

                    // Keyboard: 按键放大填满右侧面板（VStack 等高行 + GeometryReader 精确跨列）
                    VStack(spacing: 8) {
                        ForEach(0..<activeRows.count, id: \.self) { r in
                            let row = activeRows[r]
                            GeometryReader { geo in
                                let sp: CGFloat = 8
                                let cw = (geo.size.width - sp * 4) / 5
                                HStack(spacing: sp) {
                                    ForEach(0..<row.count, id: \.self) { c in
                                        let (key, span) = row[c]
                                        let kw = cw * CGFloat(span) + sp * CGFloat(span - 1)
                                        TightKeyButton(key: key, width: kw, height: geo.size.height) {
                                            if key == "DEL" {
                                                if !inputText.isEmpty { inputText.removeLast() }
                                            } else {
                                                inputText.append(key)
                                            }
                                            debounceFilter()
                                        }
                                    }
                                }
                            }
                            .frame(maxHeight: .infinity)
                        }

                        // Clear button（固定在键盘底部，键盘行平分剩余空间）
                        TightClearButton(isEmpty: inputText.isEmpty) {
                            inputText = ""; debounceFilter()
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 4)
                    .padding(.bottom, 10)
                    .frame(maxHeight: .infinity)
                }
                .frame(width: 400)
                .background(Color(hex: 0x15151f))
                .focusSection()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .focusSection()

            // Pagination footer
            HStack(spacing: 20) {
                TVTightButton(action: { if currentPage > 0 { currentPage -= 1 } }) { focused in
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.left")
                        Text("上一页")
                    }
                    .font(.system(size: 20, weight: .medium))
                    .padding(.horizontal, 22).padding(.vertical, 10)
                    .foregroundColor(currentPage > 0 ? (focused ? Color(hex: 0x1a1a2e) : .white) : WebColors.sub)
                    .background(currentPage > 0 ? (focused ? Color.white : Color.white.opacity(0.12)) : Color.clear)
                    .cornerRadius(999)
                }
                .disabled(currentPage == 0)

                Text("第 \(currentPage + 1)/\(totalPages) (共\(filteredSongs.count)首)")
                    .font(.system(size: 20))
                    .foregroundColor(.white)

                TVTightButton(action: { if currentPage + 1 < totalPages { currentPage += 1 } }) { focused in
                    HStack(spacing: 6) {
                        Text("下一页")
                        Image(systemName: "chevron.right")
                    }
                    .font(.system(size: 20, weight: .medium))
                    .padding(.horizontal, 22).padding(.vertical, 10)
                    .foregroundColor(currentPage + 1 < totalPages ? (focused ? Color(hex: 0x1a1a2e) : .white) : WebColors.sub)
                    .background(currentPage + 1 < totalPages ? (focused ? Color.white : Color.white.opacity(0.12)) : Color.clear)
                    .cornerRadius(999)
                }
                .disabled(currentPage + 1 >= totalPages)
            }
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(WebColors.topbarBg)
            .focusSection()
        }
        .background(WebColors.bg.ignoresSafeArea())
        .onAppear {
            // 重置搜索状态：清空上次搜索关键词和增量过滤缓存，确保每次进入都是全新搜索
            inputText = ""
            lastFilterQuery = ""
            lastFilterIndices = []
            currentPage = 0
            filteredSongs = api.songs
            if api.songs.isEmpty {
                api.fetchSongs { buildCache() }
            } else {
                buildCache()
            }
        }
        .onChange(of: api.songs.count) { _ in buildCache() }
    }

    @ViewBuilder
    private func songRow(_ song: Song, index: Int) -> some View {
        HStack(spacing: 14) {
            // 整行大按钮：数字 + 歌名/歌手 + 点歌，焦点区域大，遥控器易选中
            TVTightButton(action: { onAdd(song) }) { focused in
                HStack(spacing: 14) {
                    ZStack {
                        Circle()
                            .fill(LinearGradient(colors: [Color(hex: 0x9333ea), Color(hex: 0x6366f1)],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 60, height: 60)
                        Text("\(index + 1)")
                            .font(.system(size: 26, weight: .bold))
                            .foregroundColor(.white)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                            Text(song.displayTitle)
                                .font(.system(size: 32, weight: .semibold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                            HStack(spacing: 6) {
                                Text(song.displayArtist)
                                    .font(.system(size: 24))
                                    .foregroundColor(WebColors.sub)
                                    .lineLimit(1)
                                if song.isNetworkSong {
                                    Label("云", systemImage: "cloud.fill")
                                        .font(.system(size: 13, weight: .medium))
                                        .padding(.horizontal, 6).padding(.vertical, 1)
                                        .background(Color(hex: 0x0288d1).opacity(0.25))
                                        .foregroundColor(Color(hex: 0x4fc3f7))
                                        .cornerRadius(4)
                                }
                                Label(song.mediaTypeLabel, systemImage: song.mediaTypeIcon)
                                    .font(.system(size: 13, weight: .medium))
                                    .padding(.horizontal, 6).padding(.vertical, 1)
                                    .background(song.isVideoFile ? Color(hex: 0x0288d1).opacity(0.2) : Color(hex: 0x2e7d32).opacity(0.2))
                                    .foregroundColor(song.isVideoFile ? Color(hex: 0x4fc3f7) : Color(hex: 0x81c784))
                                    .cornerRadius(4)
                            }
                    }

                    Spacer(minLength: 0)

                    Text("点歌")
                        .font(.system(size: 26, weight: .semibold))
                        .padding(.horizontal, 26).padding(.vertical, 12)
                        .background(Group {
                            if focused {
                                Color.white
                            } else {
                                LinearGradient(colors: [Color(hex: 0x9333ea), Color(hex: 0x7c3aed)],
                                               startPoint: .leading, endPoint: .trailing)
                            }
                        })
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                        .cornerRadius(12)
                }
                .padding(2)
                .background(focused ? Color.white.opacity(0.08) : Color.clear)
                .cornerRadius(12)
            }

            // Favorite
            TightFavButton(isFavorite: api.favorites.contains { $0.id == song.id }) {
                api.toggleFavorite(songId: song.id)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color(hex: 0x1e1e2e))
        .cornerRadius(12)
    }
}

// MARK: - Video Preview (AVPlayerLayer without controls)
struct VideoPreview: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        let layer = AVPlayerLayer(player: player)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        context.coordinator.playerLayer = layer
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.playerLayer?.frame = uiView.bounds
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator {
        var playerLayer: AVPlayerLayer?
    }
}

// 歌词快慢校准通知：遥控端 -> 全屏播放器
extension Notification.Name {
    static let momoLyricsOffset = Notification.Name("momoLyricsOffset")
}

// MARK: - VLC调试日志覆盖层
struct DebugLogOverlay: View {
    let log: String
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("VLC调试日志 (长按队列按钮关闭)")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundColor(.white.opacity(0.7))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(hex: 0x1a1a2e).opacity(0.95))

            ScrollView {
                Text(log)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.green)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 300)
            .background(Color.black.opacity(0.9))
        }
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.green.opacity(0.5), lineWidth: 1)
        )
        .padding(16)
    }
}
