package com.nekko.protocol

import java.util.Locale
import kotlin.math.roundToLong

/**
 * What a model picker row says on its right (#2950, the iPhone's `ModelMeta`, #2925): a local
 * model's parameters and size on disk ("8B · 4.9 GB"), a cloud model's context window
 * ("400K context"). Only what the provider reported, never a guess, so null when nothing is known.
 */
object ModelMeta {
    /** [context] words the context window in the phone's language ("400K" → "400K context"). */
    fun line(
        local: Boolean,
        parameters: String? = null,
        sizeBytes: Long? = null,
        contextLength: Long? = null,
        context: (String) -> String = { "$it context" },
    ): String? {
        if (local) {
            val parts = listOfNotNull(parameters?.takeIf { it.isNotBlank() }, sizeBytes?.takeIf { it > 0 }?.let(::size))
            return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
        }
        if (contextLength == null || contextLength <= 0) return null
        return context(tokens(contextLength))
    }

    /** 4.9 GB, 850 MB: decimal units, as the computer's model library shows them. */
    fun size(bytes: Long): String {
        val gb = bytes / 1_000_000_000.0
        if (gb >= 1) return "${oneDecimal(gb)} GB"
        return "${maxOf(1L, (bytes / 1_000_000.0).roundToLong())} MB"
    }

    /** 400K, 1M, 1.5M, 512. */
    fun tokens(n: Long): String = when {
        n >= 1_000_000 -> "${oneDecimal(n / 1_000_000.0)}M"
        n >= 1_000 -> "${(n / 1_000.0).roundToLong()}K"
        else -> "$n"
    }

    private fun oneDecimal(v: Double): String {
        val r = Math.round(v * 10) / 10.0
        return if (r == Math.rint(r)) "${r.toLong()}" else String.format(Locale.ROOT, "%.1f", r)
    }
}

/**
 * Dated snapshots folded under the model they pin (#2925): `o3-2025-04-16` under `o3`,
 * `claude-sonnet-4-20250514` under `claude-sonnet-4`. Without the plain id in the list, the
 * newest snapshot leads its group.
 */
object ModelSnapshots {
    /** [dated]: newest first. */
    data class Fold(val main: String, val dated: List<String>)

    /** The id without its date suffix, or null when it has none. */
    fun base(id: String): String? {
        val parts = id.split("-")
        fun digits(s: String, n: Int) = s.length == n && s.all { it in '0'..'9' }
        if (parts.size > 3 && digits(parts[parts.size - 3], 4) && digits(parts[parts.size - 2], 2) && digits(parts.last(), 2)) {
            return parts.dropLast(3).joinToString("-")
        }
        if (parts.size > 1 && digits(parts.last(), 8) && parts.last().startsWith("20")) {
            return parts.dropLast(1).joinToString("-")
        }
        return null
    }

    /** Groups in the order their first member appears. */
    fun fold(ids: List<String>): List<Fold> {
        val present = ids.toSet()
        val members = LinkedHashMap<String, MutableList<String>>()
        for (id in ids) {
            val key = base(id)?.takeIf { it.isNotEmpty() } ?: id
            members.getOrPut(key) { mutableListOf() }.add(id)
        }
        return members.map { (key, group) ->
            val dated = group.filter { it != key }.sortedDescending()
            if (key in present) Fold(key, dated) else Fold(dated.firstOrNull() ?: key, dated.drop(1))
        }
    }
}
