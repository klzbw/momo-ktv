import SwiftUI
import Foundation

// MARK: - 歌词模型与解析
// 一个"字/词"及其开始时间（增强 LRC 的 <mm:ss.xx>）
struct LyricToken: Identifiable {
    let id = UUID()
    let time: Double
    let text: String
}

// 一行歌词：start 行起始；tokens 非空时可逐字填色，为空时整行高亮；plain 为纯文本
struct LyricLine: Identifiable {
    let id = UUID()
    let start: Double
    var end: Double
    let plain: String
    let tokens: [LyricToken]?
}

struct SongLyrics {
    let lines: [LyricLine]
    static let empty = SongLyrics(lines: [])
    var isEmpty: Bool { lines.isEmpty }

    /// "[mm:ss.xx]" / "<mm:ss.xx>" / "[mm:ss]" -> 秒；无法解析返回 nil
    private static func timeOf(_ raw: String) -> Double? {
        let s = raw.trimmingCharacters(in: CharacterSet(charactersIn: "[]<> "))
        let parts = s.split(separator: ":")
        guard parts.count >= 2,
              let mm = Double(parts[0]),
              let ss = Double(parts[1]) else { return nil }
        return mm * 60 + ss
    }

    /// 解析 LRC。优先把 <t> 逐字标签解析成 tokens（增强 LRC）；否则按整行。
    /// 一行可能带多个 [t] 时间标签（重复歌词），会展开成多行。
    static func parse(_ lrc: String?) -> SongLyrics {
        guard let lrc = lrc, !lrc.isEmpty else { return .empty }
        var out: [LyricLine] = []
        // 行首所有 [..] 标签
        let tagRegex = try? NSRegularExpression(pattern: "\\[[^\\]]+\\]")
        // 逐字 <mm:ss.xx>
        let wordRegex = try? NSRegularExpression(pattern: "<([0-9:.]+)>")

        for rawLine in lrc.components(separatedBy: .newlines) {
            guard !rawLine.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            let ns = rawLine as NSString
            // 收集行首时间标签（只取形如 [mm:ss...] 的时间标签，跳过 [ar:][ti:] 等元标签）
            var lineStarts: [Double] = []
            var bodyStart = 0
            if let tr = tagRegex {
                let matches = tr.matches(in: rawLine, range: NSRange(location: 0, length: ns.length))
                for m in matches {
                    let inside = ns.substring(with: NSRange(location: m.range.location + 1, length: m.range.length - 2))
                    if let t = timeOf(inside) {
                        lineStarts.append(t)
                        bodyStart = max(bodyStart, m.range.location + m.range.length)
                    }
                }
            }
            let body = ns.substring(from: bodyStart).trimmingCharacters(in: .whitespaces)
            guard !lineStarts.isEmpty, !body.isEmpty else { continue }

            // 解析逐字 token
            var tokens: [LyricToken] = []
            if let wr = wordRegex {
                let wms = wr.matches(in: body, range: NSRange(location: 0, length: (body as NSString).length))
                let bns = body as NSString
                for (i, m) in wms.enumerated() {
                    let tRaw = bns.substring(with: NSRange(location: m.range.location + 1, length: m.range.length - 2))
                    guard let t = timeOf(tRaw) else { continue }
                    let segStart = m.range.location + m.range.length
                    let segEnd = (i + 1 < wms.count) ? wms[i + 1].range.location : bns.length
                    if segEnd > segStart {
                        let piece = bns.substring(with: NSRange(location: segStart, length: segEnd - segStart))
                            .trimmingCharacters(in: .whitespaces)
                        if !piece.isEmpty { tokens.append(LyricToken(time: t, text: piece)) }
                    }
                }
            }
            let useTokens = tokens.count >= 2 ? tokens : nil
            for st in lineStarts {
                out.append(LyricLine(start: st, end: 0,
                                     plain: useTokens == nil ? body : useTokens!.map { $0.text }.joined(),
                                     tokens: useTokens))
            }
        }
        out.sort { $0.start < $1.start }
        // 用下一行起点回填本行结束，最后一行给一个很大的值
        for i in out.indices {
            out[i].end = (i + 1 < out.count) ? out[i + 1].start : .greatestFiniteMagnitude
        }
        // 去重（完全同时间同文本）
        var dedup: [LyricLine] = []
        for l in out where dedup.last?.start != l.start || dedup.last?.plain != l.plain { dedup.append(l) }
        return SongLyrics(lines: dedup)
    }

