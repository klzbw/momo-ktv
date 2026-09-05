import SwiftUI

// MARK: - Full Page Container (exact .pd-full / .pf-head / .pf-body / .pf-foot)
struct FullPageContainer<Content: View>: View {
    let title: String
    let onBack: () -> Void
    let showPagination: Bool
    let currentPage: Int
    let totalPages: Int
    let onPageChange: (Int) -> Void
    @ViewBuilder let content: Content

    init(title: String, onBack: @escaping () -> Void,
         showPagination: Bool = false, currentPage: Int = 1, totalPages: Int = 1,
         onPageChange: @escaping (Int) -> Void = { _ in },
         @ViewBuilder content: () -> Content) {
        self.title = title
        self.onBack = onBack
        self.showPagination = showPagination
        self.currentPage = currentPage
        self.totalPages = totalPages
        self.onPageChange = onPageChange
        self.content = content()
    }

    var body: some View {
        ZStack {
            WebColors.bg.ignoresSafeArea()
            RadialGradient(colors: [WebColors.ac.opacity(0.1), .clear],
                           center: UnitPoint(x: 0.1, y: 0.3), startRadius: 0, endRadius: 400)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                // Header (exact .pf-head)
                HStack {
                    Text(title)
                        .font(.system(size: 22, weight: .bold))
                        .foregroundColor(.white)
                    Spacer()
                    TVTightButton(action: onBack) { focused in
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left")
                            Text("返回")
                        }
                        .font(.system(size: 17))
                        .padding(.horizontal, 18).padding(.vertical, 7)
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : Color.white.opacity(0.85))
                        .background(focused ? Color.white : Color.clear)
                        .cornerRadius(999)
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 14)
                .background(WebColors.topbarBg)
                .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .bottom)

                // Body (exact .pf-body)
                content

                // Pagination footer (exact .pf-foot)
                if showPagination {
                    HStack(spacing: 16) {
                        TVTightButton(action: { if currentPage > 1 { onPageChange(currentPage - 1) } }) { focused in
                            Image(systemName: "chevron.left.circle")
                                .font(.system(size: 32))
                                .foregroundColor(currentPage > 1 ? (focused ? Color(hex: 0x1a1a2e) : WebColors.ac) : WebColors.sub)
                                .frame(width: 48, height: 48)
                                .background(focused && currentPage > 1 ? Color.white : Color.clear)
                                .cornerRadius(24)
                        }
                        .disabled(currentPage <= 1)

                        Text("第 \(currentPage) / \(max(1, totalPages)) 页")
                            .font(.system(size: 18)).foregroundColor(WebColors.sub)

                        TVTightButton(action: { if currentPage < totalPages { onPageChange(currentPage + 1) } }) { focused in
                            Image(systemName: "chevron.right.circle")
                                .font(.system(size: 32))
                                .foregroundColor(currentPage < totalPages ? (focused ? Color(hex: 0x1a1a2e) : WebColors.ac) : WebColors.sub)
                                .frame(width: 48, height: 48)
                                .background(focused && currentPage < totalPages ? Color.white : Color.clear)
                                .cornerRadius(24)
                        }
                        .disabled(currentPage >= totalPages)
                    }
                    .padding(.vertical, 10).frame(maxWidth: .infinity)
                    .background(WebColors.topbarBg)
                    .overlay(Rectangle().fill(WebColors.topbarBorder).frame(height: 1), alignment: .top)
                    .focusSection()
                }
            }
        }
        .onExitCommand { onBack() }
    }
}

