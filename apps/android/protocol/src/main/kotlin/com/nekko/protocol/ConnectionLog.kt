package com.nekko.protocol

import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * What happened to this phone's connection to a computer, newest last, for
 * Settings → Connection. Memory only, bounded, and content-free: states, the
 * relay client's own detail ("handshake timed out") and deny reasons. Never
 * rooms, keys, codes or anything a chat said. Same as the iPhone app's
 * `ConnectionLog.swift`.
 */
class ConnectionLog {
    data class Entry(
        val id: Int,
        val at: Instant,
        val state: RelayState,
        val detail: String?,
        val denied: DenyReason?,
        /** How many times in a row this same state and detail came in (retries). */
        val repeats: Int = 1,
    )

    private val list = ArrayList<Entry>()
    private var nextId = 0

    val entries: List<Entry> get() = synchronized(list) { list.toList() }

    /** Adds a status; the same state and detail again only bumps the last entry's count. */
    fun record(state: RelayState, detail: String? = null, denied: DenyReason? = null, at: Instant = Instant.now()) = synchronized(list) {
        val last = list.lastOrNull()
        if (last != null && last.state == state && last.detail == detail && last.denied == denied) {
            list[list.size - 1] = last.copy(repeats = last.repeats + 1)
            return@synchronized
        }
        list += Entry(nextId++, at, state, detail, denied)
        while (list.size > CAPACITY) list.removeAt(0)
    }

    fun clear() = synchronized(list) { list.clear() }

    /** When the connection was last online, if it has been since the log started. */
    val lastOnline: Instant? get() = entries.lastOrNull { it.state == RelayState.ONLINE }?.at

    /** The log as plain text to paste into a bug report: times, states and details only. */
    fun text(relayHost: String, tailnet: Boolean): String = buildString {
        append("Relay: $relayHost (${if (tailnet) "tailscale" else "internet"})")
        for (e in entries) {
            append('\n').append(DateTimeFormatter.ISO_INSTANT.format(e.at)).append(' ').append(e.state.name.lowercase())
            if (e.denied != null) append(" [${e.denied.wire}]") else if (e.detail != null) append(" – ${e.detail}")
            if (e.repeats > 1) append(" ×${e.repeats}")
        }
    }

    companion object {
        const val CAPACITY = 50
    }
}

/** What to try, given where the phone is trying to go and how it's going. Most likely fix first; empty when nothing is wrong. */
object ConnectionAdvice {
    fun advise(
        relayUrl: String,
        computer: String,
        state: RelayState,
        denied: DenyReason?,
        detail: String?,
        phoneOnTailnet: Boolean,
        debug: Boolean,
    ): List<String> {
        val host = RelayHint.host(relayUrl)
        return when (state) {
            RelayState.ONLINE, RelayState.IDLE -> emptyList()
            RelayState.DENIED -> listOf(
                when (denied) {
                    DenyReason.REVOKED, DenyReason.KICKED ->
                        "$computer removed this phone. Pair again: Settings → Remote access → Pair a device on the computer."
                    DenyReason.BAD_CODE ->
                        "That pairing code was used or expired (codes last 10 minutes and work once). Make a new one on $computer."
                    DenyReason.BAD_KEY ->
                        "The pairing key no longer matches $computer, usually because remote access was turned off and on there. Pair again."
                    else -> "$computer doesn’t know this phone. Pair again from Settings → Remote access on the computer."
                },
            )
            RelayState.OFFLINE -> listOf(
                "The relay answers, but $computer isn’t connected to it. Wake $computer and open Nekko Agent with Remote access on.",
                "If $computer is awake, check it uses the same relay: Settings → Remote access shows it.",
            )
            RelayState.CONNECTING -> buildList {
                RelayHint.problem(relayUrl, debug)?.let { add(RelayHint.message(it, computer)) }
                if (Tailnet.isTailnetRelay(relayUrl)) {
                    if (!phoneOnTailnet) {
                        add("Tailscale is off on this phone. Open the Tailscale app and connect to your tailnet.")
                    } else {
                        add("Tailscale is on, but $host doesn’t answer. Check $computer is awake and signed in to the same tailnet.")
                        add("On $computer, Settings → Remote access → Relay on this computer should say it’s running.")
                    }
                } else if (isEmpty()) {
                    add("Check this phone is online, then that $host is up.")
                    if (detail != null && (detail.contains("cert", ignoreCase = true) || detail.contains("tls", ignoreCase = true))) {
                        add("The relay’s certificate was refused. A self-hosted relay needs a valid TLS certificate.")
                    }
                }
            }
        }
    }
}
