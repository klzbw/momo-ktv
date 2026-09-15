import UIKit

/// 点歌搜索页：顶部 SearchBar + 结果列表 + 分页加载。
/// 点击歌曲 -> addToQueue -> toast。
class SongSearchViewController: UIViewController, UISearchBarDelegate,
                                  UITableViewDataSource, UITableViewDelegate {

    private let searchBar = UISearchBar()
    private let tableView = UITableView()
    private let loadingLabel = UILabel()

    private var results: [Song] = []
    private var page = 1
    private let pageSize = 50
    private var total = 0
    private var currentQuery = ""
    private var isLoading = false
    private var hasMore: Bool { results.count < total }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "点歌搜索"
        view.backgroundColor = .black
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: "关闭", style: .plain, target: self, action: #selector(closeTapped))
        setupUI()
        // 首次进入拉热门列表
        performSearch(query: "", reset: true)
    }

    private func setupUI() {
        searchBar.placeholder = "搜索歌名 / 歌手"
        searchBar.delegate = self
        searchBar.searchBarStyle = .minimal
        searchBar.tintColor = .white
        if let tf = searchBar.value(forKey: "searchField") as? UITextField {
            tf.textColor = .white
            tf.attributedPlaceholder = NSAttributedString(string: "搜索歌名 / 歌手",
                                                          attributes: [.foregroundColor: UIColor.lightGray])
        }
        searchBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(searchBar)

        tableView.backgroundColor = .black
        tableView.separatorColor = UIColor(white: 0.2, alpha: 1)
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "SongCell")
        tableView.dataSource = self
        tableView.delegate = self
        tableView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(tableView)

        loadingLabel.text = ""
        loadingLabel.textColor = .lightGray
        loadingLabel.font = .systemFont(ofSize: 12)
        loadingLabel.textAlignment = .center
        loadingLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(loadingLabel)

        NSLayoutConstraint.activate([
            searchBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            searchBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            searchBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            tableView.topAnchor.constraint(equalTo: searchBar.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: loadingLabel.topAnchor, constant: -4),

            loadingLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            loadingLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            loadingLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8),
            loadingLabel.heightAnchor.constraint(equalToConstant: 20),
        ])
    }

    // MARK: - 搜索
    private func performSearch(query: String, reset: Bool) {
        guard !isLoading else { return }
        isLoading = true
        if reset {
            page = 1
            results = []
            total = 0
            tableView.reloadData()
        }
        loadingLabel.text = "加载中..."
        KTVAPIClient.shared.fetchSongs(query: query, page: page, pageSize: pageSize) { [weak self] items, total in
            guard let self = self else { return }
            self.isLoading = false
            if reset {
                self.results = items
            } else {
                self.results.append(contentsOf: items)
            }
            self.total = total
            self.tableView.reloadData()
            self.loadingLabel.text = self.hasMore ? "上拉加载更多 · 共\(total)首" : (total > 0 ? "共\(total)首" : "无结果")
        }
    }

    // MARK: - UISearchBarDelegate
    func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
        searchBar.resignFirstResponder()
        currentQuery = searchBar.text ?? ""
        performSearch(query: currentQuery, reset: true)
    }

    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        // 输入防抖：清空时立即刷新；有内容时延迟 400ms 自动搜索
        NSObject.cancelPreviousPerformRequests(withTarget: self,
                                               selector: #selector(debouncedSearch), object: nil)
        perform(#selector(debouncedSearch), with: nil, afterDelay: 0.4)
    }

    @objc private func debouncedSearch() {
        currentQuery = searchBar.text ?? ""
        performSearch(query: currentQuery, reset: true)
    }

    // MARK: - UITableView
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        results.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "SongCell", for: indexPath)
        let song = results[indexPath.row]
        cell.backgroundColor = .black
        cell.textLabel?.text = song.displayTitle
        cell.textLabel?.textColor = .white
        cell.detailTextLabel?.text = song.displayArtist
        cell.detailTextLabel?.textColor = .lightGray
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let song = results[indexPath.row]
        KTVAPIClient.shared.addToQueue(songId: song.id) { [weak self] ok in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if ok {
                    self.showToast("已点歌：\(song.displayTitle)")
                } else {
                    self.showToast("点歌失败")
                }
            }
        }
    }

    // 分页：滚动到底自动加载下一页
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        let offsetY = scrollView.contentOffset.y
        let contentHeight = scrollView.contentSize.height
        let frameHeight = scrollView.bounds.height
        if offsetY > contentHeight - frameHeight - 120, hasMore, !isLoading {
            page += 1
            performSearch(query: currentQuery, reset: false)
        }
    }

    // MARK: - 关闭 / Toast
    @objc private func closeTapped() {
        navigationController?.popViewController(animated: true)
    }

    private func showToast(_ msg: String) {
        let alert = UIAlertController(title: nil, message: msg, preferredStyle: .alert)
        present(alert, animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            alert.dismiss(animated: true)
        }
    }
}
