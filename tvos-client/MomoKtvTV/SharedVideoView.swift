import SwiftUI
import AVFoundation
import UIKit

/// A video view that hosts the shared PlayerManager's AVPlayerLayer.
struct SharedVideoView: UIViewRepresentable {
    let playerManager: PlayerManager

    func makeUIView(context: Context) -> VideoHostView {
        let view = VideoHostView()
        view.playerManager = playerManager
        return view
    }

    func updateUIView(_ uiView: VideoHostView, context: Context) {
        uiView.playerManager = playerManager
    }
}

/// Host view that registers itself as the current host and manages layer frame.
class VideoHostView: UIView {
    weak var playerManager: PlayerManager? {
        didSet { registerAsHost() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        backgroundColor = .black
        clipsToBounds = true
    }

    private func registerAsHost() {
        playerManager?.currentHostView = self
        playerManager?.attachLayerToCurrentHost()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            playerManager?.currentHostView = self
            playerManager?.attachLayerToCurrentHost()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        playerManager?.updateLayerFrame()
    }

    override func removeFromSuperview() {
        // If this is the current host, clear it before removal
        if playerManager?.currentHostView === self {
            playerManager?.currentHostView = nil
        }
        super.removeFromSuperview()
    }
}
