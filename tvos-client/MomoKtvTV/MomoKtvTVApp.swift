import SwiftUI

/// 崩溃日志捕获：将崩溃信息保存到UserDefaults，下次启动时在调试界面显示
final class CrashLogger {
    static let shared = CrashLogger()
    private let crashKey = "momo_last_crash"

    private init() {
        NSSetUncaughtExceptionHandler { exception in
            let info = """
            崩溃时间: \(Date())
            崩溃名称: \(exception.name.rawValue)
            崩溃原因: \(exception.reason ?? "未知")
            调用栈:
            \(exception.callStackSymbols.joined(separator: "\n"))
            """
            UserDefaults.standard.set(info, forKey: "momo_last_crash")
            UserDefaults.standard.synchronize()
        }
    }

    var lastCrash: String? {
        UserDefaults.standard.string(forKey: crashKey)
    }

    func clear() {
        UserDefaults.standard.removeObject(forKey: crashKey)
    }
}

@main
struct MomoKtvTVApp: App {
    init() {
        // 初始化崩溃日志捕获
        _ = CrashLogger.shared
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
