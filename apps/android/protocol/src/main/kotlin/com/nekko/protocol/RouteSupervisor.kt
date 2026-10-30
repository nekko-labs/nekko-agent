package com.nekko.protocol

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** The network the phone is on, as far as choosing a relay route goes. */
enum class NetworkPath {
    /** Wi-Fi or Ethernet: a LAN route can work. */
    LOCAL,
    /** Cellular only: a LAN address is someone else's network, skip it. */
    CELLULAR,
    /** Not known yet (before the first network callback), or something else: try everything. */
    UNKNOWN,
}

/** Hysteresis knobs (Orca's `mobile-endpoint-hysteresis`); tests shrink them. */
data class RouteRules(
    /** Successful probes of the better route in a row before moving back to it. */
    val successesToReturn: Int = 3,
    /** After a route fails, it isn't chosen again (nor probed) for this long. */
    val failureCooldownMs: Long = 60_000,
    /** Stay at least this long on a route before moving back up. */
    val minDwellMs: Long = 30_000,
    /** How often the better route is probed while on a worse one. */
    val probeIntervalMs: Long = 10_000,
    /** A dial to a route with a fallback behind it gets this long to open. */
    val openTimeoutMs: Long = 4_000,
)

/**
 * Which of a computer's relay addresses to dial (TASKS.md AN-28, the Android
 * side of IO-20). The relay on the computer listens on its LAN addresses next
 * to the tailnet one; the phone prefers the LAN when it can reach it (same
 * Wi-Fi), else the tailnet, else a hosted relay. Moving down is immediate: a
 * route that fails is left at once and cools down. Moving back up takes
 * hysteresis, as Orca's `mobile-endpoint-supervisor` does: several successful
 * probes in a row, no cooldown, and a minimum dwell on the current route. A
 * network change clears the history and starts again from the best route.
 *
 * [allowed] says whether this phone may dial an address at all: the app's
 * network security config permits plain `ws://` only to the tailnet, so a
 * `ws://` LAN address is kept in the list but never chosen.
 *
 * Pure and clock-free (every call takes `now`, in ms), so it is tested without
 * sockets; [RelayClient] drives it. A port of `RouteSupervisor.swift`.
 */
