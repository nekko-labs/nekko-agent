package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToLong

/**
 * One durable `agent_watch` of a chat as the computer reports it
 * (`session:watches`, `PHONE_WATCH_VIEW`): joined to the arming call by [id].
 */
data class AgentWatch(
    val id: String,
    val kind: Kind,
    val url: String? = null,
    val status: Status,
    /** Timer: when it wakes. PR: the latest it waits before waking anyway. Milliseconds since the epoch. */
    val deadlineAt: Long,
    /** A wake-up is due but the chat has not been continued yet (busy or failing). */
    val pending: Boolean = false,
    val failures: Int = 0,
    val lastError: String? = null,
) {
    enum class Kind { TIMER, PR }
    enum class Status { ACTIVE, DONE, CANCELLED, ERROR }

    companion object {
        fun list(e: JsonElement?): List<AgentWatch> = e.arr()?.mapNotNull { v ->
            val w = v.obj() ?: return@mapNotNull null
            AgentWatch(
                id = w.str("id") ?: return@mapNotNull null,
                kind = enumOf<Kind>(w.str("kind")) ?: return@mapNotNull null,
                url = w.str("url"),
                status = enumOf<Status>(w.str("status")) ?: return@mapNotNull null,
                deadlineAt = w.long("deadlineAt") ?: return@mapNotNull null,
                pending = w.bool("pending"),
                failures = (w.long("failures") ?: 0).toInt(),
                lastError = w.str("lastError"),
            )
        }.orEmpty()

        private inline fun <reified E : Enum<E>> enumOf(raw: String?): E? =
            enumValues<E>().firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }
}

/**
 * What the agent-work rows of a chat read from a tool call beyond its label:
 * a watch's target and timer, a subagent's title and model. The iPhone's
 * `AgentRows` (ports of the desktop's `agentWatches.ts`, `SubagentCue.tsx` and
 * `subagentActivity.ts`), so all three show the same words. Pure, so the rows
 * are testable here.
 */
object AgentRows {
    const val WATCH_TOOL = "agent_watch"
    const val SUBAGENT_TOOL = "spawn_agent"

    // ---- Watches ----

    /** An `agent_watch` call as the row reads it. */
    data class WatchCall(
        val action: Action,
        val kind: AgentWatch.Kind?,
        val url: String?,
        /** Timer delay or PR maximum wait, in seconds. */
        val seconds: Double?,
        val prompt: String,
        /** The id this call armed or cancelled, once its result is in. */
        val id: String?,
    ) {
        enum class Action { CREATE, LIST, CANCEL, UNKNOWN }
    }

    private val ARMED = Regex("""Watch (?:already )?armed: ([\w-]+)""")

    fun parseWatch(input: JsonObject, output: String?, failed: Boolean = false): WatchCall {
        val action = when (input.str("action")) {
            "create" -> WatchCall.Action.CREATE
            "list" -> WatchCall.Action.LIST
            "cancel" -> WatchCall.Action.CANCEL
            else -> WatchCall.Action.UNKNOWN
        }
        val kind = when (input.str("kind")) {
            "timer" -> AgentWatch.Kind.TIMER
            "pr" -> AgentWatch.Kind.PR
            else -> null
        }
        val raw = when (kind) {
            AgentWatch.Kind.TIMER -> input.num("delay_seconds") ?: 300.0
            AgentWatch.Kind.PR -> input.num("timeout_seconds") ?: 3600.0
            null -> null
        }
        var id = if (!failed && output != null) ARMED.find(output)?.groupValues?.get(1) else null
        if (id == null && action == WatchCall.Action.CANCEL) id = input.str("id")
        return WatchCall(action, kind, input.str("url"), raw?.takeIf { it.isFinite() }, input.str("prompt").orEmpty(), id)
    }

    private val PR = Regex("""github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)""")

    /** "PR #555" and "owner/repo#555" from a GitHub pull request address. */
    fun prLabel(url: String?): Pair<String, String>? {
        val m = PR.find(url ?: return null) ?: return null
        val n = m.groupValues[3].toIntOrNull() ?: return null
        return "PR #$n" to "${m.groupValues[1]}/${m.groupValues[2]}#$n"
    }

    /** `fmtSpan`: "42s", "4m 10s", "12 min", "1h 05m", "3 days". */
    fun span(ms: Double): String {
        val s = maxOf(0L, (ms / 1000).roundToLong())
        if (s < 60) return "${s}s"
        val m = s / 60
        if (m < 10) return "${m}m " + "%02ds".format(s % 60)
        if (m < 60) return "$m min"
        val h = m / 60
        if (h < 48) return if (m % 60 != 0L) "${h}h " + "%02dm".format(m % 60) else "${h}h"
        return "${(h / 24.0).roundToLong()} days"
    }