// MARK: - Song List Row (exact .song-list-2col row)
struct WebSongRow: View {
    let song: Song
    let index: Int
    let showRank: Bool
    let onAdd: () -> Void
    let isFavorite: Bool
    let onToggleFav: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            // 整行大按钮：序号 + 歌名/歌手 + 点歌
            TVTightButton(action: onAdd) { focused in
                HStack(spacing: 14) {
                    if showRank {
                        Text("\(index + 1)")
                            .font(.system(size: index < 3 ? 28 : 24, weight: .bold))
                            .foregroundColor(index < 3 ? WebColors.ac : WebColors.sub)
                            .frame(width: 48)
                    } else {
                        Text("\(index + 1)")
                            .font(.system(size: 24, weight: .bold))
                            .foregroundColor(WebColors.sub)
                            .frame(width: 48)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(song.displayTitle)
                                .font(.system(size: 28, weight: .semibold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                            if song.hasMultiTrack {
                                Text("伴唱")
                                    .font(.system(size: 15, weight: .medium))
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(WebColors.ac2.opacity(0.3))
                                    .foregroundColor(WebColors.ac2)
                                    .cornerRadius(6)
                            }
                            Label(song.mediaTypeLabel, systemImage: song.mediaTypeIcon)
                                .font(.system(size: 14, weight: .medium))
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(song.isVideoFile ? Color(hex: 0x0288d1).opacity(0.25) : Color(hex: 0x2e7d32).opacity(0.25))
                                .foregroundColor(song.isVideoFile ? Color(hex: 0x4fc3f7) : Color(hex: 0x81c784))
                                .cornerRadius(6)
                        }
                        Text(song.displayArtist)
                            .font(.system(size: 22))
                            .foregroundColor(WebColors.sub)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 0)

                    Text("点歌")
                        .font(.system(size: 24, weight: .semibold))
                        .padding(.horizontal, 22).padding(.vertical, 10)
                        .background(Group { if focused { Color.white } else { LinearGradient.g6 } })
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                        .cornerRadius(10)
                }
                .padding(2)
                .background(focused ? Color.white.opacity(0.08) : Color.clear)
                .cornerRadius(12)
            }

            // Favorite button
            TightFavButton(isFavorite: isFavorite, action: onToggleFav)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(WebColors.cardBg)
        .cornerRadius(12)
    }
}

// MARK: - Two Column Song List
struct TwoColSongList: View {
    let songs: [Song]
    let startIndex: Int
    let showRank: Bool
    let onAdd: (Song) -> Void
    let favorites: [Song]
    let onToggleFav: (Int) -> Void

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)],
                  spacing: 12) {
            ForEach(Array(songs.enumerated()), id: \.element.id) { idx, song in
                WebSongRow(song: song, index: startIndex + idx, showRank: showRank,
                           onAdd: { onAdd(song) },
                           isFavorite: favorites.contains { $0.id == song.id },
                           onToggleFav: { onToggleFav(song.id) })
                    .gridCellColumns(
                        (idx == songs.count - 1 && songs.count % 2 == 1) ? 2 : 1
                    )
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .focusSection()
    }
}

// MARK: - Artists Page (exact #pf-artists)
struct ArtistsPage: View {
    @ObservedObject var api: KTVAPIClient
    let onBack: () -> Void
    let onArtistSelect: (String) -> Void
    @State private var currentPage = 1
    @State private var inputLetters = ""
    @State private var artistPinyin: [String: String] = [:] // key: artist name, value: pinyin initials
    @State private var filteredArtists: [Artist] = []   // 过滤结果（同步更新，点击即响应）
    @State private var isCacheReady = false
    @State private var isLoading = true
    private let pageSize = 18
    // 歌手键盘：拼音首字母不会出现 I/U/V，与网页端一致（23 键）
    // 5 行，最后一行 X Y Z + DEL（跨2列），填满整行
    private let abcRows: [[(String, Int)]] = [
        [("A",1),("B",1),("C",1),("D",1),("E",1)],
        [("F",1),("G",1),("H",1),("J",1),("K",1)],
        [("L",1),("M",1),("N",1),("O",1),("P",1)],
        [("Q",1),("R",1),("S",1),("T",1),("W",1)],
        [("X",1),("Y",1),("Z",1),("DEL",2)]
    ]

    private static var pinyinCharCache: [Character: String] = [:]
    private static let pinyinCacheLock = NSLock()

