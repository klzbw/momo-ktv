package com.momo.ktv.tv.data

import android.util.Log
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.UUID
import java.util.concurrent.TimeUnit

class WebSocketClient(
    private val apiClient: ApiClient,
    private val scope: CoroutineScope
) {
    companion object {
        private const val TAG = "WSClient"
    }

    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build()
    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null

    val clientId = UUID.randomUUID().toString()
    val deviceId = "android-tv-${UUID.randomUUID().toString().take(8)}"

    // 回调
    var onQueueUpdate: ((List<QueueItem>) -> Unit)? = null
    var onControl: ((String, Map<String, Any>) -> Unit)? = null
    var onConnected: (() -> Unit)? = null
    var onDisconnected: (() -> Unit)? = null

    fun connect() {
        val url = apiClient.wsURL()
        Log.d(TAG, "Connecting to $url")
        try {
            val request = Request.Builder().url(url).build()
            webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.d(TAG, "WebSocket connected")
                onConnected?.invoke()
                sendRoleAnnounce()
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                handleMessage(bytes.utf8())
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closing: $code $reason")
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closed: $code $reason")
                onDisconnected?.invoke()
                scheduleReconnect()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}")
                onDisconnected?.invoke()
                scheduleReconnect()
            }
        })
        } catch (e: Exception) {
            Log.e(TAG, "WebSocket connect error: ${e.message}")
            onDisconnected?.invoke()
            scheduleReconnect()
        }
    }

    fun disconnect() {
        reconnectJob?.cancel()
        webSocket?.close(1000, "client disconnect")
        webSocket = null
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = scope.launch(Dispatchers.IO) {
            delay(3000)
            connect()
        }
    }

    private fun handleMessage(text: String) {
        try {
            val type = object : TypeToken<Map<String, Any>>() {}.type
            val json = gson.fromJson<Map<String, Any>>(text, type) ?: return
            val msgType = json["type"] as? String ?: return

            when (msgType) {
                "queue" -> {
                    val data = json["data"]
                    if (data != null) {
                        val dataJson = gson.toJson(data)
                        val qType = object : TypeToken<List<QueueItem>>() {}.type
                        val queue = gson.fromJson<List<QueueItem>>(dataJson, qType) ?: emptyList()
                        onQueueUpdate?.invoke(queue)
                    }
                }
                "control" -> {
                    val action = json["action"] as? String ?: return
                    val msgClientId = json["clientId"] as? String
                    if (msgClientId == clientId) return // 过滤自己的消息
                    val payload = json.filterKeys { it !in listOf("type", "action", "clientId") }
                    onControl?.invoke(action, payload)
                }
                "atmosphere", "blessing", "lyrics_updated", "lyrics_style" -> {
                    // 可扩展
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "handleMessage error: ${e.message}")
        }
    }

    private fun sendRoleAnnounce() {
        val msg = mapOf(
            "type" to "role_announce",
            "deviceId" to deviceId,
            "deviceName" to "Android TV",
            "role" to "player"
        )
        send(gson.toJson(msg))
    }

    fun sendControl(action: String, payload: Map<String, Any> = emptyMap()) {
        val msg: MutableMap<String, Any> = mutableMapOf(
            "type" to "control",
            "action" to action,
            "clientId" to clientId
        )
        msg.putAll(payload)
        send(gson.toJson(msg))
    }

    fun sendProgress(queueId: Int?, currentTime: Double, paused: Boolean, voice: String) {
        val msg = mutableMapOf(
            "type" to "progress",
            "deviceId" to deviceId,
            "currentTime" to currentTime,
            "paused" to paused,
            "voice" to voice
        )
        if (queueId != null) msg["queueId"] = queueId
        send(gson.toJson(msg))
    }

    fun sendPlaybackState(paused: Boolean, voice: String) {
        val msg = mapOf(
            "type" to "state",
            "paused" to paused,
            "voice" to voice
        )
        send(gson.toJson(msg))
    }

    private fun send(text: String) {
        webSocket?.send(text)
    }
}
