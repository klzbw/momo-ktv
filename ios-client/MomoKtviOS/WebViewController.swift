import UIKit
import WebKit

class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {

    var webView: WKWebView!
    private var progressObs: NSKeyValueObservation?
    private let progressBar = UIProgressView(progressViewStyle: .bar)
    private let toolBar = UIView()
    private var toolbarTop: NSLayoutConstraint!
    private var toolbarHidden = false
    private var hideWorkItem: DispatchWorkItem?

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.08, green: 0.08, blue: 0.12, alpha: 1.0)
        setupWebView()
        setupToolbar()
        setupProgressBar()

        if ServerConfig.isConfigured {
            loadTV()
        } else {
            presentSetup(animated: false)
        }
    }

    // MARK: - WebView

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        // 媒体自动播放（不要求用户手势）+ 内联播放（不全屏）
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        config.allowsAirPlayForMediaPlayback = true
        // 离线缓存偏好
        if #available(iOS 13.0, *) {
            config.websiteDataStore = .default()
        }

        // 偏好设置：启用 JS
        let prefs = WKPreferences()
        prefs.javaScriptEnabled = true
        if #available(iOS 13.0, *) {
            prefs.isFraudulentWebsiteWarningEnabled = false
        }
        config.preferences = prefs

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.scrollView.bounces = false
        webView.backgroundColor = UIColor(red: 0.08, green: 0.08, blue: 0.12, alpha: 1.0)
        webView.isOpaque = false
        // 允许网页内嵌视频自动进入画中画/后台
        webView.allowsBackForwardNavigationGestures = true
        view.addSubview(webView)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        // 加载进度
        progressObs = webView.observe(\.estimatedProgress, options: .new) { [weak self] _, _ in
            guard let self = self else { return }
            self.progressBar.setProgress(Float(self.webView.estimatedProgress), animated: true)
            self.progressBar.isHidden = self.webView.estimatedProgress >= 1.0
        }
    }

    private func setupProgressBar() {
        progressBar.progressTintColor = UIColor.systemPink
        progressBar.trackTintColor = UIColor.white.withAlphaComponent(0.1)
        progressBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(progressBar)
        NSLayoutConstraint.activate([
            progressBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progressBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progressBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progressBar.heightAnchor.constraint(equalToConstant: 3)
        ])
    }

    // MARK: - 悬浮工具条（刷新/主页/设置）

    private func setupToolbar() {
        toolBar.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        toolBar.layer.cornerRadius = 18
        toolBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(toolBar)
        toolbarTop = toolBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 10)
        NSLayoutConstraint.activate([
            toolBar.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            toolbarTop,
            toolBar.heightAnchor.constraint(equalToConstant: 36)
        ])

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        toolBar.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: toolBar.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: toolBar.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: toolBar.topAnchor),
            stack.bottomAnchor.constraint(equalTo: toolBar.bottomAnchor)
        ])

        stack.addArrangedSubview(makeToolButton("刷新", action: #selector(reloadPage)))
        stack.addArrangedSubview(makeToolButton("主页", action: #selector(goHome)))
        stack.addArrangedSubview(makeToolButton("设置", action: #selector(openSettings)))

        // 点击 WebView 区域切换工具条显隐
        let tap = UITapGestureRecognizer(target: self, action: #selector(screenTapped))
        tap.cancelsTouchesInView = false
        webView.addGestureRecognizer(tap)

        scheduleHideToolbar()
    }

    private func makeToolButton(_ systemName: String, action: Selector) -> UIButton {
        let btn = UIButton(type: .system)
        if #available(iOS 13.0, *) {
            let cfg = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
            btn.setImage(UIImage(systemName: systemName, withConfiguration: cfg), for: .normal)
            btn.tintColor = .white
        } else {
            btn.setTitle(systemName, for: .normal)
            btn.setTitleColor(.white, for: .normal)
            btn.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
        }
        btn.frame = CGRect(x: 0, y: 0, width: 44, height: 36)
        btn.addTarget(self, action: action, for: .touchUpInside)
        btn.widthAnchor.constraint(equalToConstant: 44).isActive = true
        return btn
    }

    @objc private func screenTapped() {
        toolbarHidden ? showToolbar() : scheduleHideToolbar()
    }

    private func scheduleHideToolbar() {
        hideWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.hideToolbar() }
        hideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0, execute: work)
    }

    private func showToolbar() {
        toolbarHidden = false
        UIView.animate(withDuration: 0.2) { self.toolBar.alpha = 1.0 }
        scheduleHideToolbar()
    }

    private func hideToolbar() {
        toolbarHidden = true
        UIView.animate(withDuration: 0.25) { self.toolBar.alpha = 0.0 }
    }

    // MARK: - 加载

    func loadTV() {
        guard let url = ServerConfig.tvURL else {
            presentSetup(animated: true)
            return
        }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        webView.load(request)
    }

    @objc private func reloadPage() {
        if ServerConfig.isConfigured {
            webView.reload()
        } else {
            presentSetup(animated: true)
        }
        scheduleHideToolbar()
    }

    @objc private func goHome() {
        loadTV()
        scheduleHideToolbar()
    }

    @objc private func openSettings() {
        presentSetup(animated: true)
        scheduleHideToolbar()
    }

    private func presentSetup(animated: Bool) {
        let setup = ServerSetupViewController()
        setup.onSaved = { [weak self] in
            self?.loadTV()
        }
        setup.modalPresentationStyle = .fullScreen
        if animated {
            present(setup, animated: true)
        } else {
            DispatchQueue.main.async { self.present(setup, animated: false) }
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progressBar.setProgress(0, animated: false)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    private func handleLoadError(_ error: Error) {
        let nsErr = error as NSError
        // 取消加载不算错误
        if nsErr.code == NSURLErrorCancelled { return }
        // 102 是内网 HTTP 常见的帧加载中断，忽略
        if nsErr.code == 102 { return }
        showErrorToast(nsErr.localizedDescription)
    }

    private var toast: UILabel?
    private func showErrorToast(_ msg: String) {
        if toast == nil {
            let label = UILabel()
            label.backgroundColor = UIColor.black.withAlphaComponent(0.75)
            label.textColor = .white
            label.font = .systemFont(ofSize: 14, weight: .medium)
            label.textAlignment = .center
            label.numberOfLines = 0
            label.layer.cornerRadius = 10
            label.layer.masksToBounds = true
            label.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                label.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -30),
                label.widthAnchor.constraint(lessThanOrEqualToConstant: 500),
                label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 30)
            ])
            toast = label
        }
        toast?.text = "  连接失败：\(msg)，点齿轮检查服务器地址  "
        toast?.alpha = 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            UIView.animate(withDuration: 0.5) { self.toast?.alpha = 0 }
        }
    }

    // MARK: - 状态栏

    override var prefersStatusBarHidden: Bool { true }
}
