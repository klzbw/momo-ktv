import SwiftUI
import AVKit
import CoreImage


// MARK: - 灏忓睆姝岃瘝鐙珛瑙嗗浘锛?0Hz Timer 椹卞姩锛岄伩鍏?ContentView 瑙傚療 20Hz 鐨?playerManager.currentTime 瀵艰嚧鏁撮〉楂橀閲嶇粯锛?struct CompactLyricsView: View {
    let lyrics: SongLyrics
    @State private var displayTime: Double = 0
    // 灏忓睆鐢?10Hz 鍒锋柊瓒冲锛氬瓧灏忋€侀€愬瓧鏁堟灉鍦?0.1s 闂撮殧涓嬩緷鐒舵祦鐣咃紝涓?GPU 璐熻浇鍑忓崐
    private let timer = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    var body: some View {
        LyricsView(lyrics: lyrics, currentTime: displayTime, compact: true)
            .onReceive(timer) { _ in
                // 鐩存帴璇诲彇鍗曚緥鐨勫綋鍓嶆椂闂达紝涓嶉€氳繃 @ObservedObject 璁㈤槄锛岄伩鍏?20Hz 瑙﹀彂鏈鍥句箣澶栫殑閲嶇粯
                displayTime = PlayerManager.shared.currentTime
            }
    }
}

struct ContentView: View {
    @StateObject private var api: KTVAPIClient
    @AppStorage("serverAddress") private var serverAddress: String = ""
    @AppStorage("appTheme") private var appThemeRaw: Int = 1
    // 杩炴帴娴佺▼锛歝onnected=false 鏃跺浜?杩炴帴纭 / 杈撳叆鍦板潃"闃舵锛涘喎鍚姩鍥炲埌璇ラ樁娈碉紝浠庡悗鍙拌繑鍥炲垯鑷姩杩炴帴
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
    @State private var recentRandomSongIds: Set<Int> = []  // 鏈€杩戦殢鏈烘挱鏀捐繃鐨勬瓕鏇睮D锛岄伩鍏嶈繛缁噸澶?    @FocusState private var searchNavFocused: Bool
    @FocusState private var queueNavFocused: Bool
    @FocusState private var settingsNavFocused: Bool
    @State private var lastNavButton: String? = nil
    private let playerManager = PlayerManager.shared
    private let vlcManager = VLCPlayerManager.shared
    @State private var isUsingVLC = false
    @State private var showDebugLog = false
    @StateObject private var previewLyrics = LyricsLoader()  // 棣栭〉灏忕獥棰勮姝岃瘝

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