    private func pinyinFirstLetter(_ char: Character) -> String {
        ArtistsPage.pinyinCacheLock.lock()
        if let cached = ArtistsPage.pinyinCharCache[char] {
            ArtistsPage.pinyinCacheLock.unlock()
            return cached
        }
        ArtistsPage.pinyinCacheLock.unlock()

        let mutable = NSMutableString(string: String(char)) as CFMutableString
        CFStringTransform(mutable, nil, kCFStringTransformToLatin, false)
        CFStringTransform(mutable, nil, kCFStringTransformStripDiacritics, false)
        let pinyin = mutable as String
        let result = pinyin.first.map { String($0).uppercased() } ?? "#"

        ArtistsPage.pinyinCacheLock.lock()
        ArtistsPage.pinyinCharCache[char] = result
        ArtistsPage.pinyinCacheLock.unlock()

        return result
    }

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

    private func buildCache() {
        let artists = api.artists
        guard !artists.isEmpty else { return }
        isCacheReady = false
        DispatchQueue.global(qos: .userInitiated).async {
            var cache: [String: String] = [:]
            for artist in artists {
                cache[artist.artist] = computePinyinInitials(artist.displayName)
            }
            DispatchQueue.main.async {
                self.artistPinyin = cache
                self.isCacheReady = true
                self.isLoading = false
                let q = self.inputLetters
                self.filteredArtists = q.isEmpty ? artists : artists.filter { a in
                    guard let p = cache[a.artist] else { return false }
                    return p.hasPrefix(q)
                }
            }
        }
    }

    /// 同步过滤：拼音首字母过滤是字典查找+hasPrefix，极快(几毫秒)，无需防抖和后台线程
    /// 去掉150ms人为延迟，点击字母后左边列表立即更新，解决"输不动"和延迟高的问题
    private func applyFilter() {
        let query = inputLetters
        if query.isEmpty {
            filteredArtists = api.artists
        } else if isCacheReady {
            filteredArtists = api.artists.filter { artist in
                guard let p = artistPinyin[artist.artist] else { return false }
                return p.hasPrefix(query)
            }
        } else {
            filteredArtists = []
        }
        currentPage = 1
    }

    var pagedArtists: [Artist] {
        let start = (currentPage - 1) * pageSize
        let end = min(start + pageSize, filteredArtists.count)
        return start < filteredArtists.count ? Array(filteredArtists[start..<end]) : []
    }

    var totalPages: Int { max(1, (filteredArtists.count + pageSize - 1) / pageSize) }