    /** What the watch is looking at and what makes it fire, in one line. */
    fun watchHeadline(w: WatchCall, failed: String? = null): String {
        if (failed != null) return "Watch not armed · " + failed.replace("Agent watch failed: ", "").take(120)
        when (w.action) {
            WatchCall.Action.LIST -> return "Checked this chat’s watches"
            WatchCall.Action.CANCEL -> return ("Cancelled watch " + (w.id?.take(8) ?: "")).trim()
            else -> Unit
        }
        val limit = w.seconds?.let { span(it * 1000) }.orEmpty()
        return when (w.kind) {
            AgentWatch.Kind.PR -> {
                val pr = prLabel(w.url)?.first ?: "a pull request"
                "Watching $pr · wakes on any PR change" + if (limit.isEmpty()) "" else " or after $limit"
            }
            AgentWatch.Kind.TIMER -> "Timer watch · wakes after " + limit.ifEmpty { "its delay" }
            null -> "Agent watch"
        }
    }

    /** The first sentence of a prompt, in a few words: what the agent does when it wakes. */
    fun thenSummary(prompt: String, words: Int = 40): String {
        val sentence = compactSentence(prompt, limit = 400)
        if (sentence.isEmpty()) return ""
        val parts = sentence.split(' ')
        return if (parts.size > words) parts.take(words).joinToString(" ") + "…" else sentence
    }

    private val SENTENCE = Regex("""^.*?[.!?](?=\s|$)""")

    /** `compactSentence`: whitespace folded, cut at the first sentence end, at most [limit] characters. */
    fun compactSentence(text: String, limit: Int = 140): String {
        val clean = text.take(2000).split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        val sentence = SENTENCE.find(clean)?.value ?: clean
        return if (sentence.length > limit) sentence.take(limit - 1).trim() + "…" else sentence
    }

    enum class Tone { NORMAL, WARN, DANGER, QUIET }

    data class Clock(
        val text: String,
        val tone: Tone,
        val detail: String,
        /** Whether the text changes with time (so the row re-renders each second). */
        val ticking: Boolean,
    )

    /** The chip an armed watch wears: time left, overdue, due, triggered, cancelled, failed. */
    fun watchClock(w: WatchCall, view: AgentWatch?, now: Long, time: (Long) -> String = ::time): Clock? {
        view ?: return null
        when (view.status) {
            AgentWatch.Status.DONE -> return Clock("triggered", Tone.QUIET, "This watch fired and woke the chat.", false)
            AgentWatch.Status.CANCELLED -> return Clock("cancelled", Tone.QUIET, view.lastError?.let { "Cancelled: $it" } ?: "This watch was cancelled.", false)
            AgentWatch.Status.ERROR -> return Clock("failed to wake", Tone.DANGER, "The wake-up could not be delivered" + (view.lastError?.let { ": $it" } ?: "."), false)
            AgentWatch.Status.ACTIVE -> Unit
        }
        val late = (now - view.deadlineAt).toDouble()
        val lastError = view.lastError?.let { " Last error: $it" }.orEmpty()
        if (view.pending) {
            return Clock(
                "due · waiting for the chat", if (late > 120_000 || view.failures > 0) Tone.WARN else Tone.NORMAL,
                "Triggered; waiting for the chat to be free before continuing.$lastError", true,
            )
        }
        // The scheduler polls every 15 s, so a minute's grace before calling it late.
        if (late > 60_000) {
            return Clock("overdue ${span(late)}", Tone.WARN, "Expected to wake by ${time(view.deadlineAt)}. Is the app or engine running?$lastError", true)
        }
        val left = maxOf(0L, view.deadlineAt - now).toDouble()
        val retrying = if (view.failures > 0) " · retrying" else ""
        val pr = w.kind == AgentWatch.Kind.PR
        val prefix = if (pr) "≤ " else ""
        val wakes = if (pr) "Wakes on a PR change, or at ${time(view.deadlineAt)} at the latest." else "Wakes at ${time(view.deadlineAt)}."
        return Clock("$prefix${span(left)} left$retrying", if (view.failures > 0) Tone.WARN else Tone.NORMAL, wakes + lastError, true)
    }

