package com.nekko.protocol

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.time.Instant
import kotlin.math.roundToInt

/** One step of a route check: whether it worked, how long it took, and what it found. */
data class ProbeStep(val ok: Boolean, val ms: Int? = null, val detail: String? = null)

/**
 * The checks for one relay address (IO-21): the name resolves, a TCP
 * connection opens, and the relay lets this phone say hello to the computer.
 * A step after a failed one is skipped (null).
 */
data class RouteReport(val url: String, val dns: ProbeStep? = null, val tcp: ProbeStep? = null, val hello: ProbeStep? = null) {
    val kind: RelayRoute get() = RelayRoute.of(url)
    val host: String get() = Pairing.relayHost(url)
    /** Every step ran and worked. */
    val ok: Boolean get() = dns?.ok == true && tcp?.ok == true && hello?.ok == true
}

/** The network calls the checks make; [JvmProbeNetwork] for real, fakes in tests. */
interface ProbeNetwork {
    /** The addresses [host] resolves to (numeric strings). */
    suspend fun resolve(host: String, timeoutMs: Long): List<String>
    /** Opens (and closes) a TCP connection to [address]:[port]. */
    suspend fun connect(address: String, port: Int, timeoutMs: Long)
}

/** The iPhone's `Diagnostics` (NekkoProtocol/Diagnostics.swift): the same steps, words and redaction. */
object Diagnostics {
    /**
     * Check one route. [hello] joins the room on that address and reports what
     * the relay and computer said (the repository does it with a throwaway
     * relay client); [clock] returns milliseconds, for timings.
     */
    suspend fun check(
        url: String,
        network: ProbeNetwork,
        timeoutMs: Long = 5_000,
        clock: () -> Long = System::currentTimeMillis,
        hello: suspend (String) -> ProbeStep,
    ): RouteReport {
        var report = RouteReport(url)
        val (host, port) = hostPort(url) ?: return report.copy(dns = ProbeStep(false, detail = "Not a relay address"))
        fun ms(start: Long) = (clock() - start).coerceAtLeast(0).toInt()

        var addresses = listOf(host)
        if (isLiteral(host)) {
            report = report.copy(dns = ProbeStep(true, 0, "Address, no lookup needed"))
        } else {
            val start = clock()
            try {
                val found = network.resolve(host, timeoutMs)
                if (found.isEmpty()) throw RelayException("No addresses")
                addresses = found
                report = report.copy(dns = ProbeStep(true, ms(start), found.take(3).joinToString(", ")))
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException && e !is kotlinx.coroutines.TimeoutCancellationException) throw e
                return report.copy(dns = ProbeStep(false, ms(start), "Name not found: ${redact(e.message ?: "lookup failed")}"))
            }
        }

        // Every address the name has, in order, as the socket would (`localhost`
        // is often ::1 first while the relay listens on 127.0.0.1).
        val start = clock()
        var lastError: Exception? = null
        for (address in addresses.take(4)) {
            try {
                network.connect(address, port, timeoutMs)
                val via = if (addresses.size > 1) " on $address" else ""
                report = report.copy(tcp = ProbeStep(true, ms(start), "Port $port open$via"))
                lastError = null
                break
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException && e !is kotlinx.coroutines.TimeoutCancellationException) throw e
                lastError = e
            }
        }
        lastError?.let { return report.copy(tcp = ProbeStep(false, ms(start), redact(it.message ?: "Connect failed"))) }

        return report.copy(hello = hello(url))
    }

    /** Host and port of a ws/wss address (80 and 443 by default). */
    fun hostPort(url: String): Pair<String, Int>? {
        val lower = url.trim().lowercase()
        val secure = when {
            lower.startsWith("wss://") -> true
            lower.startsWith("ws://") -> false
            else -> return null
        }
        val host = RelayRoute.host(url).ifEmpty { return null }
        var authority = Pairing.relayHost(url).substringBefore('?').substringBefore('#')
        val close = authority.lastIndexOf(']')
        if (close >= 0) authority = authority.substring(close + 1)
        val port = authority.substringAfterLast(':', "").toIntOrNull()?.takeIf { it in 1..65535 } ?: if (secure) 443 else 80
        return host to port
    }

    internal fun isLiteral(host: String): Boolean = ':' in host || Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host)

    /**
     * Strip anything that could get someone into the room, in case a transport
     * error quotes the URL it dialed: `room`, `key`, `pair` and `code` values,
     * and long hex runs.
     */
    fun redact(text: String): String {
        var out = text
        for (name in listOf("room", "key", "pair", "code")) {
            out = Regex("$name=[^&\\s\"')]*", RegexOption.IGNORE_CASE).replace(out, "$name=…")
        }
        return Regex("[0-9a-fA-F]{16,}").replace(out, "…")
    }

    /**
     * What *Share diagnostics* sends: the phone, the routes and how each check
     * went, then the connection log. Hosts and timings only; never rooms, keys,
     * codes or anything a chat said.
     */
    fun text(app: String, network: NetworkPath, routeInUse: String?, reports: List<RouteReport>, log: String, at: Instant = Instant.now()): String {
        val lines = mutableListOf("Nekko Agent connection diagnostics", "When: $at", "App: $app", "Network: ${network.name.lowercase()}")
        routeInUse?.let { lines += "Route in use: ${Pairing.relayHost(it)} (${RelayRoute.of(it).name.lowercase()})" }
        lines += ""
        if (reports.isEmpty()) lines += "Checks: not run"
        for (r in reports) {
            lines += "Route ${r.host} (${r.kind.name.lowercase()}): ${if (r.ok) "ok" else "problem"}"
            for ((name, step) in listOf("dns" to r.dns, "tcp" to r.tcp, "hello" to r.hello)) {
                if (step == null) {
                    lines += "  $name: skipped"
                    continue
                }
                var line = "  $name: ${if (step.ok) "ok" else "failed"}"
                step.ms?.let { line += " $it ms" }
                step.detail?.let { line += " – $it" }
                lines += line
            }
        }
        lines += ""
        lines += log
        return redact(lines.joinToString("\n"))
    }

    /** The hello's result from the throwaway connection's first settled state (null: no answer in time). */
    fun helloStep(state: RelayStatus?, computer: String, ms: Int, timeoutMs: Long): ProbeStep = when (state?.state) {
        RelayState.ONLINE -> ProbeStep(true, ms, "$computer answered")
        RelayState.OFFLINE -> ProbeStep(true, ms, "The relay answered; $computer isn’t connected to it")
        RelayState.DENIED -> ProbeStep(false, ms, "Refused: ${state.denied?.wire ?: "denied"}")
        else -> ProbeStep(false, ms, "No answer in ${(timeoutMs / 1000.0).roundToInt()} s")
    }
}

/** DNS with [InetAddress] and a TCP connect with a [Socket], off the main thread with a deadline. */
class JvmProbeNetwork : ProbeNetwork {
    override suspend fun resolve(host: String, timeoutMs: Long): List<String> = withTimeout(timeoutMs) {
        withContext(Dispatchers.IO) { InetAddress.getAllByName(host).map { it.hostAddress.orEmpty().substringBefore('%') }.filter { it.isNotEmpty() }.distinct() }
    }

    override suspend fun connect(address: String, port: Int, timeoutMs: Long) {
        withContext(Dispatchers.IO) {
            Socket().use { it.connect(InetSocketAddress(InetAddress.getByName(address), port), timeoutMs.toInt()) }
        }
    }
}