    // Gradient colors for artist avatars (cycle through)
    private let avatarGradients: [LinearGradient] = [
        LinearGradient(colors: [Color(hex: 0xf97316), Color(hex: 0xea580c)], startPoint: .top, endPoint: .bottom),
        LinearGradient(colors: [Color(hex: 0xa855f7), Color(hex: 0x7c3aed)], startPoint: .top, endPoint: .bottom),
        LinearGradient(colors: [Color(hex: 0x06b6d4), Color(hex: 0x0891b2)], startPoint: .top, endPoint: .bottom),
        LinearGradient(colors: [Color(hex: 0xec4899), Color(hex: 0xdb2777)], startPoint: .top, endPoint: .bottom),
        LinearGradient(colors: [Color(hex: 0x22c55e), Color(hex: 0x16a34a)], startPoint: .top, endPoint: .bottom),
        LinearGradient(colors: [Color(hex: 0xf59e0b), Color(hex: 0xd97706)], startPoint: .top, endPoint: .bottom)
    ]

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                HStack(spacing: 8) {
                    Image(systemName: "music.mic")
                        .font(.system(size: 24))
                        .foregroundColor(WebColors.ac2)
                    Text("歌星")
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

            // Main: left artist grid + right alphabet panel
            HStack(spacing: 0) {
                // Left: artist grid (6 cols)
                ScrollView {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 6),
                              spacing: 20) {
                        ForEach(Array(pagedArtists.enumerated()), id: \.element.artist) { idx, artist in
                            TVTightButton(action: { onArtistSelect(artist.artist) }) { focused in
                                VStack(spacing: 8) {
                                    ZStack {
                                        Circle()
                                            .fill(avatarGradients[idx % avatarGradients.count])
                                            .frame(width: 90, height: 90)
                                        Text(String(artist.displayName.prefix(1)))
                                            .font(.system(size: 36, weight: .bold))
                                            .foregroundColor(.white)
                                    }
                                    Text(artist.displayName)
                                        .font(.system(size: 17, weight: .medium))
                                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                                        .lineLimit(1)
                                        .frame(maxWidth: .infinity)
                                    Text("\(artist.count)首")
                                        .font(.system(size: 14))
                                        .foregroundColor(focused ? Color(hex: 0x1a1a2e).opacity(0.7) : WebColors.sub)
                                }
                                .frame(maxWidth: .infinity, minHeight: 140)
                                .background(focused ? Color.white : Color(hex: 0x1e1e2e).opacity(0.001))
                                .cornerRadius(12)
                            }
                            .gridCellColumns(
                                (idx == pagedArtists.count - 1 && pagedArtists.count % 6 != 0)
                                    ? (6 - pagedArtists.count % 6) : 1
                            )
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 16)
                }
                .frame(maxWidth: .infinity)
                .focusSection()

                // Right: alphabet search panel
                VStack(spacing: 0) {
                    HStack {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 20))
                            .foregroundColor(WebColors.sub)
                        Text(inputLetters.isEmpty ? "歌星搜索" : inputLetters)
                            .font(.system(size: 22, weight: .bold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Spacer()
                    }
                    .padding(.horizontal, 16).padding(.vertical, 14)

                    // Keyboard: 按键放大填满右侧面板
                    VStack(spacing: 8) {
                        ForEach(0..<abcRows.count, id: \.self) { r in
                            let row = abcRows[r]
                            GeometryReader { geo in
                                let sp: CGFloat = 8
                                let cw = (geo.size.width - sp * 4) / 5
                                HStack(spacing: sp) {
                                    ForEach(0..<row.count, id: \.self) { c in
                                        let (key, span) = row[c]
                                        let kw = cw * CGFloat(span) + sp * CGFloat(span - 1)
                                        TightKeyButton(key: key, width: kw, height: geo.size.height) {
                                            if key == "DEL" {
                                                if !inputLetters.isEmpty { inputLetters.removeLast() }
                                            } else {
                                                inputLetters.append(key)
                                            }
                                            applyFilter()
                                        }
                                    }
                                }
                            }
                            .frame(maxHeight: .infinity)
                        }

                        // Clear button（固定底部，键盘行平分剩余空间）
                        TightClearButton(isEmpty: inputLetters.isEmpty) {
                            inputLetters = ""
                            applyFilter()
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
                TVTightButton(action: { if currentPage > 1 { currentPage -= 1 } }) { focused in
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.left")
                        Text("上一页")
                    }
                    .font(.system(size: 18, weight: .medium))
                    .padding(.horizontal, 20).padding(.vertical, 8)
                    .foregroundColor(currentPage > 1 ? (focused ? Color(hex: 0x1a1a2e) : .white) : WebColors.sub)
                    .background(currentPage > 1 ? (focused ? Color.white : Color.white.opacity(0.12)) : Color.clear)
                    .cornerRadius(999)
                }
                .disabled(currentPage == 1)

                Text("第 \(currentPage)/\(totalPages) (共\(filteredArtists.count)位)")
                    .font(.system(size: 18))
                    .foregroundColor(.white)

                TVTightButton(action: { if currentPage < totalPages { currentPage += 1 } }) { focused in
                    HStack(spacing: 6) {
                        Text("下一页")
                        Image(systemName: "chevron.right")
                    }
                    .font(.system(size: 18, weight: .medium))
                    .padding(.horizontal, 20).padding(.vertical, 8)
                    .foregroundColor(currentPage < totalPages ? (focused ? Color(hex: 0x1a1a2e) : .white) : WebColors.sub)
                    .background(currentPage < totalPages ? (focused ? Color.white : Color.white.opacity(0.12)) : Color.clear)
                    .cornerRadius(999)
                }
                .disabled(currentPage >= totalPages)
            }
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(WebColors.topbarBg)
            .focusSection()
        }
        .background(WebColors.bg.ignoresSafeArea())
        .onAppear {
            isLoading = true
            filteredArtists = api.artists
            api.fetchArtists {
                buildCache()
            }
        }
        .onChange(of: api.artists.count) { _ in
            if api.artists.count > 0 && !isCacheReady {
                buildCache()
            }
        }
    }
}

