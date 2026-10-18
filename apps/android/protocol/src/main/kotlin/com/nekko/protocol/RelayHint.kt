package com.nekko.protocol

/**
 * Why a relay address can't work from a phone, said before or while it fails,
 * so "Connecting…" never spins forever without a reason.
 *
 * The rules follow the app's network security config
 * (apps/android/app/src/main|debug/res/xml/network_security_config.xml):
 * `wss://` always, plain `ws://` only to a Tailscale MagicDNS name (`*.ts.net`),
 * and in debug builds also to localhost / 127.0.0.1 / the emulator's 10.0.2.2.
 */
object RelayHint {
    private val HOST = Regex("""^wss?://(\[[^\]]+]|[^/:?#]+)""", RegexOption.IGNORE_CASE)

    enum class Problem {
        /** `localhost` / `127.0.0.1` on a phone means the phone itself, not the computer. */
        LOOPBACK,

        /** A Tailscale 100.64.0.0/10 address over `ws://`: Android only allows the MagicDNS name. */
        TAILSCALE_IP,

        /** Any other plain `ws://` host: Android blocks cleartext there. */
        CLEARTEXT,
    }

    fun host(relayUrl: String): String = HOST.find(relayUrl.trim())?.groupValues?.get(1)?.lowercase().orEmpty()

    /** The problem with [relayUrl] on a phone, or null when it can work. [debug] = a debug build. */
    fun problem(relayUrl: String, debug: Boolean): Problem? {
        val url = relayUrl.trim()
        val h = host(url)
        val loopback = h == "localhost" || h == "127.0.0.1" || h == "[::1]"
        // Even over wss://, a loopback relay is the phone itself, unless adb reverse
        // forwards it (debug builds on a USB phone): say so only on release builds.
        if (loopback && !debug) return Problem.LOOPBACK
        if (!url.startsWith("ws://", ignoreCase = true)) return null
        return when {
            h.endsWith(".ts.net") || h == "ts.net" -> null
            debug && (loopback || h == "10.0.2.2") -> null
            isTailscaleIp(h) -> Problem.TAILSCALE_IP
            else -> Problem.CLEARTEXT
        }
    }

    /** The user-facing explanation, naming the computer. */
    fun message(problem: Problem, computer: String): String = when (problem) {
        Problem.LOOPBACK ->
            "$computer’s relay is set to this device itself (localhost). On $computer: Settings → Remote access, use the managed relay or your Tailscale name, then pair again."
        Problem.TAILSCALE_IP ->
            "Android only allows Tailscale relays by name. On $computer use ws://<name>.<tailnet>.ts.net:4400 (Settings → Remote access → Relay on this computer shows it), then pair again."
        Problem.CLEARTEXT ->
            "Android blocks unencrypted ws:// relays except on Tailscale (*.ts.net). Use a wss:// relay or your computer’s Tailscale name, then pair again."
    }

    /** 100.64.0.0/10: Tailscale's CGNAT range. */
    internal fun isTailscaleIp(h: String): Boolean {
        val parts = h.split('.')
        if (parts.size != 4) return false
        val n = parts.map { it.toIntOrNull() ?: return false }
        if (n.any { it !in 0..255 }) return false
        return n[0] == 100 && n[1] in 64..127
    }
}
