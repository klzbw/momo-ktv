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

// MARK: - 歌词显示模式（双排 / 上下滚动），遥控器或全屏按钮可切换，@AppStorage 全局记忆
enum LyricsDisplayMode: String {
    case dual    // 双排卡拉OK式：当前行大字逐字 + 下一行小字预告
    case scroll  // 上下滚动：整列歌词平滑滚动，当前行居中
    static func from(_ raw: String) -> LyricsDisplayMode { raw == "scroll" ? .scroll : .dual }
    var next: LyricsDisplayMode { self == .dual ? .scroll : .dual }
    var label: String { self == .dual ? "双排" : "滚动" }
}

// MARK: - 卡拉OK k 标签逐字渐变：底层未唱(白) + 上层已唱(金)按进度从左到右裁剪叠加
struct KaraokeWord: View {
    let text: String
    let progress: Double  // 0...1，字在 [start,end] 区间内的演唱进度
    let highlight: Color
    let base: Color
    var body: some View {
        Text(text)
            .foregroundColor(base)
            .overlay(alignment: .leading) {
                GeometryReader { geo in
                    Text(text)
                        .foregroundColor(highlight)
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
    /// 主题高亮色（已唱部分）
    var highlight: Color = Color(red: 1.0, green: 0.78, blue: 0.25)
    /// 显示模式，默认双排；与全屏控制页用同一个 AppStorage key 共享
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

    // 双排：当前行（大字逐字）+ 下一行（小字预告），固定居中不滚动
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

    // 上下滚动：整列歌词，当前行平滑滚到中间
    private var scrollBody: some View {
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

    @ViewBuilder
    private func lineView(_ line: LyricLine, idx: Int) -> some View {
        let active = idx == activeIndex
        let isDual = mode == .dual
        // 双排模式下"下一行"更小更淡；滚动模式非当前行常规缩小
        let preview = isDual && idx == activeIndex + 1
        if active, let tokens = line.tokens {
            // 当前行：卡拉OK k 标签逐字渐变，每个字在 [start,end] 内从左到右由白→金横向扫过
            HStack(spacing: 0) {
                ForEach(Array(tokens.enumerated()), id: \.element.id) { idx, tok in
                    KaraokeWord(
                        text: tok.text,
                        progress: tokenProgress(tok, tokens: tokens, index: idx, lineEnd: line.end),
                        highlight: highlight,
                        base: Color.white.opacity(0.42)
                    )
                }
            }
            .font(.system(size: isDual ? 46 : 40, weight: .bold))
            .multilineTextAlignment(.center)
            .shadow(color: .black.opacity(0.6), radius: 6, x: 0, y: 2)
        } else {
            Text(line.plain)
                .font(.system(size: active ? (isDual ? 46 : 40) : (preview ? 30 : 30),
                              weight: active ? .bold : .medium))
                .foregroundColor(active ? Color.white : Color.white.opacity(preview ? 0.5 : 0.4))
                .multilineTextAlignment(.center)
                .shadow(color: .black.opacity(active ? 0.6 : 0), radius: active ? 6 : 0, x: 0, y: 2)
        }
    }

    /// 卡拉OK k 标签：单个字在 [start, end] 区间内的演唱进度 0...1；
    /// end 取下一个字的起点，最后一字用行尾（无限则 +1.5s 延长音）
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
