package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.text.Normalizer

// What the phone reads beyond a chat's transcript, as the computer projects it
// for phones (packages/shared/src/phone-views.ts): a chat's queue, the saved
// prompts, and the chat list's search (AN-29, the iPhone's IO-22 to
// IO-25). Mirrors `Beyond.swift`.

/**
 * A run setting a phone shows for a chat, sent to the computer running it. No
 * [values] means on or off. The computer checks every one, and asks for the
 * fingerprint or screen lock for those that change what an agent may touch.
 */
data class RunOption(val key: String, val values: List<String> = emptyList()) {
    companion object {
        val all = listOf(
            RunOption("autoModel"),
            RunOption("offline"),
            RunOption("cloudOnly"),
            RunOption("incognito"),
            RunOption("gitIsolation"),
            RunOption("workMode", listOf("default", "better-review", "design", "best-output")),
            RunOption("toolApproach", listOf("list", "code")),
        )

        /** A chat's run settings, as the computer holds them. */
        fun values(o: JsonObject?): Map<String, JsonElement> =
            all.mapNotNull { option -> o?.get(option.key)?.takeIf { it !is JsonNull }?.let { option.key to it } }.toMap()
    }
}

/** One prompt waiting in a chat's queue on the computer. */
data class QueuedPrompt(
    /** The text the computer holds: what an edit is checked against (`expect`). */
    val text: String,
    val skillName: String? = null,
    val skillInput: String? = null,
    val images: Int = 0,
) {
    /** What the composer shows: a skill's prompt as `/name input`, never its instructions. */
    val shown: String get() = if (skillName == null) text else "/$skillName ${skillInput.orEmpty()}".trim()

    /** A skill's text is its instructions: it can be removed, not edited. */
    val editable: Boolean get() = skillName == null

    /** The agent takes only text at its next step: photos and skills wait for their turn. */
    val canTakeAtNextStep: Boolean get() = skillName == null && images == 0

    companion object {
        fun list(v: JsonElement?): List<QueuedPrompt> = v.arr().orEmpty().mapNotNull { q ->
            (q as? JsonPrimitive)?.takeIf { it.isString }?.let { return@mapNotNull QueuedPrompt(it.content) }
            val o = q.obj() ?: return@mapNotNull null
            val skill = o["skill"].obj()
            QueuedPrompt(o.str("text").orEmpty(), skill?.str("name"), skill?.str("input"), o["images"].arr()?.size ?: 0)
        }

        /** `chat:editQueued`'s edit: the text the phone showed, and the new text (null removes it). */
        fun edit(expect: String, text: String?): JsonObject = buildJsonObject {
            put("expect", expect)
            text?.let { put("text", it) }
        }
    }
}

/** A prompt the user saved on the computer (`AppSettings.prompts`): its name and text. */
data class SavedPrompt(val id: String, val name: String, val body: String) {
    /** What a turn sends for it, the way the desktop's `/name` does: the text, then what was typed. */
    fun text(input: String): String = listOf(body.trim(), input.trim()).filter { it.isNotEmpty() }.joinToString("\n\n")

    companion object {
        fun list(v: JsonElement?): List<SavedPrompt> = v.arr().orEmpty().mapNotNull { e ->
            val p = e.obj() ?: return@mapNotNull null
            val name = p.str("name")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val body = p.str("body") ?: return@mapNotNull null
            SavedPrompt(p.str("id") ?: name, name, body)
        }
    }
}

/** The chat list's search (the iPhone's `ChatSearch`). */
object ChatSearch {
    /**
     * Chats whose title, first prompt or last reply holds every word of
     * [query], ignoring case and accents. Completed chats included.
     */
    fun matches(chats: List<SessionSummary>, query: String): List<SessionSummary> {
        val words = fold(query).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return chats
        return chats.filter { s ->
            val hay = fold(listOf(s.title, s.firstUserText.orEmpty(), s.lastReplyText.orEmpty()).joinToString(" "))
            words.all { hay.contains(it) }
        }
    }

    /** Case, accents and width folded away (`é` → `e`, `Ｅ` → `e`). */
    internal fun fold(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "").lowercase()
}

