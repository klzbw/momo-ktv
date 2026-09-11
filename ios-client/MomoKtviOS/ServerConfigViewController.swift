import UIKit

/// 服务器配置页面：输入服务器地址，测试连接，持久化存储
class ServerConfigViewController: UIViewController {
    private let textField = UITextField()
    private let testButton = UIButton(type: .system)
    private let saveButton = UIButton(type: .system)
    private let statusLabel = UILabel()

    private let prefsKey = "momo_ktv_server_url"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        title = "服务器配置"
        setupUI()
        textField.text = UserDefaults.standard.string(forKey: prefsKey) ?? "192.168.1.100:3000"
    }

    private func setupUI() {
        let titleLabel = UILabel()
        titleLabel.text = "墨墨爱K歌"
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 28, weight: .bold)
        titleLabel.textAlignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(titleLabel)

        let hintLabel = UILabel()
        hintLabel.text = "服务器地址 (IP:端口)"
        hintLabel.textColor = .lightGray
        hintLabel.font = .systemFont(ofSize: 14)
        hintLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hintLabel)

        textField.placeholder = "例如: 192.168.1.100:3000"
        textField.backgroundColor = UIColor(white: 0.15, alpha: 1)
        textField.textColor = .white
        textField.layer.cornerRadius = 8
        textField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 0))
        textField.leftViewMode = .always
        textField.keyboardType = .URL
        textField.autocapitalizationType = .none
        textField.autocorrectionType = .no
        textField.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(textField)

        statusLabel.text = ""
        statusLabel.textColor = .lightGray
        statusLabel.font = .systemFont(ofSize: 13)
        statusLabel.textAlignment = .center
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)

        testButton.setTitle("测试连接", for: .normal)
        testButton.setTitleColor(.white, for: .normal)
        testButton.backgroundColor = UIColor(white: 0.2, alpha: 1)
        testButton.layer.cornerRadius = 8
        testButton.addTarget(self, action: #selector(testConnection), for: .touchUpInside)
        testButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(testButton)

        saveButton.setTitle("保存并进入", for: .normal)
        saveButton.setTitleColor(.black, for: .normal)
        saveButton.backgroundColor = UIColor(red: 1.0, green: 0.84, blue: 0.0, alpha: 1.0)
        saveButton.layer.cornerRadius = 8
        saveButton.addTarget(self, action: #selector(saveAndEnter), for: .touchUpInside)
        saveButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(saveButton)

        NSLayoutConstraint.activate([
            titleLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 60),
            titleLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),

            hintLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 40),
            hintLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 40),

            textField.topAnchor.constraint(equalTo: hintLabel.bottomAnchor, constant: 8),
            textField.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 40),
            textField.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -40),
            textField.heightAnchor.constraint(equalToConstant: 48),

            statusLabel.topAnchor.constraint(equalTo: textField.bottomAnchor, constant: 12),
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),

            testButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 24),
            testButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 40),
            testButton.trailingAnchor.constraint(equalTo: view.centerXAnchor, constant: -8),
            testButton.heightAnchor.constraint(equalToConstant: 48),

            saveButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 24),
            saveButton.leadingAnchor.constraint(equalTo: view.centerXAnchor, constant: 8),
            saveButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -40),
            saveButton.heightAnchor.constraint(equalToConstant: 48),
        ])
    }

    @objc private func testConnection() {
        guard let url = textField.text?.trimmingCharacters(in: .whitespaces), !url.isEmpty else {
            statusLabel.text = "请输入服务器地址"
            return
        }
        statusLabel.text = "测试中..."
        let api = KTVAPIClient(baseURL: url)
        api.fetchStats { [weak self] stats in
            DispatchQueue.main.async {
                if let stats = stats {
                    self?.statusLabel.text = "✓ 连接成功！歌曲: \(stats.total_songs ?? 0)"
                    self?.statusLabel.textColor = .green
                } else {
                    self?.statusLabel.text = "✗ 连接失败，请检查地址"
                    self?.statusLabel.textColor = .red
                }
            }
        }
    }

    @objc private func saveAndEnter() {
        guard let url = textField.text?.trimmingCharacters(in: .whitespaces), !url.isEmpty else {
            statusLabel.text = "请输入服务器地址"
            return
        }
        UserDefaults.standard.set(url, forKey: prefsKey)
        let mainVC = MainViewController()
        navigationController?.setViewControllers([mainVC], animated: true)
    }
}
