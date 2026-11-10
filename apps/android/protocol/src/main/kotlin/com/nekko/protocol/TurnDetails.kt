package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * The computer's persisted measurements for one turn (`ChatMessage.turnStats` in shared/chat.ts),
 * the iPhone's `TurnStats` (#1911). A narrow projection: never keep arbitrary provider payloads,
 * prompts, keys or future metadata. This is the turn's recorded model and effort, not the chat's
 * currently selected ones.
 */
data class TurnStats(
    val providerId: String,
    val modelId: String,
    /** low / medium / normal / high / xhigh / max; anything else is dropped. */
    val effort: String?,
    val inputTokens: Double,
    val outputTokens: Double,
    val cacheReadTokens: Double?,
    val cacheWriteTokens: Double?,
    /** The provider's decode time, ms: what the speed is measured on. */
    val outputMs: Double?,
    /** The whole turn, tools and approvals included, ms. */
    val wallMs: Double,
    val calls: Double,
    /** complete / loop / runaway; anything else is dropped. */
    val stop: String?,
) {
    /** Everything the model read: fresh input plus the cache it read and wrote, as the desktop's TurnStatsLine counts it. */
    val allInput: Double get() = inputTokens + (cacheReadTokens ?: 0.0) + (cacheWriteTokens ?: 0.0)

    /**
     * `decodeRate` in shared/chat.ts: output tokens over the provider's decode time, at least 100 ms
     * of it. Wall time includes tools and approvals, so it is never used instead.
     */
    val tokensPerSecond: Double?
        get() {
            val ms = outputMs ?: return null
            if (ms < 100 || outputTokens <= 0) return null
            val rate = outputTokens / (ms / 1000)
            return rate.takeIf { it.isFinite() && it > 0 }
        }

    /** Only these counts and identifiers follow a saved transcript. */
    fun json(): JsonObject = buildJsonObject {
        put("providerId", providerId)
        put("modelId", modelId)
        put("inputTokens", inputTokens)
        put("outputTokens", outputTokens)
        put("wallMs", wallMs)
        put("calls", calls)
        effort?.let { put("effort", it) }
        stop?.let { put("stop", it) }
        outputMs?.let { put("outputMs", it) }
        cacheReadTokens?.let { put("cacheReadTokens", it) }
        cacheWriteTokens?.let { put("cacheWriteTokens", it) }
    }

    companion object {
        val EFFORTS = setOf("low", "medium", "normal", "high", "xhigh", "max")
        val STOPS = setOf("complete", "loop", "runaway")

        /** A malformed required field drops the stats; a malformed optional one is ignored. */
        fun from(e: JsonElement?): TurnStats? {
            val o = e as? JsonObject ?: return null
            fun number(key: String): Double? = runCatching { o[key]?.jsonPrimitive?.takeIf { !it.isString }?.doubleOrNull }.getOrNull()
                ?.takeIf { it.isFinite() && it >= 0 }
            fun text(key: String): String? = runCatching { o[key]?.jsonPrimitive?.takeIf { it.isString }?.content }.getOrNull()
            return TurnStats(
                providerId = text("providerId")?.takeIf { it.isNotEmpty() } ?: return null,
                modelId = text("modelId")?.takeIf { it.isNotEmpty() } ?: return null,
                effort = text("effort")?.takeIf { it in EFFORTS },
                inputTokens = number("inputTokens") ?: return null,
                outputTokens = number("outputTokens") ?: return null,
                cacheReadTokens = number("cacheReadTokens"),
                cacheWriteTokens = number("cacheWriteTokens"),
                outputMs = number("outputMs"),
                wallMs = number("wallMs") ?: return null,
                calls = number("calls") ?: return null,
                stop = text("stop")?.takeIf { it in STOPS },
            )
        }
    }
}

/**
 * A finished reply's closing line: it belongs to the persisted message that ended the turn, never
 * to the chat's selected model or a transient `done` event. [successful] (the checkmark) only when
 * the computer recorded `stop == complete` and the reply was not interrupted.
 */
data class TurnDetails(val id: String, val stats: TurnStats, val successful: Boolean) {
    companion object {
        fun of(m: ChatMessage): TurnDetails? {
            if (m.role != "assistant") return null
            val stats = m.turnStats ?: return null
            return TurnDetails(m.id, stats, stats.stop == "complete" && !m.interrupted)
        }

        /**
         * The footers by the id of the block they follow: the reply's last tool call (a tool-only
         * reply too), else the reply itself, else (a reply with nothing to show) the last block
         * before it, as [Transcript.fromMessages] lays the blocks out.
         */
        fun footers(messages: List<ChatMessage>): Map<String, TurnDetails> {
            val out = LinkedHashMap<String, TurnDetails>()
            var last: String? = null
            for (m in messages) {
                val shows = m.role == "user" || (m.role == "assistant" && (m.content.isNotBlank() || !m.reasoning.isNullOrBlank() || m.images.isNotEmpty()))
                if (shows) last = m.id
                if (m.role == "assistant") m.toolCalls.lastOrNull()?.let { last = it.id }
                val details = of(m) ?: continue
                val anchor = m.toolCalls.lastOrNull()?.id ?: (if (shows) m.id else last) ?: continue
                out[anchor] = details
            }
            return out
        }

        /** 812, 1.2k, 34k. */
        fun tokens(n: Double): String = when {
            n >= 10_000 -> "%.0fk".format(java.util.Locale.US, n / 1000)
            n >= 1000 -> "%.1fk".format(java.util.Locale.US, n / 1000)
            else -> "%.0f".format(java.util.Locale.US, n)
        }

        /** 48 tok/s, 7.5 tok/s: the number only. */
        fun rate(r: Double): String = if (r >= 10) "%.0f".format(java.util.Locale.US, r) else "%.1f".format(java.util.Locale.US, r)
    }
}
