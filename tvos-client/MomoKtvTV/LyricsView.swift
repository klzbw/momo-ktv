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
    var tokens: [LyricToken]?
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
            // 逐字歌词行的end取最后一个token的时间（而非下一行start），
            // 避免行间距被算进行持续时间，导致间奏判断异常
            if let tokens = out[i].tokens, !tokens.isEmpty {
                let lastTok = tokens.max(by: { $0.time < $1.time })!
                out[i].end = (i + 1 < out.count) ? min(out[i + 1].start, lastTok.time + 1.0) : lastTok.time + 1.0
            } else {
                out[i].end = (i + 1 < out.count) ? out[i + 1].start : .greatestFiniteMagnitude
            }
            // 伪逐字：没有逐字标签的行，按字符平均分配行时间，实现近似逐字扫过
            if out[i].tokens == nil, !out[i].plain.trimmingCharacters(in: .whitespaces).isEmpty,
               out[i].end < .greatestFiniteMagnitude, out[i].end > out[i].start {
                let chars = Array(out[i].plain).filter { !$0.isWhitespace }
                if chars.count >= 2 {
                    let dur = (out[i].end - out[i].start) / Double(chars.count)
                    out[i].tokens = chars.enumerated().map { j, c in
                        LyricToken(time: out[i].start + dur * Double(j), text: String(c))
                    }
                }
            }
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
    @Published var loading = false          // 正在加载/更新歌词（用于显示"歌词更新中"）
    @Published var lyricsUpdated = false    // 歌词已更新提示（显示"歌词已刷新"2.5秒后自动消失）
    private var task: URLSessionDataTask?
    private var currentSongId: Int?
    private var lastReloadTime: TimeInterval = 0  // reload防抖：避免服务端生成过程中频繁触发
    private var requestGeneration = 0       // 请求版本号：防止旧回调覆盖新歌词（竞态条件修复）

    /// 强制重新拉取同一首歌（歌词时间轴被固化写回后调用，绕过 load 的去重守卫）
    /// 无缝替换：不清空旧歌词，直接加载新歌词，加载完成后平滑替换（播放不中断、无空白）
    func reload(server: String, songId: Int) {
        // 防抖：2秒内同一首歌只允许reload一次，避免频繁替换
        let now = Date().timeIntervalSince1970
        guard now - lastReloadTime > 2.0 else { return }
        lastReloadTime = now
        // 不清空旧歌词（无缝衔接），直接加载新歌词，加载完成后替换
        currentSongId = nil
        loaded = false
        load(server: server, songId: songId)
    }

    func load(server: String, songId: Int) {
        guard songId != currentSongId || !loaded else { return }
        let wasAlreadyLoaded = loaded  // 记录之前是否已加载（用于判断是否是重新生成后的刷新）
        currentSongId = songId
        loaded = true
        loading = true
        task?.cancel()
        // 递增请求版本号：旧回调发现版本号不匹配时自动丢弃，防止覆盖新歌词
        requestGeneration += 1
        let myGeneration = requestGeneration
        let host = server.replacingOccurrences(of: "http://", with: "").replacingOccurrences(of: "https://", with: "")
        guard let url = URL(string: "http://\(host)/api/songs/\(songId)/lyrics") else {
            loading = false
            return
        }
        task = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let self else { return }
            // 竞态条件修复：如果这不是最新的请求，直接丢弃结果，不覆盖新歌词
            guard myGeneration == self.requestGeneration else {
                print("[LyricsLoader] 丢弃旧请求结果 (generation=\(myGeneration), current=\(self.requestGeneration))")
                return
            }
            // 如果请求被取消，也不处理
            if let error = error as? URLError, error.code == .cancelled {
                return
            }
            DispatchQueue.main.async { self.loading = false }
            guard let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                DispatchQueue.main.async { self.lyrics = .empty }
                return
            }
            let word = obj["word"] as? String
            let plain = obj["lyrics"] as? String
            let parsed = SongLyrics.parse((word?.isEmpty == false) ? word : plain)
            DispatchQueue.main.async {
                // 再次检查版本号，确保主线程设置时还是最新请求
                guard myGeneration == self.requestGeneration else { return }
                self.lyrics = parsed
                // 非首次加载（重新生成后的刷新），显示"歌词已刷新"提示
                if wasAlreadyLoaded {
                    self.lyricsUpdated = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                        self?.lyricsUpdated = false
                    }
                }
            }
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
// MARK: - 歌词样式单例：遥控端改字色/描边色/描边粗细时实时刷新（@AppStorage 在 fullScreenCover 下偶发不刷新，改用可观察对象）
final class LyricsStyleStore: ObservableObject {
    static let shared = LyricsStyleStore()
    @Published var colorHex: String
    @Published var strokeHex: String
    @Published var lineWidth: CGFloat        // 描边粗细（点），遥控端可调 0...12
    @Published var fontScale: CGFloat        // 字号倍率，遥控端可调 0.7...3.0，默认 1
    @Published var posV: CGFloat             // 歌词整体垂直位置：距底部百分比 0...60，默认18，越大越靠上
    @Published var dualFlip: Bool            // 双排左右翻转：false=单左双右，true=单右双左
    private init() {
        colorHex = UserDefaults.standard.string(forKey: "momoLyricsColor") ?? "#FFD24A"
        strokeHex = UserDefaults.standard.string(forKey: "momoLyricsStroke") ?? "#000000"
        let savedW = UserDefaults.standard.double(forKey: "momoLyricsWidth")
        lineWidth = savedW > 0 ? CGFloat(savedW) : 5
        let savedS = UserDefaults.standard.double(forKey: "momoLyricsScale")
        fontScale = savedS > 0 ? CGFloat(savedS) : 1
        if let savedP = UserDefaults.standard.object(forKey: "momoLyricsPos") as? Double {
            posV = CGFloat(savedP)
        } else { posV = 0 }
        dualFlip = UserDefaults.standard.bool(forKey: "momoLyricsDualFlip")  // 默认false=单左双右
    }
    func apply(color: String?, stroke: String?, width: CGFloat? = nil, scale: CGFloat? = nil, posV: CGFloat? = nil, dualFlip: Bool? = nil) {
        if let c = color, !c.isEmpty {
            colorHex = c
            UserDefaults.standard.set(c, forKey: "momoLyricsColor")
        }
        if let st = stroke, !st.isEmpty {
            strokeHex = st
            UserDefaults.standard.set(st, forKey: "momoLyricsStroke")
        }
        if let w = width {
            lineWidth = max(0, min(12, w))
            UserDefaults.standard.set(Double(lineWidth), forKey: "momoLyricsWidth")
        }
        if let sc = scale {
            fontScale = max(0.7, min(3.0, sc))
            UserDefaults.standard.set(Double(fontScale), forKey: "momoLyricsScale")
        }
        if let pv = posV {
            self.posV = max(0, min(60, pv))
            UserDefaults.standard.set(Double(self.posV), forKey: "momoLyricsPos")
        }
        if let df = dualFlip {
            self.dualFlip = df
            UserDefaults.standard.set(df, forKey: "momoLyricsDualFlip")
        }
    }
}

