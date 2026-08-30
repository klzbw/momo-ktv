import SwiftUI
import AVFoundation

// MARK: - 数据模型
struct FXParticle: Identifiable {
    let id = UUID()
    let emoji: String
    let x: CGFloat        // 0~1 水平起点
    let size: CGFloat
    let dur: Double
    let delay: Double
    let rot: Double
    let falling: Bool     // 倒彩：向下落；其它：向上升
}
struct FxBurst: Identifiable { let id = UUID(); let emoji: String }
struct FXBlessing: Identifiable {
    let id = UUID()
    let text: String
    let from: String
    let track: Int
    let dur: Double
}

// MARK: - 氛围中心（单例，手机遥控 atmosphere/blessing 经服务端广播后由它驱动）
final class AtmosphereCenter: ObservableObject {
    static let shared = AtmosphereCenter()
    @Published var particles: [FXParticle] = []
    @Published var burst: FxBurst?
    @Published var blessings: [FXBlessing] = []
    /// 服务器 http 基址，用于下载 /sounds 氛围音效，连接成功后由 ContentView 注入
    var serverBase: String = ""
    private var blessTrack = 0
    private let sounds = SoundManager()
    private init() {}

    private let emojiMap: [String: [String]] = [
        "applause": ["👏", "🙌", "💪"],
        "cheers":   ["🥂", "🍻"],
        "cheer":    ["🎉", "🎊", "✨", "🥳"],
        "boo":      ["👎", "💨"]
    ]

    func trigger(_ kind: String) {
        guard let emojis = emojiMap[kind] else { return }
        sounds.play(kind, base: serverBase)
        let falling = kind == "boo"
        DispatchQueue.main.async {
            self.burst = FxBurst(emoji: emojis[0])
            let curBurst = self.burst?.id
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                if self.burst?.id == curBurst { self.burst = nil }
            }
            var ps: [FXParticle] = []
            let n = falling ? 14 : 26
            for _ in 0..<n {
                ps.append(FXParticle(
                    emoji: emojis.randomElement() ?? "🎉",
                    x: CGFloat.random(in: 0.04...0.94),
                    size: CGFloat.random(in: 48...112),
                    dur: Double.random(in: 2.0...3.4),
                    delay: Double.random(in: 0...0.55),
                    rot: Double.random(in: -30...30),
                    falling: falling))
            }
            self.particles.append(contentsOf: ps)
            let ids = Set(ps.map { $0.id })
            DispatchQueue.main.asyncAfter(deadline: .now() + 4.4) {
                self.particles.removeAll { ids.contains($0.id) }
            }
        }
    }

    func bless(_ text: String, from name: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        DispatchQueue.main.async {
            let track = self.blessTrack % 5
            self.blessTrack += 1
            let dur = max(7.0, min(14.0, Double(t.count) * 0.45))
            let b = FXBlessing(text: String(t.prefix(60)), from: name, track: track, dur: dur)
            self.blessings.append(b)
            DispatchQueue.main.asyncAfter(deadline: .now() + dur + 0.6) {
                self.blessings.removeAll { $0.id == b.id }
            }
        }
    }
}

// MARK: - 音效播放（首次从服务器 /sounds 下载并缓存到临时目录，之后本地播放）
final class SoundManager {
    private var players: [String: AVAudioPlayer] = [:]
    private var cached: [String: URL] = [:]

    func play(_ kind: String, base: String) {
        guard ["applause", "cheers", "cheer", "boo"].contains(kind) else { return }
        if let u = cached[kind], let p = try? AVAudioPlayer(contentsOf: u) {
            p.volume = 1.0; p.play(); players[kind] = p; return
        }
        guard let url = URL(string: "\(base)/sounds/\(kind).wav") else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            guard let data = try? Data(contentsOf: url) else { return }
            DispatchQueue.main.async {
                do {
                    try? AVAudioSession.sharedInstance().setActive(true)
                    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("fx_\(kind).wav")
                    try? data.write(to: tmp, options: .atomic)
                    self.cached[kind] = tmp
                    let p = try AVAudioPlayer(contentsOf: tmp)
                    p.volume = 1.0; p.prepareToPlay(); p.play()
                    self.players[kind] = p
                } catch { /* 音效缺失不影响视觉特效 */ }
            }
        }
    }
}

// MARK: - 全屏氛围层（不拦截遥控器/触摸）
struct AtmosphereOverlay: View {
    @ObservedObject private var center = AtmosphereCenter.shared
    var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(center.particles) { p in
                    FXParticleView(p: p, w: geo.size.width, h: geo.size.height)
                }
                if let burst = center.burst {
                    FxBurstView(emoji: burst.emoji).id(burst.id)
                }
                ForEach(center.blessings) { b in
                    FXBlessingView(b: b, w: geo.size.width, h: geo.size.height)
                }
            }
        }
        .allowsHitTesting(false)
    }
}

// 单个上升/下落 emoji
private struct FXParticleView: View {
    let p: FXParticle
    let w, h: CGFloat
    @State private var go = false
    private var startY: CGFloat { p.falling ? -120 : h + 120 }
    private var endY: CGFloat { p.falling ? h + 120 : -120 }

    var body: some View {
        Text(p.emoji)
            .font(.system(size: p.size))
            .shadow(color: .black.opacity(0.35), radius: 6, y: 3)
            .rotationEffect(.degrees(go ? p.rot : 0))
            .position(x: p.x * w, y: go ? endY : startY)
            .animation(.linear(duration: p.dur).delay(p.delay), value: go)
            .onAppear { go = true }
    }
}

// 中央大表情爆发一次
private struct FxBurstView: View {
    let emoji: String
    @State private var go = false
    var body: some View {
        GeometryReader { geo in
            Text(emoji)
                .font(.system(size: 150))
                .scaleEffect(go ? 1.7 : 0.3)
                .opacity(go ? 0 : 1)
                .position(x: geo.size.width / 2, y: geo.size.height * 0.42)
                .animation(.easeOut(duration: 1.1), value: go)
                .onAppear { go = true }
        }
    }
}

// 祝福语从右向左全屏滚过
private struct FXBlessingView: View {
    let b: FXBlessing
    let w, h: CGFloat
    @State private var go = false
    var body: some View {
        Text(b.from.isEmpty ? b.text : "\(b.from)：\(b.text)")
            .font(.system(size: 56, weight: .black))
            .foregroundColor(.white)
            .shadow(color: WebColors.ac, radius: 18)
            .shadow(color: .black.opacity(0.5), radius: 6, y: 3)
            .fixedSize()
            .position(x: go ? -w * 2 : w * 1.02,
                      y: h * CGFloat(0.16 + 0.13 * Double(b.track)))
            .animation(.linear(duration: b.dur), value: go)
            .onAppear { go = true }
    }
}
