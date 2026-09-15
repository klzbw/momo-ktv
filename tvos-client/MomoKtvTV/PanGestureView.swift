//
//  PanGestureView.swift
//  MomoKtvTV
//
//  tvOS 触摸板平移手势检测：精确连续调节音量。
//  根据滑动距离计算音量变化，类似手机滑块的拖拽体验。
//  限制单次滑动最大变化量，避免一次性调到极值。
//

import SwiftUI
import UIKit

struct PanGestureView: UIViewRepresentable {
    /// 回调：(手势状态, 垂直平移量pt)。正值=向下滑，负值=向上滑。
    var onPan: (UIGestureRecognizer.State, CGFloat) -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = true
        let pan = UIPanGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handlePan(_:))
        )
        pan.cancelsTouchesInView = false
        view.addGestureRecognizer(pan)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onPan = onPan
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onPan: onPan)
    }

    class Coordinator: NSObject {
        var onPan: (UIGestureRecognizer.State, CGFloat) -> Void

        init(onPan: @escaping (UIGestureRecognizer.State, CGFloat) -> Void) {
            self.onPan = onPan
        }

        @objc func handlePan(_ gesture: UIPanGestureRecognizer) {
            let translation = gesture.translation(in: gesture.view)
            onPan(gesture.state, translation.y)
        }
    }
}


// MARK: - tvOS 遥控器活动捕获：触控板滑动/按压/长按都回调，用于重置控件自动隐藏计时。
// 与方向键(onMoveCommand)互不冲突：cancelsTouchesInView=false + 允许同时识别，
// 焦点按钮自己的 onTapGesture/动作照常触发，这里只是"顺手"再调一次 resetHideTimer。
struct RemoteActivityCaptureView: UIViewRepresentable {
    /// 任意遥控器活动发生时回调（滑动 began/changed、按压、长按）
    var onActivity: () -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = true

        let pan = UIPanGestureRecognizer(target: context.coordinator,
                                         action: #selector(Coordinator.handlePan(_:)))
        pan.cancelsTouchesInView = false
        pan.delaysTouchesBegan = false
        pan.delaysTouchesEnded = false
        pan.delegate = context.coordinator
        view.addGestureRecognizer(pan)

        let tap = UITapGestureRecognizer(target: context.coordinator,
                                        action: #selector(Coordinator.handleTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)

        let long = UILongPressGestureRecognizer(target: context.coordinator,
                                                action: #selector(Coordinator.handleLong(_:)))
        long.cancelsTouchesInView = false
        long.delegate = context.coordinator
        view.addGestureRecognizer(long)

        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onActivity = onActivity
    }

    func makeCoordinator() -> Coordinator { Coordinator(onActivity: onActivity) }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onActivity: () -> Void
        init(onActivity: @escaping () -> Void) { self.onActivity = onActivity }

        @objc func handlePan(_ g: UIPanGestureRecognizer) { onActivity() }
        @objc func handleTap(_ g: UITapGestureRecognizer) { onActivity() }
        @objc func handleLong(_ g: UILongPressGestureRecognizer) { onActivity() }

        // 与焦点按钮自带的 tap/pan 同时识别，不抢不挡
        func gestureRecognizer(_ g: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}
