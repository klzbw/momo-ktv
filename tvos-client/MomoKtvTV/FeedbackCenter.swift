import SwiftUI
import Combine

// MARK: - 全局控件反馈中心
// 任何来源（遥控器本地按钮 / 手机网页遥控 / 语音）触发的操作都调用
// FeedbackCenter.shared.show(...)，主界面与全屏播放层共用同一套提示，
// 保证"操作一定有大屏反馈"，远距离也能看清。
final class FeedbackCenter: ObservableObject {
    static let shared = FeedbackCenter()
    @Published var message: String?
    @Published var icon: String = "checkmark.circle.fill"
    private var hideWork: DispatchWorkItem?
    private var kick: Int = 0
    private init() {}

    func show(_ msg: String, icon: String = "music.note", duration: Double = 1.5) {
        DispatchQueue.main.async {
            self.hideWork?.cancel()
            self.kick += 1
            let tag = self.kick
            self.icon = icon
            // 先清空再赋值，保证连续两次相同文案也能重新弹出动画
            self.message = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) {
                guard tag == self.kick else { return }
                self.message = msg
            }
            let work = DispatchWorkItem { [weak self] in
                guard tag == self?.kick else { return }
                withAnimation(.easeOut(duration: 0.25)) { self?.message = nil }
            }
            self.hideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: work)
        }
    }
}

// MARK: - 大屏反馈浮层（超大字号，居中偏上，不拦截遥控/点击）
struct TVFeedbackOverlay: View {
    @ObservedObject private var center = FeedbackCenter.shared
    var topPad: CGFloat = 150

    var body: some View {
        VStack {
            if let m = center.message {
                HStack(spacing: 18) {
                    Image(systemName: center.icon)
                        .font(.system(size: 44, weight: .bold))
                        .foregroundColor(WebColors.ac2)
                    Text(m)
                        .font(.system(size: 46, weight: .heavy))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.55)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 48)
                .padding(.vertical, 24)
                .background(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(Color(red: 12/255, green: 12/255, blue: 32/255).opacity(0.94))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .stroke(LinearGradient(colors: [WebColors.ac, WebColors.ac2],
                                               startPoint: .leading, endPoint: .trailing),
                                lineWidth: 3)
                )
                .shadow(color: .black.opacity(0.55), radius: 24, y: 8)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            Spacer()
        }
        .padding(.top, topPad)
        .allowsHitTesting(false)
        .animation(.spring(response: 0.32, dampingFraction: 0.82), value: center.message)
    }
}

// MARK: - 无缝横向跑马灯文字（双副本循环，对齐网页 nextUpScroll）
private struct MQWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct TVMarquee: View {
    let text: String
    var fontSize: CGFloat = 24
    var gap: CGFloat = 200
    @State private var textW: CGFloat = 0
    @State private var animate = false

    var body: some View {
        GeometryReader { geo in
            let viewW = geo.size.width
            HStack(spacing: gap) {
                Text(text)
                Text(text)
            }
            .font(.system(size: fontSize, weight: .semibold))
            .foregroundColor(.white)
            .shadow(color: .black.opacity(0.45), radius: 3, y: 1)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .background(
                Text(text)
                    .font(.system(size: fontSize, weight: .semibold))
                    .fixedSize()
                    .background(GeometryReader { gp in
                        Color.clear.preference(key: MQWidthKey.self, value: gp.size.width)
                    })
                    .hidden()
            )
            .offset(x: animate ? -(textW + gap) : 0)
            .onPreferenceChange(MQWidthKey.self) { nv in
                textW = nv
                restart()
            }
            .onAppear { restart() }
            .frame(width: viewW, height: geo.size.height, alignment: .leading)
            .clipped()
        }
        .frame(height: fontSize + 14)
        .clipped()
    }

    private func restart() {
        animate = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            withAnimation(.linear(duration: max(9.0, Double(text.count) * 0.42))
                .repeatForever(autoreverses: false)) {
                animate = true
            }
        }
    }
}

// MARK: - 顶部滚动横条（对齐网页 #next-up-bar：紫蓝渐变 + 毛玻璃感）
struct TVTickerBar: View {
    let text: String
    var fontSize: CGFloat = 24
    var body: some View {
        TVMarquee(text: text, fontSize: fontSize)
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity)
            .frame(height: fontSize + 30)
            .background(
                LinearGradient(colors: [WebColors.ac.opacity(0.32), WebColors.ac2.opacity(0.16)],
                               startPoint: .leading, endPoint: .trailing)
            )
            .overlay(
                Rectangle().fill(Color.white.opacity(0.12)).frame(height: 1),
                alignment: .bottom
            )
    }
}
