import SwiftUI

// MARK: - 纯音频歌曲动态背景模式（与网页端 BgStage 对应；tvOS 难取实时频谱，
// 用时间驱动的多层正弦做平滑律动，视觉上随音乐起伏）。@AppStorage 记忆，遥控/按钮可切换。
enum AudioBgMode: String, CaseIterable {
    case flow, ripple, stars, meteor, nebula, ring, bars, aurora, rain, bubbles, rays, vortex, flame, photos
    var display: String {
        switch self {
        case .flow: return "流光"
        case .ripple: return "水波纹"
        case .stars: return "星空"
        case .meteor: return "流星"
        case .nebula: return "星云"
        case .ring: return "律动环"
        case .bars: return "频谱"
        case .aurora: return "极光"
        case .rain: return "细雨"
        case .bubbles: return "气泡"
        case .rays: return "光束"
        case .vortex: return "漩涡"
        case .flame: return "暖焰"
        case .photos: return "我的图片"
        }
    }
    var next: AudioBgMode {
        let all = AudioBgMode.allCases
        guard let i = all.firstIndex(of: self) else { return .flow }
        return all[(i + 1) % all.count]
    }
    static func from(_ raw: String) -> AudioBgMode { AudioBgMode(rawValue: raw) ?? .flow }
}

/// 确定性伪随机（同一索引每次得到稳定值，避免逐帧闪烁）
@inline(__always) private func bgRand(_ i: Int) -> Double {
    let s = sin(Double(i) * 12.9898) * 43758.5453
    return s - floor(s)
}

struct AudioBackgroundView: View {
    @AppStorage("momoBgMode") private var modeRaw: String = AudioBgMode.flow.rawValue
    /// 用于"我的图片"模式拉取用户上传背景图
    var server: String = ""
    private var mode: AudioBgMode { .from(modeRaw) }

