import SwiftUI

// MARK: - Panel Overlay
struct PanelOverlay<Content: View>: View {
    let title: String
    let onClose: () -> Void
    @ViewBuilder let content: Content
    @Environment(\.theme) var theme

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
                .focusable(false)
                .onTapGesture { onClose() }
            VStack(spacing: 0) {
                HStack {
                    Text(title).font(.headline).foregroundColor(theme.text)
                    Spacer()
                    TVTightButton(action: onClose) { focused in
                        Image(systemName: "xmark")
                            .font(.system(size: 20))
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : theme.subText)
                            .frame(width: 42, height: 42)
                            .background(focused ? Color.white : Color.clear)
                            .clipShape(Circle())
                    }
                }
                .padding()
                .background(theme.panelBg)
                Divider().background(theme.cardBorder)
                content
                    .frame(maxHeight: 500)
            }
            .frame(width: 700)
            .background(theme.panelBg)
            .cornerRadius(16)
            .focusSection()
        }
    }
}

// MARK: - Search Panel (exact #pd-search)
struct SearchPanel: View {
    @ObservedObject var api: KTVAPIClient
    let onClose: () -> Void
    let onAdd: (Song) -> Void
    @State private var query = ""
    @State private var currentPage = 0
    @State private var filteredSongs: [Song] = []   // 异步过滤结果，避免主线程卡顿
    @State private var searchDebounceTimer: Timer?   // 输入防抖
    @State private var lowercasedTitles: [String] = []  // 预计算小写标题，加速过滤
    @State private var lowercasedArtists: [String] = [] // 预计算小写歌手
    private let pageSize = 40

    /// 防抖过滤：输入停止300ms后在后台线程过滤11177首歌，避免主线程卡顿1-3秒
    private func debounceFilter() {
        searchDebounceTimer?.invalidate()
        searchDebounceTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { _ in
            self.performFilter()
        }
    }

    private func performFilter() {
        let q = query.lowercased()
        let songs = api.songs
        let titles = lowercasedTitles
        let artists = lowercasedArtists
        DispatchQueue.global(qos: .userInitiated).async {
            let result: [Song]
            if q.isEmpty {
                result = songs
            } else if titles.count == songs.count {
                // 用预计算的小写数组+普通contains，比localizedCaseInsensitiveContains快3-5倍
                result = (0..<songs.count).compactMap { i in
                    (titles[i].contains(q) || artists[i].contains(q)) ? songs[i] : nil
                }
            } else {
                result = songs.filter {
                    $0.displayTitle.localizedCaseInsensitiveContains(q) ||
                    $0.displayArtist.localizedCaseInsensitiveContains(q)
                }
            }
            DispatchQueue.main.async {
                self.filteredSongs = result
                self.currentPage = 0
            }
        }
    }

