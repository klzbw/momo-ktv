import SwiftUI
import UIKit
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC视频输出视图 - 用于播放MKV等AVFoundation不支持的格式
struct VLCVideoView: UIViewRepresentable {
    let vlcManager: VLCPlayerManager

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        view.clipsToBounds = true
        vlcManager.addDrawable(view)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        // VLC drawable 已在 makeUIView 中设置
    }

    func dismantleUIView(_ uiView: UIView, coordinator: ()) {
        vlcManager.removeDrawable(uiView)
    }
}
