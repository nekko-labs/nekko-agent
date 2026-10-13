package com.nekko.android.data

import com.nekko.protocol.OkHttpTransport
import com.nekko.protocol.RelayClient
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WsTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonElement

/** Request side of a computer connection: what chat screens need. */
interface Caller {
    suspend fun call(channel: String, vararg args: JsonElement): JsonElement
    suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement): JsonElement
}

/** A live connection to one computer. [RelayRemote] in the app, fakes in tests. */
interface Remote : Caller {
    val status: StateFlow<RelayStatus>
    val events: SharedFlow<Pair<String, JsonElement>>
    val welcome: SharedFlow<WelcomedDevice>
    fun connect()
    fun close()
    fun nudge()
}

fun interface RemoteFactory {
    fun create(config: RelayConfig, scope: CoroutineScope): Remote
}

class RelayRemote(private val client: RelayClient) : Remote {
    override val status get() = client.status
    override val events get() = client.events
    override val welcome get() = client.welcome
    override fun connect() = client.connect()
    override fun close() = client.close()
    override fun nudge() = client.nudge()
    override suspend fun call(channel: String, vararg args: JsonElement) = client.call(channel, *args)
    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) =
        client.callWithTimeout(timeoutMs, channel, *args)
}

/** Production factory: one OkHttp transport shared by every connection. */
class RelayRemoteFactory(private val transport: WsTransport = OkHttpTransport()) : RemoteFactory {
    override fun create(config: RelayConfig, scope: CoroutineScope): Remote =
        RelayRemote(RelayClient(config, transport, scope))
}
