import SwiftUI
import UIKit
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC视频输出视图 - 用于播放MKV等AVFoundation不支持的格式
/// 使用activeDrawable管理，确保只有当前可见的视图输出视频
///
/// 从小屏切换到全屏时，必须使用 isFullscreen=true，
/// 内部会调用 promoteToFullscreen 强制VLC重新创建视频输出层，
/// 避免只有声音无视频的问题。
struct VLCVideoView: UIViewRepresentable {
    let vlcManager: VLCPlayerManager
    /// 是否为全屏视图（从小屏切全屏时必须设为true）
    var isFullscreen: Bool = false

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        view.clipsToBounds = true
        vlcManager.addDrawable(view)
        // 延迟设置，确保视图已添加到窗口层级
        DispatchQueue.main.async { [weak view] in
            guard let view = view else { return }
            if isFullscreen {
                // 全屏：强制提升，多次刷新确保视频显示
                vlcManager.promoteToFullscreen(view)
            } else {
                vlcManager.setActiveDrawable(view)
            }
        }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // 视图更新时确保它是活动drawable
        if isFullscreen {
            vlcManager.promoteToFullscreen(uiView)
        } else {
            vlcManager.setActiveDrawable(uiView)
        }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: ()) {
        // 清除活动drawable，会自动切换到下一个可用的视图
        VLCPlayerManager.shared.clearActiveDrawable(uiView)
    }
}