/** A scheduled, recurring or background task on the computer (`tasks:list`). */
data class AutomationTask(
    val id: String,
    val title: String,
    val kind: Kind,
    val status: String,
    val runAt: Long? = null,
    val intervalMs: Long? = null,
    val untilDone: Boolean = false,
    val lastRunAt: Long? = null,
    val nextRunAt: Long? = null,
    val runCount: Int = 0,
    val lastSessionId: String? = null,
    val lastResult: String? = null,
) {
    enum class Kind(val wire: String) { SCHEDULED("scheduled"), RECURRING("recurring"), BACKGROUND("background") }

    /** `taskCadence` (packages/shared/src/tasks.ts), in words; [whenText] formats a time for *Once*. */
    fun cadence(whenText: (Long) -> String): String = when (kind) {
        Kind.SCHEDULED -> runAt?.let { "Once, " + whenText(it) } ?: "Once"
        Kind.RECURRING -> "Every " + interval(intervalMs ?: 0)
        Kind.BACKGROUND -> if (untilDone) "Until it’s done" else "Runs in the background"
    }

    val paused: Boolean get() = status == "paused"
    val failed: Boolean get() = status == "error"

    companion object {
        fun interval(ms: Long): String {
            val min = Math.round(ms / 60_000.0).toInt()
            if (min < 60) return if (min == 1) "minute" else "${maxOf(min, 1)} minutes"
            val hr = min / 60.0
            if (hr < 24) return if (hr == 1.0) "hour" else "${formatted(hr)} hours"
            val d = hr / 24
            return if (d == 1.0) "day" else "${formatted(d)} days"
        }

        private fun formatted(x: Double) = if (x == Math.rint(x)) x.toInt().toString() else String.format(java.util.Locale.US, "%.1f", x)

        fun list(v: JsonElement?): List<AutomationTask> = v.arr().orEmpty().mapNotNull { e ->
            val t = e.obj() ?: return@mapNotNull null
            val id = t.str("id") ?: return@mapNotNull null
            AutomationTask(
                id = id, title = t.str("title") ?: "Task", kind = Kind.entries.firstOrNull { it.wire == t.str("kind") } ?: Kind.SCHEDULED,
                status = t.str("status") ?: "active", runAt = t.long("runAt"), intervalMs = t.long("intervalMs"),
                untilDone = t.str("keepAlive") == "until", lastRunAt = t.long("lastRunAt"), nextRunAt = t.long("nextRunAt"),
                runCount = t.long("runCount")?.toInt() ?: 0, lastSessionId = t.str("lastSessionId"),
                lastResult = t.str("lastResult")?.takeIf { it.isNotBlank() },
            )
        }
    }
}

/** A workflow on the computer (`workflows:list`): name and state, never its steps. */
data class AutomationWorkflow(
    val id: String,
    val name: String,
    val description: String? = null,
    val category: String = "",
    val enabled: Boolean = true,
    val stepCount: Int = 0,
    val lastRunAt: Long? = null,
    /** `queued`, `running`, `success`, `failure` or `cancelled`. */
    val lastStatus: String? = null,
    val runCount: Int = 0,
    val nextRunAt: Long? = null,
) {
    /** `Code · 2 steps · Off`. */
    val detail: String
        get() = listOfNotNull(category.ifEmpty { null }, if (stepCount == 1) "1 step" else "$stepCount steps", if (enabled) null else "Off").joinToString(" · ")

    companion object {
        fun list(v: JsonElement?): List<AutomationWorkflow> = v.arr().orEmpty().mapNotNull { e ->
            val w = e.obj() ?: return@mapNotNull null
            val id = w.str("id") ?: return@mapNotNull null
            AutomationWorkflow(
                id = id, name = w.str("name") ?: "Workflow", description = w.str("description"), category = w.str("category").orEmpty(),
                enabled = w.bool("enabled"), stepCount = w.long("stepCount")?.toInt() ?: 0, lastRunAt = w.long("lastRunAt"),
                lastStatus = w.str("lastStatus"), runCount = w.long("runCount")?.toInt() ?: 0, nextRunAt = w.long("nextRunAt"),
            )
        }
    }
}

/** The computer's provider usage (`usage:summary`). */
data class UsageSummary(val totalInput: Long, val totalOutput: Long, val totalCost: Double, val models: List<Model>, val days: List<Day>) {
    data class Model(val model: String, val input: Long, val output: Long, val cost: Double, val subscription: Boolean) {
        val tokens: Long get() = input + output
    }

    data class Day(val date: String, val tokens: Long, val cost: Double)

    val totalTokens: Long get() = totalInput + totalOutput

    companion object {
        fun from(v: JsonElement?): UsageSummary? {
            val o = v.obj() ?: return null
            val models = o["byModel"].arr().orEmpty().mapNotNull { e ->
                val m = e.obj() ?: return@mapNotNull null
                Model(m.str("model") ?: return@mapNotNull null, m.long("input") ?: 0, m.long("output") ?: 0, m.dbl("cost") ?: 0.0, m.bool("subscription"))
            }
            val days = o["daily"].arr().orEmpty().mapNotNull { e ->
                val d = e.obj() ?: return@mapNotNull null
                Day(d.str("date") ?: return@mapNotNull null, (d.long("input") ?: 0) + (d.long("output") ?: 0), d.dbl("cost") ?: 0.0)
            }
            return UsageSummary(o.long("totalInput") ?: 0, o.long("totalOutput") ?: 0, o.dbl("totalCost") ?: 0.0, models, days)
        }
    }
}

/** One provider's plan limits (`limits:get`, asked by provider id). */
data class ProviderLimits(val planType: String?, val windows: List<Window>, val updatedAt: Long?) {
    data class Window(
        val id: String,
        val label: String,
        val usedPercent: Double,
        val resetAt: Long?,
        /** `allowed`, `warning` or `rate_limited`. */
        val status: String,
    ) {
        val limited: Boolean get() = status == "rate_limited"
    }

    companion object {
        fun from(v: JsonElement?): ProviderLimits? {
            val o = v.obj() ?: return null
            val windows = o["windows"].arr().orEmpty().mapNotNull { e ->
                val w = e.obj() ?: return@mapNotNull null
                val id = w.str("id") ?: return@mapNotNull null
                Window(id, w.str("label") ?: id, (w.dbl("usedPercent") ?: 0.0).coerceIn(0.0, 100.0), w.long("resetAt"), w.str("status") ?: "allowed")
            }
            return ProviderLimits(o.str("planType"), windows, o.long("updatedAt"))
        }
    }
}
