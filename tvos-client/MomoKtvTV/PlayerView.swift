import SwiftUI
import AVFoundation
import AVKit

struct PlayerView: View {
    let song: QueueItem
    let hlsURL: URL
    let onNext: () -> Void
    let onClose: () -> Void
    let onCloseWithTime: (Double) -> Void
    let onPlayingChange: (Bool) -> Void
    let startTime: Double
    let startPlaying: Bool
    @ObservedObject var api: KTVAPIClient

    @State private var player: AVPlayer?
    @State private var showControls = true
    @State private var isPlaying: Bool
    @State private var currentTime: Double = 0
    @State private var duration: Double = 0
    @State private var voiceMode: VoiceMode = .original
    @State private var hideTimer: Timer?
    @State private var nextUpSong: QueueItem?
    @State private var showQueue = false
    @State private var timeObserver: Any?

    enum VoiceMode {
        case original, accompaniment
        var label: String { self == .original ? "原唱" : "伴唱" }
        var trackIndex: Int { self == .original ? 0 : 1 }
    }

    init(song: QueueItem, hlsURL: URL, onNext: @escaping () -> Void, onClose: @escaping () -> Void,
         onCloseWithTime: @escaping (Double) -> Void, onPlayingChange: @escaping (Bool) -> Void,
         startTime: Double, startPlaying: Bool, api: KTVAPIClient) {
        self.song = song
        self.hlsURL = hlsURL
        self.onNext = onNext
        self.onClose = onClose
        self.onCloseWithTime = onCloseWithTime
        self.onPlayingChange = onPlayingChange
        self.startTime = startTime
        self.startPlaying = startPlaying
        self.api = api
        _isPlaying = State(initialValue: startPlaying)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let player = player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
            } else {
                VStack {
                    ProgressView()
                    Text("加载视频...").font(.system(size: 16)).foregroundColor(.white.opacity(0.7))
                }
            }

