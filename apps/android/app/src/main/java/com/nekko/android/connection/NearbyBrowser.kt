package com.nekko.android.connection

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import com.nekko.protocol.NearbyComputer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Looks for computers advertising `_nekko-agent._tcp` on this Wi-Fi (the
 * desktop's *Visible on this network*) with the system's NSD service, so the
 * app holds no multicast lock and needs no permission. Starts only when the
 * user taps **Look on this network** and stops by itself after [LOOK_MS].
 * Finding a computer never pairs: its record has no secrets.
 */
class NearbyBrowser(context: Context) {
    enum class Phase { IDLE, LOOKING, FAILED }

    data class State(
        val phase: Phase = Phase.IDLE,
        val found: List<NearbyComputer> = emptyList(),
        /** A look has finished, so "none found" can be said. */
        val looked: Boolean = false,
    )

    private val nsd = context.getSystemService(NsdManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var listener: NsdManager.DiscoveryListener? = null
    // NSD resolves one service at a time; a second resolve while one runs fails.
    private val pending = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private val found = LinkedHashMap<String, NearbyComputer>()
    private val timeout = Runnable { finish() }

    fun start() {
        stop()
        found.clear()
        _state.value = State(Phase.LOOKING)
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                main.post {
                    if (listener !== this) return@post
                    listener = null
                    main.removeCallbacks(timeout)
                    _state.update { it.copy(phase = Phase.FAILED) }
                }
            }
            override fun onServiceFound(info: NsdServiceInfo) {
                main.post {
                    if (listener !== this) return@post
                    pending.addLast(info)
                    resolveNext()
                }
            }
            override fun onServiceLost(info: NsdServiceInfo) {
                main.post {
                    if (listener !== this) return@post
                    if (found.remove(info.serviceName) != null) publish()
                }
            }
        }
        listener = l
        try {
            nsd.discoverServices(NearbyComputer.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
        } catch (e: RuntimeException) {
            listener = null
            _state.update { it.copy(phase = Phase.FAILED) }
            return
        }
        main.postDelayed(timeout, LOOK_MS)
    }

    /** Leaving the screen, or the look ran its time. */
    fun stop() {
        main.removeCallbacks(timeout)
        listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        listener = null
        pending.clear()
        if (_state.value.phase == Phase.LOOKING) _state.update { it.copy(phase = Phase.IDLE) }
    }

    private fun finish() {
        stop()
        _state.update { it.copy(looked = true) }
    }

    private fun publish() {
        _state.update { it.copy(found = NearbyComputer.sorted(found.values.toList())) }
    }

    // resolveService is deprecated from API 34 in favour of service-info
    // callbacks, but it is the one call that works from API 28 to today.
    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (resolving) return
        val info = pending.removeFirstOrNull() ?: return
        val look = listener ?: return
        resolving = true
        nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                main.post { resolving = false; resolveNext() }
            }
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                main.post {
                    resolving = false
                    if (listener === look) {
                        val txt = serviceInfo.attributes.mapValues { (_, v) -> v?.toString(Charsets.UTF_8).orEmpty() }
                        NearbyComputer.from(serviceInfo.serviceName, txt)?.let {
                            found[it.id] = it
                            publish()
                        }
                    }
                    resolveNext()
                }
            }
        })
    }

    companion object {
        const val LOOK_MS = 30_000L
    }
}
