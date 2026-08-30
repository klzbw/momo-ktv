import SwiftUI
import AVKit

// MARK: - Song Row
struct SongRow: View {
    let song: Song
    let index: Int
    let onAdd: () -> Void
    let onPlay: () -> Void
    let isFavorite: Bool
    let onToggleFav: () -> Void
    @Environment(\.theme) var theme

    var body: some View {
        HStack(spacing: 12) {
            Text("\(index + 1)")
                .font(.caption)
                .foregroundColor(theme.subText)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(song.displayTitle)
                    .font(.body)
                    .foregroundColor(theme.text)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    Text(song.displayArtist)
                        .font(.caption)
                        .foregroundColor(theme.subText)
                    if song.hasMultiTrack {
                        Text("伴唱")
                            .font(.system(size: 9))
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(theme.accent.opacity(0.3))
                            .cornerRadius(3)
                    }
                    if !song.durationText.isEmpty {
                        Text(song.durationText)
                            .font(.caption2)
                            .foregroundColor(theme.subText)
                    }
                }
            }
            Spacer()
            TVTightButton(action: onToggleFav) { focused in
                Image(systemName: isFavorite ? "heart.fill" : "heart")
                    .foregroundColor(isFavorite ? theme.pink : (focused ? Color(hex: 0x1a1a2e) : theme.subText))
                    .frame(width: 44, height: 44)
                    .background(focused ? Color.white : Color.clear)
                    .cornerRadius(8)
            }
            TVTightButton(action: onAdd) { focused in
                Text("点歌")
                    .font(.caption)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(focused ? Color.white : theme.accent.opacity(0.8))
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                    .cornerRadius(6)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(theme.cardBg)
        .cornerRadius(8)
    }
}

// MARK: - Queue Row
struct QueueRow: View {
    let item: QueueItem
    let onTop: () -> Void
    let onDelete: () -> Void
    @Environment(\.theme) var theme

    var body: some View {
        HStack(spacing: 14) {
            if item.isPlaying {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(.green)
            } else if item.isTop {
                Image(systemName: "pin.fill")
                    .font(.system(size: 28))
                    .foregroundColor(theme.accent)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(item.displayTitle)
                    .font(.system(size: 30, weight: .bold))
                    .foregroundColor(item.isPlaying ? .green : theme.text)
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(item.displayArtist) · \(item.nickname ?? "匿名")")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundColor(theme.subText)
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if !item.isPlaying {
                TVTightButton(action: onTop) { focused in
                    Image(systemName: "arrow.up.to.line")
                        .font(.system(size: 26))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : theme.subText)
                        .frame(width: 56, height: 56)
                        .background(focused ? Color.white : Color.clear)
                        .cornerRadius(8)
                }
                TVTightButton(action: onDelete) { focused in
                    Image(systemName: "trash")
                        .font(.system(size: 26))
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : theme.pink)
                        .frame(width: 56, height: 56)
                        .background(focused ? Color.white : Color.clear)
                        .cornerRadius(8)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 18)
        .background(theme.cardBg)
        .cornerRadius(10)
    }
}

// MARK: - Category Chip
struct CategoryChip: View {
    let icon: String
    let title: String
    let gradient: LinearGradient
    let action: () -> Void
    @Environment(\.theme) var theme

    var body: some View {
        TVTightButton(action: action) { focused in
            VStack(spacing: 8) {
                ZStack {
                    Group {
                        if focused {
                            RoundedRectangle(cornerRadius: 14).fill(Color.white)
                        } else {
                            RoundedRectangle(cornerRadius: 14).fill(gradient)
                        }
                    }
                    .frame(width: 56, height: 56)
                    Image(systemName: icon)
                        .font(.title2)
                        .foregroundColor(focused ? Color(hex: 0x1a1a2e) : .white)
                }
                Text(title)
                    .font(.caption)
                    .foregroundColor(focused ? Color(hex: 0x1a1a2e) : theme.text)
            }
            .frame(width: 80)
        }
    }
}

// MARK: - Toast
struct ToastView: View {
    let message: String
    @Environment(\.theme) var theme
    var body: some View {
        Text(message)
            .font(.caption)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(theme.navy.opacity(0.9))
            .foregroundColor(theme.text)
            .cornerRadius(8)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.accent.opacity(0.5)))
    }
}

// MARK: - Loading View
struct LoadingView: View {
    let text: String
    @Environment(\.theme) var theme
    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(text).font(.caption).foregroundColor(theme.subText)
        }
    }
}

// MARK: - Empty View
struct EmptyStateView: View {
    let icon: String
    let text: String
    @Environment(\.theme) var theme
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.largeTitle).foregroundColor(theme.subText)
            Text(text).font(.body).foregroundColor(theme.subText)
        }
    }
}

// MARK: - Clock View
struct ClockView: View {
    @State private var now = Date()
    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    @Environment(\.theme) var theme

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(timeString).font(.headline).foregroundColor(theme.text)
            Text(dateString).font(.caption2).foregroundColor(theme.subText)
        }
        .onReceive(timer) { now = $0 }
    }

    private var timeString: String {
        let f = DateFormatter(); f.dateFormat = "HH:mm"
        return f.string(from: now)
    }
    private var dateString: String {
        let f = DateFormatter(); f.dateFormat = "MM/dd EEE"
        return f.string(from: now)
    }
}

// MARK: - Connection Status
struct ConnectionBadge: View {
    let connected: Bool
    @Environment(\.theme) var theme
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(connected ? Color.green : Color.red).frame(width: 6, height: 6)
            Text(connected ? "已连接" : "未连接").font(.caption2).foregroundColor(theme.subText)
        }
    }
}

