package com.momo.ktv.tv.data

import android.util.Log
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody

import java.util.concurrent.TimeUnit

class ApiClient(baseURL: String) {
    companion object {
        private const val TAG = "ApiClient"
        const val CLOUD115_UA = "Mozilla/5.0 115Browser/23.9.3.2"

        /** 规范化服务器地址：确保有 http:// 前缀，去除末尾斜杠 */
        fun normalizeURL(url: String): String {
            var result = url.trim()
            if (result.isEmpty()) return result
            if (!result.startsWith("http://") && !result.startsWith("https://")) {
                result = "http://$result"
            }
            return result.trimEnd('/')
        }
    }

    private var baseURL: String = normalizeURL(baseURL)
    private val gson = Gson()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    fun updateBaseURL(url: String) {
        baseURL = if (url.startsWith("http")) url else "http://$url"
    }

    fun getServerAddress(): String = baseURL.replace("http://", "").replace("https://", "")

    private fun apiURL(path: String): String = "$baseURL$path"

    // ==================== 歌曲 ====================
    suspend fun fetchSongs(query: String = "", artist: String = "", page: Int = 1, pageSize: Int = 50): Pair<List<Song>, Int> =
        withContext(Dispatchers.IO) {
            val params = mutableListOf<String>()
            if (query.isNotEmpty()) params.add("q=${java.net.URLEncoder.encode(query, "UTF-8")}")
            if (artist.isNotEmpty()) params.add("artist=${java.net.URLEncoder.encode(artist, "UTF-8")}")
            params.add("page=$page")
            params.add("pageSize=$pageSize")
            val path = "/api/songs?" + params.joinToString("&")
            try {
                val req = Request.Builder().url(apiURL(path)).get().build()
                val resp = httpClient.newCall(req).execute()
                val body = resp.body?.string() ?: return@withContext Pair(emptyList(), 0)
                // 尝试 {items, total} 格式
                try {
                    val sr = gson.fromJson(body, SearchResponse::class.java)
                    if (sr.items != null) {
                        return@withContext Pair(sr.items, sr.total ?: sr.items.size)
                    }
                } catch (_: Exception) {}
                // 兼容数组格式
                val type = object : TypeToken<List<Song>>() {}.type
                val songs = gson.fromJson<List<Song>>(body, type) ?: emptyList()
                Pair(songs, songs.size)
            } catch (e: Exception) {
                Log.e(TAG, "fetchSongs error: ${e.message}")
                Pair(emptyList(), 0)
            }
        }

    suspend fun fetchArtists(): List<Artist> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(apiURL("/api/artists")).get().build()
            val resp = httpClient.newCall(req).execute()
            val body = resp.body?.string() ?: return@withContext emptyList()
            val type = object : TypeToken<List<Artist>>() {}.type
            gson.fromJson(body, type) ?: emptyList()
        } catch (e: Exception) {
            Log.e(TAG, "fetchArtists error: ${e.message}")
            emptyList()
        }
    }

    // ==================== 队列 ====================
    suspend fun fetchQueue(): List<QueueItem> = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(apiURL("/api/queue")).get().build()
            val resp = httpClient.newCall(req).execute()
            val body = resp.body?.string() ?: return@withContext emptyList()
            val type = object : TypeToken<List<QueueItem>>() {}.type
            gson.fromJson(body, type) ?: emptyList()
        } catch (e: Exception) {
            Log.e(TAG, "fetchQueue error: ${e.message}")
            emptyList()
        }
    }

    suspend fun addToQueue(songId: Int, nickname: String = "TV用户"): Boolean = withContext(Dispatchers.IO) {
        try {
            val json = gson.toJson(mapOf("song_id" to songId, "nickname" to nickname))
            val req = Request.Builder()
                .url(apiURL("/api/queue"))
                .post(RequestBody.create(MediaType.parse("application/json"), json))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.isSuccessful
        } catch (e: Exception) {
            Log.e(TAG, "addToQueue error: ${e.message}")
            false
        }
    }

    suspend fun removeFromQueue(queueId: Int): Boolean = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(apiURL("/api/queue/$queueId")).delete().build()
            val resp = httpClient.newCall(req).execute()
            resp.isSuccessful
        } catch (e: Exception) {
            false
        }
    }

    suspend fun topQueue(queueId: Int): Boolean = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url(apiURL("/api/queue/$queueId/top"))
                .post(RequestBody.create(null, ""))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.isSuccessful
        } catch (e: Exception) {
            false
        }
    }

    // ==================== 播放信息 ====================
    suspend fun fetchSepInfo(songId: Int): SepInfo? = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(apiURL("/api/songs/$songId/sep-info")).get().build()
            val resp = httpClient.newCall(req).execute()
            val body = resp.body?.string() ?: return@withContext null
            gson.fromJson(body, SepInfo::class.java)
        } catch (e: Exception) {
            Log.e(TAG, "fetchSepInfo error: ${e.message}")
            null
        }
    }

    fun directStreamURL(filepath: String): String {
        val encoded = java.net.URLEncoder.encode(filepath, "UTF-8").replace("+", "%20")
        return apiURL("/api/direct-stream/$encoded")
    }

    fun coverURL(filename: String?): String? {
        if (filename.isNullOrEmpty()) return null
        return apiURL("/cover/$filename")
    }

    fun wsURL(): String {
        if (baseURL.startsWith("https://")) return baseURL.replace("https://", "wss://") + "/ws"
        return baseURL.replace("http://", "ws://") + "/ws"
    }

    // ==================== 统计 ====================
    suspend fun fetchStats(): Stats? = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(apiURL("/api/stats")).get().build()
            val resp = httpClient.newCall(req).execute()
            val body = resp.body?.string() ?: return@withContext null
            gson.fromJson(body, Stats::class.java)
        } catch (e: Exception) {
            null
        }
    }
}