// MARK: - Alpha Keyboard (exact .alpha-panel)
struct AlphaKey: View {
    let label: String
    var isDelete: Bool = false
    let action: () -> Void

    var body: some View {
        TVTightButton(action: action) { focused in
            Text(label)
                .font(.system(size: isDelete ? 14 : 26, weight: .bold))
                .foregroundColor(focused ? Color(hex: 0x1a1a2e) : (isDelete ? WebColors.pink : Color.white.opacity(0.8)))
                .frame(maxWidth: .infinity)
                .padding(.vertical, isDelete ? 10 : 16)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(focused ? Color.white : (isDelete ? WebColors.pink.opacity(0.15) : Color.white.opacity(0.08)))
                )
                .padding(2)
                .background(focused ? Color.white.opacity(0.15) : Color.clear)
                .cornerRadius(8)
        }
    }
}

struct AlphaKeyboard: View {
    @Binding var input: String
    @State private var isNumMode = false
    let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    let numbers = Array("0123456789")

    var body: some View {
        VStack(spacing: 10) {
            // Display (exact .alpha-disp)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundColor(WebColors.sub)
                Text(input.isEmpty ? "歌星搜索" : input)
                    .font(.system(size: 16)).foregroundColor(.white).lineLimit(1)
                Spacer()
                TVTightButton(action: { isNumMode.toggle() }) { focused in
                    Text(isNumMode ? "ABC" : "123")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : Color.white.opacity(0.8))
                        .frame(width: 56)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(focused ? Color.white : Color.white.opacity(0.08))
                        )
                        .padding(2)
                        .background(focused ? Color.white.opacity(0.15) : Color.clear)
                        .cornerRadius(8)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(WebColors.cardBg).cornerRadius(8)

            // Keys (exact .alpha-keys)
            ScrollView {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()),
                                    GridItem(.flexible()), GridItem(.flexible()),
                                    GridItem(.flexible()), GridItem(.flexible()),
                                    GridItem(.flexible())], spacing: 6) {
                    let keys = isNumMode ? numbers : letters
                    ForEach(keys, id: \.self) { ch in
                        AlphaKey(label: String(ch), action: { input.append(ch) })
                    }
                    AlphaKey(label: "删除", isDelete: true, action: { if !input.isEmpty { input.removeLast() } })
                }
            }
        }
        .padding(12)
    }
}

// MARK: - Artist Songs Page (exact #pf-artist-songs)
struct ArtistSongsPage: View {
    @ObservedObject var api: KTVAPIClient
    let artist: String
    let onBack: () -> Void
    let onAdd: (Song) -> Void
    @State private var currentPage = 1
    private let pageSize = 50

    var pagedSongs: [Song] {
        let start = (currentPage - 1) * pageSize
        let end = min(start + pageSize, api.songs.count)
        return start < api.songs.count ? Array(api.songs[start..<end]) : []
    }

    var body: some View {
        FullPageContainer(title: artist, onBack: onBack,
                         showPagination: true, currentPage: currentPage,
                         totalPages: max(1, (api.songs.count + pageSize - 1) / pageSize),
                         onPageChange: { currentPage = $0 }) {
            ScrollView {
                TwoColSongList(songs: pagedSongs, startIndex: (currentPage - 1) * pageSize,
                              showRank: false, onAdd: onAdd,
                              favorites: api.favorites, onToggleFav: { api.toggleFavorite(songId: $0) })
            }
            .focusSection()
        }
        .onAppear { api.fetchSongs(artist: artist) }
    }
}

// MARK: - Charts Page (exact #pf-charts)
struct ChartsPage: View {
    @ObservedObject var api: KTVAPIClient
    let onBack: () -> Void
    let onAdd: (Song) -> Void

