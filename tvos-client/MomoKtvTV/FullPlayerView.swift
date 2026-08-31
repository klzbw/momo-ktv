import SwiftUI
import AVFoundation

/// Fullscreen player using the shared PlayerManager.
struct FullPlayerView: View {
    let song: QueueItem
    let onNext: () -> Void
    let onClose: () -> Void
    @ObservedObject var api: KTVAPIClient
    @ObservedObject private var playerManager = PlayerManager.shared

    @State private var showControls = true
    @State private var voiceMode: VoiceMode = .original
    @State private var hideTimer: Timer?
    @State private var hasAutoExited = false
    @State private var showQueue = false
    @State private var showQR = false
    @FocusState private var tapAreaFocused: Bool  // 控制条隐藏后，透明点击区自动获得遥控器焦点，确保按确认键能呼出控制条
    @ObservedObject private var mic = MicLink.shared
    @State private var qrTab: QRTab = .order
    @StateObject private var lyricsLoader = LyricsLoader()
    @AppStorage("micPublicHost") private var micPublicHost: String = "mktv.klzbw.top"
    @AppStorage("momoLyricsMode") private var lyricsModeRaw: String = LyricsDisplayMode.dual.rawValue
    @AppStorage("momoBgMode") private var bgModeRaw: String = AudioBgMode.flow.rawValue

    enum VoiceMode {
        case original, half, accompaniment
        var label: String {
            switch self {
            case .original: return "原唱"
            case .half: return "半消"
            case .accompaniment: return "伴唱"
            }
        }
        static func from(_ index: Int) -> VoiceMode {
            index == 0 ? .original : (index == 1 ? .half : .accompaniment)
        }
    }

    enum QRTab { case order, micMode }