    private fun time(ms: Long): String =
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(ms))

    // ---- Wake-ups ----

    /** A `[Agent watch <id>]` wake-up the computer sent as a user turn. */
    data class Wake(val id: String, val trigger: String, val detail: String, val prompt: String, val url: String?)

    fun isWake(content: String): Boolean = parseWake(content) != null

    private val PR_CHANGED = Regex("""^PR state changed for (\S+?)\.? Fetch the latest details before acting\. Snapshot: """)

    fun parseWake(content: String): Wake? {
        if (!content.startsWith("[Agent watch ")) return null
        val close = content.indexOf(']').takeIf { it >= 0 } ?: return null
        val id = content.substring(13, close)
        if (id.isEmpty() || '\n' in id) return null
        var body = content.substring(close + 1)
        if (body.startsWith("\n")) body = body.substring(1)
        val marker = "\n\nContinuation requested when armed:\n"
        var reason = body
        var prompt = ""
        val at = body.indexOf(marker)
        if (at >= 0) {
            reason = body.substring(0, at)
            prompt = body.substring(at + marker.length)
            val end = prompt.indexOf("\n\nThis wake-up grants no new permissions.")
            if (end >= 0) prompt = prompt.substring(0, end)
        }
        reason = reason.trim()
        prompt = prompt.trim()
        PR_CHANGED.find(reason)?.let { m ->
            val url = m.groupValues[1]
            val parts = ArrayList<String>()
            runCatching { kotlinx.serialization.json.Json.parseToJsonElement(reason.substring(m.range.last + 1)) }.getOrNull().obj()?.let { snap ->
                snap.str("state")?.let { parts += it }
                snap.str("checks")?.takeIf { it != "none" }?.let { parts += "checks $it" }
                if (snap.bool("isDraft")) parts += "draft"
                snap.str("reviewDecision")?.let { parts += it.lowercase().replace('_', ' ') }
            }
            return Wake(id, "${prLabel(url)?.first ?: "PR"} changed", parts.joinToString(", "), prompt, url)
        }
        if (reason.startsWith("Watch deadline reached")) {
            val i = reason.indexOf("Last polling error: ")
            val error = if (i >= 0) reason.substring(i + "Last polling error: ".length) else null
            return Wake(id, "Deadline reached", error?.let { "last polling error: ${compactSentence(it, 80)}" }.orEmpty(), prompt, null)
        }
        return Wake(id, "Woke up", compactSentence(reason, 100), prompt, null)
    }

    // ---- Subagents ----

    /** The delegation's title, else the first words of its task. */
    fun subagentTitle(input: JsonObject): String {
        input.str("title")?.trim()?.takeIf { it.isNotEmpty() }?.let { return compactSentence(it) }
        input.str("task")?.trim()?.takeIf { it.isNotEmpty() }?.let { return compactSentence(it, 60) }
        return "Subagent"
    }

    /** What the delegation is for: the task's first sentence. */
    fun subagentTask(input: JsonObject): String = input.str("task")?.let { compactSentence(it, 140) }.orEmpty()

    /** `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`; `org/model:latest` → `model`. */
    fun shortModelName(id: String): String {
        var tail = id.substringAfterLast('/')
        if (tail.lowercase().endsWith(":latest")) tail = tail.dropLast(7)
        return tail.replace(Regex("""-\d{8}$"""), "")
    }

    enum class ModelSource { CHILD, REQUESTED, INHERITED }

    /** The title a delegation's child chat gets: its title, else the task's first 40 characters. */
    private fun childTitle(input: JsonObject): String =
        input.str("title")?.trim()?.takeIf { it.isNotEmpty() } ?: input.str("task")?.trim()?.take(40).orEmpty()

    /**
     * Which model a delegation ran on: the matched child chat, else the call's own
     * `model_id`, else what an unrouted call inherits (the parent's model).
     */
    fun subagentModel(input: JsonObject, child: SessionSummary?, children: List<SessionSummary>, inherited: String?): Pair<String, ModelSource>? {
        child?.modelId?.takeIf { it.isNotEmpty() }?.let { return it to ModelSource.CHILD }
        val title = childTitle(input)
        if (title.isNotEmpty()) {
            val named = children.filter { it.title == title }
            named.singleOrNull()?.modelId?.takeIf { it.isNotEmpty() }?.let { return it to ModelSource.CHILD }
        }
        input.str("model_id")?.trim()?.takeIf { it.isNotEmpty() }?.let { return it to ModelSource.REQUESTED }
        if (input["provider_id"] == null && !inherited.isNullOrEmpty()) return inherited to ModelSource.INHERITED
        return null
    }

    /** The child chat a delegation made, by title among this chat's children; null when ambiguous. */
    fun subagentChild(input: JsonObject, children: List<SessionSummary>): SessionSummary? {
        val title = childTitle(input)
        if (title.isEmpty()) return null
        return children.filter { it.title == title }.singleOrNull()
    }

    enum class SubagentStatus { WORKING, WAITING, COMPLETED, FAILED, STOPPED }

    /**
     * A child's status from what the phone knows: the call's result, the
     * child's live activity, else that it waits. A stored reply alone never
     * counts as completion (the desktop's rule).
     */
    fun subagentStatus(output: String?, failed: Boolean, activity: Activity?, parentRunning: Boolean): SubagentStatus = when {
        failed -> SubagentStatus.FAILED
        output != null -> SubagentStatus.COMPLETED
        activity == Activity.NEEDS_YOU -> SubagentStatus.WAITING
        activity == Activity.RUNNING -> SubagentStatus.WORKING
        parentRunning -> SubagentStatus.WORKING
        else -> SubagentStatus.WAITING
    }

    private fun JsonObject.num(k: String): Double? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
}