// MARK: - 描边文字：单个 Text 叠加 8 方向锐利阴影形成轮廓。
// 性能关键：只保留 1 个 Text 视图节点(阴影交给 GPU 合成)，不再为描边复制 8~9 个 Text——
// 否则逐字双层 × 每行十几字 × 每秒数十次刷新会产生数百个文本视图，拖卡整个 app。
struct StrokeFillText: View {
    let text: String
    let fill: Color
    let strokeColor: Color
    let w: CGFloat

    var body: some View {
        let on = w > 0.01
        let c = on ? strokeColor : Color.clear
        let r = w * 0.30
        // let d = w * 0.7071  // 对角描边已移除，减少GPU开销
        Text(text)
            .foregroundColor(fill)
            .shadow(color: c, radius: r, x: w, y: 0)
            .shadow(color: c, radius: r, x: -w, y: 0)
            .shadow(color: c, radius: r, x: 0, y: w)
            .shadow(color: c, radius: r, x: 0, y: -w)
            // 4方向描边已足够清晰，去掉4个对角减少GPU合成层数（原8层->4层）
    }
}

// MARK: - 卡拉OK k 标签逐字渐变：底层未唱(白) + 上层已唱(主题色)用遮罩从左到右揭开，
// 扫色前缘带一段线性羽化(黑→透明)形成"消色过渡"，比硬边裁剪更顺滑；遮罩走 GPU，且省掉 GeometryReader。
struct KaraokeWord: View {
    let text: String
    let progress: Double
    var highlight: Color = Color(red: 1.0, green: 0.78, blue: 0.25)
    var base: Color = Color.white.opacity(0.42)
    var stroke: Color = .black
    var lineW: CGFloat = 5

