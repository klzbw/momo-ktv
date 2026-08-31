import SwiftUI
import Foundation
import UIKit

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
        let tagRegex = try? NSRegularExpression(pattern: "\\[[^\\]]+\\]")
        let wordRegex = try? NSRegularExpression(pattern: "<([0-9:.]+)>")

        for rawLine in lrc.components(separatedBy: .newlines) {
            guard !rawLine.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            let ns = rawLine as NSString
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
        for i in out.indices {
            out[i].end = (i + 1 < out.count) ? out[i + 1].start : .greatestFiniteMagnitude
        }
        var dedup: [LyricLine] = []
        for l in out where dedup.last?.start != l.start || dedup.last?.plain != l.plain { dedup.append(l) }
        return SongLyrics(lines: dedup)
    }

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
            guard let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                DispatchQueue.main.async { self?.lyrics = .empty }
                return
            }
            let word = obj["word"] as? String
            let plain = obj["lyrics"] as? String
            let parsed = SongLyrics.parse((word?.isEmpty == false) ? word : plain)
            DispatchQueue.main.async { self?.lyrics = parsed }
        }
        task?.resume()
    }
}

// MARK: - 歌词显示模式
enum LyricsDisplayMode: String {
    case dual
    case scroll
    static func from(_ raw: String) -> LyricsDisplayMode { raw == "scroll" ? .scroll : .dual }
    var next: LyricsDisplayMode { self == .dual ? .scroll : .dual }
    var label: String { self == .dual ? "双排" : "滚动" }
}

/// 解析 "#RRGGBB" 或 "RRGGBB" 字符串为 SwiftUI Color
private func colorFromHex(_ hex: String) -> Color {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s = String(s.dropFirst()) }
    var rgb: UInt64 = 0
    Scanner(string: s).scanHexInt64(&rgb)
    return Color(red: Double((rgb >> 16) & 0xFF) / 255.0,
                 green: Double((rgb >> 8) & 0xFF) / 255.0,
                 blue: Double(rgb & 0xFF) / 255.0)
}

// MARK: - 卡拉OK k 标签逐字渐变：底层未唱(白) + 上层已唱(金)按进度从左到右裁剪叠加，带描边
struct KaraokeWord: View {
    let text: String
    let progress: Double
    var highlight: Color = Color(red: 1.0, green: 0.78, blue: 0.25)
    var base: Color = Color.white.opacity(0.42)
    var stroke: Color = .black

    private func stroked(_ t: String, fill: Color) -> Text {
        var a = AttributedString(t)
        a.foregroundColor = UIColor(fill)
        a.strokeColor = UIColor(stroke)
        a.strokeWidth = -2.5
        return Text(a)
    }

    var body: some View {
        stroked(text, fill: base)
            .overlay(alignment: .leading) {
                GeometryReader { geo in
                    stroked(text, fill: highlight)
                        .frame(width: geo.size.width * CGFloat(min(max(progress, 0), 1)),
                               alignment: .leading)
                        .clipped()
                }
            }
    }
}

// MARK: - 歌词滚动 + 逐字填色视图（双模式）
struct LyricsView: View {
    let lyrics: SongLyrics
    let currentTime: Double
    @AppStorage("momoLyricsColor") private var lyricsColorHex: String = "#FFD24A"
    @AppStorage("momoLyricsStroke") private var lyricsStrokeHex: String = "#000000"
    private var highlight: Color { colorFromHex(lyricsColorHex) }
    private var stroke: Color { colorFromHex(lyricsStrokeHex) }
    @AppStorage("momoLyricsMode") private var modeRaw: String = LyricsDisplayMode.dual.rawValue
    private var mode: LyricsDisplayMode { .from(modeRaw) }

    private var activeIndex: Int { lyrics.lineIndex(at: currentTime) }

    var body: some View {
        if lyrics.isEmpty {
            Text("♪ 纯音乐 · 请欣赏 ♪")
                .font(.system(size: 30, weight: .semibold))
                .foregroundColor(.white.opacity(0.55))
        } else if mode == .dual {
            dualBody
        } else {
            scrollBody
        }
    }

    private var dualBody: some View {
        let ai = activeIndex
        return VStack(spacing: 22) {
            Spacer(minLength: 0)
            if ai >= 0 {
                lineView(lyrics.lines[ai], idx: ai)
                    .id(lyrics.lines[ai].id)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            if ai + 1 < lyrics.lines.count {
                lineView(lyrics.lines[ai + 1], idx: ai + 1)
                    .id(lyrics.lines[ai + 1].id)
                    .transition(.opacity)
            }
            Spacer(minLength: 0)
        }
        .animation(.easeOut(duration: 0.25), value: ai)
        .padding(.horizontal, 70)
    }

    private var scrollBody: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 26) {
                    ForEach(Array(lyrics.lines.enumerated()), id: \.element.id) { idx, line in
                        lineView(line, idx: idx)
                            .id(line.id)
                    }
                }
                .padding(.vertical, 220)
                .padding(.horizontal, 60)
            }
            .onChange(of: activeIndex) { newValue in
                guard newValue >= 0 else { return }
                withAnimation(.easeOut(duration: 0.35)) {
                    proxy.scrollTo(lyrics.lines[newValue].id, anchor: .center)
                }
            }
        }
        .disabled(true)
    }

    @ViewBuilder
    private func lineView(_ line: LyricLine, idx: Int) -> some View {
        let active = idx == activeIndex
        let isDual = mode == .dual
        let preview = isDual && idx == activeIndex + 1
        if active, let tokens = line.tokens {
            HStack(spacing: 0) {
                ForEach(Array(tokens.enumerated()), id: \.element.id) { idx, tok in
                    KaraokeWord(
                        text: tok.text,
                        progress: tokenProgress(tok, tokens: tokens, index: idx, lineEnd: line.end),
                        highlight: highlight,
                        base: Color.white.opacity(0.42),
                        stroke: stroke
                    )
                }
            }
            .font(.system(size: isDual ? 46 : 40, weight: .bold))
            .multilineTextAlignment(.center)
        } else {
            let sz: CGFloat = active ? (isDual ? 46 : 40) : 30
            let fill = active ? highlight : Color.white.opacity(preview ? 0.5 : 0.4)
            strokedLine(line.plain, fill: fill, size: sz, weight: active ? .bold : .medium)
        }
    }

    /// 带描边的整行文字（非逐字 LRC 用）
    private func strokedLine(_ text: String, fill: Color, size: CGFloat, weight: Font.Weight) -> some View {
        var a = AttributedString(text)
        a.foregroundColor = UIColor(fill)
        a.strokeColor = UIColor(stroke)
        a.strokeWidth = -2.5
        a.font = UIFont.systemFont(ofSize: size, weight: weight == .bold ? .bold : .regular)
        return Text(a)
            .multilineTextAlignment(.center)
    }

    /// 卡拉OK k 标签：单个字在 [start, end] 区间内的演唱进度 0...1
    private func tokenProgress(_ tok: LyricToken, tokens: [LyricToken], index: Int, lineEnd: Double) -> Double {
        let end: Double
        if index + 1 < tokens.count {
            end = tokens[index + 1].time
        } else {
            end = lineEnd < .greatestFiniteMagnitude ? lineEnd : tok.time + 1.5
        }
        let dur = max(0.05, end - tok.time)
        return min(max((currentTime - tok.time) / dur, 0), 1)
    }
}
