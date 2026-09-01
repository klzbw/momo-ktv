import UIKit

class ServerSetupViewController: UIViewController, UITextFieldDelegate {

    var onSaved: (() -> Void)?

    private let hostField = UITextField()
    private let portField = UITextField()
    private let connectBtn = UIButton(type: .system)
    private let statusLabel = UILabel()
    private let scrollView = UIScrollView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.10, green: 0.10, blue: 0.16, alpha: 1.0)
        setupUI()
        hostField.text = ServerConfig.host
        portField.text = ServerConfig.port
    }

    private func setupUI() {
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)

        let content = UIView()
        content.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(content)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: scrollView.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: scrollView.trailingAnchor),
            content.topAnchor.constraint(equalTo: scrollView.topAnchor),
            content.bottomAnchor.constraint(equalTo: scrollView.bottomAnchor),
            content.widthAnchor.constraint(equalTo: scrollView.widthAnchor)
        ])

        // 标题
        let titleLabel = UILabel()
        titleLabel.text = "墨墨爱K歌"
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 34, weight: .heavy)
        titleLabel.textAlignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(titleLabel)

        let subLabel = UILabel()
        subLabel.text = "请输入服务器（飞牛NAS / 主机）的 IP 地址"
        subLabel.textColor = UIColor.white.withAlphaComponent(0.7)
        subLabel.font = .systemFont(ofSize: 15, weight: .regular)
        subLabel.textAlignment = .center
        subLabel.numberOfLines = 0
        subLabel.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(subLabel)

        // IP 输入
        configureField(hostField, placeholder: "例如 192.168.3.16", keyboard: .decimalPad)
        hostField.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(hostField)

        // 端口输入
        configureField(portField, placeholder: "8083", keyboard: .numberPad)
        portField.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(portField)

        let hostTitle = makeFieldTitle("服务器 IP 地址")
        let portTitle = makeFieldTitle("端口")
        hostTitle.translatesAutoresizingMaskIntoConstraints = false
        portTitle.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(hostTitle)
        content.addSubview(portTitle)

        // 连接按钮
        connectBtn.setTitle("连接并进入", for: .normal)
        connectBtn.titleLabel?.font = .systemFont(ofSize: 19, weight: .bold)
        connectBtn.setTitleColor(.white, for: .normal)
        connectBtn.backgroundColor = UIColor(red: 1.0, green: 0.18, blue: 0.33, alpha: 1.0)
        connectBtn.layer.cornerRadius = 14
        connectBtn.translatesAutoresizingMaskIntoConstraints = false
        connectBtn.addTarget(self, action: #selector(connectTapped), for: .touchUpInside)
        content.addSubview(connectBtn)

        // 状态
        statusLabel.textColor = UIColor(red: 1.0, green: 0.8, blue: 0.0, alpha: 1.0)
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(statusLabel)

        // 提示
        let tipLabel = UILabel()
        tipLabel.text = "提示：iPad 需与服务器连接同一个 WiFi。\n服务器地址与端口请在飞牛NAS的墨墨爱K歌容器中查看（默认端口 8083）。"
        tipLabel.textColor = UIColor.white.withAlphaComponent(0.5)
        tipLabel.font = .systemFont(ofSize: 13)
        tipLabel.textAlignment = .center
        tipLabel.numberOfLines = 0
        tipLabel.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(tipLabel)

        NSLayoutConstraint.activate([
            titleLabel.topAnchor.constraint(equalTo: content.topAnchor, constant: 90),
            titleLabel.centerXAnchor.constraint(equalTo: content.centerXAnchor),

            subLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 12),
            subLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 40),
            subLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -40),

            hostTitle.topAnchor.constraint(equalTo: subLabel.bottomAnchor, constant: 40),
            hostTitle.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 40),

            hostField.topAnchor.constraint(equalTo: hostTitle.bottomAnchor, constant: 8),
            hostField.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 40),
            hostField.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -40),
            hostField.heightAnchor.constraint(equalToConstant: 52),

            portTitle.topAnchor.constraint(equalTo: hostField.bottomAnchor, constant: 20),
            portTitle.leadingAnchor.constraint(equalTo: hostTitle.leadingAnchor),

            portField.topAnchor.constraint(equalTo: portTitle.bottomAnchor, constant: 8),
            portField.leadingAnchor.constraint(equalTo: hostField.leadingAnchor),
            portField.trailingAnchor.constraint(equalTo: hostField.trailingAnchor),
            portField.heightAnchor.constraint(equalToConstant: 52),

            connectBtn.topAnchor.constraint(equalTo: portField.bottomAnchor, constant: 36),
            connectBtn.leadingAnchor.constraint(equalTo: hostField.leadingAnchor),
            connectBtn.trailingAnchor.constraint(equalTo: hostField.trailingAnchor),
            connectBtn.heightAnchor.constraint(equalToConstant: 54),

            statusLabel.topAnchor.constraint(equalTo: connectBtn.bottomAnchor, constant: 16),
            statusLabel.leadingAnchor.constraint(equalTo: hostField.leadingAnchor),
            statusLabel.trailingAnchor.constraint(equalTo: hostField.trailingAnchor),

            tipLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 30),
            tipLabel.leadingAnchor.constraint(equalTo: hostField.leadingAnchor),
            tipLabel.trailingAnchor.constraint(equalTo: hostField.trailingAnchor),
            tipLabel.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -40)
        ])

        // 点击空白收键盘
        let tap = UITapGestureRecognizer(target: view, action: #selector(UIView.endEditing))
        view.addGestureRecognizer(tap)
    }

    private func makeFieldTitle(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.textColor = UIColor.white.withAlphaComponent(0.85)
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        return label
    }

    private func configureField(_ field: UITextField, placeholder: String, keyboard: UIKeyboardType) {
        field.placeholder = placeholder
        field.keyboardType = keyboard
        field.backgroundColor = UIColor.white.withAlphaComponent(0.12)
        field.textColor = .white
        field.font = .systemFont(ofSize: 18, weight: .medium)
        field.layer.cornerRadius = 12
        field.layer.borderWidth = 1
        field.layer.borderColor = UIColor.white.withAlphaComponent(0.2).cgColor
        field.delegate = self
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.spellCheckingType = .no
        field.returnKeyType = .done
        let pad = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 10))
        field.leftView = pad
        field.leftViewMode = .always
        if #available(iOS 13.0, *) {
            field.attributedPlaceholder = NSAttributedString(
                string: placeholder,
                attributes: [.foregroundColor: UIColor.white.withAlphaComponent(0.4)])
        }
    }

    @objc private func connectTapped() {
        view.endEditing(true)
        let host = (hostField.text ?? "").trimmingCharacters(in: .whitespaces)
        let port = (portField.text ?? "").trimmingCharacters(in: .whitespaces)
        guard !host.isEmpty else {
            statusLabel.text = "请输入服务器 IP 地址"
            return
        }
        ServerConfig.host = host
        ServerConfig.port = port.isEmpty ? "8083" : port
        statusLabel.text = "正在保存…"
        dismiss(animated: true) { [weak self] in
            self?.onSaved?()
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField == hostField {
            portField.becomeFirstResponder()
        } else {
            connectTapped()
        }
        return true
    }
}