    var body: some View {
        let p = CGFloat(min(max(progress, 0), 1))
        let edge: CGFloat = 0.14   // 扫色前缘羽化带占该字宽度比例
        StrokeFillText(text: text, fill: base, strokeColor: stroke, w: lineW)
            .overlay {
                StrokeFillText(text: text, fill: highlight, strokeColor: stroke, w: lineW)
                    .mask(
                        LinearGradient(
                            stops: [
                                .init(color: .black, location: 0),
                                .init(color: .black, location: max(0, p - edge)),
                                .init(color: .clear, location: min(1, p)),
                                .init(color: .clear, location: 1)
                            ],
                            startPoint: .leading, endPoint: .trailing)
                    )
                    .animation(.linear(duration: 0.06), value: p)
            }
    }
}

// MARK: - 歌词滚动 + 逐字填色视图（双模式）
struct LyricsView: View {
    let lyrics: SongLyrics
    let currentTime: Double
    var compact: Bool = false        // 首页小窗预览用小字号
    var timeOffset: Double = 0       // 歌词时间轴整体偏移（秒）：正值=歌词延后出现，负值=提前出现，用于唱字同步校准
    @ObservedObject private var styleStore = LyricsStyleStore.shared
    @AppStorage("momoLyricsMode") private var modeRaw: String = LyricsDisplayMode.dual.rawValue
    @State private var hintPulse = false  // 间奏提示呼吸脉冲动画状态
    @State private var showUpdatedTip = false  // 歌词已更新提示（2.5秒后自动消失）
    // 用@AppStorage持久化记录上一次歌词签名，避免视图重建时@State被重置导致提示失效
    @AppStorage("momoLastLyricsSig") private var lastLyricsSig: String = ""

    /// 校准后的时间（叠加用户调节的偏移）
    private var displayTime: Double { currentTime + timeOffset }
    /// 字号对齐网页 TV 端：双排当前/预备均 58(.black 同字号)；滚动当前 52、邻近 36；再统一乘遥控可调倍率 fontScale
    private var sc: CGFloat { styleStore.fontScale }
    private var activeSize: CGFloat { (compact ? 26 : 58) * sc }
    private var scrollActiveSize: CGFloat { (compact ? 21 : 52) * sc }
    private var near1Size: CGFloat { (compact ? 15 : 36) * sc }
    private var mode: LyricsDisplayMode { .from(modeRaw) }
    private var highlight: Color { colorFromHex(styleStore.colorHex) }
    private var stroke: Color { colorFromHex(styleStore.strokeHex) }

    private var activeIndex: Int { lyrics.lineIndex(at: displayTime) }

    /// 间奏状态：一次遍历同时算出nextIdx/isInterlude/wait，避免多次O(n)遍历拖卡
    private struct InterludeState {
        var nextIdx: Int = -1
        var isInterlude: Bool = false
        var wait: Double = 0
    }
    private var interlude: InterludeState {
        let t = displayTime
        var s = InterludeState()
        for (i, line) in lyrics.lines.enumerated() {
            if line.start > t { s.nextIdx = i; s.wait = max(0, line.start - t); break }
        }
        let ai = activeIndex
        if ai < 0 {
            s.isInterlude = lyrics.lines.first.map { t < $0.start - 0.3 } ?? false
        } else if ai < lyrics.lines.count {
            let cur = lyrics.lines[ai]
            // 逐字歌词：用实际最后一个字结束时间判断间奏，不被lineEnd拉长
            let actualEnd: Double
            if let tokens = cur.tokens, !tokens.isEmpty {
                if tokens.count >= 2 {
                    let avgDur = (tokens[tokens.count - 1].time - tokens[0].time) / Double(tokens.count - 1)
                    actualEnd = tokens[tokens.count - 1].time + max(0.15, min(avgDur, 0.8))
                } else {
                    actualEnd = tokens[0].time + 0.3
                }
            } else {
                actualEnd = cur.end
            }
            if t > actualEnd + 0.2 {
                s.isInterlude = (ai + 1 >= lyrics.lines.count) || (t < lyrics.lines[ai + 1].start)
            }
        }
        return s
    }

