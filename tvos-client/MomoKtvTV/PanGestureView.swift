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
