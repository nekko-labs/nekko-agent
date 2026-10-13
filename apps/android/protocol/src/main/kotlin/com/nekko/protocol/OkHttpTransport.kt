package com.nekko.protocol

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * OkHttp WebSocket transport. The relay URL is `wss://` in production; `ws://`
 * is accepted only because a self-hosted relay on a LAN or a local test relay
 * may use it. Payloads are E2E-sealed either way, but the app layer decides
 * whether to allow a cleartext relay (see the Android network security config).
 */
class OkHttpTransport(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build(),
) : WsTransport {
    override fun open(url: String, listener: WsListener): WsConnection {
        // OkHttp wants http(s) schemes for the upgrade request.
        val httpUrl = url.replaceFirst(Regex("^ws", RegexOption.IGNORE_CASE), "http")
        val closed = AtomicBoolean(false)
        val ws = client.newWebSocket(Request.Builder().url(httpUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                if (closed.compareAndSet(false, true)) listener.onClosed(code, reason)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (closed.compareAndSet(false, true)) listener.onClosed(code, reason)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (closed.compareAndSet(false, true)) listener.onClosed(1006, t.message ?: "connection failed")
            }
        })
        return object : WsConnection {
            override fun send(text: String) = ws.send(text)
            override fun close(code: Int, reason: String) {
                ws.close(code, reason.take(120))
            }
        }
    }
}
