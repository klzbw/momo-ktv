import UIKit
import AVFoundation
#if canImport(TVVLCKit)
import TVVLCKit
#endif

/// VLC鎾斁鍣ㄥ皝瑁?- 鐢ㄤ簬鎾斁MKV绛堿VFoundation涓嶆敮鎸佺殑鏍煎紡
/// 鏀寔115/澶稿厠缃戠洏鑷畾涔塙A銆?02鐩磋繛棰勮В鏋愩€侀煶杞ㄥ垏鎹紙鍘熷敱/浼村敱锛?///
/// 銆愰棯閫€淇璇存槑 - 鍩轰簬 e79f2cbd 绋冲畾鐗堛€?/// 鏍瑰洜锛歴etupLibrary(cookie:) 琚Щ鍒?resolveRedirect 鐨勫紓姝ュ洖璋冨唴鍒涘缓锛?/// 瀵艰嚧 play() 杩斿洖鏃?player 浠嶄负 nil銆傜櫥褰曞悗 onChange(queue) 绔嬪嵆瑙﹀彂
/// stop()鈫抪lay()锛屽紓姝ュ洖璋冧笌瑙嗗浘娓叉煋绔炰簤璁块棶 player 鈫?use-after-free 鈫?闂€€銆?/// 淇锛氭仮澶?e79f2cbd 鐨勫悓姝?setupLibrary() 妯″紡鈥斺€攑lay() 寮€澶寸珛鍗冲垱寤?/// VLCLibrary + VLCMediaPlayer锛宲layer 闈炵┖鍚庡啀鍋氬紓姝?302 瑙ｆ瀽銆?/// Cookie 淇濇寔鍦?media 绾у埆璁剧疆锛堜笌绋冲畾鐗堜竴鑷达級锛屼笉鍦?library 绾у埆璁剧疆
/// 锛坙ibrary 绾у埆 cookie 鍙兘鍦ㄥ垱寤烘椂璁剧疆锛屼細寮哄埗寮傛鍖栵紝鏄棯閫€鏍规簮锛夈€?class VLCPlayerManager: NSObject, ObservableObject {
    static let shared = VLCPlayerManager()

    // MARK: - 鐘舵€?    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var duration: Double = 0
    @Published var debugLog: String = ""
    /// @Published锛氬師鍞?浼村敱鍒囨崲鍚庤 mvCtrl / FullPlayerView 鐨勬寜閽枃瀛楀嵆鏃跺埛鏂?    @Published private(set) var audioTrackNames: [String] = []
    @Published private(set) var currentAudioTrackIndex: Int = 0

    var onTimeUpdate: ((Double, Double) -> Void)?
    var onStateChange: ((Bool) -> Void)?
    var onError: ((String) -> Void)?
    /// 鎾斁鑷劧缁撴潫鍥炶皟锛圴LC妯″紡涓嬬敤浜庤嚜鍔ㄦ挱鏀句笅涓€棣栵紝涓?AVPlayer 鐨?onPlaybackEnd 瀵归綈锛?    var onPlaybackEnd: (() -> Void)?

    // MARK: - VLC瀹炰緥
    #if canImport(TVVLCKit)
    private var library: VLCLibrary?
    var player: VLCMediaPlayer?
    private var media: VLCMedia?
    /// 淇濆瓨鍘熷鐨?stream URL锛坉irect-stream / share/stream / cloud/115-direct锛宺estart鏃剁敤锛岄伩鍏嶇敤杩囨湡鐨凜DN鐩撮摼锛?    private var originalStreamURL: URL?
    #endif
    private var drawableViews: NSHashTable<UIView> = NSHashTable.weakObjects()
    private var activeDrawable: UIView?
    private var timeObserverTimer: Timer?
    private var lastDebugSecond: Int = -1

    private var libraryInitialized = false
    private var isRestarting = false
    private var lastReportedState: Int = -1

    /// 鎾斁浠ょ墝锛氭瘡娆?play() 鑷銆俽esolveRedirect 鏄紓姝ョ殑锛屽揩鍒囨瓕鏃朵笂涓€棣栫殑鍥炶皟鍙兘
    /// 鍦ㄦ柊姝屼箣鍚庢墠鍥炴潵锛屽鑷村鍚屼竴涓?player 閲嶅 setupLibrary/startPlayback锛堟椂搴忕珵浜夛紝
    /// media 琚簩娆¤祴鍊硷紝tvOS 涓婅〃鐜颁负"杩炰笂鏈嶅姟鍣ㄤ笉鍒?绉掗棯閫€"锛夈€傜敤浠ょ墝涓㈠純杩囨湡鍥炶皟銆?    private var playToken: Int = 0

    /// 褰撳墠鎾斁鐨勭綉鐩橀┍鍔ㄧ被鍨嬶紙鐢ㄤ簬閫夋嫨姝ｇ‘鐨刄A鍜孯eferer锛?    /// 澶稿厠CDN鐩撮摼绛惧悕涓嶶A缁戝畾锛屽繀椤讳娇鐢ㄥじ鍏嬪鎴风UA
    private var currentCloudDriver: String = "pan115"

    /// 115 缃戠洏涓撶敤 UA锛堝繀椤讳笌 pan115 driver 璋冪敤 API 鏃朵娇鐢ㄧ殑 UA 涓€鑷达級
    static let cloud115UserAgent = "Mozilla/5.0 115Browser/23.9.3.2"

    /// 澶稿厠缃戠洏涓撶敤 UA锛堝繀椤讳笌 quark driver 璋冪敤 API 鏃朵娇鐢ㄧ殑 UA 涓€鑷达級
    /// 澶稿厠 CDN 鐩撮摼绛惧悕涓?UA 缁戝畾锛屽繀椤讳娇鐢ㄥじ鍏嬪鎴风 UA 鎵嶈兘璁块棶
    static let cloudQuarkUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch"

    /// 鏍规嵁缃戠洏椹卞姩绫诲瀷杩斿洖瀵瑰簲鐨刄A
    static func userAgent(forDriver driver: String?) -> String {
        if driver == "quark" {
            return cloudQuarkUserAgent
        }
        return cloud115UserAgent
    }

    /// 鏍规嵁缃戠洏椹卞姩绫诲瀷杩斿洖瀵瑰簲鐨凴eferer
    static func referer(forDriver driver: String?) -> String {
        if driver == "quark" {
            return "https://pan.quark.cn/"
        }
        return "https://115.com/"
    }

    private override init() {
        super.init()
    }

    #if canImport(TVVLCKit)
    /// 鍒涘缓VLCLibrary锛堝悓姝ヨ皟鐢紝鍦?play() 寮€澶寸珛鍗虫墽琛岋紝纭繚 player 闈炵┖锛?    /// 浣跨敤 currentCloudDriver 閫夋嫨瀵瑰簲鐨?UA 鍜?Referer銆?    /// 娉ㄦ剰锛氫笉鍦ㄦ澶勮缃?library 绾у埆 Cookie鈥斺€擟ookie 鍙兘鍦ㄥ垱寤烘椂璁剧疆锛?    /// 鑰?Cookie 鏉ヨ嚜 302 鍝嶅簲澶达紙寮傛鑾峰彇锛夛紝浼氬己鍒跺紓姝ュ寲 library 鍒涘缓锛屾槸闂€€鏍规簮銆?    /// Cookie 鏀瑰湪 startPlayback 鐨?media 绾у埆璁剧疆锛堜笌 e79f2cbd 绋冲畾鐗堜竴鑷达級銆?    private func setupLibrary() {
        guard !libraryInitialized else { return }
        libraryInitialized = true
        let ua = VLCPlayerManager.userAgent(forDriver: currentCloudDriver)
        let ref = VLCPlayerManager.referer(forDriver: currentCloudDriver)
        // 澶氶噸淇濋殰锛歭ibrary绾у埆 + 鍚庣画media绾у埆
        let options = [
            "--http-user-agent=\(ua)",
            "--http-referrer=\(ref)",
            "--no-video-title-show",
            "--network-caching=1000",
            "--live-caching=1000",
            "--file-caching=1000"
        ]
        let lib = VLCLibrary(options: options)
        library = lib
        player = VLCMediaPlayer(library: lib)
        player?.delegate = self
        log("VLCLibrary鍒濆鍖栨垚鍔?鍚屾), driver=\(currentCloudDriver), UA=\(ua.prefix(25))...")
    }
    #endif

    /// 鍏叡鏃ュ織鎺ュ彛锛氫緵 ContentView 绛夊閮ㄦā鍧楄緭鍑烘挱鏀鹃摼璺瘖鏂俊鎭?    func log(_ message: String) {
        let timestamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        let line = "[\(timestamp)] \(message)"
        print(line)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.debugLog = line + "\n" + self.debugLog
            let lines = self.debugLog.components(separatedBy: "\n")
            if lines.count > 50 {
                self.debugLog = lines.prefix(50).joined(separator: "\n")
            }
        }
    }

    // MARK: - 302 閲嶅畾鍚戦瑙ｆ瀽

    /// 鐢ㄤ簬鎹曡幏302閲嶅畾鍚戠殑URLSession浠ｇ悊锛堢姝㈣嚜鍔ㄨ窡闅忛噸瀹氬悜锛?    private class RedirectCatcher: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            // 杩斿洖nil绂佹鑷姩璺熼殢閲嶅畾鍚戯紝淇濈暀鍘熷302鍝嶅簲浠ヤ究璇诲彇Location澶?            completionHandler(nil)
        }
    }
    private let redirectCatcher = RedirectCatcher()
    private lazy var noRedirectSession: URLSession = {
        URLSession(configuration: .default, delegate: redirectCatcher, delegateQueue: nil)
    }()

    /// 棰勮В鏋?URL 鐨?302 閲嶅畾鍚戯紝杩斿洖鏈€缁?URL銆?    /// 浣跨敤鑷畾涔塙RLSession绂佹鑷姩璺熼殢閲嶅畾鍚戯紝纭繚鑳借鍙栧埌302鐨凩ocation澶淬€?    /// 锛圲RLSession.shared榛樿浼氳嚜鍔ㄨ窡闅?02锛屽鑷磋繑鍥炴渶缁堝搷搴旇€岄潪302锛?    ///
    /// 瑙﹀彂鏉′欢锛堜互涓?URL 閮戒細 302 鍒?CDN 鐩撮摼锛夛細
    /// - /api/direct-stream/...     锛坣etktv-mkv锛?15/澶稿厠缃戠洏鐩撮摼锛?    /// - /api/share/stream/...      锛坰hare-115 鍒嗕韩閾炬帴锛孉list /d/ 浠ｇ悊锛?    /// - /api/cloud/115-direct/...  锛堥€氱敤缃戠洏鍗曞眰鐩撮摼锛屾寜璐﹀彿椹卞姩鑷姩鍒嗗彂 pan115/quark/cmcc锛?    /// - /api/cloud/stream-path/... 锛坈loud-drive AList浠ｇ悊锛?    /// 蹇呴』鍦ㄥ鎴风鍏堣В鏋愶紝鍚﹀垯 VLC 鑷璺熼殢閲嶅畾鍚戞椂鍙兘涓㈠け鑷畾涔?UA锛?    /// 瀵艰嚧 CDN 杩斿洖 403 invalid signature 鎴?412銆?    private func resolveRedirect(for url: URL, completion: @escaping (URL, String?) -> Void) {
        let urlStr = url.absoluteString
        // 闇€瑕侀瑙ｆ瀽302鐨勭鐐?        let needsResolve = urlStr.contains("direct-stream")
            || urlStr.contains("share/stream")
            || urlStr.contains("cloud/115-direct")
            || urlStr.contains("cloud/stream-path")
            || urlStr.contains("cloud/direct")
        guard needsResolve else {
            completion(url, nil)
            return
        }

        log("棰勮В鏋?02閲嶅畾鍚? \(url.absoluteString)")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        // 鏍规嵁褰撳墠缃戠洏绫诲瀷浣跨敤瀵瑰簲UA锛堝じ鍏嬬洿閾剧鍚嶄笌UA缁戝畾锛屽繀椤讳笌鏈嶅姟绔痙river鐢熸垚鐩撮摼鏃剁殑UA涓€鑷达級
        let ua = VLCPlayerManager.userAgent(forDriver: currentCloudDriver)
        request.setValue(ua, forHTTPHeaderField: "User-Agent")
        request.setValue("bytes=0-0", forHTTPHeaderField: "Range")  // 鍙彇1瀛楄妭锛屽揩閫熻幏鍙?02

        let task = noRedirectSession.dataTask(with: request) { [weak self] _, response, error in
            if let error = error {
                self?.log("棰勮В鏋愬け璐?\(error.localizedDescription))锛屼娇鐢ㄥ師濮婾RL")
                DispatchQueue.main.async { completion(url, nil) }
                return
            }
            if let httpResp = response as? HTTPURLResponse {
                self?.log("棰勮В鏋愮姸鎬? \(httpResp.statusCode)")
                // 302/301閲嶅畾鍚戯細浠嶭ocation澶磋幏鍙栨渶缁圲RL
                if (300...399).contains(httpResp.statusCode),
                   let location = httpResp.allHeaderFields["Location"] as? String,
                   let finalURL = URL(string: location) {
                    let cloudCookie = httpResp.allHeaderFields["X-Cloud-Cookie"] as? String
                    if cloudCookie != nil {
                        self?.log("棰勮В鏋愭垚鍔?\(httpResp.statusCode))锛屾崟鑾峰埌缃戠洏Cookie")
                    } else {
                        self?.log("棰勮В鏋愭垚鍔?\(httpResp.statusCode))锛屾渶缁圲RL: \(finalURL.absoluteString.prefix(80))...")
                    }
                    DispatchQueue.main.async { completion(finalURL, cloudCookie) }
                    return
                }
                // 200锛氬彲鑳芥湇鍔＄鐩存帴杩斿洖鍐呭锛堥潪閲嶅畾鍚戞ā寮忥級锛岀敤鍘熷URL璁￢LC澶勭悊
                if httpResp.statusCode == 200 {
                    self?.log("棰勮В鏋愯繑鍥?00锛堥潪閲嶅畾鍚戯級锛屼娇鐢ㄥ師濮婾RL")
                } else {
                    self?.log("棰勮В鏋愯繑鍥瀄(httpResp.statusCode)锛屼娇鐢ㄥ師濮婾RL")
                }
            }
            DispatchQueue.main.async { completion(url, nil) }
        }
        task.resume()
    }

    // MARK: - 鎾斁鎺у埗

    /// 鎾斁URL锛堟敮鎸?15/澶稿厠缃戠洏302鐩磋繛锛岄瑙ｆ瀽閲嶅畾鍚戝悗VLC鐩存帴璁块棶CDN锛?    ///
    /// 銆愬叧閿€憇etupLibrary() 鍦?play() 寮€澶?*鍚屾**璋冪敤锛岀‘淇?player 闈炵┖鍚庡啀鍋氬紓姝ユ搷浣溿€?    /// 杩欐槸 e79f2cbd 绋冲畾鐗堜笉闂€€鐨勬牳蹇冨師鍥犮€?    /// - Parameters:
    ///   - url: 鎾斁URL锛圢AS鐨?direct-stream / cloud/115-direct 绔偣鎴栧畬鏁碈DN URL锛?    ///   - cloudDriver: 缃戠洏椹卞姩绫诲瀷锛坧an115/quark/cmcc锛夛紝鐢ㄤ簬閫夋嫨姝ｇ‘鐨刄A鍜孯eferer
    func play(url: URL, cloudDriver: String? = nil) {
        #if canImport(TVVLCKit)
        // 璁剧疆褰撳墠缃戠洏椹卞姩绫诲瀷锛堝繀椤诲湪 setupLibrary 涔嬪墠锛岀‘淇漊A涓€鑷达級
        if let driver = cloudDriver {
            currentCloudDriver = driver
        }
        log("鎾斁缃戠洏绫诲瀷: \(currentCloudDriver), UA=\(VLCPlayerManager.userAgent(forDriver: currentCloudDriver).prefix(25))...")

        // 鈽?鍚屾鍒涘缓 VLCLibrary + VLCMediaPlayer锛坋79f2cbd 绋冲畾鐗堟ā寮忥紝闃查棯閫€锛?        setupLibrary()

        guard let player = player else {
            onError?("VLC鎾斁鍣ㄦ湭鍒濆鍖?)
            return
        }

        // 閫掑浠ょ墝骞惰褰曟湰娆℃挱鏀撅細蹇垏姝屾椂锛屽彧鏈変护鐗屼粛鍖归厤鐨勬渶鏂颁竴娆″洖璋冩墠鍏佽鐪熸璧锋挱
        playToken += 1
        let token = playToken

        // 棰勮В鏋?02閲嶅畾鍚戯紝寰楀埌鏈€缁圕DN URL鍜岀綉鐩楥ookie鍚庡啀鎾斁
        resolveRedirect(for: url) { [weak self] finalURL, cloudCookie in
            guard let self = self else { return }
            // 鍏抽敭锛氳繃鏈熷洖璋冧涪寮冦€傝嫢鏈熼棿鍙堣Е鍙戜簡鏂扮殑 play()锛堝揩鍒囨瓕/鑷姩鍒囨瓕锛夛紝
            // 杩欓噷缁濅笉鑳藉啀 startPlayback锛屽惁鍒欎細涓庢柊姝岀殑鎾斁閾捐矾绔炰簤銆?            guard token == self.playToken else {
                self.log("play鍥炶皟杩囨湡(浠ょ墝\(token) != 褰撳墠\(self.playToken))锛屼涪寮?)
                return
            }
            self.startPlayback(player: player, url: finalURL, originalURL: url, cloudCookie: cloudCookie)
        }
        #else
        onError?("MobileVLCKit鏈泦鎴?)
        #endif
    }

    #if canImport(TVVLCKit)
    private func startPlayback(player: VLCMediaPlayer, url: URL, originalURL: URL, cloudCookie: String?) {
        cleanup()
        // 淇濆瓨鍘熷URL渚況estart浣跨敤锛圕DN鐩撮摼鏈夎繃鏈熸椂闂达紝restart鏃跺繀椤荤敤鍘熷URL閲嶆柊鑾峰彇锛?        self.originalStreamURL = originalURL

        log("鈻讹笍 鎾斁URL: \(url.absoluteString.prefix(120))")
        if url != originalURL {
            let host = url.host ?? ""
            if host.contains("quark") {
                log("   (鍘熷URL宸查瑙ｆ瀽涓哄じ鍏婥DN鐩撮摼)")
            } else if host.contains("115") || host.contains("115cdn") {
                log("   (鍘熷URL宸查瑙ｆ瀽涓?15 CDN鐩撮摼)")
            } else {
                log("   (鍘熷URL宸查瑙ｆ瀽涓虹綉鐩楥DN鐩撮摼)")
            }
        }
        log("URL scheme: \(url.scheme ?? "nil"), host: \(url.host ?? "nil")")

        // 涓夐噸UA淇濋殰锛?        // 1. library绾у埆 --http-user-agent (setupLibrary涓缃紝鍚屾鍒涘缓)
        // 2. media绾у埆 :http-user-agent
        // 3. 棰勮В鏋?02璁￢LC鐩存帴璇锋眰鏈€缁圲RL锛堥伩鍏嶉噸瀹氬悜涓A锛?        let ua = VLCPlayerManager.userAgent(forDriver: currentCloudDriver)
        let ref = VLCPlayerManager.referer(forDriver: currentCloudDriver)
        let media = VLCMedia(url: url)
        media.addOption(":http-user-agent=\(ua)")
        media.addOption(":http-referrer=\(ref)")
        media.addOption(":http-accept=*/*")
        if let cookie = cloudCookie, !cookie.isEmpty {
            // 鐢ㄥ紩鍙峰寘瑁笴ookie鍊硷紝閬垮厤鍒嗗彿琚玍LC閫夐」瑙ｆ瀽鍣ㄦ埅鏂?            media.addOption(":http-cookie=\"\(cookie)\"")
            log("宸茶缃甿edia UA(\(ua.prefix(20))...) + 缃戠洏Cookie(\(cookie.count)瀛楃,甯﹀紩鍙?, Referer=\(ref)")
        } else {
            log("宸茶缃甿edia UA: \(ua.prefix(30))...")
        }
        self.media = media
        player.media = media

        // 璁剧疆瑙嗛杈撳嚭
        let views = drawableViews.allObjects
        for view in views {
            player.drawable = view
        }
        log("宸叉敞鍐宒rawable鏁伴噺: \(views.count)")
        if views.isEmpty {
            log("鈿狅笍 璀﹀憡锛氭病鏈夊凡娉ㄥ唽鐨勮棰戣緭鍑鸿鍥撅紒")
        }

        let isCloud = url.absoluteString.contains("115cdn")
            || url.absoluteString.contains("direct-stream")
            || url.absoluteString.contains("share/stream")
            || url.absoluteString.contains("cloud/115-direct")
            || url.absoluteString.contains("cloud/stream-path")
            || url.absoluteString.contains("quark")
        if isCloud {
            log("浣跨敤缃戠洏鐩磋繛妯″紡锛堜笉鍗燦AS甯﹀锛孷LC鐩存帴璁块棶CDN锛?)
        }

        player.play()
        isPlaying = true
        onStateChange?(true)

        // 澶氭寤惰繜鍒锋柊drawable
        let delays: [Double] = [0.3, 0.8, 1.5, 2.5, 4.0, 6.0, 8.0]
        for (i, delay) in delays.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self else { return }
                self.refreshDrawables()
            }
        }

        // 缃戠粶娴侀煶杞ㄩ渶瑕佹洿闀挎椂闂磋В鏋愶紙HTTP缂撳啿+MKV demux锛夛紝澶氭寤惰繜鍒锋柊纭繚闊宠建鍒楄〃灏辩华
        let trackDelays: [Double] = [1.0, 2.0, 3.5, 5.0, 8.0, 12.0]
        for delay in trackDelays {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, let p = self.player else { return }
                self.refreshAudioTracks()
                let trackCount = p.audioTrackNames.count
                if trackCount >= 2 {
                    self.log("鉁?闊宠建宸插氨缁?\(trackCount)鏉?锛屽欢杩焅(delay)s")
                }
            }
        }
        // 寤惰繜4绉掓墦鍗扮姸鎬侊紙浠呮棩蹇楋紝涓嶈嚜鍔ㄩ噸璇曪紝閬垮厤寰幆锛?        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) { [weak self] in
            guard let self = self, let p = self.player else { return }
            self.log("4绉掑悗鐘舵€? \(p.state.rawValue), 瑙嗛杞?\(p.videoTrackNames.count), 闊抽杞?\(p.audioTrackNames.count)")
            if p.state == .error || p.videoTrackNames.count == 0 {
                let diskName = self.cloudDiskName(from: self.originalStreamURL)
                self.log("鈿狅笍 VLC鎾斁寮傚父锛堣棰戣建0鎴栭敊璇姸鎬侊級锛岃妫€鏌ョ綉缁滃拰\(diskName)鐧诲綍鐘舵€?)
            }
        }
        log("鈻讹笍 寮€濮嬫挱鏀? \(url.lastPathComponent)")

        startTimer()
    }
    #endif

    /// 浠庢挱鏀綰RL涓彁鍙栫綉鐩樺悕绉?    private func cloudDiskName(from url: URL?) -> String {
        guard let urlStr = url?.absoluteString else { return "缃戠洏" }
        if urlStr.contains("quark") { return "澶稿厠缃戠洏" }
        if urlStr.contains("cloud/direct/62") { return "澶稿厠缃戠洏" }
        if urlStr.contains("115") || urlStr.contains("cloud/direct/1") { return "115缃戠洏" }
        if urlStr.contains("cloud/direct/") {
            // 灏濊瘯鎻愬彇accountId
            if let range = urlStr.range(of: "cloud/direct/") {
                let rest = String(urlStr[range.upperBound...])
                if let accountId = rest.split(separator: "/").first {
                    return "缃戠洏#\(accountId)"
                }
            }
        }
        return "缃戠洏"
    }

    func pause() {
        #if canImport(TVVLCKit)
        player?.pause()
        isPlaying = false
        onStateChange?(false)
        #endif
    }

    func resume() {
        #if canImport(TVVLCKit)
        player?.play()
        isPlaying = true
        onStateChange?(true)
        #endif
    }

    func stop() {
        #if canImport(TVVLCKit)
        // 璁╂鍦ㄩ琛岀殑 resolveRedirect 鍥炶皟澶辨晥锛堝垏鍥濧VPlayer/鍋滄挱鏃讹級锛?        // 閬垮厤鏃у洖璋冩妸 VLC 鍙堟媺璧锋潵涓庢柊鎾斁閾捐矾绔炰簤銆?        playToken += 1
        player?.stop()
        isPlaying = false
        activeDrawable = nil
        onStateChange?(false)
        stopTimer()
        log("stop: 鍋滄VLC鎾斁(浠ょ墝\(playToken))")
        #endif
    }

    func seek(to seconds: Double) {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        player.time = VLCTime(int: Int32(seconds * 1000))
        currentTime = seconds
        #endif
    }

    // MARK: - 闊宠建鍒囨崲锛堝師鍞?浼村敱锛?
    func togglePlayPause() {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        if isPlaying {
            p.pause()
            isPlaying = false
            log("togglePlayPause: 鏆傚仠")
        } else {
            p.play()
            isPlaying = true
            log("togglePlayPause: 鎭㈠鎾斁")
            // 鎭㈠鎾斁鏃跺娆″埛鏂?drawable锛歏LC 鏆傚仠杩囦箙鍚庤棰戣緭鍑哄眰鍙兘澶辨晥锛?            // 涓嶅埛鏂颁細瀵艰嚧鍙湁澹伴煶鏃犵敾闈紙榛戝睆锛夈€傚瘑闆嗗埛鏂拌鐩?VLC 寮傛鎭㈠鐨勫悇涓樁娈点€?            let delays: [Double] = [0.1, 0.3, 0.6, 1.0, 1.5, 2.0, 3.0]
            for (i, delay) in delays.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.refreshDrawables()
                }
            }
        }
        #endif
    }

    func setVolume(_ volume: Float) {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        let vlcVolume = Int32(volume * 100)
        p.audio?.volume = vlcVolume
        log("setVolume: \(volume) (VLC: \(vlcVolume))")
        #endif
    }

    func restart() {
        #if canImport(TVVLCKit)
        guard !isRestarting else { return }
        // 浼樺厛浣跨敤淇濆瓨鐨勫師濮?stream URL锛坉irect-stream 鎴?share/stream锛孋DN鐩撮摼浼氳繃鏈燂紝涓嶈兘鐢╩edia.url锛?        let url = originalStreamURL ?? player?.media?.url
        guard let url = url, let p = player else { return }
        isRestarting = true
        log("restart: 鍋滄骞堕噸鏂版挱鏀?(URL: \(url.lastPathComponent))")
        p.stop()
        isPlaying = false
        onStateChange?(false)
        activeDrawable = nil
        // 寤惰繜0.5绉掑悗閲嶆柊鎾斁锛堢瓑寰呰繛鎺ュ畬鍏ㄥ叧闂級
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            self.play(url: url)
            let delays: [Double] = [0.5, 1.2, 2.0, 3.5]
            for (i, delay) in delays.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.refreshDrawables()
                    if i == delays.count - 1 {
                        self?.isRestarting = false
                    }
                }
            }
        }
        #endif
    }

    /// 淇濈暀鎾斁杩涘害鐨勮蒋閲嶅惎锛歴top鍚庨噸鏂皃lay骞秙eek鍥炲師浣嶇疆銆?    /// 鐢ㄤ簬澶у皬灞忎簰鍒囨椂寮哄埗VLC閲嶆柊鍒濆鍖栬棰戣緭鍑哄眰銆?    /// TVVLCKit鍦ㄦ挱鏀句腑鍔ㄦ€佸垏鎹rawable涓嶅彲闈狅紙鍙湁澹伴煶鏃犺棰戯級锛?    /// 蹇呴』stop+play閲嶅缓瑙嗛杈撳嚭銆傛鏂规硶淇濈暀杩涘害锛岀敤鎴锋劅鐭ュ彧鏄煭鏆傜紦鍐层€?    func restartPreservingPosition() {
        #if canImport(TVVLCKit)
        guard !isRestarting else { return }
        let url = originalStreamURL ?? player?.media?.url
        guard let url = url, let p = player else { return }
        // 淇濆瓨褰撳墠鎾斁鏃堕棿
        let savedTime = p.time
        isRestarting = true
        log("restartPreservingPosition: 淇濆瓨鏃堕棿=\(savedTime.intValue/1000)s, 鍋滄骞堕噸鏂版挱鏀?)
        p.stop()
        isPlaying = false
        onStateChange?(false)
        activeDrawable = nil
        // 寤惰繜0.5绉掗噸鏂版挱鏀?        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            self.play(url: url)
            // 绛夊緟缂撳啿鍚庡娆eek鍒颁繚瀛樼殑鏃堕棿
            let seekDelays: [Double] = [0.8, 1.2, 1.8, 2.5]
            for (i, delay) in seekDelays.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    guard let self = self, let p = self.player else { return }
                    if p.state == .playing || p.state == .buffering {
                        p.time = savedTime
                        if i == 0 {
                            self.log("restartPreservingPosition: seek鍒癨(savedTime.intValue/1000)s")
                        }
                    }
                    if i == seekDelays.count - 1 {
                        self.isRestarting = false
                        self.log("restartPreservingPosition: 瀹屾垚")
                    }
                }
            }
        }
        #endif
    }

    func forceResetDrawable() {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        p.drawable = nil
        activeDrawable = nil
        log("forceResetDrawable: 娓呴櫎鎵€鏈塪rawable")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self, let p = self.player else { return }
            if let active = self.drawableViews.allObjects.last as? UIView {
                self.activeDrawable = active
                p.drawable = active
            } else if let first = self.drawableViews.allObjects.first as? UIView {
                self.activeDrawable = first
                p.drawable = first
            }
        }
        #endif
    }

    func refreshAudioTracks() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        let names = player.audioTrackNames as? [String] ?? []
        var mappedNames: [String] = []
        for (i, name) in names.enumerated() {
            if name.lowercased() == "disable" { continue }
            if name.lowercased().contains("track 1") || name.lowercased().contains("track1") {
                mappedNames.append("鍘熷敱")
            } else if name.lowercased().contains("track 2") || name.lowercased().contains("track2") {
                mappedNames.append("浼村敱")
            } else {
                mappedNames.append(name)
            }
        }
        if mappedNames.isEmpty {
            mappedNames = ["鍘熷敱", "浼村敱"]
        }
        audioTrackNames = mappedNames
        let playerIndex = Int(player.currentAudioTrackIndex)
        if currentAudioTrackIndex < 0 || currentAudioTrackIndex >= mappedNames.count {
            if playerIndex >= 0 && playerIndex < names.count {
                var filteredIndex = 0
                for i in 0...playerIndex {
                    if i < names.count && names[i].lowercased() != "disable" {
                        if i == playerIndex { break }
                        filteredIndex += 1
                    }
                }
                currentAudioTrackIndex = filteredIndex
            } else {
                currentAudioTrackIndex = 0
            }
        }
        log("闊宠建鍒楄〃: \(audioTrackNames), 褰撳墠: \(currentAudioTrackIndex)")
        #endif
    }

    func setAudioTrack(index: Int) {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        let rawNames = player.audioTrackNames as? [String] ?? []
        var vlcIndex = 0
        var found = false
        var filteredCount = 0
        for (i, name) in rawNames.enumerated() {
            if name.lowercased() == "disable" { continue }
            if filteredCount == index {
                vlcIndex = i
                found = true
                break
            }
            filteredCount += 1
        }
        if found {
            player.currentAudioTrackIndex = Int32(vlcIndex)
            log("鍒囨崲闊宠建: 鏄犲皠\(index) -> VLC\(vlcIndex), \(rawNames[vlcIndex])")
        } else {
            player.currentAudioTrackIndex = Int32(index)
        }
        currentAudioTrackIndex = index
        #endif
    }

    func toggleVoice() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        // 闊宠建鏈氨缁椂鍏堝埛鏂颁竴娆★紙缃戠粶娴佸彲鑳藉欢杩熻В鏋愶級
        if audioTrackNames.isEmpty {
            refreshAudioTracks()
        }
        let count = max(audioTrackNames.count, 1)
        let nextIndex = (currentAudioTrackIndex + 1) % count
        log("toggleVoice: \(currentAudioTrackIndex) -> \(nextIndex), 杞ㄩ亾鏁?\(count)")
        setAudioTrack(index: nextIndex)
        #endif
    }

    var voiceLabel: String {
        if audioTrackNames.isEmpty {
            return currentAudioTrackIndex == 0 ? "鍘熷敱" : "浼村敱"
        }
        if currentAudioTrackIndex < audioTrackNames.count {
            return audioTrackNames[currentAudioTrackIndex]
        }
        return "鍘熷敱"
    }

    // MARK: - 瑙嗛杈撳嚭瑙嗗浘

    func addDrawable(_ view: UIView) {
        drawableViews.add(view)
        let activeInArray = drawableViews.allObjects.contains(where: { $0 as AnyObject === activeDrawable })
        if activeDrawable == nil || !activeInArray {
            setActiveDrawable(view)
        }
    }

    /// 璁剧疆娲诲姩drawable骞跺己鍒跺埛鏂拌棰戣緭鍑猴紙缁熶竴鍏ュ彛锛屽叏灞忓拰灏忓睆閮界敤杩欎釜锛?    /// 鍏堣nil鍐嶅娆″欢杩熻缃紝寮哄埗VLC閲嶆柊鍒涘缓瑙嗛杈撳嚭灞傦紝
    /// 瑙ｅ喅澶у皬灞忎簰鍒囨椂鍙湁澹伴煶鏃犺棰戠殑闂銆?    func setActiveDrawable(_ view: UIView?) {
        activeDrawable = view
        #if canImport(TVVLCKit)
        if let v = view {
            ensureVideoOutput(for: v)
        } else {
            player?.drawable = nil
        }
        #endif
    }

    /// 鍏煎鏃ф帴鍙ｏ細鍏ㄥ睆鎻愬崌锛屽唴閮ㄨ皟鐢╡nsureVideoOutput
    func promoteToFullscreen(_ view: UIView) {
        log("promoteToFullscreen: 鎻愬崌瑙嗗浘涓烘椿鍔╠rawable")
        setActiveDrawable(view)
    }

    /// 寮哄埗纭繚瑙嗛杈撳嚭鍒版寚瀹氳鍥撅細鍏堟竻闄わ紝鍐嶅湪澶氫釜鏃堕棿鐐归噸鏂拌缃紝
    /// 姣忔閮芥槸nil鈫掕缃紝寮哄埗VLC閿€姣佸苟閲嶅缓瑙嗛娓叉煋灞傘€?    /// 杩欐槸瑙ｅ喅"鍒囨崲瑙嗗浘鍚庡彧鏈夊０闊虫棤瑙嗛"鐨勬牳蹇冩柟娉曘€?    private func ensureVideoOutput(for view: UIView) {
        #if canImport(TVVLCKit)
        guard let p = player else { return }
        // 绔嬪嵆娓呴櫎
        p.drawable = nil
        // 澶氫釜鏃堕棿鐐归噸鏂拌缃紝瑕嗙洊VLC寮傛鍒濆鍖栫殑鍚勪釜闃舵
        let delays: [Double] = [0.05, 0.15, 0.3, 0.5, 0.8, 1.2, 1.8]
        for (i, delay) in delays.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak p, weak view, weak self] in
                guard let p = p, let view = view, let self = self else { return }
                // 鍙湪杩欎釜瑙嗗浘浠嶇劧鏄椿鍔╠rawable鏃舵墠璁剧疆
                guard self.activeDrawable === view else { return }
                p.drawable = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { [weak p, weak view] in
                    guard let p = p, let view = view else { return }
                    p.drawable = view
                    if i < 3 {  // 鍓?娆℃墦鏃ュ織锛岄伩鍏嶅埛灞?                        self.log("ensureVideoOutput: 绗琝(i+1)/\(delays.count)娆″埛鏂癲rawable")
                    }
                }
            }
        }
        #endif
    }

    func clearActiveDrawable(_ view: UIView) {
        let wasActive = activeDrawable === view
        drawableViews.remove(view)
        if wasActive {
            activeDrawable = nil
            // 娓呴櫎鍚庯紝濡傛灉杩樻湁鍏朵粬瑙嗗浘锛屼富鍔ㄧ‘淇濊棰戣緭鍑哄垏鎹㈠埌涓嬩竴涓?            if let next = drawableViews.allObjects.first(where: { $0 !== view }) as? UIView {
                log("clearActiveDrawable: 鍒囨崲鍒颁笅涓€涓鍥?)
                setActiveDrawable(next)
            } else {
                player?.drawable = nil
                log("clearActiveDrawable: 鏃犲彲鐢ㄨ鍥撅紝娓呴櫎drawable")
            }
        }
    }

    func refreshDrawables() {
        #if canImport(TVVLCKit)
        if let active = activeDrawable {
            ensureVideoOutput(for: active)
        } else if let first = drawableViews.allObjects.first as? UIView {
            setActiveDrawable(first)
        }
        #endif
    }

    func removeDrawable(_ view: UIView) {
        drawableViews.remove(view)
    }

    // MARK: - 鍐呴儴

    private func startTimer() {
        stopTimer()
        timeObserverTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.updateTime()
        }
    }

    private func stopTimer() {
        timeObserverTimer?.invalidate()
        timeObserverTimer = nil
    }

    private func updateTime() {
        #if canImport(TVVLCKit)
        guard let player = player else { return }
        let currentMs = player.time.intValue
        let totalMs = player.media?.length.intValue ?? 0
        let current = Double(currentMs) / 1000.0
        let total = Double(totalMs) / 1000.0
        if Int(current) % 5 == 0 && Int(current) != lastDebugSecond {
            lastDebugSecond = Int(current)
            log("鏃堕棿: \(current)s / \(total)s, state=\(player.state.rawValue)")
        }
        if current != currentTime || total != duration {
            currentTime = current
            duration = total
            onTimeUpdate?(currentTime, duration)
        }
        #endif
    }

    private func cleanup() {
        stopTimer()
        #if canImport(TVVLCKit)
        player?.stop()
        media = nil
        #endif
        currentTime = 0
        duration = 0
        audioTrackNames = []
        currentAudioTrackIndex = 0
    }
}