    var body: some View {
        FullPageContainer(title: "🏆 热歌榜单", onBack: onBack) {
            ScrollView {
                TwoColSongList(songs: api.charts, startIndex: 0, showRank: true,
                              onAdd: onAdd,
                              favorites: api.favorites, onToggleFav: { api.toggleFavorite(songId: $0) })
            }
        }
        .onAppear { api.fetchCharts() }
    }
}

// MARK: - Favorites Page (exact #pf-favorites)
struct FavoritesPage: View {
    @ObservedObject var api: KTVAPIClient
    let onBack: () -> Void
    let onAdd: (Song) -> Void
    @State private var currentPage = 1
    private let pageSize = 50

    var pagedSongs: [Song] {
        let start = (currentPage - 1) * pageSize
        let end = min(start + pageSize, api.favorites.count)
        return start < api.favorites.count ? Array(api.favorites[start..<end]) : []
    }

    var body: some View {
        FullPageContainer(title: "❤️ 我的收藏", onBack: onBack,
                         showPagination: true, currentPage: currentPage,
                         totalPages: max(1, (api.favorites.count + pageSize - 1) / pageSize),
                         onPageChange: { currentPage = $0 }) {
            if api.favorites.isEmpty {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "heart").font(.system(size: 48)).foregroundColor(WebColors.sub)
                    Text("暂无收藏歌曲").font(.system(size: 16)).foregroundColor(WebColors.sub)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                Spacer()
            } else {
                ScrollView {
                    TwoColSongList(songs: pagedSongs, startIndex: (currentPage - 1) * pageSize,
                                  showRank: false, onAdd: onAdd,
                                  favorites: api.favorites, onToggleFav: { api.toggleFavorite(songId: $0) })
                }
            }
        }
        .onAppear { api.fetchFavorites() }
    }
}

// MARK: - History Page (exact #pf-history)
struct HistoryPage: View {
    @ObservedObject var api: KTVAPIClient
    let onBack: () -> Void
    let onAdd: (Song) -> Void
    @State private var currentPage = 1
    private let pageSize = 50

    var pagedSongs: [Song] {
        let start = (currentPage - 1) * pageSize
        let end = min(start + pageSize, api.history.count)
        return start < api.history.count ? Array(api.history[start..<end]) : []
    }

    var body: some View {
        FullPageContainer(title: "⭐ 常唱", onBack: onBack,
                         showPagination: true, currentPage: currentPage,
                         totalPages: max(1, (api.history.count + pageSize - 1) / pageSize),
                         onPageChange: { currentPage = $0 }) {
            if api.history.isEmpty {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "clock").font(.system(size: 48)).foregroundColor(WebColors.sub)
                    Text("暂无演唱记录").font(.system(size: 16)).foregroundColor(WebColors.sub)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                Spacer()
            } else {
                ScrollView {
                    TwoColSongList(songs: pagedSongs, startIndex: (currentPage - 1) * pageSize,
                                  showRank: false, onAdd: onAdd,
                                  favorites: api.favorites, onToggleFav: { api.toggleFavorite(songId: $0) })
                }
            }
        }
        .onAppear { api.fetchHistory() }
    }
}

// MARK: - Newest Page (exact #pf-newest)
struct NewestPage: View {
    @ObservedObject var api: KTVAPIClient
    let onBack: () -> Void
    let onAdd: (Song) -> Void
    @State private var currentPage = 1
    private let pageSize = 18

    var pagedSongs: [Song] {
        let start = (currentPage - 1) * pageSize
        let end = min(start + pageSize, api.newest.count)
        return start < api.newest.count ? Array(api.newest[start..<end]) : []
    }

    var body: some View {
        FullPageContainer(title: "🆕 最新入库", onBack: onBack,
                         showPagination: true, currentPage: currentPage,
                         totalPages: max(1, (api.newest.count + pageSize - 1) / pageSize),
                         onPageChange: { currentPage = $0 }) {
            ScrollView {
                TwoColSongList(songs: pagedSongs, startIndex: (currentPage - 1) * pageSize,
                              showRank: false, onAdd: onAdd,
                              favorites: api.favorites, onToggleFav: { api.toggleFavorite(songId: $0) })
            }
        }
        .onAppear { api.fetchNewest() }
    }
}