    /// 歌词签名（行数+首句+末句+总字符数），用于检测歌词内容变化
    /// 比只用行数+首句更可靠，避免重新生成后签名相同不触发
    private var lyricsSignature: String {
        guard !lyrics.lines.isEmpty else { return "empty" }
        let first = lyrics.lines.first?.plain ?? ""
        let last = lyrics.lines.last?.plain ?? ""
        let totalChars = lyrics.lines.reduce(0) { $0 + $1.plain.count }
        return "\(lyrics.lines.count)_\(first)_\(last)_\(totalChars)"
    }

    var body: some View {
        GeometryReader { geo in
            Group {
                if lyrics.isEmpty {
                    Text("♪ 纯音乐 · 请欣赏 ♪")
                        .font(.system(size: compact ? 16 : 34, weight: .semibold))
                        .foregroundColor(.white.opacity(0.55))
                } else if mode == .dual {
                    dualBody
                } else {
                    scrollBody
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // 遥控可调的歌词整体上下位置：posV=18 为默认(位移0)，调大整体上移、调小下移
            .offset(y: -styleStore.posV / 100.0 * geo.size.height * 0.62)
            .animation(.easeOut(duration: 0.18), value: styleStore.posV)
            // 歌词已更新提示（右上角浮动提示，2.5秒后自动消失）
            .overlay(alignment: .topTrailing) {
                if showUpdatedTip {
                    Text("歌词已刷新")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background(
                            RoundedRectangle(cornerRadius: 16)
                                .fill(Color.green.opacity(0.85))
                                .shadow(color: .black.opacity(0.4), radius: 8, x: 0, y: 4)
                        )
                        .padding(.top, 60)
                        .padding(.trailing, 40)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.3), value: showUpdatedTip)
        }
        // onChange 放在 GeometryReader 外部，避免内部重绘时反复注册
        // 用@AppStorage持久化记录上一次签名，首次加载不提示，后续刷新才显示
        .onChange(of: lyricsSignature) { _, newSig in
            guard !newSig.isEmpty && newSig != "empty" else { return }
            if !lastLyricsSig.isEmpty && newSig != lastLyricsSig {
                showUpdatedTip = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    showUpdatedTip = false
                }
            }
            lastLyricsSig = newSig
        }
    }

    // 双排模式（上下两排·左右错落·只羽化不跳动）：奇数句(单)恒在上排且靠左，偶数句(双)恒在下排且靠右(不居中)，
    // 每排占满屏宽(字号可放很大)。当前演唱句所在排逐字高亮，另一排提前显示下一句(预备、同字号、暗淡)；某句到来时
    // 在自己固定位置原地变亮，唱完后另一排羽化换为再下一句——全程不跨排跳动，位置/大小不变。
    private var dualBody: some View {
        let ai = activeIndex
        let il = interlude
        // 间奏预唱提示：逐字歌词和非逐字歌词都显示
        // 逐字歌词最后一个字羽化正常结束后，间奏用🎵🎵🎵占位
        // 阈值1.5秒：超过1.5秒的间奏才显示预唱提示
        let showHint = il.isInterlude && il.wait > 1.5
        // dualFlip=false: 单左双右；dualFlip=true: 单右双左
        let topAlign: Alignment = styleStore.dualFlip ? .trailing : .leading
        let bottomAlign: Alignment = styleStore.dualFlip ? .leading : .trailing
        return VStack(spacing: compact ? 12 : 32) {  // 增加行间距，防止两排歌词挤在一起
            Spacer(minLength: 0)
            if il.isInterlude {
                // 间奏/前奏：当前行歌词淡出，不显示
                // 上排：间奏>1.5秒显示🎵🎵🎵预唱提示，否则留空（当前行已淡出）
                if showHint {
                    HStack(spacing: compact ? 6 : 14) {
                        StrokeFillText(text: "🎵🎵🎵",
                                       fill: hintPulse ? .white : highlight,
                                       strokeColor: stroke,
                                       w: styleStore.lineWidth)
                            .font(.system(size: activeSize, weight: .black))
                    }
                    .opacity(hintPulse ? 0.5 : 1.0)
                    // 移除 scaleEffect：间奏提示只呼吸不缩放，避免视觉跳动
                    .frame(maxWidth: .infinity, alignment: topAlign)
                    // 移除 transition：间奏提示直接显示/消失
                    .onAppear {
                        withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                            hintPulse = true
                        }
                    }
                    .onDisappear {
                        hintPulse = false
                    }
                } else {
                    // 间奏较短：上排空位，当前行歌词已淡出
                    Color.clear.frame(maxWidth: .infinity)
                }
                // 下排显示下一句预备歌词
                let next = il.nextIdx
                if next >= 0 {
                    dualSlot(next, bottomAlign)
                } else {
                    Color.clear.frame(maxWidth: .infinity)
                }
            } else {
                let topIdx = ai % 2 == 0 ? ai + 1 : ai       // 上排恒为奇数句(单)
                let bottomIdx = ai % 2 == 0 ? ai : ai + 1    // 下排恒为偶数句(双)
                dualSlot(topIdx, topAlign)
                dualSlot(bottomIdx, bottomAlign)
            }
        }
        .padding(.horizontal, compact ? 16 : 60)
        .padding(.bottom, compact ? 8 : 16)
        // 移除整行动画：歌词切换直接替换，不收缩不铺展不闪烁，只保留逐字羽化扫色
    }