                    // VLC璋冭瘯鏃ュ織瑕嗙洊灞傦紙闀挎寜瑙嗛鍖哄煙1绉掑垏鎹㈡樉绀猴級
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
                // 棣栨浣跨敤锛堟棤鍘嗗彶鍦板潃锛夋垨鐢ㄦ埛閫夋嫨"杈撳叆鏂板湴鍧€"锛氳繘鍏?IP 杈撳叆椤?                SetupView(serverAddress: $serverAddress, onSave: { connectCurrent() })
            } else {
                // 姣忔杩涘叆 App / 浠庡悗鍙拌繑鍥烇細鍏堝脊杩炴帴纭锛屽彲涓€閿洿杩炰笂娆″湴鍧€鎴栨敼鏂板湴鍧€
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
            // 涓嶈嚜鍔ㄨ繛鎺ワ細鏈変笂娆″湴鍧€鍏堝脊"鐩存帴杩炴帴 / 鏀规柊鍦板潃"纭锛涙病鏈夎褰曟墠鐩存帴杩涘叆杈撳叆椤?            connected = false
            showSetupInput = serverAddress.isEmpty
        }
        .onChange(of: scenePhase) { phase in
            // 鍏ㄩ€€鍚庡彴鍐嶆杩涘叆 App锛氶噸鏂板脊鍑烘湇鍔″櫒杩炴帴纭锛堜繚鐣欎笂娆″湴鍧€锛屽彲鐩磋繛鎴栨敼鏂?IP锛?            switch phase {
            case .background:
                hasBeenBackground = true
            case .active:
                if hasBeenBackground {
                    hasBeenBackground = false
                    if !serverAddress.isEmpty {
                        // 浠庡悗鍙拌繑鍥炴椂鐩存帴鑷姩杩炴帴涓婃鏈嶅姟鍣紝涓嶅啀寮硅繛鎺ョ‘璁ら〉璁╃敤鎴锋墜鍔ㄧ偣鍑伙紝
                        // 瑙ｅ喅"娓呭嚭鍚庡彴鍚巃pp杩炴帴鏈嶅姟鍣ㄦ參"鐨勯棶棰?                        showSetupInput = false
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
            // VLC浣跨敤鍏变韩鍗曚緥瑙嗗浘(VLCSharedVideoView)锛屽ぇ灏忓睆鍒囨崲鏃跺彧鏄妸
            // 鍚屼竴涓猆IView鍦ㄥ鍣ㄩ棿绉诲姩锛岃棰戣緭鍑哄畬鍏ㄤ笉涓柇锛屾棤闇€杞噸鍚€?        }
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
            // 寮圭獥鍏抽棴鍚庯紝鎶婄劍鐐规仮澶嶅埌鎵撳紑瀹冪殑閭ｄ釜瀵艰埅鎸夐挳
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
                Text("澧ㄥⅷ鐖盞姝?)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(.white)
            }
            .padding(.trailing, 4)

            NavButton(icon: "magnifyingglass", title: "鎼滅储", badge: nil, externalFocus: $searchNavFocused) { lastNavButton = "search"; activePanel = .search }
            NavButton(icon: "list.bullet", title: "宸茬偣", badge: api.queue.count > 0 ? api.queue.count : nil, externalFocus: $queueNavFocused) { lastNavButton = "queue"; activePanel = .queue }
            NavButton(icon: "gearshape", title: "璁剧疆", badge: nil, externalFocus: $settingsNavFocused) { lastNavButton = "settings"; activePanel = .settings }

            Spacer()

            // Connection status
            HStack(spacing: 6) {
                Circle()
                    .fill(api.isConnected ? Color.green : Color.orange)
                    .frame(width: 10, height: 10)
                Text(api.isConnected ? "宸茶繛鎺? : "鏈繛鎺?)
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

    // MARK: - Next Up Bar锛堝父椹绘粴鍔ㄦí鏉★紝瀵归綈缃戦〉 #next-up-bar锛屽皬灞忎笉娑堝け锛?    private var nextUpBar: some View {
        TVTickerBar(text: tickerText, fontSize: 22)
    }

    /// 涓荤晫闈㈡粴鍔ㄦí鏉℃枃妗堬紙姝ｅ湪鎾斁/涓嬩竴棣?寰呮挱鎻愰啋/闃熷垪鏁伴噺/娆㈣繋璇級
    private var tickerText: String {
        var parts: [String] = []
        if let cur = api.queue.first(where: { $0.isPlaying }) {
            parts.append("鈾?姝ｅ湪鎾斁锛氥€奬(cur.displayTitle)銆?\(cur.displayArtist)")
        } else {
            parts.append("馃帳 蹇潵鐐规瓕寮€鍞卞惂锝?)
        }
        let waiting = api.queue.filter { !$0.isPlaying }
        if let next = waiting.first {
            parts.append("馃幍 涓嬩竴棣栵細銆奬(next.displayTitle)銆?\(next.displayArtist)")
        }
        if waiting.count < 3 { parts.append("馃帳 寰呮挱鏇茬洰涓嶅鍟︼紝缁х画鐐规瓕鍚э綖") }
        parts.append("馃搵 闃熷垪閲岃繕鏈?\(waiting.count) 棣栨瓕")
        parts.append("馃帳 澧ㄥⅷ鐖盞姝屸€斺€旀瓕澹版湁绾︼紝蹇箰鏃犻檺")
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
            quickCard(title: "鐑瓕鎺掕", icon: "chart.line.uptrend.xyaxis", gradient: LinearGradient(colors: [Color(hex: 0xff4f9b), Color(hex: 0xff6b6b)], startPoint: .leading, endPoint: .trailing)) { activePage = .charts }
            quickCard(title: "鏈€杩戝敱杩?, icon: "clock.fill", gradient: LinearGradient(colors: [Color(hex: 0x8e44f7), Color(hex: 0xc736f7)], startPoint: .leading, endPoint: .trailing)) { activePage = .history }
            quickCard(title: "鎴戠殑鏀惰棌", icon: "heart.fill", gradient: LinearGradient(colors: [Color(hex: 0xff8c42), Color(hex: 0xffb347)], startPoint: .leading, endPoint: .trailing)) { activePage = .favorites }
            quickCard(title: "鏈€鏂板叆搴?, icon: "tray.full.fill", gradient: LinearGradient(colors: [Color(hex: 0x1a7bff), Color(hex: 0x36d9f7)], startPoint: .leading, endPoint: .trailing)) { activePage = .newest }
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
            Text("鎵爜鐐规瓕")
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
                    // 鍏ㄥ睆鏃朵笉鍒涘缓灏忓睆VLC瑙嗗浘锛岄伩鍏嶄笌鍏ㄥ睆VLCVideoView绔炰簤drawable瀵艰嚧鍙湁澹伴煶鏃犺棰?                    if !showingPlayer {
                        VLCVideoView(vlcManager: vlcManager)
                            .id("preview-vlc")
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .onAppear {
                                // VLC妯″紡锛氳棰戝凡鍦╬laySong涓缃紝杩欓噷鍙姞杞芥瓕璇?                                if playing.isVideoFile { previewLyrics.lyrics = .empty }
                                else if previewLyrics.lyrics.isEmpty { previewLyrics.load(server: api.serverAddress, songId: playing.song_id) }
                            }
                    }

                } else if let hlsURL = hlsURL {
                    // 鍏ㄥ睆鏃朵笉鍒涘缓灏忓睆SharedVideoView锛孎ullPlayerView宸叉湁鑷繁鐨勮棰戣鍥?                    if !showingPlayer {
                        SharedVideoView(playerManager: playerManager)
                            .id("preview")
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
                }

                // 绾煶棰戞瓕锛氬皬绐椾篃鏄剧ず鍔ㄦ€佽儗鏅?+ 閫愬瓧姝岃瘝锛屼笌鍏ㄥ睆 FullPlayerView 涓€鑷?                if !playing.isVideoFile {
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
                    Text("澧ㄥⅷ鐖盞姝?)
                        .font(.system(size: 36, weight: .heavy))
                        .foregroundStyle(LinearGradient(colors: [WebColors.ac2, WebColors.ac, WebColors.pink],
                                                        startPoint: .leading, endPoint: .trailing))
                    Text("鎵爜鐐规瓕 路 澶у睆娌夋蹈婕斿敱")
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

            // === 鍒囨瓕绔嬪嵆鍋滄鏃ф挱鏀撅細闃叉鍒囨瓕鍚庡悗鍙版畫鐣欐棫姝屾洸闊抽 ===
            isUsingVLC = false
            vlcManager.stop()
            playerManager.pause()

            if let playing = api.queue.first(where: { $0.isPlaying }) {
                // 灏忕獥棰勮姝岃瘝锛氳棰戞瓕娓呯┖锛岀函闊抽姝屽姞杞?                if playing.isVideoFile { previewLyrics.lyrics = .empty }
                else { previewLyrics.load(server: api.serverAddress, songId: playing.song_id) }
                introSong = playing
                showSongIntro = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    showSongIntro = false
                }
                let sid = playing.song_id

                // === 鏈湴姝屾洸绔嬪嵆 HLS 璧锋挱锛屼笉绛?sep-info锛堝ぇ骞呮彁鍗囧垏姝岄€熷害锛?==
                // 缃戠粶姝屾洸(115缃戠洏)蹇呴』绛?sep-info 鍐冲畾璧?VLC(MKV鐩磋繛) 杩樻槸 DUAL(鍙孎LAC鐩磋繛)
                if !playing.isNetworkSong, let hlsURL = api.hlsURL(songId: sid) {
                    playerManager.vocalTrackCount = playing.audio_tracks ?? 1
                    playerManager.setupPlayer(for: hlsURL)
                    playerManager.setVolume(volume)
                }

                // === 鍚庡彴寮傛鑾峰彇 sep-info锛氱綉缁滄瓕鏇茬洿杩炴挱鏀?/ 鏈湴姝屾洸鍗囩骇 DUAL ===
                api.fetchSepInfo(songId: sid) { info in
                    DispatchQueue.main.async {
                        // 蹇垏姝屼繚鎶わ細褰撳墠浠嶅湪鎾斁鍚屼竴棣栨墠缁х画
                        guard self.api.queue.first(where: { $0.isPlaying })?.song_id == sid else {
                            self.vlcManager.log("sep-info: 蹇垏姝屼繚鎶わ紝蹇界暐 sid=\(sid)")
                            return
                        }

                        // 鎵撳嵃 sep-info 璇婃柇淇℃伅锛堝畾浣?share-115 绛夐摼璺棶棰橈級
                        if let info = info {
                            self.vlcManager.log("sep-info: isNetKtvMkv=\(info.isNetKtvMkv ?? false), isNetworkMkvRaw=\(info.isNetworkMkvRaw ?? false), isNetworkMkv=\(info.isNetworkMkv), videoUrl=\(info.videoUrl ?? "nil"), source=\(info.source ?? "nil"), isNetworkSong=\(playing.isNetworkSong), source_root=\(playing.source_root ?? "nil")")
                        } else {
                            self.vlcManager.log("sep-info: 杩斿洖 nil (sid=\(sid))")
                        }

                        // 缃戠粶 MKV 瑙嗛锛歏LC 302 鐩磋繛鎾斁锛堜笉鍗?NAS 甯﹀鍜屽閲忥級
                        // 鏀寔涓夌鏉ユ簮锛?api/direct-stream/*銆?api/cloud/115-direct/*銆乧loud_url瀹屾暣URL
                        if let info = info, info.isNetworkMkv,
                           let videoURL = self.api.cloudDirectURL(for: info) {
                            let videoPath = info.videoUrl ?? info.cloud_url ?? videoURL.absoluteString
                            self.vlcManager.log("鈻讹笍 璧癡LC鐩磋繛鍒嗘敮: \(videoPath)")
                            self.isUsingVLC = true
                            self.playerManager.cleanup()
                            // 浼犻€掔綉鐩橀┍鍔ㄧ被鍨嬶紝纭繚VLC浣跨敤姝ｇ‘鐨刄A鍜孯eferer
                            // 浼樺厛 sep-info 鐨?cloud_driver锛屽叾娆￠槦鍒楅」鐨?cloud_driver銆?                            // 澶稿厠CDN鐩撮摼绛惧悕涓嶶A缁戝畾锛屽繀椤讳娇鐢ㄥじ鍏嬪鎴风UA
                            let driver = info.cloud_driver ?? playing.cloud_driver
                            self.vlcManager.play(url: videoURL, cloudDriver: driver)
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
                            print("[ContentView] 缃戠粶MKV鐩磋繛(VLC): \(videoPath)")
                            return
                        }

                        // 闈?MKV锛氬仠姝?VLC锛堥槻姝袱绉嶅０闊冲悓鏃跺瓨鍦級
                        self.vlcManager.log("鈴笍 鏈蛋VLC鍒嗘敮: isNetworkMkv=\(info?.isNetworkMkv ?? false), videoUrl=\(info?.videoUrl ?? "nil")")
                        self.isUsingVLC = false
                        self.vlcManager.stop()

                        // 缃戠粶鍙?FLAC锛欴UAL 娣峰悎鐩磋繛鎾斁锛堝師鍞?浼村敱杩炵画璋冭妭锛?                        if let info = info, info.isNetworkDual,
                           let vocalPath = info.vocalUrl, let accompPath = info.accompUrl,
                           let vURL = self.api.apiURL(vocalPath),
                           let aURL = self.api.apiURL(accompPath) {
                            self.vlcManager.log("鈻讹笍 璧癉UAL鍙孎LAC鍒嗘敮: vocal=\(vocalPath)")
                            self.playerManager.vocalTrackCount = 2
                            self.playerManager.setupNetKtvPlayer(songId: String(sid), vocalURL: vURL, accompURL: aURL)
                            self.playerManager.setVolume(volume)
                            return
                        }

                        // 鏈湴姝屾洸锛氬凡鍦ㄤ笂鏂圭珛鍗?HLS 璧锋挱锛岃繖閲屾鏌ユ槸鍚﹂渶瑕佸崌绾?DUAL锛圓I鍒嗙姝岋級
                        if !playing.isNetworkSong {
                            self.vlcManager.log("鈴笍 璧版湰鍦癏LS/prepareDual鍒嗘敮 (isNetworkSong=false)")
                            self.prepareDualIfNeeded(playing)
                        } else {
                            self.vlcManager.log("鉂?鏃犲尮閰嶆挱鏀惧垎鏀? isNetworkSong=true 浣嗘棦闈濵KV涔熼潪DUAL")
                        }
                    }
                }
            } else {
                // No song playing
                playerManager.cleanup()
            }
            isPlaying = playerManager.isPlaying
            shouldResumePlaying = true
        }
        .focusSection()
    }

    /// 绾煶棰戜笖宸?AI 鍒嗙鐨勬瓕锛欻LS 鍏堣捣鎾紝闅忓悗鍗囩骇涓?DUAL 杩炵画浜哄０闊抽噺锛?    /// 缃戠粶KTV姝屾洸(isNetKtv)鐩存帴鐢ㄧ綉缁淯RL锛屼笉涓嬭浇鍒版湰鍦帮紱鏈湴鍒嗙姝屾洸鍏堜笅杞藉啀婵€娲汇€?    /// MKV/MP4 绛夎棰戞瓕鐩存帴璺宠繃锛屼繚鎸佸師 HLS 澶氭。/澹伴亾鏂规銆?    private func prepareDualIfNeeded(_ playing: QueueItem) {
        guard !playing.isVideoFile else { return }
        let sid = playing.song_id
        api.fetchSepInfo(songId: sid) { info in
            guard let info = info, info.isDual,
                  let vocalPath = info.vocalUrl, let accompPath = info.accompUrl else { return }

            // 缃戠粶KTV姝屾洸锛氱洿鎺ョ敤缃戠粶URL锛屼笉涓嬭浇鍒版湰鍦?            if info.isNetworkDual {
                guard let vURL = self.api.apiURL(vocalPath),
                      let aURL = self.api.apiURL(accompPath) else { return }
                // 蹇垏姝屼繚鎶わ細褰撳墠浠嶅湪鎾斁鍚屼竴棣栨墠鍗囩骇
                guard self.api.queue.first(where: { $0.isPlaying })?.song_id == sid else { return }
                self.playerManager.activateDual(songId: sid, vocalFile: vURL, accompFile: aURL)
                return
            }

            // 鏈湴鍒嗙姝屾洸锛氬厛涓嬭浇鍒版湰鍦板啀婵€娲?            self.api.downloadDualTracks(songId: sid, vocalPath: vocalPath, accompPath: accompPath) { vFile, aFile in
                guard let vFile = vFile, let aFile = aFile else { return }
                // 蹇垏姝屼繚鎶わ細褰撳墠浠嶅湪鎾斁鍚屼竴棣栨墠鍗囩骇锛圥layerManager 鍐呴儴鍙︽湁 generation 鏍￠獙锛?                guard self.api.queue.first(where: { $0.isPlaying })?.song_id == sid else { return }
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
                    FeedbackCenter.shared.show(vlcManager.isPlaying ? "寮€濮嬫挱鏀? : "鏆傚仠鎾斁",
                                           icon: vlcManager.isPlaying ? "play.fill" : "pause.fill")
                } else {
                    playerManager.togglePlayPause()
                    isPlaying = playerManager.isPlaying
                    FeedbackCenter.shared.show(playerManager.isPlaying ? "寮€濮嬫挱鏀? : "鏆傚仠鎾斁",
                                           icon: playerManager.isPlaying ? "play.fill" : "pause.fill")
                }
            case "repeat":
                // 鏀跺埌WebSocket骞挎挱鐨剅epeat娑堟伅锛屽彧鎵ц鏈湴restart锛屼笉鍐嶈皟鐢╝pi.restartSong()
                // 鍚﹀垯浼氬舰鎴愬洖鐜細鍙戦€乺epeat -> 骞挎挱鍥炴潵 -> 鍐嶅彂閫?-> 鏃犻檺寰幆
                if isUsingVLC {
                    vlcManager.restart()
                } else {
                    playerManager.restart()
                }
                FeedbackCenter.shared.show("閲嶆柊婕斿敱", icon: "gobackward")
            case "voice":
                // Server broadcasts control messages back to ALL clients including
                // the sender; ignore our own echo so we don't toggle twice.
                if (payload["clientId"] as? String) != api.clientId {
                    playerManager.toggleVoice()
                }
                FeedbackCenter.shared.show(playerManager.vocalTrackLabel, icon: "mic.fill")
            case "eq":
                if let name = payload["name"] as? String {
                    let labels = ["flat": "鏍囧噯", "vocal": "浜哄０澧炲己", "bass": "浣庨煶澧炲己", "bright": "鏄庝寒娓呮櫚"]
                    FeedbackCenter.shared.show("鍧囪　鍣細\(labels[name] ?? name)", icon: "slider.horizontal.3")
                }
            case "volume":
                // JSON 鏁板瓧缁?JSONSerialization 妗ユ帴涓?NSNumber锛岀洿鎺?as? Float 鍦ㄩ儴鍒嗘儏鍐典笅
                // 浼氬緱鍒?nil锛屽鑷存墜鏈洪仴鎺ч煶閲忔棤鏁堬紱缁熶竴鐢?NSNumber.floatValue 璇诲彇銆?                let delta = (payload["delta"] as? NSNumber)?.floatValue
                    ?? Float(payload["delta"] as? Double ?? 0)
                guard delta != 0 else { return }
                volume = max(0, min(1, volume + delta))
                if isUsingVLC { vlcManager.setVolume(volume) } else { playerManager.setVolume(volume) }
                FeedbackCenter.shared.show("闊抽噺 \(Int(volume * 100))%",
                                           icon: delta > 0 ? "speaker.plus" : "speaker.minus")
            case "next":
                FeedbackCenter.shared.show("鍒囧埌涓嬩竴棣?, icon: "forward.end.fill")
                advancePlayback()
            case "fullscreen":
                if api.queue.contains(where: { $0.isPlaying }) { showingPlayer = true }
            case "home":
                showingPlayer = false
                activePanel = nil
                activePage = nil
            case "bg_next":
                // 閬ユ帶绔垏鎹㈠姩鎬佽儗鏅細寰幆 AudioBgMode 鍐欏叆 UserDefaults锛孎ullPlayerView 鐨?@AppStorage 鑷姩鍝嶅簲
                let curRaw = UserDefaults.standard.string(forKey: "momoBgMode") ?? AudioBgMode.flow.rawValue
                let nextMode = AudioBgMode.from(curRaw).next
                UserDefaults.standard.set(nextMode.rawValue, forKey: "momoBgMode")
                FeedbackCenter.shared.show("鑳屾櫙锛歕(nextMode.display)", icon: "sparkles")
            case "bg_set":
                // 閬ユ帶绔寚瀹氳儗鏅ā寮忕储寮?                if let idx = (payload["index"] as? NSNumber)?.intValue {
                    let all = AudioBgMode.allCases
                    let mode = all[((idx % all.count) + all.count) % all.count]
                    UserDefaults.standard.set(mode.rawValue, forKey: "momoBgMode")
                    FeedbackCenter.shared.show("鑳屾櫙锛歕(mode.display)", icon: "sparkles")
                }
            case "lyrics_mode":
                // 閬ユ帶绔垏鎹㈡瓕璇嶅弻鎺?婊氬姩妯″紡
                let lmRaw = UserDefaults.standard.string(forKey: "momoLyricsMode") ?? "dual"
                UserDefaults.standard.set(lmRaw == "dual" ? "scroll" : "dual", forKey: "momoLyricsMode")
            case "lyrics_offset":
                // 閬ユ帶绔瓕璇嶅揩鎱㈡牎鍑嗭細杞彂缁欐鍦ㄦ樉绀虹殑鍏ㄥ睆鎾斁鍣?                let delta = (payload["delta"] as? NSNumber)?.doubleValue
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
        // AVPlayer 妯″紡鎾斁缁撴潫鍥炶皟
        playerManager.onPlaybackEnd = {
            DispatchQueue.main.async {
                guard let curSong = self.api.queue.first(where: { $0.isPlaying }) else {
                    if self.showingPlayer { self.showingPlayer = false }
                    return
                }
                // Prevent duplicate next calls for the same song
                if self.lastAutoNextQueueId == curSong.id { return }
                self.lastAutoNextQueueId = curSong.id
                // 闃熷垪閲岃繕鏈夊凡鐐瑰氨鎾笅涓€棣栵紱宸茬偣鎾畬鍒欒嚜鍔ㄤ粠鏇插簱闅忔満閫変竴棣栫画鎾紝
                // 涓嶅啀鐩存帴鍋滀綇 / 閫€鍑哄叏灞忥紙淇"宸茬偣姝屾洸鎾畬鍚庢棤娉曡嚜鍔ㄩ殢鏈烘挱鏀?锛?                self.advancePlayback()
            }
        }
        // VLC 妯″紡鎾斁缁撴潫鍥炶皟锛堢綉缁?MKV 瑙嗛璧?VLC锛屼箣鍓嶆挱瀹屼笉瑙﹀彂鑷姩鍒囨瓕锛?        vlcManager.onPlaybackEnd = {
            DispatchQueue.main.async {
                guard let curSong = self.api.queue.first(where: { $0.isPlaying }) else {
                    if self.showingPlayer { self.showingPlayer = false }
                    return
                }
                if self.lastAutoNextQueueId == curSong.id { return }
                self.lastAutoNextQueueId = curSong.id
                self.advancePlayback()
            }
        }
    }

    /// 缁熶竴鎺ㄨ繘鎾斁锛氶槦鍒楅噷鏈夊緟鎾凡鐐?鈫?鍒囦笅涓€棣栵紱宸茬偣闃熷垪娓呯┖ 鈫?鑷姩闅忔満鎸戜竴棣栫画鎾€?    /// 鎵嬪姩鍒囨瓕銆侀仴鎺у垏姝屻€佽嚜鐒舵挱瀹屼笁澶勯兘璧拌繖閲岋紝淇濊瘉琛屼负涓€鑷淬€?    /// 缁熶竴鎺ㄨ繘鎾斁锛氶槦鍒楅噷鏈夊緟鎾凡鐐?鈫?鍒囦笅涓€棣栵紱宸茬偣闃熷垪娓呯┖ 鈫?鑷姩闅忔満鎸戜竴棣栫画鎾€?    /// 鎵嬪姩鍒囨瓕銆侀仴鎺у垏姝屻€佽嚜鐒舵挱瀹屼笁澶勯兘璧拌繖閲岋紝淇濊瘉琛屼负涓€鑷淬€?    private func advancePlayback() {
        // 1) 杩樻湁绛夊緟涓殑宸茬偣姝屾洸锛岀洿鎺ュ垏涓嬩竴棣?        if api.queue.contains(where: { !$0.isPlaying }) {
            api.nextSong()
            return
        }
        // 2) 宸茬偣闃熷垪宸茬┖锛氫粠鏇插簱闅忔満鎸戜竴棣栵紙鎺掗櫎鏈€杩戞挱鏀捐繃鐨勶紝閬垮厤杩炵画閲嶅锛?        let currentId = api.queue.first(where: { $0.isPlaying })?.song_id
        func pick(from list: [Song]) {
            // 鎺掗櫎褰撳墠姝屾洸鍜屾渶杩戦殢鏈烘挱鏀捐繃鐨勬瓕鏇诧紙鏈€澶氫繚鐣?0棣栧巻鍙诧級
            var pool = list.filter { $0.id != currentId && !self.recentRandomSongIds.contains($0.id) }
            // 濡傛灉鎺掗櫎鍚庝负绌猴紙鏇插簱澶皬锛夛紝閫€鍖栦负鍙帓闄ゅ綋鍓嶆瓕鏇?            if pool.isEmpty { pool = list.filter { $0.id != currentId } }
            // 濡傛灉杩樻槸涓虹┖锛堝彧鏈変竴棣栨瓕锛夛紝鐢ㄥ叏閮ㄥ垪琛?            let finalPool = pool.isEmpty ? list : pool
            guard let song = finalPool.randomElement() else {
                // 鏇插簱纭疄涓虹┖銆佹棤姝屽彲缁挱鏃舵墠閫€鍑哄叏灞?                if self.showingPlayer { self.showingPlayer = false }
                return
            }
            // 璁板綍鍒版渶杩戞挱鏀惧巻鍙?            self.recentRandomSongIds.insert(song.id)
            if self.recentRandomSongIds.count > 20 {
                self.recentRandomSongIds.removeFirst()
            }
            // 鍏堟妸闅忔満姝屼互 waiting 鍏ラ槦锛屽欢杩熶竴鐐瑰啀鍒囨瓕锛岀‘淇濋槦鍒楀凡鏇存柊锛堥伩鍏嶅崱椤?鏃犳瓕鏇诧級
            self.api.addToQueue(songId: song.id) { ok in
                if ok {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        self.api.nextSong()
                    }
                } else {
                    // 鍏ラ槦澶辫触锛屼粠鍘嗗彶涓Щ闄ゅ苟閲嶈瘯涓€娆?                    self.recentRandomSongIds.remove(song.id)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        self.advancePlayback()
                    }
                }
            }
        }
        if api.songs.isEmpty {
            // 鏇插簱灏氭湭鍔犺浇鍒板唴瀛橈紝鍏堟媺鍙栧啀闅忔満鎸戦€?            api.fetchSongs { pick(from: self.api.songs) }
        } else {
            pick(from: self.api.songs)
        }
    }

    /// 鐢ㄥ綋鍓?serverAddress 寤虹珛杩炴帴骞惰繘鍏ヤ富鐣岄潰锛?鐩存帴杩炴帴"涓?杈撳叆鏂板湴鍧€鍚庤繛鎺?鍏辩敤锛夈€?    private func connectCurrent() {
        guard !serverAddress.isEmpty else { showSetupInput = true; return }
        // updateBaseURL 鍐呴儴浼氭柇寮€鏃?WebSocket銆佺敤鐩爣鍦板潃閲嶈繛骞?fetchAll 鎷夊彇鍏ㄩ儴鏁版嵁
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
    /// controllers 鈥?mobile remote then interpolates for its progress bar.
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
            MVButton(icon: "slider.horizontal.3", title: "鍧囪　鍣?) { activePanel = .eq }
            MVButton(icon: "mic", title: isUsingVLC ? vlcManager.voiceLabel : playerManager.vocalTrackLabel) {
                if isUsingVLC {
                    // VLC妯″紡锛氫娇鐢╒LC闊宠建鍒囨崲
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
            MVButton(icon: "speaker.minus", title: "闊抽噺-") {
                volume = max(0, volume - 0.1)
                if isUsingVLC { vlcManager.setVolume(volume) } else { playerManager.setVolume(volume) }
                showToast("闊抽噺: \(Int(volume * 100))%")
            }
            MVButton(icon: (isUsingVLC ? vlcManager.isPlaying : playerManager.isPlaying) ? "pause.fill" : "play.fill",
                    title: (isUsingVLC ? vlcManager.isPlaying : playerManager.isPlaying) ? "鏆傚仠" : "鎾斁", isCenter: true) {
                if isUsingVLC {
                    vlcManager.togglePlayPause()
                    isPlaying = vlcManager.isPlaying
                    FeedbackCenter.shared.show(vlcManager.isPlaying ? "寮€濮嬫挱鏀? : "鏆傚仠鎾斁",
                                           icon: vlcManager.isPlaying ? "play.fill" : "pause.fill")
                } else {
                    playerManager.togglePlayPause()
                    isPlaying = playerManager.isPlaying
                    FeedbackCenter.shared.show(playerManager.isPlaying ? "寮€濮嬫挱鏀? : "鏆傚仠鎾斁",
                                           icon: playerManager.isPlaying ? "play.fill" : "pause.fill")
                }
                // Sync playback state to server so mobile remote play/pause
                // button icon stays in sync with the TV.
                api.sendPlaybackState(paused: !(isUsingVLC ? vlcManager.isPlaying : playerManager.isPlaying),
                    voice: isUsingVLC ? vlcManager.voiceLabel : playerManager.voiceStateString)
            }
            MVButton(icon: "speaker.plus", title: "闊抽噺+") {
                volume = min(1, volume + 0.1)
                if isUsingVLC { vlcManager.setVolume(volume) } else { playerManager.setVolume(volume) }
                showToast("闊抽噺: \(Int(volume * 100))%")
            }
            MVButton(icon: "forward.end.fill", title: "鍒囨瓕") { FeedbackCenter.shared.show("鍒囧埌涓嬩竴棣?, icon: "forward.end.fill"); advancePlayback() }
            MVButton(icon: "gobackward", title: "閲嶅敱") {
                if isUsingVLC {
                    vlcManager.restart()
                } else {
                    playerManager.restart()
                }
                api.restartSong()
                FeedbackCenter.shared.show("閲嶆柊婕斿敱", icon: "gobackward")
            }
            MVButton(icon: "ladybug", title: "璋冭瘯") {
                showDebugLog.toggle()
                FeedbackCenter.shared.show(showDebugLog ? "璋冭瘯鏃ュ織宸插紑鍚? : "璋冭瘯鏃ュ織宸插叧闂?, icon: "ladybug")
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
            bigRequestButton(title: "姝屽悕鐐规瓕", icon: "music.note.list", gradient: LinearGradient(colors: [Color(hex: 0xff4f9b), Color(hex: 0xff6b6b)], startPoint: .leading, endPoint: .trailing)) { activePage = .order }
            bigRequestButton(title: "姝屾墜鐐规瓕", icon: "mic.fill", gradient: LinearGradient(colors: [Color(hex: 0x8e44f7), Color(hex: 0xc736f7)], startPoint: .leading, endPoint: .trailing)) { activePage = .artists }
            bigRequestButton(title: "鍒嗙被鐐规瓕", icon: "square.grid.2x2.fill", gradient: LinearGradient(colors: [Color(hex: 0xff8c42), Color(hex: 0xffb347)], startPoint: .leading, endPoint: .trailing)) { activePage = .category }
            bigRequestButton(title: "鎵爜鐐规瓕", icon: "qrcode", gradient: LinearGradient(colors: [Color(hex: 0x1a7bff), Color(hex: 0x36d9f7)], startPoint: .leading, endPoint: .trailing)) { showQR.toggle() }
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
                        if item.isNetworkSong && !item.cloudDiskLabel.isEmpty {
                            Label(item.cloudDiskLabel, systemImage: item.cloudDiskIcon)
                                .font(.system(size: 12, weight: .medium))
                                .padding(.horizontal, 5).padding(.vertical, 0)
                                .background(Color(hex: 0x6a1b9a).opacity(0.25))
                                .foregroundColor(Color(hex: 0xba68c8))
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
                Text("鈾?宸茬偣闃熷垪")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundColor(WebColors.ac2)
                Spacer()
                Text("\(api.queue.count)棣?)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundColor(WebColors.sub)
            }

            if api.queue.isEmpty {
                Spacer()
                Text("鏆傛棤鐐规瓕")
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
                        onAdd: { song in api.addToQueue(songId: song.id); showToast("宸茬偣: \(song.displayTitle)") })
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
                          onAdd: { song in api.addToQueue(songId: song.id); showToast("宸茬偣: \(song.displayTitle)") })
        case .artists:
            ArtistsPage(api: api, onBack: { activePage = nil }, onArtistSelect: { artist in
                selectedArtist = artist
                activePage = .artistSongs
            })
        case .artistSongs:
            ArtistSongsPage(api: api, artist: selectedArtist, onBack: { activePage = .artists },
                            onAdd: { song in api.addToQueue(songId: song.id); showToast("宸茬偣: \(song.displayTitle)") })
        case .charts:
            ChartsPage(api: api, onBack: { activePage = nil },
                       onAdd: { song in api.addToQueue(songId: song.id); showToast("宸茬偣: \(song.displayTitle)") })
        case .favorites:
            FavoritesPage(api: api, onBack: { activePage = nil },
                          onAdd: { song in api.addToQueue(songId: song.id); showToast("宸茬偣: \(song.displayTitle)") })
        case .history:
            HistoryPage(api: api, onBack: { activePage = nil },
                        onAdd: { song in api.addToQueue(songId: song.id); showToast("宸茬偣: \(song.displayTitle)") })
        case .newest:
            NewestPage(api: api, onBack: { activePage = nil },
                       onAdd: { song in api.addToQueue(songId: song.id); showToast("宸茬偣: \(song.displayTitle)") })
        case .category:
            CategoryPage(api: api, onBack: { activePage = nil },
                         onAdd: { song in api.addToQueue(songId: song.id); showToast("宸茬偣: \(song.displayTitle)") })
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
        f.dateFormat = "M鏈坉鏃?EEE"
        f.locale = Locale(identifier: "zh_CN")
        return f.string(from: Date())
    }

    // MARK: - Toast锛堢粺涓€璧板叏灞€澶у睆鍙嶉涓績锛?    private func showToast(_ msg: String) {
        FeedbackCenter.shared.show(msg)
    }
}

// MARK: - Order Songs Page (姝屽悕鐐规瓕 - left list + right alphabet panel)
struct OrderSongsPage: View {
    let api: KTVAPIClient
    let onBack: () -> Void
    let onAdd: (Song) -> Void
    @State private var currentPage = 0
    @State private var inputText = "" // Pinyin initials (ABC) or digits (123)
    @State private var keyboardMode: KeyboardMode = .abc
    @State private var songPinyin: [Int: String] = [:] // Precomputed pinyin initials
    @State private var isCacheReady = false
    @State private var filteredSongs: [Song] = []   // 杩囨护缁撴灉锛園State閬垮厤姣忔UI娓叉煋閲嶆柊杩囨护锛?    @State private var searchDebounceTimer: Timer?   // 杈撳叆闃叉姈
    @State private var lastFilterQuery = ""           // 澧為噺杩囨护锛氫笂娆℃煡璇?    @State private var lastFilterIndices: [Int] = []  // 澧為噺杩囨护锛氫笂娆＄粨鏋滅储寮?    private let pageSize = 32
    private enum KeyboardMode { case abc, num }
    // 姝屽悕閿洏 ABC 妯″紡锛? 琛岋紝鏈€鍚庝竴琛?Z 璺?2 鍒椼€丏EL 璺?3 鍒楋紝濉弧鏁磋
    private let abcRows: [[(String, Int)]] = [
        [("A",1),("B",1),("C",1),("D",1),("E",1)],
        [("F",1),("G",1),("H",1),("I",1),("J",1)],
        [("K",1),("L",1),("M",1),("N",1),("O",1)],
        [("P",1),("Q",1),("R",1),("S",1),("T",1)],
        [("U",1),("V",1),("W",1),("X",1),("Y",1)],
        [("Z",2),("DEL",3)]
    ]
    // 姝屽悕閿洏鏁板瓧妯″紡锛? 琛岋紝DEL 璺?5 鍒楀～婊℃暣琛?    private let numRows: [[(String, Int)]] = [
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
                // 缂撳瓨灏辩华鍚庨噸鏂拌繃婊わ紙濡傛灉褰撳墠鏈夎緭鍏ワ級
                if !self.inputText.isEmpty {
                    self.lastFilterQuery = ""
                    self.applyFilter()
                }
            }
        }
    }

    /// 闃叉姈杩囨护锛氳緭鍏ュ仠姝?00ms鍚庡悗鍙扮嚎绋嬭繃婊?    private func debounceFilter() {
        searchDebounceTimer?.invalidate()
        searchDebounceTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: false) { _ in
            self.currentPage = 0
            self.applyFilter()
        }
    }

    /// 鍚庡彴绾跨▼杩囨护+澧為噺杩囨护锛圓BC妯″紡鏂板瓧姣嶅湪涓婃缁撴灉涓婄户缁繃婊わ級
    private func applyFilter() {
        let q = inputText
        let songs = api.songs
        let pinyin = songPinyin
        let cacheReady = isCacheReady
        let mode = keyboardMode

        // 澧為噺杩囨护锛欰BC妯″紡涓嬶紝鏂皅uery鏄棫query鐨勫墠缂€鎵╁睍鏃讹紝鍦ㄤ笂娆＄粨鏋滅储寮曞熀纭€涓婅繃婊?        let sourceIndices: [Int]
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
                    Text("绔嬪嵆鐐规瓕")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundColor(.white)
                }
                Spacer()
                TVTightButton(action: onBack) { focused in
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.left")
                        Text("杩斿洖")
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
                        Text(inputText.isEmpty ? "姝屽悕鎼滅储" : inputText)
                            .font(.system(size: 22, weight: .bold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Spacer()
                        // 鍗曟寜閽垏鎹細ABC 妯″紡鏄剧ず"123"锛?23 妯″紡鏄剧ず"ABC"
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

                    // Keyboard: 鎸夐敭鏀惧ぇ濉弧鍙充晶闈㈡澘锛圴Stack 绛夐珮琛?+ GeometryReader 绮剧‘璺ㄥ垪锛?                    VStack(spacing: 8) {
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

                        // Clear button锛堝浐瀹氬湪閿洏搴曢儴锛岄敭鐩樿骞冲垎鍓╀綑绌洪棿锛?                        TightClearButton(isEmpty: inputText.isEmpty) {
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
                        Text("涓婁竴椤?)
                    }
                    .font(.system(size: 20, weight: .medium))
                    .padding(.horizontal, 22).padding(.vertical, 10)
                    .foregroundColor(currentPage > 0 ? (focused ? Color(hex: 0x1a1a2e) : .white) : WebColors.sub)
                    .background(currentPage > 0 ? (focused ? Color.white : Color.white.opacity(0.12)) : Color.clear)
                    .cornerRadius(999)
                }
                .disabled(currentPage == 0)

                Text("绗?\(currentPage + 1)/\(totalPages) (鍏盶(filteredSongs.count)棣?")
                    .font(.system(size: 20))
                    .foregroundColor(.white)

                TVTightButton(action: { if currentPage + 1 < totalPages { currentPage += 1 } }) { focused in
                    HStack(spacing: 6) {
                        Text("涓嬩竴椤?)
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
            // 閲嶇疆鎼滅储鐘舵€侊細娓呯┖涓婃鎼滅储鍏抽敭璇嶅拰澧為噺杩囨护缂撳瓨锛岀‘淇濇瘡娆¤繘鍏ラ兘鏄叏鏂版悳绱?            inputText = ""
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
            // 鏁磋澶ф寜閽細鏁板瓧 + 姝屽悕/姝屾墜 + 鐐规瓕锛岀劍鐐瑰尯鍩熷ぇ锛岄仴鎺у櫒鏄撻€変腑
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
                                if song.isNetworkSong && !song.cloudDiskLabel.isEmpty {
                                    Label(song.cloudDiskLabel, systemImage: song.cloudDiskIcon)
                                        .font(.system(size: 13, weight: .medium))
                                        .padding(.horizontal, 6).padding(.vertical, 1)
                                        .background(Color(hex: 0x6a1b9a).opacity(0.25))
                                        .foregroundColor(Color(hex: 0xba68c8))
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

                    Text("鐐规瓕")
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

// 姝岃瘝蹇參鏍″噯閫氱煡锛氶仴鎺х -> 鍏ㄥ睆鎾斁鍣?extension Notification.Name {
    static let momoLyricsOffset = Notification.Name("momoLyricsOffset")
}

// MARK: - VLC璋冭瘯鏃ュ織瑕嗙洊灞?struct DebugLogOverlay: View {
    let log: String
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("VLC璋冭瘯鏃ュ織 v2026.09.13-sync-lib-fix5 (闀挎寜闃熷垪鎸夐挳鍏抽棴)")
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