    /// 当前时间对应的行索引；都还没到返回 -1
    func lineIndex(at t: Double) -> Int {
        var idx = -1
        for (i, l) in lines.enumerated() where l.start <= t + 0.01 { idx = i }
        return idx
    }
}

// MARK: - 歌词加载
final class LyricsLoader: ObservableObject {
    @Published var lyrics = SongLyrics.empty
    @Published var loaded = false
    private var task: URLSessionDataTask?
    private var currentSongId: Int?

    func load(server: String, songId: Int) {
        guard songId != currentSongId || !loaded else { return }
        currentSongId = songId
        loaded = true
        task?.cancel()
        let host = server.replacingOccurrences(of: "http://", with: "").replacingOccurrences(of: "https://", with: "")
        guard let url = URL(string: "http://\(host)/api/songs/\(songId)/lyrics") else { return }
        task = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                DispatchQueue.main.async { self?.lyrics = .empty }
                return
            }
            // 优先逐字增强 LRC，没有再用普通 LRC
            let word = obj["word"] as? String
            let plain = obj["lyrics"] as? String
            let parsed = SongLyrics.parse((word?.isEmpty == false) ? word : plain)
            DispatchQueue.main.async { self?.lyrics = parsed }
        }
        task?.resume()
    }
}

// MARK: - 歌词滚动 + 逐字填色视图
struct LyricsView: View {
    let lyrics: SongLyrics
    let currentTime: Double
    /// 主题高亮色（已唱部分）
    var highlight: Color = Color(red: 1.0, green: 0.78, blue: 0.25)

    private var activeIndex: Int { lyrics.lineIndex(at: currentTime) }

    var body: some View {
        if lyrics.isEmpty {
            Text("♪ 纯音乐 · 请欣赏 ♪")
                .font(.system(size: 30, weight: .semibold))
                .foregroundColor(.white.opacity(0.55))
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 26) {
                        ForEach(Array(lyrics.lines.enumerated()), id: \.element.id) { idx, line in
                            lineView(line, idx: idx)
                                .id(line.id)
                        }
                    }
                    .padding(.vertical, 220) // 上下留白，让首/末行也能滚到中间
                    .padding(.horizontal, 60)
                }
                .onChange(of: activeIndex) { newValue in
                    guard newValue >= 0 else { return }
                    withAnimation(.easeOut(duration: 0.35)) {
                        proxy.scrollTo(lyrics.lines[newValue].id, anchor: .center)
                    }
                }
            }
            .disabled(true) // 歌词区不抢遥控器焦点，只做展示
        }
    }

    @ViewBuilder
    private func lineView(_ line: LyricLine, idx: Int) -> some View {
        let active = idx == activeIndex
        if active, let tokens = line.tokens {
            // 当前行：逐字填色，已唱的点亮，未到的半透明白
            HStack(spacing: 0) {
                ForEach(tokens) { tok in
                    Text(tok.text)
                        .foregroundColor(currentTime >= tok.time ? highlight : Color.white.opacity(0.4))
                }
            }
            .font(.system(size: 40, weight: .bold))
            .multilineTextAlignment(.center)
            .shadow(color: .black.opacity(0.6), radius: 6, x: 0, y: 2)
        } else {
            Text(line.plain)
                .font(.system(size: active ? 40 : 30, weight: active ? .bold : .medium))
                .foregroundColor(active ? Color.white : Color.white.opacity(0.4))
                .multilineTextAlignment(.center)
                .shadow(color: .black.opacity(active ? 0.6 : 0), radius: active ? 6 : 0, x: 0, y: 2)
        }
    }
}
