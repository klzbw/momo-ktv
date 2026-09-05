import SwiftUI
import UIKit
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC视频输出视图 - 用于播放MKV等AVFoundation不支持的格式
/// 使用activeDrawable管理，确保只有当前可见的视图输出视频
struct VLCVideoView: UIViewRepresentable {
    let vlcManager: VLCPlayerManager

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        view.clipsToBounds = true
        vlcManager.addDrawable(view)
        // 设置为活动drawable（这个视图出现时接管视频输出）
        DispatchQueue.main.async {
            vlcManager.setActiveDrawable(view)
        }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // 视图更新时确保它是活动drawable
        vlcManager.setActiveDrawable(uiView)
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: ()) {
        // 清除活动drawable，会自动切换到下一个可用的视图
        VLCPlayerManager.shared.clearActiveDrawable(uiView)
    }
}
