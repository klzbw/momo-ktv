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
    @State private var currentPage = 1
    @State private var searchResults: [Song] = []    // API返回的当前页结果
    @State private var totalCount = 0                 // 搜索结果总数
    @State private var isSearching = false            // 搜索中状态
    @State private var searchDebounceTimer: Timer?    // 输入防抖
    @State private var isNumMode = false              // 字母/数字键盘切换
    private let pageSize = 40
    // 自定义键盘布局：5列，字母6行(26字母+DEL)，数字2行(10数字)+DEL
    private let letterRows: [[(String, Int)]] = [
        [("A",1),("B",1),("C",1),("D",1),("E",1)],
        [("F",1),("G",1),("H",1),("I",1),("J",1)],
        [("K",1),("L",1),("M",1),("N",1),("O",1)],
        [("P",1),("Q",1),("R",1),("S",1),("T",1)],
        [("U",1),("V",1),("W",1),("X",1),("Y",1)],
        [("Z",1),("DEL",4)]
    ]
    private let numberRows: [[(String, Int)]] = [
        [("1",1),("2",1),("3",1),("4",1),("5",1)],
        [("6",1),("7",1),("8",1),("9",1),("0",1)],
        [("DEL",5)]
    ]

    /// 防抖过滤：输入停止300ms后在后台线程过滤11177首歌，避免主线程卡顿1-3秒
    /// 防抖搜索：输入停止150ms后调用服务端API搜索（照搬网页端逻辑）
    private func debounceSearch() {
        searchDebounceTimer?.invalidate()
        searchDebounceTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { _ in
            self.currentPage = 1
            self.doSearch()
        }
    }

    /// 调用服务端分页搜索API /api/songs?q=&page=&pageSize=
    /// 服务端过滤+分页，只返回当前页40首，比本地过滤11177首快得多
    private func doSearch() {
        isSearching = true
        api.searchSongs(query: query, page: currentPage, pageSize: pageSize) { songs, total in
            self.searchResults = songs
            self.totalCount = total
            self.isSearching = false
        }
    }

    var totalPages: Int { max(1, (totalCount + pageSize - 1) / pageSize) }

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
                .focusable(false)
            VStack(spacing: 0) {
                // Header: 标题 + 搜索显示框 + 123/ABC切换 + 关闭
                HStack(spacing: 10) {
                    Text("搜索").font(.system(size: 22, weight: .bold)).foregroundColor(.white)
                    Spacer().frame(width: 8)
                    // 搜索显示框（不再用TextField系统键盘，改用自定义键盘）
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass").foregroundColor(WebColors.sub)
                            .font(.system(size: 16))
                        Text(query.isEmpty ? "点击右侧字母输入歌名/歌手" : query)
                            .font(.system(size: 18))
                            .foregroundColor(query.isEmpty ? WebColors.sub : .white)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(WebColors.nbBg)
                    .cornerRadius(999)
                    .frame(maxWidth: .infinity)

                    // 123/ABC 切换（小按钮，正常适配大小）
                    TVTightButton(action: { isNumMode.toggle() }) { focused in
                        Text(isNumMode ? "ABC" : "123")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.ac2)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(focused ? Color.white : WebColors.cardBg)
                            .cornerRadius(8)
                    }

                    TVTightButton(action: onClose, autoFocus: true) { focused in
                        Image(systemName: "xmark")
                            .font(.system(size: 18))
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.sub)
                            .frame(width: 38, height: 38)
                            .background(focused ? Color.white : Color.clear)
                            .clipShape(Circle())
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(WebColors.topbarBg)
                .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .bottom)

                // Main: 左边搜索结果 + 右边自定义字母键盘
                HStack(spacing: 0) {
                    // Left: 搜索结果（2列）
                    Group {
                        if searchResults.isEmpty {
                            VStack(spacing: 12) {
                                Image(systemName: "magnifyingglass").font(.system(size: 36)).foregroundColor(WebColors.sub)
                                Text(query.isEmpty ? "点击右侧字母开始搜索" : "未找到相关歌曲")
                                    .font(.system(size: 15)).foregroundColor(WebColors.sub)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else {
                            ScrollView {
                                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                                          spacing: 8) {
                                    ForEach(Array(searchResults.enumerated()), id: \.element.id) { idx, song in
                                        searchSongRow(song, index: (currentPage - 1) * pageSize + idx)
                                    }
                                }
                                .padding(.horizontal, 14).padding(.vertical, 10)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity)

                    // Right: 自定义字母键盘（5列，紧凑大小，避免被拉伸过大）
                    VStack(spacing: 0) {
                        ScrollView {
                            VStack(spacing: 6) {
                                ForEach(0..<(isNumMode ? numberRows.count : letterRows.count), id: \.self) { r in
                                    let row = isNumMode ? numberRows[r] : letterRows[r]
                                    GeometryReader { geo in
                                        let sp: CGFloat = 6
                                        let totalSpan = row.reduce(0) { $0 + $1.1 }
                                        let cw = (geo.size.width - sp * CGFloat(row.count - 1)) / CGFloat(totalSpan)
                                        HStack(spacing: sp) {
                                            ForEach(0..<row.count, id: \.self) { c in
                                                let (key, span) = row[c]
                                                let kw = cw * CGFloat(span) + sp * CGFloat(span - 1)
                                                SearchKeyButton(label: key, width: kw, height: geo.size.height, action: {
                                                    if key == "DEL" {
                                                        if !query.isEmpty { query.removeLast() }
                                                    } else {
                                                        query.append(key)
                                                    }
                                                    debounceSearch()
                                                })
                                            }
                                        }
                                    }
                                    .frame(height: 44)
                                }
                            }
                            .padding(.horizontal, 8).padding(.vertical, 8)
                            Spacer(minLength: 0)
                        }
                        // 清空按钮
                        TVTightButton(action: { query = ""; currentPage = 1; debounceSearch() }) { focused in
                            Text("清空")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.pink)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(focused ? Color.white : WebColors.pink.opacity(0.12))
                                .cornerRadius(8)
                        }
                        .padding(.horizontal, 8).padding(.bottom, 8)
                    }
                    .frame(width: 260)
                    .background(Color(hex: 0x15151f))
                }
                .frame(maxHeight: .infinity)

                // Pagination footer
                HStack(spacing: 16) {
                    TVTightButton(action: { if currentPage > 1 { currentPage -= 1; doSearch() } }) { focused in
                        Image(systemName: "chevron.left.circle")
                            .font(.system(size: 26))
                            .foregroundColor(currentPage > 1 ? (focused ? Color(hex: 0x1a1a2e) : WebColors.ac) : WebColors.sub)
                            .frame(width: 40, height: 40)
                            .background(focused && currentPage > 1 ? Color.white : Color.clear)
                            .cornerRadius(20)
                    }
                    .disabled(currentPage == 1)

                    Text("第 \(currentPage) / \(totalPages) 页 (共\(totalCount)首)")
                        .font(.system(size: 14)).foregroundColor(WebColors.sub)

                    TVTightButton(action: {
                        if currentPage < totalPages { currentPage += 1; doSearch() }
                    }) { focused in
                        Image(systemName: "chevron.right.circle")
                            .font(.system(size: 26))
                            .foregroundColor(currentPage < totalPages ? (focused ? Color(hex: 0x1a1a2e) : WebColors.ac) : WebColors.sub)
                            .frame(width: 40, height: 40)
                            .background(focused && currentPage < totalPages ? Color.white : Color.clear)
                            .cornerRadius(20)
                    }
                }
                .padding(.vertical, 8).frame(maxWidth: .infinity)
                .background(WebColors.topbarBg)
                .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .top)
            }
            .frame(width: 920, height: 620)
            .background(WebColors.panelBg)
            .cornerRadius(16)
            .focusSection()
        }
        .onAppear {
            doSearch()
        }
    }

// MARK: - 紧凑搜索键盘按键（适合260pt宽的键盘区域，避免被拉伸过大）
struct SearchKeyButton: View {
    let label: String
    let width: CGFloat
    let height: CGFloat
    let action: () -> Void

    var body: some View {
        TVTightButton(action: action) { focused in
            Group {
                if label == "DEL" {
                    HStack(spacing: 4) {
                        Image(systemName: "delete.left")
                            .font(.system(size: 15, weight: .bold))
                        Text("删除")
                            .font(.system(size: 15, weight: .bold))
                    }
                } else {
                    Text(label)
                        .font(.system(size: 19, weight: .bold))
                }
            }
            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : (label == "DEL" ? WebColors.pink : .white.opacity(0.9)))
            .frame(width: width, height: height)
            .background(focused ? Color.white : (label == "DEL" ? WebColors.pink.opacity(0.15) : Color.white.opacity(0.08)))
            .cornerRadius(8)
        }
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