    /// 当前真正在播放的队列项（切歌后以队列状态为准，兜底用传入的 song）
    private var currentItem: QueueItem { api.queue.first(where: { $0.isPlaying }) ?? song }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            SharedVideoView(playerManager: playerManager)
                .ignoresSafeArea()
                .id("fullscreen-video")
                .onAppear { setup() }
                .onDisappear { cleanup() }
                .onChange(of: api.queue.first(where: { $0.isPlaying })?.id) { _ in
                    // Song changed, re-attach layer to ensure video shows
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        playerManager.attachLayerToCurrentHost()
                    }
                    if let playing = api.queue.first(where: { $0.isPlaying }) {
                        if playing.isVideoFile { lyricsLoader.lyrics = .empty } // 视频歌不显示歌词
                        else { lyricsLoader.load(server: api.serverAddress, songId: playing.song_id) }
                    }
                }
                .onChange(of: showControls) { shown in
                    // 控制条隐藏后，延迟把遥控器焦点交给透明点击区，确保按确认键能呼出控制条（图片背景时尤其关键）
                    if !shown && !showQueue && !showQR {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { tapAreaFocused = true }
                    }
                }

            // 纯音频歌曲的动态背景（13 种程序化效果 + 我的图片，随律动变化）；
            // 盖在服务端渐变视频轨之上、歌词层之下，视频歌(MKV/MP4)不显示。
            if !currentItem.isVideoFile {
                AudioBackgroundView(server: api.serverAddress)
                    .allowsHitTesting(false)  // 背景层（含我的图片）绝不拦截遥控器焦点/点击，避免控件呼不出
            }

            // 逐字歌词层：居中滚动、当前行逐字填色；不抢遥控器焦点，控制层在其之上。
            // 视频歌(MKV/MP4 等)自带画面与内嵌字幕，不再叠加 App 歌词。
            if !currentItem.isVideoFile {
                LyricsView(lyrics: lyricsLoader.lyrics, currentTime: playerManager.currentTime)
                    .allowsHitTesting(false)
                    .opacity(showControls ? 0.35 : 1.0) // 控制条弹出时歌词弱化，避免与底部信息打架
                    .animation(.easeOut(duration: 0.25), value: showControls)
            }

            if showControls && !showQueue && !showQR {
                VStack {
                    Spacer()
                    VStack(spacing: 14) {
                        // Progress bar
                        VStack(spacing: 6) {
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(Color.white.opacity(0.2))
                                        .frame(height: 4)
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(LinearGradient(colors: [WebColors.ac, WebColors.ac2],
                                                             startPoint: .leading, endPoint: .trailing))
                                        .frame(width: playerManager.duration > 0 ? geo.size.width * CGFloat(playerManager.currentTime / playerManager.duration) : 0, height: 4)
                                }
                            }
                            .frame(height: 4)

                            HStack {
                                Text(formatTime(playerManager.currentTime))
                                    .font(.system(size: 13))
                                    .foregroundColor(Color.white.opacity(0.7))
                                Spacer()
                                Text(formatTime(playerManager.duration))
                                    .font(.system(size: 13))
                                    .foregroundColor(Color.white.opacity(0.7))
                            }
                        }

                        // 7 control buttons - standard tvOS focusable buttons
                        HStack(spacing: 20) {
                            TVTightButton(action: { FeedbackCenter.shared.show("返回主页", icon: "house.fill"); onClose() }) { focused in
                                controlContent(icon: "house", title: "主页", focused: focused)
                            }

                            TVTightButton(action: { playerManager.restart(); api.restartSong(); FeedbackCenter.shared.show("重新演唱", icon: "gobackward") }) { focused in
                                controlContent(icon: "gobackward", title: "重唱", focused: focused)
                            }

                            TVTightButton(action: {
                                playerManager.togglePlayPause()
                                FeedbackCenter.shared.show(playerManager.isPlaying ? "开始播放" : "暂停播放",
                                                          icon: playerManager.isPlaying ? "play.fill" : "pause.fill")
                            }, autoFocus: true) { focused in
                                controlContent(
                                    icon: playerManager.isPlaying ? "pause.fill" : "play.fill",
                                    title: playerManager.isPlaying ? "暂停" : "播放",
                                    focused: focused
                                )
                            }

                            TVTightButton(action: { toggleVoice() }) { focused in
                                controlContent(icon: "mic.fill", title: playerManager.vocalTrackLabel, focused: focused)
                            }

                            TVTightButton(action: { FeedbackCenter.shared.show("切到下一首", icon: "forward.end.fill"); onNext() }) { focused in
                                controlContent(icon: "forward.end.fill", title: "切歌", focused: focused)
                            }

                            TVTightButton(action: { showQueue = true }) { focused in
                                controlContent(icon: "list.bullet", title: "队列", focused: focused)
                            }

                            TVTightButton(action: { showQR = true }) { focused in
                                controlContent(icon: "qrcode", title: "扫码", focused: focused)
                            }

                            // 歌词显示模式：双排 / 上下滚动 循环切换（纯音频歌才显示）
                            if !currentItem.isVideoFile {
                                TVTightButton(action: {
                                    lyricsModeRaw = LyricsDisplayMode.from(lyricsModeRaw).next.rawValue
                                    FeedbackCenter.shared.show("歌词：\(LyricsDisplayMode.from(lyricsModeRaw).label)模式",
                                                              icon: "text.alignleft")
                                }) { focused in
                                    controlContent(icon: "text.alignleft",
                                                   title: "歌词·\(LyricsDisplayMode.from(lyricsModeRaw).label)",
                                                   focused: focused)
                                }
                            }

                            // 动态背景切换（仅纯音频歌）：13 种程序化效果 + 我的图片循环
                            if !currentItem.isVideoFile {
                                TVTightButton(action: {
                                    bgModeRaw = AudioBgMode.from(bgModeRaw).next.rawValue
                                    FeedbackCenter.shared.show("背景：\(AudioBgMode.from(bgModeRaw).display)",
                                                              icon: "sparkles")
                                }) { focused in
                                    controlContent(icon: "sparkles",
                                                   title: "背景·\(AudioBgMode.from(bgModeRaw).display)",
                                                   focused: focused)
                                }
                            }
                        }
                        .padding(.horizontal, 10)

                        // 人声大小档位条：仅 AI 分离出多档(>=3)的歌曲出现。左=纯伴奏，右=原唱，
                        // 聚焦后用遥控器左右键逐档调节（tvOS 无原生 Slider，用 TVSegmentSlider），
                        // 与上方麦克风按钮共享同一状态并大屏反馈。
                        if playerManager.vocalTrackCount >= 3 {
                            HStack(spacing: 16) {
                                Text("伴奏")
                                    .font(.system(size: 20, weight: .semibold))
                                    .foregroundColor(.white.opacity(0.75))
                                TVSegmentSlider(
                                    segments: playerManager.vocalTrackCount,
                                    selected: Binding(
                                        get: { max(0, playerManager.vocalTrackCount - 1 - playerManager.vocalTrackIndex) },
                                        set: { disp in
                                            playerManager.selectVocalTrack(playerManager.vocalTrackCount - 1 - disp)
                                            FeedbackCenter.shared.show(playerManager.vocalTrackLabel, icon: "mic.fill")
                                        }),
                                    onCommit: { _ in }
                                )
                                .frame(width: 300)
                                Text("原唱 · 人声\(playerManager.vocalVolumePercent)%")
                                    .font(.system(size: 20, weight: .bold))
                                    .foregroundColor(.white)
                            }
                            .padding(.top, 10)
                            .padding(.horizontal, 40)
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                    .padding(.top, 16)
                    .background(LinearGradient(colors: [.clear, Color.black.opacity(0.9)],
                                               startPoint: .top, endPoint: .bottom))
                }
                .transition(.opacity)
            }

            // Transparent focusable area to receive select button when controls are hidden
            if !showControls && !showQueue && !showQR {
                Color.black.opacity(0.001)
                    .contentShape(Rectangle())
                    .focusable(true)
                    .focusEffectDisabled()
                    .focused($tapAreaFocused)
                    .onTapGesture {
                        withAnimation(.easeOut(duration: 0.2)) {
                            showControls = true
                        }
                        resetHideTimer()
                    }
                    .ignoresSafeArea()
            }

            // Queue panel overlay
            if showQueue {
                queuePanel
                    .transition(.move(edge: .trailing))
                    .zIndex(2)
            }

            // QR code overlay
            if showQR {
                qrPanel
                    .transition(.opacity)
                    .zIndex(3)
            }

            // 顶部滚动横条：跟随底部7个控件一起显隐(showControls)，打开队列/扫码面板时也隐藏
            VStack {
                if showControls && !showQueue && !showQR { TVTickerBar(text: tickerText) }
                Spacer()
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .zIndex(5)

            // 大屏控件操作反馈
            TVFeedbackOverlay().zIndex(20)
            // 氛围 emoji 刷屏 + 祝福弹幕（最顶层，不挡操作）
            AtmosphereOverlay().zIndex(21)
        }
        .onPlayPauseCommand {
            playerManager.togglePlayPause()
            FeedbackCenter.shared.show(playerManager.isPlaying ? "开始播放" : "暂停播放",
                                      icon: playerManager.isPlaying ? "play.fill" : "pause.fill")
            showControls = true
            resetHideTimer()
        }
        .onExitCommand {
            if showQR {
                showQR = false
            } else if showQueue {
                showQueue = false
            } else if showControls {
                showControls = false
            } else {
                onClose()
            }
        }
    }

    // MARK: - 顶部滚动横条文案（对齐网页 buildNextUpMessages）
    private var tickerText: String {
        var parts: [String] = []
        parts.append("♪ 正在播放：《\(song.displayTitle)》 \(song.displayArtist)")
        let waiting = api.queue.filter { !$0.isPlaying }
        if let next = waiting.first {
            parts.append("🎵 下一首：《\(next.displayTitle)》 \(next.displayArtist)")
        }
        if waiting.count < 3 { parts.append("🎤 待播曲目不多啦，继续点歌吧～") }
        parts.append("📋 队列里还有 \(waiting.count) 首歌")
        parts.append("🎤 墨墨爱K歌——歌声有约，快乐无限")
        return parts.joined(separator: "        ")
    }

    private func controlContent(icon: String, title: String, focused: Bool) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 30, weight: .medium))
                .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
        }
        .frame(width: 95, height: 95)
        .background(focused ? Color.white : Color.white.opacity(0.15))
        .cornerRadius(16)
    }

    private func setup() {
        showControls = true
        resetHideTimer()
        hasAutoExited = false
        voiceMode = VoiceMode.from(playerManager.vocalTrackIndex)
        // 拉取歌词（优先 AI 逐字增强 LRC，没有则普通 LRC）；视频歌自带字幕不拉取
        if song.isVideoFile { lyricsLoader.lyrics = .empty }
        else { lyricsLoader.load(server: api.serverAddress, songId: song.song_id) }
        // 切歌/全屏视图重建时，若麦克风模式仍开着则保持连接不断
        mic.keepAlive(api.serverAddress)
    }

    // MARK: - Queue Panel
    private var queuePanel: some View {
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea()
                .focusable(false)
                .onTapGesture { showQueue = false }
            HStack {
                Spacer()
                VStack(spacing: 0) {
                    HStack {
                        Text("♪ 已点队列")
                            .font(.system(size: 30, weight: .bold))
                            .foregroundColor(WebColors.ac2)
                        Text("\(api.queue.count)首")
                            .font(.system(size: 20, weight: .medium))
                            .foregroundColor(WebColors.sub)
                            .padding(.leading, 10)
                        Spacer()
                        TVTightButton(action: { showQueue = false }) { focused in
                            Image(systemName: "xmark")
                                .font(.system(size: 24, weight: .bold))
                                .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                                .frame(width: 56, height: 56)
                                .background(focused ? Color.white : Color.white.opacity(0.1))
                                .clipShape(Circle())
                        }
                    }
                    .padding(.horizontal, 20).padding(.vertical, 16)
                    .background(WebColors.topbarBg)

                    ScrollView {
                        VStack(spacing: 6) {
                            ForEach(Array(api.queue.enumerated()), id: \.element.id) { idx, item in
                                HStack(spacing: 14) {
                                    if item.isPlaying {
                                        Image(systemName: "play.circle.fill")
                                            .foregroundColor(WebColors.ac2)
                                            .font(.system(size: 30))
                                    } else {
                                        Text("\(idx + 1)")
                                            .font(.system(size: 24, weight: .bold))
                                            .foregroundColor(WebColors.sub)
                                            .frame(width: 40)
                                    }
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(item.displayTitle)
                                            .font(.system(size: 28, weight: .bold))
                                            .foregroundColor(.white)
                                            .lineLimit(nil)
                                            .fixedSize(horizontal: false, vertical: true)
                                        Text(item.displayArtist)
                                            .font(.system(size: 20, weight: .medium))
                                            .foregroundColor(WebColors.sub)
                                            .lineLimit(nil)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    Spacer()
                                    if !item.isPlaying {
                                        TVTightButton(action: { api.topSong(queueId: item.queue_id) }) { focused in
                                            Image(systemName: "arrow.up.to.line")
                                                .font(.system(size: 26))
                                                .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.ac2)
                                                .frame(width: 56, height: 56)
                                                .background(focused ? Color.white : Color.clear)
                                                .cornerRadius(8)
                                        }
                                        TVTightButton(action: { api.removeFromQueue(queueId: item.queue_id) }) { focused in
                                            Image(systemName: "trash")
                                                .font(.system(size: 26))
                                                .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.pink)
                                                .frame(width: 56, height: 56)
                                                .background(focused ? Color.white : Color.clear)
                                                .cornerRadius(8)
                                        }
                                    }
                                }
                                .padding(.horizontal, 20).padding(.vertical, 18)
                                .background(item.isPlaying ? WebColors.ac.opacity(0.15) : Color.clear)
                                .cornerRadius(12)
                            }
                        }
                        .padding(.vertical, 10)
                    }
                }
                .frame(width: 680)
                .background(WebColors.panelBg)
                .cornerRadius(20, corners: [.topLeft, .bottomLeft])
                .focusSection()
            }
            .ignoresSafeArea()
        }
    }

    // MARK: - QR Panel（点歌码 / 手机麦克风码 两个页签）
    private var qrPanel: some View {
        ZStack {
            Color.black.opacity(0.7).ignoresSafeArea()
                .focusable(false)
                .onTapGesture { showQR = false }
            VStack(spacing: 14) {
                // 顶部页签切换
                HStack(spacing: 12) {
                    qrTabButton(tab: .order, icon: "music.note", title: "扫码点歌")
                    qrTabButton(tab: .micMode, icon: "mic.fill", title: "手机麦克风")
                }

                if qrTab == .order {
                    Text("扫码点歌")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundColor(.white)
                    if let qrImage = generateQRCode(from: "http://\(api.serverAddress)/m") {
                        qrImageBox(qrImage, size: 220)
                    }
                    Text("手机扫码即可点歌")
                        .font(.system(size: 16))
                        .foregroundColor(WebColors.sub)
                    TVTightButton(action: { showQR = false }, autoFocus: true) { focused in
                        qrCloseLabel(focused)
                    }
                } else {
                    micPanelContent
                }
            }
            .padding(26)
            .frame(width: 580)
            .background(WebColors.panelBg)
            .cornerRadius(20)
            .focusSection()
        }
    }

    // MARK: 手机麦克风面板
    private var micPanelContent: some View {
        VStack(spacing: 12) {
            Text("手机麦克风")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(.white)
            if let qrImage = generateQRCode(from: "https://\(micPublicHost)/mic") {
                qrImageBox(qrImage, size: 208)
            }
            Text("手机扫码当无线麦克风 · \(micPublicHost)")
                .font(.system(size: 14))
                .foregroundColor(WebColors.sub)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            // 连接状态
            HStack(spacing: 8) {
                Circle()
                    .fill(mic.phoneCount > 0 ? Color.green :
                          (mic.socketConnected && mic.isOn ? Color.orange : Color.gray))
                    .frame(width: 10, height: 10)
                Text(micStatusText)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
            }

            // 电视端总开关
            TVTightButton(action: { mic.toggle(api.serverAddress) }, autoFocus: true) { focused in
                Text(mic.isOn ? "■ 关闭麦克风（电视端）" : "▶ 开启麦克风（电视端）")
                    .font(.system(size: 18, weight: .heavy))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(focused ? Color.white :
                                (mic.isOn ? WebColors.ac : Color.white.opacity(0.12)))
                    .cornerRadius(12)
            }

            // 人声音量加减
            HStack(spacing: 14) {
                TVTightButton(action: { mic.nudgeGain(-0.2) }) { focused in
                    Image(systemName: "minus")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                        .frame(width: 52, height: 40)
                        .background(focused ? Color.white : Color.white.opacity(0.12))
                        .cornerRadius(10)
                }
                Text("人声音量 \(Int(mic.gain * 100))%")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                    .frame(width: 170)
                TVTightButton(action: { mic.nudgeGain(0.2) }) { focused in
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                        .frame(width: 52, height: 40)
                        .background(focused ? Color.white : Color.white.opacity(0.12))
                        .cornerRadius(10)
                }
            }

            TVTightButton(action: { showQR = false }) { focused in
                qrCloseLabel(focused)
            }
            Text("手机与电视需连同一 WiFi；手机页必须用 https 加密域名打开")
                .font(.system(size: 12))
                .foregroundColor(WebColors.sub)
                .multilineTextAlignment(.center)
        }
    }

    private var micStatusText: String {
        if !mic.isOn { return "电视端未开启" }
        if mic.phoneCount > 0 { return "手机已连接，正在传输人声" }
        if mic.socketConnected { return "已就绪，请用手机扫码点“开始唱歌”" }
        return "正在连接服务器…"
    }

    private func qrTabButton(tab: QRTab, icon: String, title: String) -> some View {
        TVTightButton(action: { qrTab = tab }) { focused in
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 16, weight: .bold))
                Text(title).font(.system(size: 16, weight: .bold))
            }
            .padding(.horizontal, 18).padding(.vertical, 10)
            .background(qrTab == tab ? WebColors.ac :
                        (focused ? Color.white : Color.white.opacity(0.1)))
            .foregroundColor(qrTab == tab ? Color.white :
                             (focused ? Color(hex: 0x1a1a2e) : WebColors.sub))
            .cornerRadius(999)
        }
    }

    private func qrImageBox(_ img: UIImage, size: CGFloat) -> some View {
        Image(uiImage: img)
            .interpolation(.none)
            .resizable()
            .frame(width: size, height: size)
            .background(Color.white)
            .cornerRadius(12)
            .padding(10)
            .background(Color.white)
            .cornerRadius(16)
    }

    private func qrCloseLabel(_ focused: Bool) -> some View {
        Text("关闭")
            .font(.system(size: 16, weight: .medium))
            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
            .padding(.horizontal, 24).padding(.vertical, 10)
            .background(focused ? Color.white : WebColors.ac)
            .cornerRadius(999)
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

    private func cleanup() {
        hideTimer?.invalidate()
        hideTimer = nil
    }

    private func toggleVoice() {
        playerManager.toggleVoice()
        voiceMode = VoiceMode.from(playerManager.vocalTrackIndex)
        FeedbackCenter.shared.show(playerManager.vocalTrackLabel, icon: "mic.fill")
        api.toggleVoice()
    }

    private func resetHideTimer() {
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { _ in
            DispatchQueue.main.async {
                withAnimation(.easeOut(duration: 0.3)) {
                    showControls = false
                }
            }
        }
    }

    private func formatTime(_ seconds: Double) -> String {
        guard !seconds.isNaN else { return "0:00" }
        return String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }
}

// Helper for corner radius
extension View {
    func cornerRadius(_ radius: CGFloat, corners: UIRectCorner) -> some View {
        clipShape(RoundedCorner(radius: radius, corners: corners))
    }
}

struct RoundedCorner: Shape {
    var radius: CGFloat = .infinity
    var corners: UIRectCorner = .allCorners

    func path(in rect: CGRect) -> Path {
        let path = UIBezierPath(roundedRect: rect, byRoundingCorners: corners, cornerRadii: CGSize(width: radius, height: radius))
        return Path(path.cgPath)
    }
}