// MARK: - Category Page (exact #pf-category)
struct CategoryPage: View {
    @ObservedObject var api: KTVAPIClient
    let onBack: () -> Void
    let onAdd: (Song) -> Void
    @State private var selectedLang: String? = nil
    @State private var selectedGenre: String? = nil
    @State private var currentPage = 1
    private let pageSize = 50

    let languages = ["国语", "粤语", "英语", "日语", "韩语", "其他"]
    let genres = ["流行", "摇滚", "民谣", "电子", "古典", "爵士", "乡村", "R&B", "其他"]

    var filteredSongs: [Song] {
        api.songs.filter { song in
            if let lang = selectedLang, song.language != lang { return false }
            if let genre = selectedGenre, song.category != genre { return false }
            return true
        }
    }

    var pagedSongs: [Song] {
        let start = (currentPage - 1) * pageSize
        let end = min(start + pageSize, filteredSongs.count)
        return start < filteredSongs.count ? Array(filteredSongs[start..<end]) : []
    }

    var body: some View {
        FullPageContainer(title: "🗂 分类点歌", onBack: onBack,
                         showPagination: true, currentPage: currentPage,
                         totalPages: max(1, (filteredSongs.count + pageSize - 1) / pageSize),
                         onPageChange: { currentPage = $0 }) {
            HStack(spacing: 0) {
                // Category panel (exact .cat-panel)
                VStack(alignment: .leading, spacing: 16) {
                    Text("语种")
                        .font(.system(size: 26, weight: .heavy))
                        .foregroundColor(WebColors.ac2)
                    WrapView(items: languages, minWidth: 110, spacing: 12) { lang in
                        TightChipButton(title: lang, isSelected: selectedLang == lang) {
                            selectedLang = selectedLang == lang ? nil : lang
                            currentPage = 1
                        }
                    }

                    Text("风格")
                        .font(.system(size: 26, weight: .heavy))
                        .foregroundColor(WebColors.ac2)
                        .padding(.top, 10)
                    WrapView(items: genres, minWidth: 110, spacing: 12) { genre in
                        TightChipButton(title: genre, isSelected: selectedGenre == genre) {
                            selectedGenre = selectedGenre == genre ? nil : genre
                            currentPage = 1
                        }
                    }
                }
                .frame(width: 380)
                .padding(20)
                .background(Color.black.opacity(0.3))

                // Song list (exact .song-list-2col)
                ScrollView {
                    TwoColSongList(songs: pagedSongs, startIndex: (currentPage - 1) * pageSize,
                                  showRank: false, onAdd: onAdd,
                                  favorites: api.favorites, onToggleFav: { api.toggleFavorite(songId: $0) })
                }
                .focusSection()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - TV Tight Button (reliable focus: no system card, no scaleEffect)
// 根据是否有外部焦点绑定，选择使用外部或内部 @FocusState
private struct ConditionalFocusModifier: ViewModifier {
    let externalFocus: FocusState<Bool>.Binding?
    let internalFocus: FocusState<Bool>.Binding
    let focusedTag: FocusState<Int?>.Binding?
    let focusTag: Int?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let ft = focusedTag, let tag = focusTag {
            content.focused(ft, equals: tag)
        } else if let ext = externalFocus {
            content.focused(ext)
        } else {
            content.focused(internalFocus)
        }
    }
}

// 用普通 View + focusable + onTapGesture 代替 Button，避免 tvOS 内置焦点大白圈
struct TVTightButton<Label: View>: View {
    let action: () -> Void
    var autoFocus: Bool = false
    var externalFocus: FocusState<Bool>.Binding? = nil
    var focusedTag: FocusState<Int?>.Binding? = nil
    var focusTag: Int? = nil
    var onFocusChange: ((Bool) -> Void)? = nil
    @ViewBuilder let label: (Bool) -> Label
    @FocusState private var focused: Bool

    private var isFocused: Bool {
        if let ft = focusedTag, let tag = focusTag {
            return ft.wrappedValue == tag
        }
        return externalFocus?.wrappedValue ?? focused
    }

    var body: some View {
        label(isFocused)
            .focusable(true)
            .modifier(ConditionalFocusModifier(externalFocus: externalFocus, internalFocus: $focused, focusedTag: focusedTag, focusTag: focusTag))
            .focusEffectDisabled()
            .onTapGesture { action() }
            .onChange(of: isFocused) { newVal in
                onFocusChange?(newVal)
            }
            .onAppear {
                if autoFocus {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        if let ft = focusedTag, let tag = focusTag {
                            ft.wrappedValue = tag
                        } else if let ext = externalFocus {
                            ext.wrappedValue = true
                        } else {
                            focused = true
                        }
                    }
                }
            }
    }
}

// MARK: - Tight Focus Chip Button
struct TightChipButton: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        TVTightButton(action: action) { focused in
            Text(title)
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(isSelected ? .white : (focused ? Color(hex: 0x1a1a2e) : WebColors.sub))
                .padding(.horizontal, 24).padding(.vertical, 14)
                .background {
                    if isSelected {
                        LinearGradient.g6
                    } else if focused {
                        Color.white
                    } else {
                        WebColors.cardBg
                    }
                }
                .cornerRadius(999)
        }
    }
}

