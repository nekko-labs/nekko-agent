package com.nekko.protocol

import java.net.URLDecoder

/**
 * Pairing links. Settings → Remote access on the computer shows a QR carrying
 * `nekko-agent-pair:?relay=&room=&key=&host=&pair=` (or, from the Local Web UI,
 * `https://host/?relay=…`), plus one `alt=` per extra route to the same relay
 * (the relay on the computer's LAN addresses, TASKS.md IO-20). Either form, or
 * a bare query string, parses to the same credentials. Mirrors
 * `packages/shared/src/pairing-link.ts`, held to it by the fixture
 * `pairing-links.json` (test resources).
 */
data class PairingLink(
    val relayUrl: String,
    val room: String,
    val key: String,
    /** One-time enrollment code; absent when re-using an existing pairing. */
    val pair: String? = null,
    /** Other addresses of the same relay, in the link's order; [RouteSupervisor] picks among them and [relayUrl]. */
    val alts: List<String> = emptyList(),
    /** The computer's public key (X9.63 P-256, base64) to pin; null when the link has none, and such a link can't pair. */
    val hostKey: String? = null,
) {
    /** Never print the secret. */
    override fun toString(): String = "PairingLink(relay=$relayUrl, room=$room, pair=${pair != null}, alts=${alts.size})"
}

object Pairing {
    private val ROOM = Regex("^[0-9a-fA-F]{8,128}$")
    private val KEY = Regex("^[0-9a-fA-F]{16,256}$")
    private val WS = Regex("^wss?://", RegexOption.IGNORE_CASE)
    private val HOST_KEY = Regex("^[A-Za-z0-9+/]{87}=$")

    /** At most this many `alt` routes are kept (`MAX_PAIRING_ALTS`). */
    const val MAX_ALTS = 4

    /** A link from a computer too old to name its host key: a first-seen key is never trusted. */
    const val NEEDS_HOST_KEY = "Update Nekko Agent on your computer, then make a new pairing code."

    fun parse(input: String): PairingLink? {
        val raw = input.trim()
        if (raw.isEmpty()) return null
        val query = (if ('?' in raw) raw.substringAfter('?') else raw).substringBefore('#')
        val params = parseQuery(query) ?: return null
        fun first(k: String) = params.firstOrNull { it.first == k }?.second
        val relay = first("relay")?.trim().orEmpty()
        val room = first("room")?.trim().orEmpty()
        val key = first("key")?.trim().orEmpty()
        if (relay.isEmpty() || room.isEmpty() || key.isEmpty()) return null
        if (!WS.containsMatchIn(relay)) return null
        if (!ROOM.matches(room) || !KEY.matches(key)) return null
        val pair = first("pair")?.trim()?.uppercase()?.ifEmpty { null }
        val relayUrl = relay.trimEnd('/')
        val hostKey = first("host")?.trim()?.takeIf { HOST_KEY.matches(it) }
        return PairingLink(relayUrl, room, key, pair, alts(params.filter { it.first == "alt" }.map { it.second }, relayUrl), hostKey)
    }

    /** The usable `alt` values: PH1-clean, no trailing slashes, no repeats of the relay or each other. */
    fun alts(values: List<String>, relayUrl: String): List<String> {
        val out = ArrayList<String>()
        for (v in values) {
            val url = v.trim().trimEnd('/')
            if (url.isEmpty() || urlProblem(url) || url == relayUrl || url in out) continue
            out += url
            if (out.size == MAX_ALTS) break
        }
        return out
    }

    /** Relay host for display ("nekko-agent-relay.fly.dev"). */
    fun relayHost(relayUrl: String): String = relayUrl.replace(WS, "").substringBefore('/')

    /** `relayUrlProblem` (packages/shared/src/relay-route.ts): bad shape, or plain ws:// to the open internet. */
    private fun urlProblem(url: String): Boolean {
        if (!Regex("^wss?://[^/?#]", RegexOption.IGNORE_CASE).containsMatchIn(url)) return true
        return RelayRoute.publicCleartext(url)
    }

    /** URLSearchParams semantics: every pair in order (first wins for get()), `+` is a space. */
    private fun parseQuery(q: String): List<Pair<String, String>>? = try {
        val out = ArrayList<Pair<String, String>>()
        for (part in q.split('&')) {
            if (part.isEmpty()) continue
            val k = URLDecoder.decode(part.substringBefore('='), Charsets.UTF_8)
            val v = if ('=' in part) URLDecoder.decode(part.substringAfter('='), Charsets.UTF_8) else ""
            out += k to v
        }
        out
    } catch (_: IllegalArgumentException) {
        null
    }
}
