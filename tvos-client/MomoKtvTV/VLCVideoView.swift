import SwiftUI
import UIKit
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC视频输出视图 - 用于播放MKV等AVFoundation不支持的格式
///
/// 大小屏互切时只有声音无视频的根因：VLC视频输出层切换时需要
/// 先销毁再重建，直接设置p.drawable会复用旧渲染层。
/// 本视图在出现时调用vlcManager.setActiveDrawable（内部ensureVideoOutput
/// 做多次nil→设置强制刷新），确保视频输出正确切换。
struct VLCVideoView: UIViewRepresentable {
    let vlcManager: VLCPlayerManager
    /// 是否为全屏视图（保留参数兼容，内部统一用setActiveDrawable）
    var isFullscreen: Bool = false

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        view.clipsToBounds = true
        vlcManager.addDrawable(view)
        // 延迟设置，确保视图已添加到窗口层级
        // 多次延迟设置，覆盖SwiftUI视图生命周期的各个阶段
        let delays: [Double] = [0.1, 0.25, 0.45]
        for delay in delays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak view, weak vlcManager] in
                guard let view = view, let vlcManager = vlcManager else { return }
                // 只在视图仍然在窗口层级中时才设置
                if view.window != nil {
                    vlcManager.setActiveDrawable(view)
                }
            }
        }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // 视图更新时确保它是活动drawable
        DispatchQueue.main.async { [weak uiView, weak vlcManager] in
            guard let uiView = uiView, let vlcManager = vlcManager else { return }
            if uiView.window != nil {
                vlcManager.setActiveDrawable(uiView)
            }
        }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: ()) {
        // 清除活动drawable，内部会自动切换到下一个可用视图
        VLCPlayerManager.shared.clearActiveDrawable(uiView)
    }
}