            // Controls overlay (exact #fs-ov gradient)
            if showControls {
                VStack(spacing: 0) {
                    // Top bar (exact #ov-top)
                    HStack(spacing: 16) {
                        // Back button (exact #ov-back: 56x56 circle)
                        TVTightButton(action: { onClose() }) { focused in
                            Image(systemName: "chevron.left")
                                .font(.system(size: 26))
                                .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                                .frame(width: 56, height: 56)
                                .background(focused ? Color.white : Color.black.opacity(0.4))
                                .clipShape(Circle())
                        }

                        // Title + artist (exact #ov-title / #ov-artist)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(song.displayTitle)
                                .font(.system(size: 26, weight: .bold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                            Text(song.displayArtist)
                                .font(.system(size: 17))
                                .foregroundColor(Color.white.opacity(0.65))
                                .lineLimit(1)
                        }

                        Spacer()
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 18)
                    .background(LinearGradient(colors: [Color.black.opacity(0.7), .clear],
                                               startPoint: .top, endPoint: .bottom))

                    Spacer()

                    // Next up banner
                    if let next = nextUpSong {
                        HStack(spacing: 8) {
                            Image(systemName: "forward.fill")
                                .font(.system(size: 14))
                                .foregroundColor(WebColors.ac2)
                            Text("下一首: \(next.displayTitle) - \(next.displayArtist)")
                                .font(.system(size: 14))
                                .foregroundColor(.white)
                            Spacer()
                        }
                        .padding(.horizontal, 24)
                        .padding(.vertical, 8)
                        .padding(.bottom, 4)
                    }

                    // Bottom controls (exact #ov-bot)
                    VStack(spacing: 10) {
                        // Progress bar (exact #prog-bar / #prog-fill)
                        VStack(spacing: 4) {
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(Color.white.opacity(0.2))
                                        .frame(height: 4)
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(LinearGradient(colors: [WebColors.ac, WebColors.ac2],
                                                             startPoint: .leading, endPoint: .trailing))
                                        .frame(width: duration > 0 ? geo.size.width * CGFloat(currentTime / duration) : 0, height: 4)
                                }
                            }
                            .frame(height: 4)

                            HStack {
                                Text(formatTime(currentTime))
                                    .font(.system(size: 13))
                                    .foregroundColor(Color.white.opacity(0.7))
                                Spacer()
                                Text(formatTime(duration))
                                    .font(.system(size: 13))
                                    .foregroundColor(Color.white.opacity(0.7))
                            }
                        }

                        // Control buttons (exact #ov-btns with .ob buttons)
                        HStack(spacing: 10) {
                            controlButton(icon: "house", title: "主页") { onClose() }
                            controlButton(icon: "gobackward", title: "重唱") { restart() }
                            controlButton(icon: isPlaying ? "pause.fill" : "play.fill", title: isPlaying ? "暂停" : "播放", isCenter: true) { togglePlay() }
                            controlButton(icon: "mic.fill", title: voiceMode.label) { toggleVoice() }
                            controlButton(icon: "forward.end.fill", title: "切歌") { onNext() }
                            controlButton(icon: "list.bullet", title: "队列") { showQueue.toggle() }
                        }
                        .focusSection()
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 14)
                    .padding(.top, 14)
                    .background(LinearGradient(colors: [.clear, Color.black.opacity(0.8)],
                                               startPoint: .top, endPoint: .bottom))
                }
                .background(
                    LinearGradient(colors: [
                        Color.black.opacity(0.2),
                        Color.clear,
                        Color.black.opacity(0.2),
                        Color.black.opacity(0.72)
                    ], startPoint: .top, endPoint: .bottom)
                )
                .transition(.opacity)
            }

            // Queue side panel
            if showQueue {
                queuePanel
            }
        }
        .onAppear { setupPlayer() }
        .onDisappear { cleanup() }
        .contentShape(Rectangle())
        .onTapGesture { toggleControls() }
        .focusable()
        .onPlayPauseCommand { togglePlay(); resetHideTimer() }
        .onExitCommand {
            if showQueue { showQueue = false }
            else { onClose() }
        }
        .onMoveCommand { direction in
            if direction == .left { seek(-10) }
            else if direction == .right { seek(10) }
            resetHideTimer()
        }
    }

    // MARK: - Control Button (exact .ob style)
    private func controlButton(icon: String, title: String, isCenter: Bool = false, action: @escaping () -> Void) -> some View {
        TVTightButton(action: { action(); resetHideTimer() }) { focused in
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: isCenter ? 30 : 26))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : Color.white.opacity(0.9))
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : Color.white.opacity(0.85))
            }
            .frame(minWidth: 72)
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
            .background(focused ? Color.white : Color.white.opacity(0.1))
            .cornerRadius(11)
        }
    }

    // MARK: - Queue Panel
    private var queuePanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("♪ 已点队列")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundColor(WebColors.ac2)
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
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .overlay(Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1), alignment: .bottom)

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
                            if item.isPlaying {
                                Text("播放中")
                                    .font(.system(size: 20, weight: .bold))
                                    .foregroundColor(WebColors.ac2)
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, 18)
                        .background(item.isPlaying ? WebColors.ac.opacity(0.15) : Color.clear)
                        .cornerRadius(12)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
        }
        .frame(width: 680)
        .background(Color(red: 5/255, green: 5/255, blue: 20/255).opacity(0.95))
        .cornerRadius(20)
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.1), lineWidth: 1))
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.trailing, 20)
        .padding(.vertical, 40)
        .transition(.move(edge: .trailing))
    }

    // MARK: - Player Logic
    private func setupPlayer() {
        let playerItem = AVPlayerItem(url: hlsURL)
        let p = AVPlayer(playerItem: playerItem)
        self.player = p

        // Seek to start time if provided (continue from small preview)
        if startTime > 0 {
            p.seek(to: CMTime(seconds: startTime, preferredTimescale: 600))
        }

        // Start playing or paused based on small window state
        if startPlaying {
            p.play()
        } else {
            p.pause()
        }

        // Add time observer
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { time in
            currentTime = time.seconds
            if let dur = p.currentItem?.duration.seconds, !dur.isNaN {
                duration = dur
            }
        }

        NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: playerItem, queue: .main
        ) { _ in onNext() }

        if let playingIdx = api.queue.firstIndex(where: { $0.isPlaying }) {
            let nextIdx = api.queue.index(after: playingIdx)
            if nextIdx < api.queue.count {
                nextUpSong = api.queue[nextIdx]
            }
        }

        resetHideTimer()
    }

    private func cleanup() {
        let time = currentTime
        let playing = isPlaying
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
            timeObserver = nil
        }
        player?.pause()
        player = nil
        hideTimer?.invalidate()
        onCloseWithTime(time)
        onPlayingChange(playing)
    }

    private func togglePlay() {
        guard let player = player else { return }
        if player.timeControlStatus == .playing {
            player.pause(); isPlaying = false
        } else {
            player.play(); isPlaying = true
        }
        onPlayingChange(isPlaying)
    }

    private func restart() {
        guard let player = player else { return }
        player.seek(to: .zero)
        player.play()
        isPlaying = true
        onPlayingChange(true)
        api.restartSong()
    }

    private func seek(_ seconds: Double) {
        guard let player = player else { return }
        let newTime = max(0, currentTime + seconds)
        player.seek(to: CMTime(seconds: newTime, preferredTimescale: 600))
    }

    private func toggleVoice() {
        voiceMode = voiceMode == .original ? .accompaniment : .original
        if song.hasMultiTrack {
            if let group = player?.currentItem?.asset.mediaSelectionGroup(forMediaCharacteristic: .audible) {
                let options = group.options
                if options.count > voiceMode.trackIndex {
                    player?.currentItem?.select(options[voiceMode.trackIndex], in: group)
                }
            }
        }
        api.reportVoiceSwitch(songId: song.song_id, mode: song.hasMultiTrack ? "tracks" : "stereo",
                              to: voiceMode == .original ? "original" : "accompaniment")
    }

    private func toggleControls() {
        showControls.toggle()
        if showControls { resetHideTimer() }
    }

    private func resetHideTimer() {
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { _ in
            DispatchQueue.main.async { showControls = false }
        }
    }

    private func formatTime(_ seconds: Double) -> String {
        guard !seconds.isNaN else { return "0:00" }
        return String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }
}

