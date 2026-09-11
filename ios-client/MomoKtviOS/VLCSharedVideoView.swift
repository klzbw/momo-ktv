import UIKit
#if canImport(MobileVLCKit)
import MobileVLCKit
#endif

/// VLC 共享视频视图单例。
/// VLC 始终渲染到同一个 UIView 实例，小屏和全屏只是把这个视图
/// 在不同父容器之间移动，视频输出完全不中断。
class VLCSharedVideoView {
    static let shared = VLCSharedVideoView()
    let view: UIView

    private init() {
        let v = UIView()
        v.backgroundColor = .black
        v.clipsToBounds = true
        v.translatesAutoresizingMaskIntoConstraints = false
        self.view = v
    }

    func attach(to parent: UIView) {
        if view.superview !== parent {
            view.removeFromSuperview()
            parent.addSubview(view)
        }
        view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.deactivate(view.constraints)
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: parent.topAnchor),
            view.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
            view.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
        ])
        parent.layoutIfNeeded()
    }

    func detach() {
        view.removeFromSuperview()
    }

    var isAttached: Bool { view.superview != nil }
}