    /// 双排里的一个固定排：越界留等高空位；内容变化仅羽化(opacity)不位移；满宽并按 align 左右对齐
    @ViewBuilder
    private func dualSlot(_ idx: Int, _ align: Alignment) -> some View {
        if idx >= 0 && idx < lyrics.lines.count {
            lineView(lyrics.lines[idx], idx: idx,
                     multilineAlign: align == .leading ? .leading : .trailing)
                // 移除 .id 和 .transition：歌词切换直接替换，不重建视图不淡入淡出
                .frame(maxWidth: .infinity, alignment: align)
        } else {
            Color.clear.frame(maxWidth: .infinity)
        }
    }

    private var scrollBody: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 30) {
                    ForEach(Array(lyrics.lines.enumerated()), id: \.element.id) { idx, line in
                        lineView(line, idx: idx)
                            .id(line.id)
                    }
                }
                .padding(.vertical, compact ? 40 : 240)
                .padding(.horizontal, compact ? 14 : 80)
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

    /// 计算跑马灯水平偏移量（独立函数，避免在@ViewBuilder中使用for循环）
    private func marqueeXOffset(needsMarquee: Bool, active: Bool, tokens: [LyricToken]?,
                                charCount: Int, maxChars: Int, charWidth: CGFloat, spacing: CGFloat) -> CGFloat {
        guard needsMarquee, active, let tokens = tokens else { return 0 }
        var currentIdx = 0
        for (i, tok) in tokens.enumerated() {
            if displayTime >= tok.time { currentIdx = i }
        }
        let targetPos = min(maxChars / 3, maxChars - 1)
        let rawOffset = CGFloat(currentIdx - targetPos) * (charWidth + spacing)
        let totalWidth = CGFloat(charCount) * (charWidth + spacing)
        let visibleWidth = CGFloat(maxChars) * (charWidth + spacing)
        let maxOffset = max(0, totalWidth - visibleWidth)
        return -min(max(0, rawOffset), maxOffset)
    }

    @ViewBuilder
        private func lineView(_ line: LyricLine, idx: Int, multilineAlign: TextAlignment = .center) -> some View {
        let active = idx == activeIndex
        let isDual = mode == .dual
        let fontSize: CGFloat = isDual ? activeSize : (active ? scrollActiveSize : near1Size)
        let charWidth = fontSize + (compact ? 0 : 1) * sc
        let fixedSpacing = (compact ? 0 : 1) * sc
        let baseColor = active ? Color.white.opacity(0.42) : Color.white.opacity(isDual ? 0.5 : 0.42)
        
        // 获取所有字（用三元运算符，避免在@ViewBuilder中使用if/else赋值）
        let allTokens: [LyricToken]? = (line.tokens?.isEmpty == false) ? line.tokens : nil
        let allChars: [String] = allTokens?.map { $0.text } ?? Array(line.plain).filter { !$0.isWhitespace }.map { String($0) }
        
        // 计算每排最大显示字数
        let screenWidth: CGFloat = UIScreen.main.bounds.width
        let availableWidth = screenWidth - (compact ? 32 : 120) - 40
        let maxCharsPerRow = max(8, Int(availableWidth / (charWidth + fixedSpacing)))
        let needsMarquee = allChars.count > maxCharsPerRow
        
        // 计算跑马灯偏移（调用独立辅助函数，避免在@ViewBuilder中使用for循环）
        let marqueeOffset: CGFloat = marqueeXOffset(
            needsMarquee: needsMarquee,
            active: active,
            tokens: allTokens,
            charCount: allChars.count,
            maxChars: maxCharsPerRow,
            charWidth: charWidth,
            spacing: fixedSpacing
        )
        
        Group {
            if let tokens = allTokens {
                HStack(spacing: fixedSpacing) {
                    ForEach(Array(tokens.enumerated()), id: \.element.id) { tokIdx, tok in
                        KaraokeWord(
                            text: tok.text,
                            progress: active ? tokenProgress(tok, tokens: tokens, index: tokIdx, lineEnd: line.end) : 0,
                            highlight: highlight,
                            base: baseColor,
                            stroke: stroke,
                            lineW: styleStore.lineWidth
                        )
                        .frame(width: charWidth)
                        .fixedSize(horizontal: true, vertical: false)
                    }
                }
                .font(.system(size: fontSize, weight: .black))
                .fixedSize(horizontal: true, vertical: false)
                .offset(x: marqueeOffset)
                .animation(.linear(duration: 0.15), value: marqueeOffset)
                .multilineTextAlignment(multilineAlign)
                .lineLimit(1)
                .shadow(color: .black.opacity(0.55), radius: 3, x: 0, y: 2)
            } else {
                HStack(spacing: fixedSpacing) {
                    ForEach(Array(allChars.enumerated()), id: \.offset) { _, ch in
                        StrokeFillText(text: ch, fill: baseColor, strokeColor: stroke, w: styleStore.lineWidth)
                            .font(.system(size: fontSize, weight: (active || isDual) ? .black : .medium))
                            .frame(width: charWidth)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                .font(.system(size: fontSize, weight: .black))
                .fixedSize(horizontal: true, vertical: false)
                .offset(x: marqueeOffset)
                .animation(.linear(duration: 0.15), value: marqueeOffset)
                .multilineTextAlignment(multilineAlign)
                .lineLimit(1)
                .shadow(color: .black.opacity(0.55), radius: 3, x: 0, y: 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
    }



    /// 整行文字（非逐字 LRC 用），StrokeFillText 多层描边 + 与网页一致的投影；字号/粗细遥控可调
    private func strokedLine(_ text: String, fill: Color, size: CGFloat, weight: Font.Weight, active: Bool, multilineAlign: TextAlignment = .center) -> some View {
        StrokeFillText(text: text, fill: fill, strokeColor: stroke, w: styleStore.lineWidth)
            .font(.system(size: size, weight: weight))
            .tracking((!compact ? 1 : 0) * styleStore.fontScale)
            .multilineTextAlignment(multilineAlign)
            .lineLimit(1)                    // 长句不换行，保持一行；跨对边占满整行显示
            .shadow(color: .black.opacity(0.55), radius: active ? 3 : 4, x: 0, y: 2)
    }

    /// 卡拉OK k 标签：单个字在 [start, end] 区间内的演唱进度 0...1（叠加时间偏移）
    private func tokenProgress(_ tok: LyricToken, tokens: [LyricToken], index: Int, lineEnd: Double) -> Double {
        // 计算平均字持续时间（修正ai-worker生成的不准确时间轴，句尾常见间隔过长）
        let avgDur: Double
        if tokens.count >= 2 {
            avgDur = (tokens[tokens.count - 1].time - tokens[0].time) / Double(tokens.count - 1)
        } else {
            avgDur = 0.3
        }
        let normalDur = max(0.15, min(avgDur, 0.6))
        // 每个字的最大持续时间：平均持续时间的1.5倍，防止句尾字被拉长
        let maxDur = normalDur * 1.5

        let end: Double
        if index + 1 < tokens.count {
            let nextTime = tokens[index + 1].time
            // 直接限制每个字的最大持续时间，不检查间隔阈值
            // 这样不管ai-worker生成的间隔多长，每个字的羽化速度都不会超过正常范围
            end = min(nextTime, tok.time + maxDur)
        } else {
            // 最后一个字：用平均持续时间，不被lineEnd拉长
            end = tok.time + normalDur
        }
        let dur = max(0.05, end - tok.time)
        return min(max((displayTime - tok.time) / dur, 0), 1)
    }
}