    var body: some View {
        ZStack {
            // 深色底，保证任何效果下都不透出服务端渐变轨
            LinearGradient(colors: [Color(red: 0.04, green: 0.03, blue: 0.12),
                                    Color(red: 0.01, green: 0.01, blue: 0.05)],
                           startPoint: .top, endPoint: .bottom)
            if mode == .photos {
                PhotosBg(server: server)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { tl in
                    Canvas { ctx, size in
                        render(mode, t: tl.date.timeIntervalSince1970, size: size, ctx: &ctx)
                    }
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)  // 背景层绝不拦截遥控器焦点/点击
    }

    // MARK: 各效果绘制（所有坐标统一使用 CGFloat，避免 Swift 不自动转换 Double）
    private func render(_ mode: AudioBgMode, t: Double, size s: CGSize, ctx: inout GraphicsContext) {
        let w = s.width, h = s.height
        let cx = w / 2, cy = h / 2
        // 统一律动强度 0~1（多频叠加的伪频谱）
        func beat(_ k: Double) -> Double { 0.5 + 0.5 * sin(t * (2.2 + k * 0.3) + k) }
        let palette = [Color(red: 0.21, green: 0.85, blue: 0.97),
                       Color(red: 0.55, green: 0.36, blue: 0.97),
                       Color(red: 0.98, green: 0.31, blue: 0.61)]

        switch mode {
        case .flow:
            for k in 0..<4 {
                var p = Path()
                let base = h * CGFloat(0.35 + 0.12 * Double(k))
                p.move(to: CGPoint(x: 0, y: h))
                for x in stride(from: CGFloat(0), through: w, by: CGFloat(12)) {
                    let y = base + CGFloat(sin(Double(x) * 0.006 + t * (1.1 + Double(k) * 0.25) + Double(k))) * 70
                    p.addLine(to: CGPoint(x: x, y: y))
                }
                p.addLine(to: CGPoint(x: w, y: h)); p.closeSubpath()
                ctx.opacity = 0.22
                ctx.fill(p, with: .linearGradient(Gradient(colors: [palette[k % 3], palette[(k + 1) % 3]]),
                                                   startPoint: CGPoint(x: 0, y: base),
                                                   endPoint: CGPoint(x: w, y: base)))
            }
        case .ripple:
            for k in 0..<6 {
                let ph = (t * 0.55 + Double(k) / 6.0).truncatingRemainder(dividingBy: 1)
                let r = CGFloat(ph) * max(w, h) * 0.7
                ctx.opacity = 0.35 * (1 - ph)
                let rect = CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
                ctx.stroke(Path(ellipseIn: rect), with: .color(palette[k % 3]), lineWidth: 3)
            }
        case .stars:
            for i in 0..<140 {
                let x = CGFloat(bgRand(i)) * w
                let y = CGFloat(bgRand(i + 999)) * h
                let tw = 0.3 + 0.7 * (0.5 + 0.5 * sin(t * (1 + bgRand(i + 7) * 2) + bgRand(i + 3) * 6))
                let r = CGFloat(1 + bgRand(i + 21) * 2.4)
                ctx.opacity = tw
                ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: r, height: r)), with: .color(.white))
            }
        case .meteor:
            for i in 0..<10 {
                let period = 2.4 + bgRand(i) * 2
                let ph = (t / period + bgRand(i + 5)).truncatingRemainder(dividingBy: 1)
                let len = CGFloat(120 + bgRand(i + 2) * 160)
                let sx = CGFloat(bgRand(i + 9)) * w
                let sy = CGFloat(bgRand(i + 11)) * h * 0.5
                let dx = CGFloat(ph) * (w + len)
                let head = CGPoint(x: sx + dx, y: sy + dx * 0.55)
                let tail = CGPoint(x: head.x - len, y: head.y - len * 0.55)
                ctx.opacity = sin(ph * .pi)
                var p = Path(); p.move(to: head); p.addLine(to: tail)
                ctx.stroke(p, with: .linearGradient(Gradient(colors: [.white, .clear]),
                                                    startPoint: head, endPoint: tail), lineWidth: 2.5)
            }
        case .nebula:
            for k in 0..<5 {
                let bx = CGFloat(0.2 + 0.6 * bgRand(k + 1)) * w
                let by = CGFloat(0.2 + 0.6 * bgRand(k + 30)) * h
                let rad = CGFloat(180 + beat(Double(k)) * 120)
                let c = CGPoint(x: bx + CGFloat(sin(t * 0.4 + Double(k))) * 60,
                                y: by + CGFloat(cos(t * 0.33 + Double(k) * 2)) * 50)
                ctx.opacity = 0.28
                let g = Gradient(colors: [palette[k % 3], .clear])
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - rad, y: c.y - rad, width: rad * 2, height: rad * 2)),
                         with: .radialGradient(g, center: c, startRadius: 0, endRadius: rad))
            }
        case .ring:
            for k in 0..<4 {
                let b = beat(Double(k))
                let r = CGFloat(60 + b * 220 + Double(k) * 40)
                ctx.opacity = 0.5 * (1 - Double(k) * 0.18)
                ctx.stroke(Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)),
                           with: .color(palette[k % 3]), lineWidth: 6)
            }
        case .bars:
            let n = 40, bw = w / CGFloat(n)
            for i in 0..<n {
                let v = 0.15 + beat(Double(i) * 0.4) * 0.85 * (0.6 + 0.4 * bgRand(i + 4))
                let bh = CGFloat(v) * h * 0.5
                let rect = CGRect(x: CGFloat(i) * bw + 2, y: h - bh, width: bw - 4, height: bh)
                ctx.fill(Path(roundedRect: rect, cornerRadius: 3),
                         with: .linearGradient(Gradient(colors: [palette[i % 3], palette[(i + 1) % 3]]),
                                               startPoint: CGPoint(x: 0, y: h), endPoint: CGPoint(x: 0, y: h * 0.4)))
            }
        case .aurora:
            for k in 0..<3 {
                var p = Path()
                p.move(to: CGPoint(x: 0, y: 0))
                for x in stride(from: CGFloat(0), through: w, by: CGFloat(14)) {
                    let y = h * CGFloat(0.18 + 0.12 * Double(k)) + CGFloat(sin(Double(x) * 0.005 + t * 0.8 + Double(k) * 2)) * 60
                    p.addLine(to: CGPoint(x: x, y: y))
                }
                p.addLine(to: CGPoint(x: w, y: 0)); p.closeSubpath()
                ctx.opacity = 0.3
                ctx.fill(p, with: .linearGradient(Gradient(colors: [palette[k % 3], .clear]),
                                                   startPoint: CGPoint(x: 0, y: 0), endPoint: CGPoint(x: 0, y: h * 0.5)))
            }
        case .rain:
            for i in 0..<90 {
                let speed = 0.5 + bgRand(i) * 0.9
                let ph = (bgRand(i + 2) + t * speed / 4).truncatingRemainder(dividingBy: 1)
                let x = CGFloat(bgRand(i + 6)) * w
                let y = CGFloat(ph) * h
                ctx.opacity = 0.35
                var p = Path()
                p.move(to: CGPoint(x: x, y: y)); p.addLine(to: CGPoint(x: x - 6, y: y + 22))
                ctx.stroke(p, with: .color(palette[i % 3]), lineWidth: 1.5)
            }
        case .bubbles:
            for i in 0..<40 {
                let speed = 0.12 + bgRand(i + 3) * 0.2
                let ph = (bgRand(i + 8) + t * speed).truncatingRemainder(dividingBy: 1)
                let r = CGFloat(8 + bgRand(i + 12) * 34)
                let x = CGFloat(bgRand(i + 15)) * w + CGFloat(sin(t + Double(i))) * 20
                let y = CGFloat(ph) * h
                ctx.opacity = 0.3 * (1 - abs(ph - 0.5))
                ctx.stroke(Path(ellipseIn: CGRect(x: x, y: y, width: r, height: r)),
                           with: .color(palette[i % 3]), lineWidth: 2)
            }
        case .rays:
            let n = 18
            ctx.opacity = 0.16
            for i in 0..<n {
                let ang = CGFloat(Double(i) / Double(n) * .pi * 2 + t * 0.3)
                var p = Path()
                p.move(to: CGPoint(x: cx, y: cy))
                let len = max(w, h)
                p.addLine(to: CGPoint(x: cx + cos(ang) * len, y: cy + sin(ang) * len))
                p.addLine(to: CGPoint(x: cx + cos(ang + 0.12) * len, y: cy + sin(ang + 0.12) * len))
                p.closeSubpath()
                ctx.fill(p, with: .color(palette[i % 3]))
            }
        case .vortex:
            for i in 0..<80 {
                let base = Double(i) / 80 * .pi * 8
                let rad = CGFloat(Double(i) / 80) * max(w, h) * 0.45 * CGFloat(0.8 + beat(Double(i)) * 0.3)
                let ang = CGFloat(base + t * 1.4)
                let p = CGPoint(x: cx + cos(ang) * rad, y: cy + sin(ang) * rad)
                let rr = CGFloat(2) + CGFloat(beat(Double(i))) * 4
                ctx.opacity = 0.7
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - rr, y: p.y - rr, width: rr * 2, height: rr * 2)),
                         with: .color(palette[i % 3]))
            }
        case .flame:
            for i in 0..<60 {
                let speed = 0.3 + bgRand(i) * 0.5
                let ph = (bgRand(i + 3) + t * speed / 3).truncatingRemainder(dividingBy: 1)
                let x = CGFloat(0.3 + 0.4 * bgRand(i + 7)) * w + CGFloat(sin(t * 2 + Double(i))) * 40 * CGFloat(ph)
                let y = CGFloat(1 - ph) * h
                let r = CGFloat((1 - ph) * 26 + 4)
                ctx.opacity = 0.5 * (1 - ph)
                ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: r, height: r * 1.4)),
                         with: .color(i % 2 == 0 ? Color(red: 1, green: 0.55, blue: 0.2) : Color(red: 1, green: 0.3, blue: 0.45)))
            }
        case .photos:
            break // 由 PhotosBg 处理
        }
    }
}

