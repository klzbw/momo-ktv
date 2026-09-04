import SwiftUI

// MARK: - 网络KTV歌曲列表页
/// 115网盘直连双FLAC播放的歌曲列表
struct NetKtvListView: View {
    @ObservedObject var api: KTVAPIClient
    @ObservedObject var player: PlayerManager
    let onBack: () -> Void

    @State private var isPlaying = false

    var body: some View {
        FullPageContainer(title: "网络KTV · 115网盘直连", onBack: onBack) {
            ZStack {
                if api.netKtvLoading {
                    // 加载中
                    VStack(spacing: 16) {
                        ProgressView()
                            .scaleEffect(1.5)
                        Text("正在从115网盘加载歌曲...")
                            .font(.system(size: 18))
                            .foregroundColor(WebColors.sub)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = api.netKtvError {
                    // 错误
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 48))
                            .foregroundColor(.orange)
                        Text("加载失败")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundColor(.white)
                        Text(error)
                            .font(.system(size: 16))
                            .foregroundColor(WebColors.sub)
                            .multilineTextAlignment(.center)
                        TVTightButton(action: { api.fetchNetKtvSongs() }) { focused in
                            HStack(spacing: 6) {
                                Image(systemName: "arrow.clockwise")
                                Text("重试")
                            }
                            .font(.system(size: 17))
                            .padding(.horizontal, 24).padding(.vertical, 10)
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : Color.white)
                            .background(focused ? Color.white : WebColors.ac)
                            .cornerRadius(999)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.horizontal, 40)
                } else if api.netKtvSongs.isEmpty {
                    // 空列表
                    VStack(spacing: 16) {
                        Image(systemName: "music.note.list")
                            .font(.system(size: 48))
                            .foregroundColor(WebColors.sub)
                        Text("暂无歌曲")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundColor(.white)
                        Text("请先在服务端上传分离文件到115网盘")
                            .font(.system(size: 16))
                            .foregroundColor(WebColors.sub)
                        TVTightButton(action: { api.fetchNetKtvSongs() }) { focused in
                            HStack(spacing: 6) {
                                Image(systemName: "arrow.clockwise")
                                Text("刷新")
                            }
                            .font(.system(size: 17))
                            .padding(.horizontal, 24).padding(.vertical, 10)
                            .foregroundColor(focused ? Color(hex: 0x1a1a2e) : Color.white)
                            .background(focused ? Color.white : WebColors.ac)
                            .cornerRadius(999)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    // 歌曲列表
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(api.netKtvSongs) { song in
                                NetKtvSongRow(
                                    song: song,
                                    isPlaying: player.isNetKtvPlaying && player.dualSongId == 0,
                                    onPlay: { playSong(song) }
                                )
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, 16)
                    }
                }
            }
        }
        .onAppear {
            if api.netKtvSongs.isEmpty {
                api.fetchNetKtvSongs()
            }
        }
    }

    private func playSong(_ song: NetKtvSong) {
        guard let vocalURL = api.netKtvStreamURL(song: song, type: "vocals"),
              let accompURL = api.netKtvStreamURL(song: song, type: "accompaniment") else {
            return
        }
        player.setupNetKtvPlayer(songId: song.id, vocalURL: vocalURL, accompURL: accompURL)
        isPlaying = true
    }
}

// MARK: - 网络KTV歌曲行
struct NetKtvSongRow: View {
    let song: NetKtvSong
    let isPlaying: Bool
    let onPlay: () -> Void

    var body: some View {
        TVTightButton(action: onPlay) { focused in
            HStack(spacing: 16) {
                // 封面/图标
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(focused ? Color.white.opacity(0.15) : WebColors.cardBg)
                        .frame(width: 56, height: 56)
                    Image(systemName: isPlaying ? "waveform" : "music.note")
                        .font(.system(size: 24))
                        .foregroundColor(isPlaying ? WebColors.ac : (focused ? .white : WebColors.sub))
                }

                // 歌曲信息
                VStack(alignment: .leading, spacing: 4) {
                    Text(song.displayTitle)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                        .lineLimit(1)
                    Text(song.displayArtist)
                        .font(.system(size: 14))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e).opacity(0.7) : WebColors.sub)
                        .lineLimit(1)
                }

                Spacer()

                // 大小和标签
                VStack(alignment: .trailing, spacing: 4) {
                    Text(song.totalSizeText)
                        .font(.system(size: 14))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e).opacity(0.7) : WebColors.sub)
                    HStack(spacing: 4) {
                        Image(systemName: "person.2.fill")
                            .font(.system(size: 10))
                        Text("双FLAC")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : WebColors.ac)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(focused ? Color.white.opacity(0.3) : WebColors.ac.opacity(0.15))
                    .cornerRadius(4)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(focused ? Color.white : WebColors.cardBg)
            .cornerRadius(12)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isPlaying ? WebColors.ac : Color.clear, lineWidth: 2)
            )
        }
    }
}
