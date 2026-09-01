import UIKit
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 后台音频播放：KTV 歌曲在切到后台/锁屏后继续播放
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback,
                                    options: [.allowAirPlay])
            try session.setActive(true, options: [])
        } catch {
            print("AVAudioSession setup error: \(error)")
        }

        window = UIWindow(frame: UIScreen.main.bounds)
        let webVC = WebViewController()
        let nav = UINavigationController(rootViewController: webVC)
        nav.setNavigationBarHidden(true, animated: false)
        window?.rootViewController = nav
        window?.makeKeyAndVisible()
        return true
    }

    // 支持全部方向（TV 大屏页以横屏为佳，但设置页竖屏也可用）
    func application(_ application: UIApplication,
                     supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        return .all
    }
}
