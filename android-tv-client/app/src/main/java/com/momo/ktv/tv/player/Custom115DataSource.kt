package com.momo.ktv.tv.player

import android.net.Uri
import android.util.Log
import androidx.media3.common.C
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.HttpDataSource
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/**
 * 自定义 HttpDataSource：
 * 1. 设置 User-Agent 为 115Browser/23.9.3.2（115 CDN 校验 UA）
 * 2. 支持 302 重定向（OkHttp 默认自动跟随）
 * 3. 支持 Range 请求（ExoPlayer seek 时需要）
 */
class Custom115DataSource private constructor(
    private val client: OkHttpClient
) : BaseDataSource(true), HttpDataSource {

    companion object {
        private const val TAG = "Custom115DS"
        const val USER_AGENT = "Mozilla/5.0 115Browser/23.9.3.2"

        class Factory : DataSource.Factory {
            private val client = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .followRedirects(true)
                .followSslRedirects(true)
                .build()

            override fun createDataSource(): DataSource = Custom115DataSource(client)
        }
    }

    private var response: Response? = null
    private var inputStream: InputStream? = null
    private var uri: Uri? = null
    private var bytesToRead: Long = 0
    private var bytesRead: Long = 0
    private var opened = false
    private var responseCode = 0

    override fun open(dataSpec: DataSpec): Long {
        transferInitializing(dataSpec)
        this.uri = dataSpec.uri

        val url = uri.toString()
        val requestBuilder = Request.Builder()
            .url(url)
            .header("User-Agent", USER_AGENT)
            .header("Referer", "https://115.com/")
            .get()

        if (dataSpec.position > 0 || dataSpec.length != C.LENGTH_UNSET.toLong()) {
            var rangeHeader = "bytes=${dataSpec.position}-"
            if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
                rangeHeader += (dataSpec.position + dataSpec.length - 1)
            }
            requestBuilder.header("Range", rangeHeader)
        }

        dataSpec.httpRequestHeaders.forEach { (key, value) ->
            requestBuilder.header(key, value)
        }

        try {
            response = client.newCall(requestBuilder.build()).execute()
        } catch (e: IOException) {
            throw HttpDataSource.HttpDataSourceException(
                e, dataSpec, HttpDataSource.HttpDataSourceException.TYPE_OPEN
            )
        }

        val resp = response ?: throw HttpDataSource.HttpDataSourceException(
            IOException("Null response"), dataSpec, HttpDataSource.HttpDataSourceException.TYPE_OPEN
        )

        responseCode = resp.code
        val code = resp.code
        if (code < 200 || code >= 300) {
            val bodyBytes = try { resp.body?.bytes() ?: ByteArray(0) } catch (_: Exception) { ByteArray(0) }
            Log.e(TAG, "HTTP $code for $url")
            throw HttpDataSource.InvalidResponseCodeException(
                code, resp.message, HashMap(), dataSpec, bodyBytes
            )
        }

        inputStream = resp.body?.byteStream()
        if (inputStream == null) {
            throw HttpDataSource.HttpDataSourceException(
                IOException("Null response body"), dataSpec, HttpDataSource.HttpDataSourceException.TYPE_OPEN
            )
        }

        if (dataSpec.position > 0 && code != 206) {
            try {
                var skipped: Long = 0
                while (skipped < dataSpec.position) {
                    val s = inputStream!!.skip(dataSpec.position - skipped)
                    if (s <= 0) break
                    skipped += s
                }
            } catch (e: IOException) {
                throw HttpDataSource.HttpDataSourceException(
                    e, dataSpec, HttpDataSource.HttpDataSourceException.TYPE_OPEN
                )
            }
        }

        val contentLength = resp.body?.contentLength() ?: -1L
        bytesToRead = if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
            dataSpec.length
        } else if (contentLength > 0) {
            contentLength
        } else {
            C.LENGTH_UNSET.toLong()
        }
        bytesRead = 0
        opened = true
        transferStarted(dataSpec)
        return bytesToRead
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (!opened) return C.RESULT_END_OF_INPUT
        if (length == 0) return 0
        if (bytesToRead != C.LENGTH_UNSET.toLong() && bytesRead >= bytesToRead) {
            return C.RESULT_END_OF_INPUT
        }

        val toRead = if (bytesToRead != C.LENGTH_UNSET.toLong()) {
            minOf(length.toLong(), bytesToRead - bytesRead).toInt()
        } else {
            length
        }

        return try {
            val read = inputStream!!.read(buffer, offset, toRead)
            if (read == -1) {
                C.RESULT_END_OF_INPUT
            } else {
                bytesRead += read
                bytesTransferred(read)
                read
            }
        } catch (e: IOException) {
            throw HttpDataSource.HttpDataSourceException(
                e, DataSpec(uri ?: Uri.EMPTY), HttpDataSource.HttpDataSourceException.TYPE_READ
            )
        }
    }

    override fun getUri(): Uri? = uri

    override fun getResponseCode(): Int = responseCode

    override fun close() {
        if (opened) {
            try { inputStream?.close() } catch (_: Exception) {}
            try { response?.close() } catch (_: Exception) {}
            inputStream = null
            response = null
            opened = false
            transferEnded()
        }
    }

    override fun setRequestProperty(name: String, value: String) {}
    override fun clearRequestProperty(name: String) {}
    override fun clearAllRequestProperties() {}
    override fun getResponseHeaders(): MutableMap<String, MutableList<String>> =
        response?.headers?.toMultimap() ?: HashMap()
}