// MARK: - Tight Focus Key Button (focus frame only 2px larger than key)
struct TightKeyButton: View {
    let key: String
    let width: CGFloat
    let height: CGFloat
    let action: () -> Void

    var body: some View {
        TVTightButton(action: action) { focused in
            Group {
                if key == "DEL" {
                    HStack(spacing: 8) {
                        Image(systemName: "delete.left")
                            .font(.system(size: 30, weight: .bold))
                        Text("删除")
                            .font(.system(size: 30, weight: .bold))
                    }
                } else {
                    Text(key)
                        .font(.system(size: 42, weight: .heavy))
                }
            }
            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
            .frame(width: width, height: height)
            .background(focused ? Color.white : Color(hex: 0x2a2a3a))
            .cornerRadius(12)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(focused ? Color.clear : Color.white.opacity(0.12), lineWidth: 1.5)
            )
        }
    }
}

// MARK: - Tight Focus Favorite Button
struct TightFavButton: View {
    let isFavorite: Bool
    let action: () -> Void

    var body: some View {
        TVTightButton(action: action) { focused in
            Image(systemName: isFavorite ? "heart.fill" : "heart")
                .font(.system(size: 30))
                .foregroundColor(isFavorite ? Color(hex: 0xe91e63) : (focused ? Color(hex: 0x1a1a2e) : Color.white.opacity(0.6)))
                .frame(width: 64, height: 64)
                .background(focused ? Color.white : (isFavorite ? Color(hex: 0xe91e63).opacity(0.3) : WebColors.cardBg))
                .cornerRadius(10)
        }
    }
}

// MARK: - Tight Focus Clear Button
struct TightClearButton: View {
    let isEmpty: Bool
    let action: () -> Void

    var body: some View {
        TVTightButton(action: action) { focused in
            Text("清空")
                .font(.system(size: 22, weight: .medium))
                .foregroundColor(focused && !isEmpty ? Color(hex: 0x1a1a2e) : .white)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(isEmpty ? Color.clear : (focused ? Color.white : Color.white.opacity(0.1)))
                .cornerRadius(12)
        }
        .disabled(isEmpty)
        .opacity(isEmpty ? 0 : 1)
    }
}

// MARK: - Wrap View (for category chips)
struct WrapView<Data: RandomAccessCollection, Content: View>: View where Data.Element: Hashable {
    let items: Data
    var minWidth: CGFloat = 70
    var spacing: CGFloat = 8
    let content: (Data.Element) -> Content

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: minWidth), spacing: spacing)],
                  spacing: spacing) {
            ForEach(items, id: \.self) { item in
                content(item)
            }
        }
    }
}