    var pagedSongs: [Song] {
        let start = currentPage * pageSize
        let end = min(start + pageSize, filteredSongs.count)
        return start < filteredSongs.count ? Array(filteredSongs[start..<end]) : []
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
                .focusable(false)
            VStack(spacing: 0) {
                // Header
                HStack {
                    Text("搜索").font(.system(size: 22, weight: .bold)).foregroundColor(.white)
                    Spacer()
                    // Search box (exact capsule style)
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass").foregroundColor(WebColors.sub)
                        TextField("搜索歌曲/歌手", text: $query)
                            .textFieldStyle(.plain)
                            .foregroundColor(.white)
                            .onSubmit { currentPage = 0 }
                            .onChange(of: query) { _ in debounceFilter() }
                .onChange(of: api.songs.count) { _ in
                    lowercasedTitles = api.songs.map { $0.displayTitle.lowercased() }
                    lowercasedArtists = api.songs.map { $0.displayArtist.lowercased() }
                }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(WebColors.nbBg)
                    .cornerRadius(999)
                    .frame(width: 280)

                    TVTightButton(action: onClose, autoFocus: true) { focused in
                        Image(systemName: "xmark")
                            .font(.system(size: 20))
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.sub)
                            .frame(width: 42, height: 42)
                            .background(focused ? Color.white : Color.clear)
                            .clipShape(Circle())
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 14)
                .background(WebColors.topbarBg)
                .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .bottom)

                // Results (exact #pl-search 2-col grid)
                if filteredSongs.isEmpty {
                    Spacer()
                    VStack(spacing: 12) {
                        Image(systemName: "magnifyingglass").font(.system(size: 40)).foregroundColor(WebColors.sub)
                        Text(query.isEmpty ? "输入关键词搜索歌曲" : "未找到相关歌曲")
                            .font(.system(size: 16)).foregroundColor(WebColors.sub)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)],
                                  spacing: 10) {
                            ForEach(Array(pagedSongs.enumerated()), id: \.element.id) { idx, song in
                                searchSongRow(song, index: currentPage * pageSize + idx)
                            }
                        }
                        .padding(.horizontal, 20).padding(.vertical, 12)
                    }
                }

                // Pagination footer (exact .pf-foot)
                HStack(spacing: 16) {
                    TVTightButton(action: { if currentPage > 0 { currentPage -= 1 } }) { focused in
                        Image(systemName: "chevron.left.circle")
                            .font(.system(size: 30))
                            .foregroundColor(currentPage > 0 ? (focused ? Color(hex: 0x1a1a2e) : WebColors.ac) : WebColors.sub)
                            .frame(width: 44, height: 44)
                            .background(focused && currentPage > 0 ? Color.white : Color.clear)
                            .cornerRadius(22)
                    }
                    .disabled(currentPage == 0)

                    Text("第 \(currentPage + 1) / \(max(1, (filteredSongs.count + pageSize - 1) / pageSize)) 页")
                        .font(.system(size: 15)).foregroundColor(WebColors.sub)

                    TVTightButton(action: {
                        if (currentPage + 1) * pageSize < filteredSongs.count { currentPage += 1 }
                    }) { focused in
                        Image(systemName: "chevron.right.circle")
                            .font(.system(size: 30))
                            .foregroundColor((currentPage + 1) * pageSize < filteredSongs.count ? (focused ? Color(hex: 0x1a1a2e) : WebColors.ac) : WebColors.sub)
                            .frame(width: 44, height: 44)
                            .background(focused && (currentPage + 1) * pageSize < filteredSongs.count ? Color.white : Color.clear)
                            .cornerRadius(22)
                    }
                }
                .padding(.vertical, 10).frame(maxWidth: .infinity)
                .background(WebColors.topbarBg)
                .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .top)
            }
            .frame(width: 800, height: 600)
            .background(WebColors.panelBg)
            .cornerRadius(16)
            .focusSection()
        }
        .onAppear {
            filteredSongs = api.songs
            lowercasedTitles = api.songs.map { $0.displayTitle.lowercased() }
            lowercasedArtists = api.songs.map { $0.displayArtist.lowercased() }
            api.fetchSongs(query: "")
        }
    }

    @ViewBuilder
    private func searchSongRow(_ song: Song, index: Int) -> some View {
        TVTightButton(action: { onAdd(song); onClose() }) { focused in
            HStack(spacing: 10) {
                Text("\(index + 1)").font(.system(size: 14)).foregroundColor(WebColors.sub).frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(song.displayTitle).font(.system(size: 16)).foregroundColor(.white).lineLimit(1)
                    Text(song.displayArtist).font(.system(size: 13)).foregroundColor(WebColors.sub).lineLimit(1)
                }
                Spacer()
                if api.favorites.contains { $0.id == song.id } {
                    Image(systemName: "heart.fill")
                        .font(.system(size: 17))
                        .foregroundColor(WebColors.pink)
                        .frame(width: 36, height: 36)
                }
                Text("点歌").font(.system(size: 15))
                    .padding(.horizontal, 12).padding(.vertical, 5)
                    .background(LinearGradient.g6).foregroundColor(.white).cornerRadius(8)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(focused ? WebColors.ac.opacity(0.25) : WebColors.cardBg)
            .cornerRadius(10)
            .padding(2)
            .background(focused ? Color.white.opacity(0.12) : Color.clear)
            .cornerRadius(12)
        }
    }
}