#if canImport(TVVLCKit)
extension VLCPlayerManager: VLCMediaPlayerDelegate {
    func mediaPlayerStateChanged(_ aNotification: Notification) {
        guard let player = player else { return }
        let stateNames = ["Idle", "Opening", "Buffering", "Ended", "Error", "Playing", "Paused", "Stopped"]
        let stateName = player.state.rawValue < stateNames.count ? stateNames[Int(player.state.rawValue)] : "Unknown"
        if player.state.rawValue != lastReportedState {
            log("鐘舵€? \(stateName)(\(player.state.rawValue)), 鏃堕暱:\(player.media?.length.intValue ?? 0)ms")
            lastReportedState = player.state.rawValue
        }
        switch player.state {
        case .playing:
            isPlaying = true
            onStateChange?(true)
            refreshAudioTracks()
        case .paused:
            isPlaying = false
            onStateChange?(false)
        case .ended:
            isPlaying = false
            onStateChange?(false)
            // VLC 鎾斁鑷劧缁撴潫锛氳Е鍙戣嚜鍔ㄦ挱鏀句笅涓€棣栵紙淇 VLC 妯″紡涓嬫挱瀹屼笉鑷姩鍒囨瓕锛?            onPlaybackEnd?()
        case .error:
            log("鉂?VLC閿欒! 瑙嗛杞?\(player.videoTrackNames.count) 闊抽杞?\(player.audioTrackNames.count)")
            if let media = player.media {
                log("鉂?URL: \(media.url?.absoluteString ?? "nil")")
            }
            onError?("VLC鎾斁閿欒")
        default:
            break
        }
    }

    func mediaPlayerTimeChanged(_ aNotification: Notification) {
        updateTime()
    }
}
#endif
