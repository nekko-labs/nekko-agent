package com.nekko.protocol

/**
 * A computer that says it runs Nekko Agent on this network (TASKS.md PH3),
 * read from its `_nekko-agent._tcp` DNS-SD TXT record. The record holds only a
 * name, a version and, when the computer runs its own relay, that relay's
 * address; never anything that lets a phone into the room. So a listing is a
 * pointer ("open Remote access on Studio and scan its code"), not a pairing.
 * Mirrors the iPhone app's `NearbyComputer`.
 */
data class NearbyComputer(
    /** The DNS-SD instance name, unique on the network. */
    val id: String,
    val name: String,
    /** The computer's own relay, when it says one and this phone could use it. */
    val relayUrl: String?,
) {
    companion object {
        const val SERVICE_TYPE = "_nekko-agent._tcp"
        internal const val VERSION = "1"
        internal const val MAX_NAME = 63

        /** Null for a record from another version, or one with nothing to show. */
        fun from(instance: String, txt: Map<String, String>): NearbyComputer? {
            if (txt["v"] != VERSION) return null
            val name = clean(txt["name"].orEmpty()).ifEmpty { clean(instance) }.ifEmpty { return null }
            return NearbyComputer(instance, name, usableRelay(txt["relay"]))
        }

        /**
         * Anyone on the network can write this record, so the relay is shown
         * only when it's a ws/wss address this phone would accept anyway
         * (wss://, or ws:// to the tailnet or the LAN).
         */
        internal fun usableRelay(raw: String?): String? {
            val url = raw?.trim().orEmpty()
            if (!url.startsWith("ws://", ignoreCase = true) && !url.startsWith("wss://", ignoreCase = true)) return null
            if (RelayHint.host(url).isEmpty()) return null
            return url.takeIf { RelayHint.problem(it, debug = false) == null }
        }

        /** Printable, one line, at most [MAX_NAME] characters. */
        internal fun clean(s: String): String =
            s.map { if (it.isISOControl()) ' ' else it }.joinToString("")
                .split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
                .take(MAX_NAME)

        /** By name, so the list holds still while results come and go. */
        fun sorted(list: List<NearbyComputer>): List<NearbyComputer> = list.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }
}