class RouteSupervisor(
    routes: List<String>,
    val rules: RouteRules = RouteRules(),
    path: NetworkPath = NetworkPath.UNKNOWN,
    now: Long = System.currentTimeMillis(),
    private val allowed: (String) -> Boolean = { true },
) {
    /** Every address, best first. */
    val routes: List<String> = order(routes).ifEmpty { listOf("") }
    /** The route in use (or being dialed), an index into [routes]. */
    var current: Int = 0
        private set
    var path: NetworkPath = path
        private set
    private var since = now
    private val cooldownUntil = HashMap<Int, Long>()
    private var successes = 0

    init {
        current = best(now) ?: this.routes.indices.firstOrNull { eligible(it) } ?: 0
    }

    val url: String get() = routes[current]
    val kind: RelayRoute get() = RelayRoute.of(url)
    val hasAlternatives: Boolean get() = routes.count { allowed(it) } > 1

    /** Allowed on this phone, and not a LAN address on cellular. */
    fun eligible(i: Int): Boolean =
        allowed(routes[i]) && (path != NetworkPath.CELLULAR || RelayRoute.of(routes[i]) != RelayRoute.LAN)

    private fun cooling(i: Int, now: Long) = (cooldownUntil[i] ?: Long.MIN_VALUE) > now

    /** The best eligible route that isn't cooling down. */
    private fun best(now: Long): Int? = routes.indices.firstOrNull { eligible(it) && !cooling(it, now) }

    /**
     * Whether a dial to the current route should give up early: there is a
     * worse eligible route to fall back to. The last resort gets the
     * transport's own, longer timeout.
     */
    val fallbackExists: Boolean get() = routes.indices.any { it > current && eligible(it) }

    /** The route to dial now. A route that stopped being eligible (the phone left Wi-Fi) is swapped for the best one. */
    fun routeToDial(now: Long): String {
        if (!eligible(current)) (best(now) ?: routes.indices.firstOrNull { eligible(it) })?.let { move(it, now) }
        return url
    }

    /** What [failed] did: whether the route changed, and whether the new one can be dialed at once (not cooling). */
    data class Failover(val changed: Boolean, val ready: Boolean)

    /**
     * The current route failed: it didn't open, or dropped. With another
     * eligible route, it cools down and the next one is used.
     */
    fun failed(now: Long): Failover {
        val others = routes.indices.filter { it != current && eligible(it) }
        if (others.isEmpty()) return Failover(changed = false, ready = false)
        cooldownUntil[current] = now + rules.failureCooldownMs
        successes = 0
        // The next not cooling down, best first; else the one that cools off first.
        val next = others.firstOrNull { !cooling(it, now) }
            ?: others.minBy { cooldownUntil[it] ?: Long.MIN_VALUE }
        val ready = !cooling(next, now)
        move(next, now)
        return Failover(changed = true, ready = ready)
    }

    /** On the best route this network allows: nothing to move back to. */
    val onBest: Boolean get() = routes.indices.none { it < current && eligible(it) }

    /** The better route to probe while on a worse one, if any. */
    fun probeTarget(now: Long): Int? = best(now)?.takeIf { it < current }

    /** A probe of [route] came back. */
    fun probed(route: Int, ok: Boolean, now: Long) {
        if (route != probeTarget(now)) return
        if (ok) {
            successes++
        } else {
            successes = 0
            cooldownUntil[route] = now + rules.failureCooldownMs
        }
    }

    /** Enough evidence to move back up: the better route answered enough times in a row and the current one has had its dwell. */
    fun shouldMoveBack(now: Long): Boolean =
        probeTarget(now) != null && successes >= rules.successesToReturn && now - since >= rules.minDwellMs

    /** Take the better route. Returns its address. */
    fun moveBack(now: Long): String {
        probeTarget(now)?.let { move(it, now) }
        return url
    }

    /**
     * The phone moved to another network: forget what failed where, and start
     * again from the best route for this path. Returns whether the route changed.
     */
    fun pathChanged(next: NetworkPath, now: Long): Boolean {
        path = next
        cooldownUntil.clear()
        successes = 0
        val b = best(now) ?: current
        if (b == current) return false
        move(b, now)
        return true
    }

    private fun move(i: Int, now: Long) {
        if (i != current) since = now
        current = i
        successes = 0
    }

    companion object {
        /** Best first: the phone's own network (LAN, loopback), then the tailnet, then the internet; ties keep the link's order. No repeats. */
        fun order(urls: List<String>): List<String> =
            urls.distinct().withIndex().sortedWith(compareBy({ rank(it.value) }, { it.index })).map { it.value }

        private fun rank(url: String) = when (RelayRoute.of(url)) {
            RelayRoute.LAN, RelayRoute.LOOPBACK -> 0
            RelayRoute.TAILSCALE -> 1
            RelayRoute.INTERNET -> 2
        }
    }
}

/** Whether a relay address answers right now, without joining the room: what [RelayClient] asks of the better route before moving back to it. */
fun interface RouteProber {
    suspend fun reachable(relayUrl: String, timeoutMs: Long): Boolean
}

/**
 * Asks the relay's `/healthz` over HTTP(S) at the same address
 * (`ws://h:p` → `http://h:p/healthz`). Nothing about the room, the device or
 * the computer is sent. Same network security rules as the socket.
 */
class HealthProber(private val client: OkHttpClient = OkHttpClient()) : RouteProber {
    override suspend fun reachable(relayUrl: String, timeoutMs: Long): Boolean {
        val url = healthUrl(relayUrl) ?: return false
        val c = client.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).retryOnConnectionFailure(false).build()
        return withContext(Dispatchers.IO) {
            runCatching { c.newCall(Request.Builder().url(url).build()).execute().use { it.code == 200 } }.getOrDefault(false)
        }
    }

    companion object {
        fun healthUrl(relayUrl: String): String? {
            val s = relayUrl.trim().trimEnd('/')
            val lower = s.lowercase()
            val http = when {
                lower.startsWith("wss://") -> "https://" + s.substring(6)
                lower.startsWith("ws://") -> "http://" + s.substring(5)
                else -> return null
            }
            return "$http/healthz"
        }
    }
}
