import UIKit
#if canImport(MobileVLCKit)
import MobileVLCKit
#endif

/// 主播放界面：全屏视频 + 歌词 + 控制栏 + 点歌队列侧栏
class MainViewController: UIViewController {
    private let videoContainer = UIView()
    private let lyricsView = LyricsView()
    private let songInfoLabel = UILabel()
    private let voiceLabel = UILabel()
    private let queueTitleLabel = UILabel()
    private let tableView = UITableView()
    private let controlBar = UIView()
    private let playPauseButton = UIButton(type: .system)
    private let voiceButton = UIButton(type: .system)
    private let prevButton = UIButton(type: .system)
    private let nextButton = UIButton(type: .system)
    private let configButton = UIButton(type: .system)

    private var queueItems: [QueueItem] = []
    private var currentQueueId: Int?
    private var progressTimer: Timer?
    private let debugLabel = UILabel()

    private let prefsKey = "momo_ktv_server_url"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupUI()
        setupPlayers()
        connectServer()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
        VLCSharedVideoView.shared.attach(to: videoContainer)
        debugLog("viewWillAppear, 队列\(queueItems.count)首")
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
    }

    // MARK: - UI
    private func setupUI() {
        // 视频容器
        videoContainer.backgroundColor = .black
        videoContainer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(videoContainer)

        // 歌词
        lyricsView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(lyricsView)

        // 歌曲信息
        songInfoLabel.text = "未播放"
        songInfoLabel.textColor = .white
        songInfoLabel.font = .systemFont(ofSize: 16, weight: .medium)
        songInfoLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(songInfoLabel)

        // 调试标签
        debugLabel.text = "DEBUG: 初始化中..."
        debugLabel.textColor = UIColor(red: 0.5, green: 1.0, blue: 0.5, alpha: 1.0)
        debugLabel.font = .systemFont(ofSize: 10)
        debugLabel.numberOfLines = 0
        debugLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(debugLabel)

        // 声道
        voiceLabel.text = "声道: 原唱"
        voiceLabel.textColor = UIColor(red: 1.0, green: 0.84, blue: 0.0, alpha: 1.0)
        voiceLabel.font = .systemFont(ofSize: 14)
        voiceLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(voiceLabel)

        // 队列面板
        let queuePanel = UIView()
        queuePanel.backgroundColor = UIColor(white: 0.1, alpha: 1.0)
        queuePanel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(queuePanel)

        queueTitleLabel.text = "点歌队列 (0)"
        queueTitleLabel.textColor = .white
        queueTitleLabel.font = .systemFont(ofSize: 16, weight: .bold)
        queueTitleLabel.translatesAutoresizingMaskIntoConstraints = false
        queuePanel.addSubview(queueTitleLabel)

        tableView.backgroundColor = .clear
        tableView.separatorColor = UIColor(white: 0.2, alpha: 1)
        tableView.delegate = self
        tableView.dataSource = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "QueueCell")
        tableView.translatesAutoresizingMaskIntoConstraints = false
        queuePanel.addSubview(tableView)

        // 控制栏
        controlBar.backgroundColor = UIColor(white: 0.13, alpha: 1.0)
        controlBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controlBar)

        let buttons = [(prevButton, "上一首"), (playPauseButton, "播放"), (nextButton, "下一首"),
                       (voiceButton, "原唱/伴唱"), (configButton, "设置")]
        for (btn, title) in buttons {
            btn.setTitle(title, for: .normal)
            btn.setTitleColor(.white, for: .normal)
            btn.backgroundColor = UIColor(white: 0.25, alpha: 1)
            btn.layer.cornerRadius = 6
            btn.titleLabel?.font = .systemFont(ofSize: 14, weight: .medium)
            btn.translatesAutoresizingMaskIntoConstraints = false
            controlBar.addSubview(btn)
        }

        playPauseButton.addTarget(self, action: #selector(togglePlayPause), for: .touchUpInside)
        voiceButton.addTarget(self, action: #selector(toggleVoice), for: .touchUpInside)
        prevButton.addTarget(self, action: #selector(playPrev), for: .touchUpInside)
        nextButton.addTarget(self, action: #selector(playNext), for: .touchUpInside)
        configButton.addTarget(self, action: #selector(openConfig), for: .touchUpInside)

        // 布局
        let queueWidth: CGFloat = 280
        let barHeight: CGFloat = 60
        NSLayoutConstraint.activate([
            videoContainer.topAnchor.constraint(equalTo: view.topAnchor),
            videoContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            videoContainer.trailingAnchor.constraint(equalTo: queuePanel.leadingAnchor),
            videoContainer.bottomAnchor.constraint(equalTo: controlBar.topAnchor),

            lyricsView.leadingAnchor.constraint(equalTo: videoContainer.leadingAnchor),
            lyricsView.trailingAnchor.constraint(equalTo: videoContainer.trailingAnchor),
            lyricsView.bottomAnchor.constraint(equalTo: controlBar.topAnchor, constant: -16),
            lyricsView.heightAnchor.constraint(equalToConstant: 120),

            songInfoLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            songInfoLabel.leadingAnchor.constraint(equalTo: videoContainer.leadingAnchor, constant: 16),

            debugLabel.topAnchor.constraint(equalTo: songInfoLabel.bottomAnchor, constant: 4),
            debugLabel.leadingAnchor.constraint(equalTo: videoContainer.leadingAnchor, constant: 16),
            debugLabel.trailingAnchor.constraint(equalTo: queuePanel.leadingAnchor, constant: -16),

            voiceLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            voiceLabel.trailingAnchor.constraint(equalTo: queuePanel.leadingAnchor, constant: -16),

            queuePanel.topAnchor.constraint(equalTo: view.topAnchor),
            queuePanel.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            queuePanel.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            queuePanel.widthAnchor.constraint(equalToConstant: queueWidth),

            queueTitleLabel.topAnchor.constraint(equalTo: queuePanel.safeAreaLayoutGuide.topAnchor, constant: 12),
            queueTitleLabel.leadingAnchor.constraint(equalTo: queuePanel.leadingAnchor, constant: 12),
            queueTitleLabel.trailingAnchor.constraint(equalTo: queuePanel.trailingAnchor, constant: -12),

            tableView.topAnchor.constraint(equalTo: queueTitleLabel.bottomAnchor, constant: 8),
            tableView.leadingAnchor.constraint(equalTo: queuePanel.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: queuePanel.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: queuePanel.bottomAnchor),

            controlBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controlBar.trailingAnchor.constraint(equalTo: queuePanel.leadingAnchor),
            controlBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            controlBar.heightAnchor.constraint(equalToConstant: barHeight),
        ])

        // 控制栏按钮布局
        let buttonStack = UIStackView(arrangedSubviews: [prevButton, playPauseButton, nextButton, voiceButton, configButton])
        buttonStack.axis = .horizontal
        buttonStack.spacing = 10
        buttonStack.distribution = .fillEqually
        buttonStack.alignment = .center
        buttonStack.translatesAutoresizingMaskIntoConstraints = false
        controlBar.addSubview(buttonStack)
        NSLayoutConstraint.activate([
            buttonStack.centerYAnchor.constraint(equalTo: controlBar.centerYAnchor),
            buttonStack.leadingAnchor.constraint(equalTo: controlBar.leadingAnchor, constant: 16),
            buttonStack.trailingAnchor.constraint(equalTo: controlBar.trailingAnchor, constant: -16),
            buttonStack.heightAnchor.constraint(equalToConstant: 40),
        ])
    }

    // MARK: - 播放器
    private func setupPlayers() {
        VLCPlayerManager.shared.onTimeUpdate = { [weak self] current, duration in
            DispatchQueue.main.async {
                self?.lyricsView.updateProgress(timeMs: current * 1000)
            }
        }
        VLCPlayerManager.shared.onStateChange = { [weak self] playing in
            DispatchQueue.main.async {
                self?.playPauseButton.setTitle(playing ? "暂停" : "播放", for: .normal)
            }
        }
        VLCPlayerManager.shared.onError = { [weak self] err in
            DispatchQueue.main.async {
                self?.debugLog("VLC错误: \(err)")
                let alert = UIAlertController(title: "播放错误", message: err, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                self?.present(alert, animated: true)
            }
        }
        VLCPlayerManager.shared.onEnded = { [weak self] in
            DispatchQueue.main.async { self?.playNext() }
        }
    }

    private func connectServer() {
        guard let url = UserDefaults.standard.string(forKey: prefsKey), !url.isEmpty else {
            debugLog("无服务器地址，跳转到配置页")
            navigationController?.setViewControllers([ServerConfigViewController()], animated: false)
            return
        }
        debugLog("连接服务器: \(url)")
        let api = KTVAPIClient(baseURL: url)
        KTVAPIClient.shared.updateBaseURL(url)
        debugLog("shared.baseURL=\(KTVAPIClient.shared.baseURL)")

        KTVWebSocketClient.shared.onQueueUpdate = { [weak self] queue in
            DispatchQueue.main.async { self?.updateQueue(queue) }
        }
        KTVWebSocketClient.shared.onControl = { [weak self] action, payload in
            DispatchQueue.main.async { self?.handleControl(action, payload) }
        }
        KTVWebSocketClient.shared.connect(apiClient: api)

        api.fetchQueue { [weak self] queue in
            DispatchQueue.main.async { self?.updateQueue(queue) }
        }
    }

    private func updateQueue(_ items: [QueueItem]) {
        queueItems = items
        queueTitleLabel.text = "点歌队列 (\(items.count))"
        tableView.reloadData()
        debugLog("队列更新: \(items.count)首, 当前播放ID=\(currentQueueId ?? -1)")
        let playing = items.first { $0.isPlaying }
        if let playing = playing, playing.queue_id != currentQueueId {
            debugLog("自动播放: \(playing.displayTitle)")
            playQueueItem(playing)
        } else if playing == nil {
            debugLog("队列中无正在播放的歌曲")
        }
    }

    private func playQueueItem(_ item: QueueItem) {
        debugLog("playQueueItem: \(item.displayTitle), filepath=\(item.filepath ?? "nil")")
        guard let filepath = item.filepath else {
            debugLog("ERROR: filepath 为 nil，无法播放")
            return
        }
        guard let url = KTVAPIClient.shared.directStreamURL(filepath: filepath) else {
            debugLog("ERROR: directStreamURL 返回 nil, baseURL=\(KTVAPIClient.shared.baseURL)")
            return
        }
        debugLog("播放URL: \(url.absoluteString.prefix(80))...")
        currentQueueId = item.queue_id
        songInfoLabel.text = "\(item.displayTitle) - \(item.displayArtist)"
        lyricsView.clear()
        VLCPlayerManager.shared.setActiveDrawable(videoContainer)
        VLCPlayerManager.shared.play(url: url)
        debugLog("已调用 VLCPlayerManager.play()")

        // 获取分离信息（音轨）
        KTVAPIClient.shared.fetchSepInfo(songId: item.song_id) { info in
            if let info = info, let tracks = info.audioTracks, !tracks.isEmpty {
                DispatchQueue.main.async {
                    self.voiceLabel.text = "声道: 原唱 (\(tracks.count)轨)"
                }
            }
        }
    }

    // MARK: - 控制
    @objc private func togglePlayPause() {
        debugLog("点击播放/暂停, isPlaying=\(VLCPlayerManager.shared.isPlaying), currentQueueId=\(currentQueueId ?? -1)")
        if currentQueueId == nil {
            debugLog("警告: 当前无播放歌曲，队列\(queueItems.count)首")
            if let first = queueItems.first {
                debugLog("自动播放第一首")
                playQueueItem(first)
                return
            }
        }
        VLCPlayerManager.shared.togglePlayPause()
        KTVWebSocketClient.shared.sendPlaybackState(paused: !VLCPlayerManager.shared.isPlaying,
                                                  voice: VLCPlayerManager.shared.voiceLabel)
    }

    @objc private func toggleVoice() {
        VLCPlayerManager.shared.toggleVoice()
        voiceLabel.text = "声道: \(VLCPlayerManager.shared.voiceLabel)"
        KTVWebSocketClient.shared.sendPlaybackState(paused: !VLCPlayerManager.shared.isPlaying,
                                                  voice: VLCPlayerManager.shared.voiceLabel)
    }

    @objc private func playPrev() {
        guard let idx = queueItems.firstIndex(where: { $0.queue_id == currentQueueId }),
              idx > 0 else { return }
        playQueueItem(queueItems[idx - 1])
    }

    @objc private func playNext() {
        guard let idx = queueItems.firstIndex(where: { $0.queue_id == currentQueueId }) else {
            if let first = queueItems.first { playQueueItem(first) }
            return
        }
        if idx < queueItems.count - 1 {
            playQueueItem(queueItems[idx + 1])
        }
    }

    @objc private func openConfig() {
        navigationController?.pushViewController(ServerConfigViewController(), animated: true)
    }

    private func handleControl(_ action: String, _ payload: [String: Any]) {
        switch action {
        case "play": VLCPlayerManager.shared.resume()
        case "pause": VLCPlayerManager.shared.pause()
        case "toggle": VLCPlayerManager.shared.togglePlayPause()
        case "next": playNext()
        case "prev": playPrev()
        case "seek":
            if let time = payload["time"] as? Double {
                VLCPlayerManager.shared.seek(to: time)
            }
        case "voice": toggleVoice()
        case "play_song":
            if let songId = (payload["song_id"] as? NSNumber)?.intValue {
                KTVAPIClient.shared.addToQueue(songId: songId)
            }
        default: break
        }
    }

    // MARK: - 调试
    private func debugLog(_ msg: String) {
        print("[DEBUG] \(msg)")
        DispatchQueue.main.async {
            self.debugLabel.text = "DEBUG: \(msg)"
        }
    }

    deinit {
        VLCPlayerManager.shared.stop()
        KTVWebSocketClient.shared.disconnect()
    }
}

// MARK: - UITableView
extension MainViewController: UITableViewDelegate, UITableViewDataSource {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        queueItems.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "QueueCell", for: indexPath)
        let item = queueItems[indexPath.row]
        cell.backgroundColor = .clear
        cell.textLabel?.text = item.displayTitle
        cell.textLabel?.textColor = item.isPlaying ?
            UIColor(red: 1.0, green: 0.84, blue: 0.0, alpha: 1.0) : .white
        cell.detailTextLabel?.text = item.displayArtist
        cell.detailTextLabel?.textColor = .lightGray
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        playQueueItem(queueItems[indexPath.row])
    }
}
