import UIKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.backgroundColor = .black

        let prefsKey = "momo_ktv_server_url"
        let hasServer = UserDefaults.standard.string(forKey: prefsKey) != nil
        let rootVC = hasServer ? MainViewController() : ServerConfigViewController()
        let nav = UINavigationController(rootViewController: rootVC)
        nav.navigationBar.barStyle = .black
        nav.navigationBar.tintColor = .white
        nav.setNavigationBarHidden(hasServer, animated: false)

        window?.rootViewController = nav
        window?.makeKeyAndVisible()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        VLCPlayerManager.shared.pause()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        VLCPlayerManager.shared.pause()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        VLCPlayerManager.shared.stop()
        KTVWebSocketClient.shared.disconnect()
    }
}
