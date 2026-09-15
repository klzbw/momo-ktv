package com.momo.ktv.tv.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.momo.ktv.tv.R
import com.momo.ktv.tv.data.ApiClient
import com.momo.ktv.tv.data.Song
import kotlinx.coroutines.launch

/**
 * 点歌搜索页：
 * - 顶部输入关键字搜索
 * - 列表展示歌曲，点击"点歌"加入队列
 * - 滚动到底部自动加载下一页
 */
class SongSearchActivity : AppCompatActivity() {

    companion object {
        private const val PREFS_NAME = "momo_ktv_prefs"
        private const val KEY_SERVER_URL = "server_url"
        private const val PAGE_SIZE = 30
    }

    private lateinit var apiClient: ApiClient

    private lateinit var etSearch: EditText
    private lateinit var btnSearch: Button
    private lateinit var btnBack: Button
    private lateinit var tvResult: TextView
    private lateinit var rvResults: RecyclerView
    private lateinit var progress: ProgressBar

    private val songs = mutableListOf<Song>()
    private lateinit var adapter: SongAdapter

    private var currentQuery: String = ""
    private var currentPage: Int = 1
    private var totalCount: Int = 0
    private var isLoading: Boolean = false
    private var hasSearched: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_song_search)

        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val serverURL = prefs.getString(KEY_SERVER_URL, "") ?: ""
        apiClient = ApiClient(serverURL)

        etSearch = findViewById(R.id.etSearch)
        btnSearch = findViewById(R.id.btnSearch)
        btnBack = findViewById(R.id.btnBack)
        tvResult = findViewById(R.id.tvSearchResult)
        rvResults = findViewById(R.id.rvSearchResults)
        progress = findViewById(R.id.progressLoading)

        adapter = SongAdapter(songs) { song ->
            addSongToQueue(song)
        }
        val lm = LinearLayoutManager(this)
        rvResults.layoutManager = lm
        rvResults.adapter = adapter

        // 滚动到底部加载下一页
        rvResults.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
                if (dy <= 0) return
                val visible = lm.childCount
                val total = lm.itemCount
                val firstVisible = lm.findFirstVisibleItemPosition()
                if (visible + firstVisible >= total - 3 && !isLoading && hasSearched) {
                    if (songs.size < totalCount) {
                        loadPage(currentQuery, currentPage + 1)
                    }
                }
            }
        })

        btnSearch.setOnClickListener { doSearch() }
        btnBack.setOnClickListener { finish() }
        etSearch.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                doSearch()
                true
            } else false
        }
    }

    private fun doSearch() {
        val q = etSearch.text.toString().trim()
        currentQuery = q
        currentPage = 1
        songs.clear()
        adapter.notifyDataSetChanged()
        loadPage(q, 1)
        // 收起键盘
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(etSearch.windowToken, 0)
    }

    private fun loadPage(query: String, page: Int) {
        if (isLoading) return
        isLoading = true
        progress.visibility = View.VISIBLE
        lifecycleScope.launch {
            val (items, total) = apiClient.fetchSongs(query = query, page = page, pageSize = PAGE_SIZE)
            withMain {
                isLoading = false
                progress.visibility = View.GONE
                hasSearched = true
                currentPage = page
                totalCount = total
                if (page == 1) songs.clear()
                val start = songs.size
                songs.addAll(items)
                adapter.notifyItemRangeInserted(start, items.size)
                tvResult.text = if (query.isEmpty()) {
                    "共 $total 首歌曲"
                } else {
                    "“$query” 共 $total 首"
                }
                if (songs.isEmpty()) {
                    tvResult.text = if (query.isEmpty()) "没有歌曲" else "未找到“$query”"
                }
            }
        }
    }

    private fun addSongToQueue(song: Song) {
        lifecycleScope.launch {
            val ok = apiClient.addToQueue(song.id)
            withMain {
                if (ok) {
                    Toast.makeText(this@SongSearchActivity,
                        "已点歌: ${song.displayTitle}", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this@SongSearchActivity,
                        "点歌失败", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private inline fun withMain(crossinline block: () -> Unit) {
        runOnUiThread { block() }
    }

    // ==================== 歌曲列表适配器 ====================
    class SongAdapter(
        private val items: List<Song>,
        private val onClick: (Song) -> Unit
    ) : RecyclerView.Adapter<SongAdapter.VH>() {

        class VH(view: View) : RecyclerView.ViewHolder(view) {
            val tvTitle: TextView = view.findViewById(R.id.tvSongTitle)
            val tvArtist: TextView = view.findViewById(R.id.tvSongArtist)
            val tvMeta: TextView = view.findViewById(R.id.tvSongMeta)
            val btnAdd: Button = view.findViewById(R.id.btnAddToQueue)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context)
                .inflate(R.layout.item_song, parent, false)
            return VH(v)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val s = items[position]
            holder.tvTitle.text = s.displayTitle
            holder.tvArtist.text = s.displayArtist
            holder.tvMeta.text = buildString {
                if (s.duration != null && s.duration > 0) {
                    append("%d:%02d".format(s.duration / 60, s.duration % 60))
                }
                if (s.isVideoFile) {
                    if (isNotEmpty()) append(" · ")
                    append("MKV")
                }
            }
            holder.itemView.setOnClickListener { onClick(s) }
            holder.btnAdd.setOnClickListener { onClick(s) }
        }

        override fun getItemCount(): Int = items.size
    }
}