// MARK: - 我的图片：拉取服务端用户上传的背景图，多张随机轮播，带柔和交叉淡入
struct PhotosBg: View {
    let server: String
    @State private var urls: [String] = []
    @State private var idx = 0
    @State private var timer: Timer?   // 手动 Timer，播放时比 Timer.publish 更可靠

    var body: some View {
        ZStack {
            Color(red: 0.03, green: 0.03, blue: 0.08)
            if urls.isEmpty {
                LinearGradient(colors: [Color(red: 0.12, green: 0.1, blue: 0.3), Color(red: 0.04, green: 0.02, blue: 0.12)],
                               startPoint: .top, endPoint: .bottom)
            } else if let u = URL(string: urls[idx % urls.count]) {
                AsyncImage(url: u, transaction: Transaction(animation: .easeInOut(duration: 1.2))) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFill().transition(.opacity)
                    default: Color.clear
                    }
                }
                .id(idx)
                .focusable(false)
                .allowsHitTesting(false)
            }
        }
        .allowsHitTesting(false)
        .onAppear {
            load()
            startSlideshow()
        }
        .onDisappear {
            timer?.invalidate()
            timer = nil
        }
    }

    /// 启动图片轮播：每6秒随机切换一张，播放/暂停时均正常运行
    private func startSlideshow() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 6, repeats: true) { _ in
            guard !urls.isEmpty else { return }
            var n = Int.random(in: 0..<urls.count)
            if urls.count > 1 && n == idx { n = (n + 1) % urls.count }
            DispatchQueue.main.async {
                withAnimation(.easeInOut(duration: 1.0)) { idx = n }
            }
        }
    }

    private func load() {
        let host = server.hasPrefix("http") ? (server.hasSuffix("/") ? String(server.dropLast()) : server)
               : "http://\(server)"
        guard let u = URL(string: host + "/api/backgrounds/images") else { return }
        URLSession.shared.dataTask(with: u) { data, _, _ in
            guard let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let arr = obj["images"] as? [Any] else { return }
            let list: [String] = arr.compactMap { item in
                if let dict = item as? [String: Any], let urlPath = dict["url"] as? String {
                    return urlPath.hasPrefix("http") ? urlPath : host + urlPath
                }
                if let s = item as? String { return s.hasPrefix("http") ? s : host + s }
                return nil
            }
            DispatchQueue.main.async {
                self.urls = list
                self.idx = list.isEmpty ? 0 : Int.random(in: 0..<list.count)
            }
        }.resume()
    }
}
