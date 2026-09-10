import UIKit
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC共享视频视图单例。
///
/// 核心思路：VLC始终渲染到同一个UIView实例，小屏和全屏只是把这个视图
/// 在不同父容器之间移动（removeFromSuperview + addSubview），而不是
/// 创建两个视图再切换drawable。这样视频输出完全不中断，切换无感知。
///
/// TVVLCKit在播放中动态切换drawable不可靠（只有声音无视频），
/// 但移动同一个UIView到不同父视图是完全安全的，VLC持续渲染。
class VLCSharedVideoView {
    static let shared = VLCSharedVideoView()

    /// 唯一的视频输出视图，VLC的drawable始终指向它
    let view: UIView

    private init() {
        let v = UIView()
        v.backgroundColor = .black
        v.clipsToBounds = true
        v.translatesAutoresizingMaskIntoConstraints = false
        self.view = v
    }

    /// 将共享视频视图附加到指定父容器（自动从旧父视图移除）
    func attach(to parent: UIView) {
        if view.superview !== parent {
            view.removeFromSuperview()
            parent.addSubview(view)
        }
        // 确保约束填满父视图
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

    /// 从当前父视图移除（不销毁，下一个容器会重新attach）
    func detach() {
        view.removeFromSuperview()
    }

    /// 当前是否附加在某个父视图上
    var isAttached: Bool { view.superview != nil }
}
