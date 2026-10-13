package com.nekko.protocol

import java.net.URLDecoder

/**
 * Pairing links. Settings → Remote access on the computer shows a QR carrying
 * `nekko-agent-pair:?relay=&room=&key=&pair=` (or, from the web edition,
 * `https://host/?relay=…`). Either form, or a bare query string, parses to the
 * same credentials. Mirrors `apps/mobile/src/lib/pairing.ts`.
 */
data class PairingLink(
    val relayUrl: String,
    val room: String,
    val key: String,
    /** One-time enrollment code; absent when re-using an existing pairing. */
    val pair: String? = null,
) {
    /** Never print the secret. */
    override fun toString(): String = "PairingLink(relay=$relayUrl, room=$room, pair=${pair != null})"
}

object Pairing {
    private val ROOM = Regex("^[0-9a-fA-F]{8,128}$")
    private val KEY = Regex("^[0-9a-fA-F]{16,256}$")
    private val WS = Regex("^wss?://", RegexOption.IGNORE_CASE)

    fun parse(input: String): PairingLink? {
        val raw = input.trim()
        if (raw.isEmpty()) return null
        val query = (if ('?' in raw) raw.substringAfter('?') else raw).substringBefore('#')
        val params = parseQuery(query) ?: return null
        val relay = params["relay"]?.trim().orEmpty()
        val room = params["room"]?.trim().orEmpty()
        val key = params["key"]?.trim().orEmpty()
        if (relay.isEmpty() || room.isEmpty() || key.isEmpty()) return null
        if (!WS.containsMatchIn(relay)) return null
        if (!ROOM.matches(room) || !KEY.matches(key)) return null
        val pair = params["pair"]?.trim()?.uppercase()?.ifEmpty { null }
        return PairingLink(relay.trimEnd('/'), room, key, pair)
    }

    /** Relay host for display ("nekko-agent-relay.fly.dev"). */
    fun relayHost(relayUrl: String): String = relayUrl.replace(WS, "").substringBefore('/')

    /** URLSearchParams semantics: first value wins for get(), `+` is a space. */
    private fun parseQuery(q: String): Map<String, String>? = try {
        val out = LinkedHashMap<String, String>()
        for (part in q.split('&')) {
            if (part.isEmpty()) continue
            val k = URLDecoder.decode(part.substringBefore('='), Charsets.UTF_8)
            val v = if ('=' in part) URLDecoder.decode(part.substringAfter('='), Charsets.UTF_8) else ""
            out.putIfAbsent(k, v)
        }
        out
    } catch (_: IllegalArgumentException) {
        null
    }
}
