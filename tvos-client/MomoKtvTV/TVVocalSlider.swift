import SwiftUI
import UIKit

/// tvOS 双FLAC(DUAL)模式专用：垂直「人声」连续音量条。
/// 聚焦后用 Siri Remote 上/下键（轻扫）以 5% 步进、或在触摸板上上下拖动连续调节人声增益，
/// 底部=纯伴奏(0)，顶部=原唱(1)。与五档分段条 TVSegmentSlider 互斥（后者给 HLS 多档歌）。
struct TVVocalSlider: View {
    @Binding var level: Float              // 0...1
    var step: Float = 0.025
    var onChange: (Float) -> Void = { _ in }
    /// 外部点「原/伴唱」按钮时自增该值，触发音量条主动获取遥控器焦点
    var autoFocusToken: Int

    var body: some View {
        _VocalCatcher(level: $level,
                      step: step,
                      onChange: onChange,
                      autoFocusToken: autoFocusToken)
    }
}

// MARK: - UIViewRepresentable 桥接
private struct _VocalCatcher: UIViewRepresentable {
    @Binding var level: Float
    let step: Float
    var onChange: (Float) -> Void
    let autoFocusToken: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> _VocalBar {
        let v = _VocalBar()
        v.onNudge = { dir in context.coordinator.nudge(dir) }
        v.onPanValue = { val in context.coordinator.set(val) }
        return v
    }

    func updateUIView(_ uiView: _VocalBar, context: Context) {
        context.coordinator.parent = self
        uiView.setLevel(CGFloat(level), animated: false)
        // autoFocusToken 变化（用户点了原/伴唱按钮）时，主动把焦点落到音量条上以便立即上下调音
        if uiView.lastAutoFocusToken != autoFocusToken {
            uiView.lastAutoFocusToken = autoFocusToken
            DispatchQueue.main.async { uiView.becomeFirstResponder() }
        }
    }

    final class Coordinator {
        var parent: _VocalCatcher
        init(_ p: _VocalCatcher) { parent = p }
        func nudge(_ dir: Int) {
            let nv = max(0, min(1, parent.level + parent.step * Float(dir)))
            guard abs(nv - parent.level) > 0.0001 else { return }
            parent.level = nv
            parent.onChange(nv)
        }
        func set(_ v: Float) {
            let nv = max(0, min(1, v))
            parent.level = nv
            parent.onChange(nv)
        }
    }

    final class _VocalBar: UIView {
        var onNudge: ((Int) -> Void)?       // -1 下调 / +1 上调
        var onPanValue: ((Float) -> Void)?  // 触摸板拖动给出的 0...1
        var lastAutoFocusToken: Int = 0   // 与外部初始 token(0) 相同：首次出现不抢焦点，仅点击按钮后才主动聚焦
        private var lastNudgeTime: TimeInterval = 0   // 上下键防抖：Siri Remote 轻扫一次会触发多次 key repeat，合并为一次
        private var panStartLevel: CGFloat = 0         // pan 手势开始时的音量，用于增量调节

        private let trackLayer = CALayer()
        private let fillLayer = CAGradientLayer()
        private let thumbLayer = CALayer()
        private var level: CGFloat = 1
        private let barWidth: CGFloat = 16
        private let barHeight: CGFloat = 168

        override var canBecomeFocused: Bool { true }
        override var canBecomeFirstResponder: Bool { true }

        override init(frame: CGRect) {
            super.init(frame: frame)
            setup()
        }
        required init?(coder: NSCoder) {
            super.init(coder: coder)
            setup()
        }