// MARK: - Queue Panel (exact #pd-queue)
struct QueuePanel: View {
    @ObservedObject var api: KTVAPIClient
    let onClose: () -> Void
    let onPlay: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
                .focusable(false)
                .onTapGesture { onClose() }
            VStack(spacing: 0) {
                // Header
                HStack {
                    Text("♪ 已点队列").font(.system(size: 22, weight: .bold)).foregroundColor(WebColors.ac2)
                    Text("\(api.queue.count)首").font(.system(size: 14)).foregroundColor(WebColors.sub).padding(.leading, 8)
                    Spacer()
                    if api.queue.contains(where: { $0.isPlaying }) {
                        TVTightButton(action: { onClose(); onPlay() }) { focused in
                            HStack(spacing: 4) {
                                Image(systemName: "play.rectangle.fill")
                                Text("全屏播放")
                            }
                            .font(.system(size: 15))
                            .padding(.horizontal, 14).padding(.vertical, 6)
                            .background(Group { if focused { Color.white } else { LinearGradient.g6 } })
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                            .cornerRadius(8)
                        }
                    }
                    TVTightButton(action: onClose, autoFocus: true) { focused in
                        Image(systemName: "xmark")
                            .font(.system(size: 20))
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.sub)
                            .frame(width: 42, height: 42)
                            .background(focused ? Color.white : Color.clear)
                            .clipShape(Circle())
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 14)
                .background(WebColors.topbarBg)
                .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .bottom)

                // Queue list
                if api.queue.isEmpty {
                    Spacer()
                    VStack(spacing: 12) {
                        Image(systemName: "music.note.list").font(.system(size: 40)).foregroundColor(WebColors.sub)
                        Text("点歌队列为空").font(.system(size: 16)).foregroundColor(WebColors.sub)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    Spacer()
                } else {
                    ScrollView {
                        VStack(spacing: 4) {
                            ForEach(Array(api.queue.enumerated()), id: \.element.id) { idx, item in
                                queueRow(item, index: idx)
                            }
                        }
                        .padding(.horizontal, 16).padding(.vertical, 12)
                    }
                }
            }
            .frame(width: 680, height: 560)
            .background(WebColors.panelBg)
            .cornerRadius(16)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(WebColors.cardBorder, lineWidth: 1))
            .focusSection()
        }
    }

    @ViewBuilder
    private func queueRow(_ item: QueueItem, index: Int) -> some View {
        HStack(spacing: 14) {
            if item.isPlaying {
                Image(systemName: "play.circle.fill").foregroundColor(WebColors.ac2).font(.system(size: 28))
            } else {
                Text("\(index + 1)").font(.system(size: 22, weight: .bold)).foregroundColor(WebColors.sub).frame(width: 36)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(item.displayTitle).font(.system(size: 28, weight: .bold)).foregroundColor(.white).lineLimit(nil).fixedSize(horizontal: false, vertical: true)
                Text(item.displayArtist).font(.system(size: 20, weight: .medium)).foregroundColor(WebColors.sub).lineLimit(nil).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if !item.isPlaying {
                TVTightButton(action: { api.topSong(queueId: item.queue_id) }) { focused in
                    Image(systemName: "arrow.up.to.line")
                        .font(.system(size: 24))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.ac2)
                        .frame(width: 52, height: 52)
                        .background(focused ? Color.white : WebColors.cardBg)
                        .cornerRadius(8)
                }
                TVTightButton(action: { api.removeFromQueue(queueId: item.queue_id) }) { focused in
                    Image(systemName: "trash")
                        .font(.system(size: 24))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.pink)
                        .frame(width: 52, height: 52)
                        .background(focused ? Color.white : WebColors.cardBg)
                        .cornerRadius(8)
                }
            } else {
                Text("播放中").font(.system(size: 20, weight: .bold)).foregroundColor(WebColors.ac2)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 16)
        .background(item.isPlaying ? WebColors.ac.opacity(0.15) : WebColors.cardBg)
        .cornerRadius(12)
    }
}

