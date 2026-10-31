package com.nekko.protocol

/**
 * Why a relay address can't work from a phone, said before or while it fails,
 * so "Connecting…" never spins forever without a reason. The iPhone's
 * `RelayRoute.problem`, with a debug build in place of the simulator.
 *
 * The transport rule (TASKS.md PH1): `wss://` anywhere; plain `ws://` only
 * toward private networks, where something else already encrypts or confines
 * the hop: a Tailscale tailnet (WireGuard) or the LAN. Frames are E2E-sealed
 * on every path; the rule is about not leaking metadata to the open internet.
 * The network security config permits cleartext app-wide, since it can't name
 * IP ranges, so the app refuses public `ws://` itself before dialing
 * ([RelayRoute.publicCleartext]).
 */
object RelayHint {
    private val HOST = Regex("""^wss?://(\[[^\]]+]|[^/:?#]+)""", RegexOption.IGNORE_CASE)

    enum class Problem {
        /** `localhost` / `127.0.0.1` on a phone means the phone itself, not the computer. */
        LOOPBACK,

        /** Plain `ws://` toward the open internet: refused (use `wss://`). */
        CLEARTEXT,
    }

    fun host(relayUrl: String): String = HOST.find(relayUrl.trim())?.groupValues?.get(1)?.lowercase().orEmpty()

    /** The problem with [relayUrl] on a phone, or null when it can work. [debug] = a debug build. */
    fun problem(relayUrl: String, debug: Boolean): Problem? {
        // Even over wss://, a loopback relay is the phone itself, unless adb reverse
        // forwards it (debug builds on a USB phone): say so only on release builds.
        if (RelayRoute.of(relayUrl) == RelayRoute.LOOPBACK && !debug) return Problem.LOOPBACK
        if (RelayRoute.publicCleartext(relayUrl)) return Problem.CLEARTEXT
        return null
    }

    /** The user-facing explanation, naming the computer. */
    fun message(problem: Problem, computer: String): String = when (problem) {
        Problem.LOOPBACK ->
            "$computer’s relay is set to this device itself (localhost). On $computer: Settings → Remote access, use the managed relay or your Tailscale name, then pair again."
        Problem.CLEARTEXT ->
            "This relay is not encrypted (ws://) and is on the open internet. Use a wss:// relay, or your computer’s Tailscale name, then pair again."
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