        private func setup() {
            backgroundColor = .clear
            // 轨道
            trackLayer.cornerRadius = barWidth / 2
            trackLayer.backgroundColor = UIColor.white.withAlphaComponent(0.18).cgColor
            layer.addSublayer(trackLayer)
            // 填充（金色渐变，下→上）
            fillLayer.cornerRadius = barWidth / 2
            fillLayer.colors = [UIColor(red: 1.0, green: 0.62, blue: 0.2, alpha: 1).cgColor,
                                UIColor(red: 1.0, green: 0.82, blue: 0.3, alpha: 1).cgColor]
            fillLayer.startPoint = CGPoint(x: 0.5, y: 1)
            fillLayer.endPoint = CGPoint(x: 0.5, y: 0)
            layer.addSublayer(fillLayer)
            // 滑块
            thumbLayer.cornerRadius = 13
            thumbLayer.backgroundColor = UIColor.white.cgColor
            thumbLayer.shadowColor = UIColor.black.cgColor
            thumbLayer.shadowOpacity = 0.35
            thumbLayer.shadowRadius = 4
            thumbLayer.shadowOffset = CGSize(width: 0, height: 1)
            layer.addSublayer(thumbLayer)

            // Siri Remote 触摸板上下拖动
            let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
            pan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirect.rawValue)]
            addGestureRecognizer(pan)

            // 给出可聚焦的命中区域（比视觉条宽，便于遥控器聚焦）
            frame = CGRect(x: 0, y: 0, width: 44, height: barHeight + 28)
        }

        override var intrinsicContentSize: CGSize {
            CGSize(width: 44, height: barHeight + 28)
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            let cx = bounds.midX
            let trackY = (bounds.height - barHeight) / 2
            trackLayer.frame = CGRect(x: cx - barWidth / 2, y: trackY, width: barWidth, height: barHeight)
            applyFillFrame()
        }

        private func applyFillFrame() {
            let cx = bounds.midX
            let trackY = (bounds.height - barHeight) / 2
            let h = barHeight * level
            fillLayer.frame = CGRect(x: cx - barWidth / 2, y: trackY + barHeight - h, width: barWidth, height: h)
            let thumbY = trackY + barHeight * (1 - level) - 13
            thumbLayer.frame = CGRect(x: cx - 13, y: thumbY, width: 26, height: 26)
        }

        func setLevel(_ x: CGFloat, animated: Bool) {
            level = max(0, min(1, x))
            if animated {
                CATransaction.begin()
                CATransaction.setAnimationDuration(0.08)
                applyFillFrame()
                CATransaction.commit()
            } else {
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                applyFillFrame()
                CATransaction.commit()
            }
        }

        override func didUpdateFocus(in context: UIFocusUpdateContext,
                                     with coordinator: UIFocusAnimationCoordinator) {
            super.didUpdateFocus(in: context, with: coordinator)
            let focused = context.nextFocusedView === self
            coordinator.addCoordinatedAnimations {
                self.thumbLayer.transform = focused ? CATransform3DMakeScale(1.25, 1.25, 1) : CATransform3DIdentity
                self.trackLayer.borderWidth = focused ? 2 : 0
                self.trackLayer.borderColor = UIColor.white.withAlphaComponent(0.7).cgColor
            }
        }

        // 遥控器方向键：垂直条只接管 上/下 调音；左/右交还给焦点引擎，以便移动到相邻控制按钮
        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            var handled = false
            let now = Date.timeIntervalSinceReferenceDate
            for p in presses {
                guard let key = p.key else { continue }
                switch key.keyCode {
                case .keyboardUpArrow:
                    if now - lastNudgeTime > 0.07 { onNudge?(1); lastNudgeTime = now }
                    handled = true
                case .keyboardDownArrow:
                    if now - lastNudgeTime > 0.07 { onNudge?(-1); lastNudgeTime = now }
                    handled = true
                default: break
                }
            }
            if !handled { super.pressesBegan(presses, with: event) }
        }

        @objc private func handlePan(_ g: UIPanGestureRecognizer) {
            // 增量模式：记录手势开始时的音量，用触摸板滑动距离映射音量变化，
            // 避免绝对位置映射导致手指刚碰触摸板就跳变。250pt 滑动对应 0...1 全范围。
            switch g.state {
            case .began:
                panStartLevel = level
            case .changed:
                let ty = g.translation(in: self).y
                let delta = -ty / 250.0
                onPanValue?(Float(max(0, min(1, panStartLevel + delta))))
            default: break
            }
        }
    }
}