// MARK: - Settings Panel (exact #pd-settings 3-column layout)
struct SettingsPanel: View {
    @ObservedObject var api: KTVAPIClient
    let onClose: () -> Void
    let onThemeChange: (AppTheme) -> Void
    @State private var currentTheme: AppTheme = .theme1
    @State private var showEQ = false
    @State private var deviceRole: DeviceRole = .player
    @State private var playerLocked = false
    @AppStorage("micPublicHost") private var micPublicHost: String = "mktv.klzbw.top"

    enum DeviceRole { case player, controller
        var label: String { self == .player ? "播放端" : "控制端" }
    }

    let themes = [
        (name: "紫墨焕彩", theme: AppTheme.theme1),
        (name: "暗夜霓虹", theme: AppTheme.theme2),
        (name: "动感韶音", theme: AppTheme.theme3)
    ]

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
                .focusable(false)
                .onTapGesture { onClose() }
            VStack(spacing: 0) {
                // Header (exact .ph)
                HStack {
                    Text("⚙ 设置").font(.system(size: 22, weight: .bold)).foregroundColor(.white)
                    Spacer()
                    TVTightButton(action: onClose, autoFocus: true) { focused in
                        Image(systemName: "xmark")
                            .font(.system(size: 20))
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                            .frame(width: 42, height: 42)
                            .background(focused ? Color.white : Color.white.opacity(0.08))
                            .clipShape(Circle())
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 14)
                .background(WebColors.topbarBg)
                .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .bottom)

                // Body (exact .pb 3-column .st-col)
                ScrollView {
                    HStack(alignment: .top, spacing: 28) {
                        // Column 1: System info
                        VStack(alignment: .leading, spacing: 10) {
                            settingRow(label: "当前版本", value: api.stats?.appVersion ?? "—")
                            settingRow(label: "服务器", value: api.serverAddress)
                            settingRow(label: "手机域名", value: micPublicHost)
                            settingRow(label: "曲库歌曲", value: "\(api.stats?.songCount ?? 0) 首")
                            TVTightButton(action: { api.scanLibrary() }) { focused in
                                HStack {
                                    Text("重新扫描曲库").font(.system(size: 17))
                                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                                    Spacer()
                                    Text("▶ 扫描").font(.system(size: 16))
                                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.ac2)
                                }
                                .padding(.horizontal, 12).padding(.vertical, 10)
                                .background(focused ? Color.white : WebColors.cardBg)
                                .cornerRadius(8)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        // Column 2: Theme + Autoplay
                        VStack(alignment: .leading, spacing: 12) {
                            Text("主题").font(.system(size: 15)).foregroundColor(WebColors.sub)
                                .padding(.top, 4)
                            VStack(spacing: 8) {
                                ForEach(themes, id: \.name) { t in
                                    eqOption(title: t.name, isSelected: currentTheme == t.theme) {
                                        currentTheme = t.theme
                                        onThemeChange(t.theme)
                                    }
                                }
                            }

                            Text("已点歌曲播完后自动随机播放").font(.system(size: 15)).foregroundColor(WebColors.sub)
                                .padding(.top, 12)
                            HStack(spacing: 8) {
                                eqOption(title: "开启", isSelected: api.autoplayEnabled) {
                                    api.setAutoplay(enabled: true, localOnly: api.autoplayLocalOnly)
                                }
                                eqOption(title: "关闭", isSelected: !api.autoplayEnabled) {
                                    api.setAutoplay(enabled: false, localOnly: api.autoplayLocalOnly)
                                }
                            }

                            if api.autoplayEnabled {
                                Text("仅随机本地曲库(不含网络曲库)").font(.system(size: 15)).foregroundColor(WebColors.sub)
                                    .padding(.top, 8)
                                HStack(spacing: 8) {
                                    eqOption(title: "开启", isSelected: api.autoplayLocalOnly) {
                                        api.setAutoplay(enabled: true, localOnly: true)
                                    }
                                    eqOption(title: "关闭", isSelected: !api.autoplayLocalOnly) {
                                        api.setAutoplay(enabled: true, localOnly: false)
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        // Column 3: Device role
                        VStack(alignment: .leading, spacing: 12) {
                            Text("终端角色").font(.system(size: 15)).foregroundColor(WebColors.sub)
                                .padding(.top, 4)
                            HStack(spacing: 8) {
                                eqOption(title: "播放端", isSelected: deviceRole == .player) {
                                    deviceRole = .player
                                }
                                eqOption(title: "控制端", isSelected: deviceRole == .controller) {
                                    deviceRole = .controller
                                }
                            }
                            settingRow(label: "当前播放端", value: "本机")
                            TVTightButton(action: { playerLocked.toggle() }) { focused in
                                HStack {
                                    Text("播放端上锁").font(.system(size: 17))
                                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                                    Spacer()
                                    Text(playerLocked ? "已上锁" : "未上锁").font(.system(size: 16))
                                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.sub)
                                }
                                .padding(.horizontal, 12).padding(.vertical, 10)
                                .background(focused ? Color.white : WebColors.cardBg)
                                .cornerRadius(8)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(20)
                }
            }
            .frame(width: 900, height: 560)
            .background(WebColors.panelBg)
            .cornerRadius(16)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(WebColors.cardBorder, lineWidth: 1))
            .focusSection()
        }
        .onAppear {
            api.fetchStats()
            api.fetchAutoplaySettings()
        }
        .sheet(isPresented: $showEQ) { EQPanel { showEQ = false } }
    }

    private func settingRow(label: String, value: String) -> some View {
        HStack {
            Text(label).font(.system(size: 17)).foregroundColor(.white).frame(maxWidth: .infinity, alignment: .leading)
            Text(value).font(.system(size: 16)).foregroundColor(WebColors.sub).lineLimit(1)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(WebColors.cardBg)
        .cornerRadius(8)
    }

    private func eqOption(title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        TVTightButton(action: action) { focused in
            Text(title)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(isSelected || focused ? Color(hex: 0x1a1a2e) : .white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background {
                    if isSelected || focused {
                        Color.white
                    } else {
                        LinearGradient(colors: [Color(hex: 0xf73669).opacity(0.38), Color(hex: 0xff4f9b).opacity(0.28)],
                                       startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))
                    }
                }
                .cornerRadius(10)
        }
    }
}

// MARK: - EQ Panel (exact #pd-eq presets)
struct EQPanel: View {
    let onClose: () -> Void
    @State private var selectedEQ = "flat"
    let presets = [
        (id: "flat", name: "标准（关闭）"),
        (id: "vocal", name: "人声增强"),
        (id: "bass", name: "低音增强"),
        (id: "bright", name: "明亮清晰")
    ]

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
                .focusable(false)
                .onTapGesture { onClose() }
            VStack(spacing: 0) {
                HStack {
                    Text("🎚 均衡器").font(.system(size: 22, weight: .bold)).foregroundColor(.white)
                    Spacer()
                    TVTightButton(action: onClose, autoFocus: true) { focused in
                        Image(systemName: "xmark")
                            .font(.system(size: 20))
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                            .frame(width: 42, height: 42)
                            .background(focused ? Color.white : Color.white.opacity(0.08))
                            .clipShape(Circle())
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 14)
                .background(WebColors.topbarBg)
                .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .bottom)

                VStack(spacing: 10) {
                    ForEach(presets, id: \.id) { preset in
                        TVTightButton(action: { selectedEQ = preset.id }) { focused in
                            Text(preset.name)
                                .font(.system(size: 17, weight: .medium))
                                .foregroundColor(selectedEQ == preset.id || focused ? Color(hex: 0x1a1a2e) : .white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 16)
                                .background {
                                    if selectedEQ == preset.id || focused {
                                        Color.white
                                    } else {
                                        LinearGradient(colors: [Color(hex: 0xf73669).opacity(0.38), Color(hex: 0xff4f9b).opacity(0.28)],
                                                       startPoint: UnitPoint(x: 0, y: 0), endPoint: UnitPoint(x: 1, y: 1))
                                    }
                                }
                                .cornerRadius(12)
                        }
                    }
                }
                .padding(20)
                Spacer()
            }
            .frame(width: 420, height: 420)
            .background(WebColors.panelBg)
            .cornerRadius(16)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(WebColors.cardBorder, lineWidth: 1))
            .focusSection()
        }
    }
}


