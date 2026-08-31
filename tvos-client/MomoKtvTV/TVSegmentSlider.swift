import SwiftUI
import UIKit

/// tvOS 没有 SwiftUI 原生 Slider。这里用 UIView 捕获遥控器左右键，实现一个
/// 可聚焦、逐档调节的分段档位条：聚焦后左右键在 segments 档之间移动。
struct TVSegmentSlider: View {
    let segments: Int
    @Binding var selected: Int                 // 0..segments-1，从左到右
    var onCommit: (Int) -> Void = { _ in }
    var fillColor: Color = Color(red: 1.0, green: 0.78, blue: 0.25)

    var body: some View {
        ZStack {
            // 视觉档位格：已选到的格子用高亮色，其余暗灰
            HStack(spacing: 8) {
                ForEach(0..<max(1, segments), id: \.self) { i in
                    Capsule()
                        .fill(i <= selected ? fillColor : Color.white.opacity(0.18))
                        .frame(height: 16)
                }
            }
            // 透明按键捕获层（负责聚焦与左右键）
            _KeyCatcher(segments: segments, selected: $selected, onCommit: onCommit)
        }
        .frame(height: 44)
    }
}

private struct _KeyCatcher: UIViewRepresentable {
    let segments: Int
    @Binding var selected: Int
    var onCommit: (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> _CaptureView {
        let v = _CaptureView()
        v.onStep = { dir in context.coordinator.step(dir) }
        v.backgroundColor = .clear
        v.layer.cornerRadius = 10
        return v
    }
    func updateUIView(_ uiView: _CaptureView, context: Context) {
        context.coordinator.parent = self
    }

    final class Coordinator {
        var parent: _KeyCatcher
        init(_ p: _KeyCatcher) { parent = p }
        func step(_ dir: Int) {
            let ni = max(0, min(parent.segments - 1, parent.selected + dir))
            guard ni != parent.selected else { return }
            parent.selected = ni
            parent.onCommit(ni)
        }
    }

    final class _CaptureView: UIView {
        var onStep: ((Int) -> Void)?
        override var canBecomeFocused: Bool { true }
        override var canBecomeFirstResponder: Bool { true }

        override func didUpdateFocus(in context: UIFocusUpdateContext,
                                     with coordinator: UIFocusAnimationCoordinator) {
            super.didUpdateFocus(in: context, with: coordinator)
            let focused = context.nextFocusedView === self
            coordinator.addCoordinatedAnimations {
                self.layer.borderWidth = focused ? 2 : 0
                self.layer.borderColor = UIColor.white.cgColor
                self.transform = focused ? CGAffineTransform(scaleX: 1.02, y: 1.12) : .identity
            }
        }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            var handled = false
            for p in presses {
                guard let key = p.key else { continue }
                switch key.keyCode {
                case .keyboardLeftArrow:  onStep?(-1); handled = true
                case .keyboardRightArrow: onStep?(1);  handled = true
                default: break
                }
            }
            if !handled { super.pressesBegan(presses, with: event) }
        }
    }
}
