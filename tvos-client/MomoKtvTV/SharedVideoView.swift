import SwiftUI
import AVFoundation
import UIKit

/// 音频/AVPlayer 共享渲染表面单例（对齐 VLCSharedVideoView 的丝滑大小屏切换方案）。
///
/// 核心思路：AVPlayerLayer 始终挂在这同一个 UIView 实例上，小屏和全屏只是把这个
/// 表面在不同父容器之间移动（removeFromSuperview + addSubview），而不是每次切换都
/// 新建 host 视图、把 playerLayer 从旧 layer 摘下再挂到新 layer。
/// 这样 AVPlayer 渲染管线完全不重建，双 FLAC 轨道（人声+伴奏）/播放进度都不中断，
/// 大小屏切换与 MKV(VLC) 一样丝滑。
final class AudioSharedVideoView: UIView {
    static let shared = AudioSharedVideoView()

    /// 表面被放进新容器或尺寸变化时回调（PlayerManager 据此把 AVPlayerLayer 撑满）
    var onLayout: ((CGRect) -> Void)?

    private init() {
        super.init(frame: .zero)
        backgroundColor = .black
        clipsToBounds = true
        translatesAutoresizingMaskIntoConstraints = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// 将共享表面附加到指定父容器（自动从旧父视图移除）
    func attach(to parent: UIView) {
        if superview !== parent {
            removeFromSuperview()
            parent.addSubview(self)
        }
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.deactivate(constraints)
        NSLayoutConstraint.activate([
            topAnchor.constraint(equalTo: parent.topAnchor),
            bottomAnchor.constraint(equalTo: parent.bottomAnchor),
            leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            trailingAnchor.constraint(equalTo: parent.trailingAnchor),
        ])
        parent.layoutIfNeeded()
    }

    /// 从当前父视图移除（不销毁，下一个容器会重新 attach）
    func detach() {
        removeFromSuperview()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?(bounds)
    }
}

/// 承载共享 PlayerManager 的 AVPlayerLayer。
/// 与 VLCVideoView 完全同构：真正的渲染表面是 AudioSharedVideoView.shared（单例），
/// 本视图只是一个容器，makeUIView 时把共享表面 attach 进来，dismantleUIView 时
/// detach（不销毁）。大小屏切换时共享表面从一个容器移到另一个容器，AVPlayer 不中断。
struct SharedVideoView: UIViewRepresentable {
    let playerManager: PlayerManager

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        container.clipsToBounds = true
        // 把共享渲染表面附加到这个容器
        AudioSharedVideoView.shared.attach(to: container)
        // 确保 AVPlayerLayer 已挂到共享表面上
        playerManager.attachLayerToSharedSurface()
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // 确保共享表面仍附加在这个容器
        if AudioSharedVideoView.shared.superview !== uiView {
            AudioSharedVideoView.shared.attach(to: uiView)
        }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: ()) {
        // 只 detach，不销毁共享表面。下一个 SharedVideoView 会在 makeUIView 重新 attach。
        if AudioSharedVideoView.shared.superview === uiView {
            AudioSharedVideoView.shared.detach()
        }
    }
}
