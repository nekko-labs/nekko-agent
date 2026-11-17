package com.nekko.android.data

import com.nekko.protocol.PhoneConnector
import com.nekko.protocol.PhoneConnectors
import com.nekko.protocol.PhoneRequest
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrl
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** One call to a connected service: its status and (bounded) body, whatever the status. */
interface ConnectorHTTP {
    suspend fun send(request: PhoneRequest): Pair<Int, String>
}

/** No redirects (a token never follows a service to another origin), https only, 2 MB at most. */
class DirectConnectorHTTP : ConnectorHTTP {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS).build()

    override suspend fun send(request: PhoneRequest): Pair<Int, String> = suspendCancellableCoroutine { cont ->
        val url = request.url.toHttpUrl()
        require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.fragment == null) { "Connectors use https only." }
        val builder = Request.Builder().url(url)
        request.headers.forEach { (k, v) -> builder.header(k, v) }
        builder.method(request.method, request.body?.toString()?.toRequestBody("application/json".toMediaType()))
        val call = client.newCall(builder.build())
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(IOException("Couldn’t reach the service. Check your connection and its address."))
            }
            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use { r ->
                        val source = r.body?.source()
                        val text = if (source == null) "" else {
                            source.request(2_000_001)
                            val bytes = source.buffer.readByteArray(minOf(source.buffer.size, 2_000_000))
                            bytes.toString(Charsets.UTF_8)
                        }
                        if (cont.isActive) cont.resume(r.code to text)
                    }
                } catch (e: Exception) {
                    if (cont.isActive) cont.resumeWithException(IOException("The service’s answer couldn’t be read."))
                }
            }
        })
    }
}

/**
 * What this phone is connected to (#2109, the iPhone's ConnectorsModel): the list and each
 * token in the Keystore-sealed store, apart from the computers' connectors.
 */
class Connectors(private val secrets: SecureStore, private val http: ConnectorHTTP, private val now: () -> Long = System::currentTimeMillis) {
    data class State(val loaded: Boolean = false, val connectors: List<PhoneConnector> = emptyList(), val selectedGit: String? = null) {
        fun connector(kind: String) = connectors.firstOrNull { it.kind == kind }
        val git: List<PhoneConnector> get() = connectors.filter { it.category == PhoneConnectors.Category.GIT }
        val tasks: List<PhoneConnector> get() = connectors.filter { it.category == PhoneConnectors.Category.TASKS }
        /** The git provider the Pull requests screen reads: the one picked, else the first connected. */
        val gitProvider: PhoneConnector? get() = selectedGit?.let { id -> git.firstOrNull { it.kind == id } } ?: git.firstOrNull()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    private val lock = Mutex()
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun load() = lock.withLock {
        if (_state.value.loaded) return@withLock
        val saved = secrets.get(SLOT)?.let { runCatching { json.decodeFromString(com.nekko.protocol.PhoneConnectorList.serializer(), it) }.getOrNull() } ?: com.nekko.protocol.PhoneConnectorList()
        _state.value = State(true, saved.connectors.filter { PhoneConnectors.kind(it.kind) != null }, saved.selectedGit)
    }

    suspend fun token(kind: String): String? = secrets.get(PhoneConnectors.tokenSlot(kind))

    /**
     * Connect, checking the token with a real call first: nothing is kept if the service turns it
     * down. Connecting a kind already connected replaces it (a new token, or another account).
     */
    suspend fun connect(kind: String, token: String, settings: Map<String, String>): PhoneConnector {
        val made = PhoneConnectors.make(kind, token, settings, now())
        val secret = token.trim()
        val (status, body) = http.send(PhoneConnectors.whoAmI(made, secret))
        if (status !in 200..299) throw IllegalArgumentException(PhoneConnectors.failure(made.label, status, body))
        PhoneConnectors.graphQLRefusal(body)?.let { said ->
            throw IllegalArgumentException("${made.label} turned the token down" + if (said.isNotEmpty()) ": ${said.take(200)}" else "")
        }
        val c = made.copy(account = PhoneConnectors.account(kind, body), userId = PhoneConnectors.userId(kind, body))
        lock.withLock {
            secrets.set(PhoneConnectors.tokenSlot(kind), secret)
            _state.update { s -> s.copy(connectors = s.connectors.filterNot { it.kind == kind } + c) }
            save()
        }
        return c
    }

    suspend fun disconnect(kind: String) = lock.withLock {
        secrets.set(PhoneConnectors.tokenSlot(kind), null)
        _state.update { s -> s.copy(connectors = s.connectors.filterNot { it.kind == kind }, selectedGit = s.selectedGit.takeIf { it != kind }) }
        save()
    }

    suspend fun selectGit(kind: String) = lock.withLock {
        if (_state.value.git.none { it.kind == kind }) return@withLock
        _state.update { it.copy(selectedGit = kind) }
        save()
    }

    private suspend fun save() {
        val s = _state.value
        secrets.set(SLOT, json.encodeToString(com.nekko.protocol.PhoneConnectorList.serializer(), com.nekko.protocol.PhoneConnectorList(s.connectors, s.selectedGit)))
    }

    companion object {
        const val SLOT = "phone.connectors.v1"
    }
}
