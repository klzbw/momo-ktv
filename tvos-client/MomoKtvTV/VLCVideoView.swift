import SwiftUI
import UIKit
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC视频输出视图 - 使用共享单例视图实现无感知大小屏切换。
///
/// VLC始终渲染到VLCSharedVideoView.shared.view这个唯一实例，
/// 本视图只是一个容器，在makeUIView时把共享视图attach进来，
/// dismantleUIView时detach（不销毁）。切换大小屏时共享视图
/// 从一个容器移到另一个容器，VLC视频输出完全不中断。
struct VLCVideoView: UIViewRepresentable {
    let vlcManager: VLCPlayerManager
    /// 保留参数兼容（不再需要区分全屏/小屏，统一用共享视图）
    var isFullscreen: Bool = false

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        container.clipsToBounds = true
        // 把共享视频视图附加到这个容器
        VLCSharedVideoView.shared.attach(to: container)
        // 确保VLC的drawable是共享视图（只在第一次或需要时设置）
        if vlcManager.player?.drawable as? UIView !== VLCSharedVideoView.shared.view {
            vlcManager.setActiveDrawable(VLCSharedVideoView.shared.view)
        }
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // 确保共享视图仍然附加在这个容器
        if VLCSharedVideoView.shared.view.superview !== uiView {
            VLCSharedVideoView.shared.attach(to: uiView)
        }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: ()) {
        // 只detach，不销毁共享视图。下一个VLCVideoView会在makeUIView中重新attach。
        // 如果共享视图当前附加在这个容器上才移除
        if VLCSharedVideoView.shared.view.superview === uiView {
            VLCSharedVideoView.shared.detach()
        }
    }
}
