import UIKit

/// 歌词同步显示视图。
/// 支持 LRC 格式，根据播放进度高亮当前行，双行显示。
class LyricsView: UIView {
    struct LyricLine {
        let timeMs: TimeInterval
        let text: String
    }

    private var lyrics: [LyricLine] = []
    private var currentIndex = -1

    private let currentLabel = UILabel()
    private let prevLabel = UILabel()
    private let nextLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        backgroundColor = .clear

        prevLabel.textAlignment = .center
        prevLabel.textColor = UIColor(white: 1.0, alpha: 0.6)
        prevLabel.font = .systemFont(ofSize: 20, weight: .medium)
        prevLabel.numberOfLines = 1

        currentLabel.textAlignment = .center
        currentLabel.textColor = UIColor(red: 1.0, green: 0.84, blue: 0.0, alpha: 1.0)
        currentLabel.font = .systemFont(ofSize: 32, weight: .bold)
        currentLabel.numberOfLines = 1
        currentLabel.layer.shadowColor = UIColor.black.cgColor
        currentLabel.layer.shadowRadius = 4
        currentLabel.layer.shadowOpacity = 0.8
        currentLabel.layer.shadowOffset = CGSize(width: 1, height: 1)

        nextLabel.textAlignment = .center
        nextLabel.textColor = UIColor(white: 1.0, alpha: 0.6)
        nextLabel.font = .systemFont(ofSize: 20, weight: .medium)
        nextLabel.numberOfLines = 1

        let stack = UIStackView(arrangedSubviews: [prevLabel, currentLabel, nextLabel])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),
        ])
    }

    func setLyrics(_ lrcText: String) {
        lyrics = parseLRC(lrcText)
        currentIndex = -1
        updateLabels()
    }

    func setLyricsLines(_ lines: [LyricLine]) {
        lyrics = lines.sorted { $0.timeMs < $1.timeMs }
        currentIndex = -1
        updateLabels()
    }

    func updateProgress(timeMs: TimeInterval) {
        let newIndex = findCurrentLine(timeMs)
        if newIndex != currentIndex {
            currentIndex = newIndex
            updateLabels()
        }
    }

    func clear() {
        lyrics = []
        currentIndex = -1
        updateLabels()
    }

    private func parseLRC(_ text: String) -> [LyricLine] {
        var result: [LyricLine] = []
        let regex = try? NSRegularExpression(pattern: "\\[(\\d{2}):(\\d{2})[.:](\\d{2,3})\\](.*)", options: [])
        for line in text.components(separatedBy: .newlines) {
            guard let matches = regex?.matches(in: line, range: NSRange(line.startIndex..., in: line)) else { continue }
            for match in matches {
                guard let minRange = Range(match.range(at: 1), in: line),
                      let secRange = Range(match.range(at: 2), in: line),
                      let msRange = Range(match.range(at: 3), in: line),
                      let contentRange = Range(match.range(at: 4), in: line) else { continue }
                let min = Int(line[minRange]) ?? 0
                let sec = Int(line[secRange]) ?? 0
                let msStr = String(line[msRange])
                let ms = msStr.count == 2 ? (Int(msStr) ?? 0) * 10 : (Int(msStr) ?? 0)
                let content = String(line[contentRange]).trimmingCharacters(in: .whitespaces)
                if !content.isEmpty {
                    result.append(LyricLine(timeMs: TimeInterval((min * 60 + sec) * 1000 + ms), text: content))
                }
            }
        }
        return result.sorted { $0.timeMs < $1.timeMs }
    }

    private func findCurrentLine(_ timeMs: TimeInterval) -> Int {
        var idx = -1
        for i in lyrics.indices {
            if lyrics[i].timeMs <= timeMs { idx = i } else { break }
        }
        return idx
    }

    private func updateLabels() {
        if lyrics.isEmpty {
            prevLabel.text = ""
            currentLabel.text = "♪"
            nextLabel.text = ""
            return
        }
        prevLabel.text = currentIndex > 0 ? lyrics[currentIndex - 1].text : ""
        currentLabel.text = currentIndex >= 0 ? lyrics[currentIndex].text : "♪"
        nextLabel.text = (currentIndex >= 0 && currentIndex < lyrics.count - 1) ? lyrics[currentIndex + 1].text : ""
    }

    var currentLyricText: String {
        currentIndex >= 0 && currentIndex < lyrics.count ? lyrics[currentIndex].text : ""
    }
}
