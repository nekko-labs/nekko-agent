package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * A chat's audit trail as `audit:read` returns it (crates/nekkod/src/audit.rs):
 * what the agent did and who allowed it, never what it read or sent. The
 * desktop shows the same trail (apps/desktop/.../auditTrailLines.ts).
 */
object Audit {
    /** Who answered: `this computer`, `phone`, `paired computer`, `telegram`, `yolo`, … */
    data class By(val via: String, val device: String? = null, val deviceName: String? = null) {
        /** The device's current name, else null; a device no longer paired has its id only. */
        val name: String? get() = deviceName?.trim()?.ifEmpty { null }
    }

    sealed interface Event {
        val at: Long
        val turnId: String
    }

    data class Turn(override val at: Long, override val turnId: String, val mode: String?, val model: String?, val claudeCode: Boolean) : Event

    /** [touched] is the value-free detail: a host, a path, a program, an MCP server. */
    data class Tool(
        override val at: Long,
        override val turnId: String,
        val tool: String,
        val isError: Boolean,
        val ms: Long?,
        val touched: List<String>,
        val recipients: Int,
    ) : Event

    enum class Answer { APPROVED, DENIED, UNANSWERED }

    data class Approval(override val at: Long, override val turnId: String, val tool: String?, val severity: String?, val answer: Answer, val by: By?) : Event

    /** A Claude Code permission the approval bridge answered. */
    data class Permission(override val at: Long, override val turnId: String, val tool: String, val decision: String, val by: By?) : Event

    /** The chat read content from outside this computer, through [by]. */
    data class Taint(override val at: Long, override val turnId: String, val by: String) : Event

    /** What the Privacy Shield hid, by kind, in the order sent. */
    data class Redactions(override val at: Long, override val turnId: String, val counts: List<Pair<String, Int>>) : Event

    /** A turn and the events it wrote, oldest first. */
    data class TurnGroup(val turnId: String, val start: Turn?, val events: List<Event>)

    /** The trail, oldest first; an event it doesn't know is skipped. */
    fun parse(json: JsonElement?): List<Event> = (json as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.let(::event) }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
    private fun by(json: JsonElement?): By? = (json as? JsonObject)?.let { o -> o.str("via")?.let { By(it, o.str("device"), o.str("deviceName")) } }

    private fun event(o: JsonObject): Event? {
        val at = o.long("at") ?: return null
        val turnId = o.str("turnId").orEmpty()
        return when (o.str("type")) {
            "turn" -> Turn(at, turnId, o.str("mode"), o.str("model"), (o["claudeCode"] as? JsonPrimitive)?.booleanOrNull == true)
            "tool" -> {
                val d = o["detail"] as? JsonObject ?: JsonObject(emptyMap())
                val touched = listOfNotNull(d.str("host"), d.str("path"), d.str("program"), d.str("action"), d.str("server")?.let { "server $it" })
                Tool(at, turnId, o.str("tool") ?: return null, (o["isError"] as? JsonPrimitive)?.booleanOrNull == true, o.long("ms"), touched, d.long("recipients")?.toInt() ?: 0)
            }
            "approval" -> {
                val answer = when (o.str("answer")) { "approved" -> Answer.APPROVED; "denied" -> Answer.DENIED; else -> Answer.UNANSWERED }
                Approval(at, turnId, o.str("tool"), o.str("severity"), answer, by(o["by"]))
            }
            "permission" -> Permission(at, turnId, o.str("tool") ?: return null, o.str("decision").orEmpty(), by(o["by"]))
            "taint" -> Taint(at, turnId, o.str("by") ?: return null)
            "redactions" -> Redactions(
                at, turnId,
                (o["counts"] as? JsonObject).orEmpty().mapNotNull { (k, v) -> (v as? JsonPrimitive)?.longOrNull?.let { k to it.toInt() } },
            )
            else -> null
        }
    }

    /** Group by turn, keeping the order written. */
    fun group(trail: List<Event>): List<TurnGroup> {
        val turns = mutableListOf<Pair<Turn?, MutableList<Event>>>()
        val ids = mutableListOf<String>()
        for (e in trail) {
            if (turns.isEmpty() || ids.last() != e.turnId || e is Turn) {
                turns += (e as? Turn) to mutableListOf()
                ids += e.turnId
            }
            if (e !is Turn) turns.last().second += e
        }
        return turns.mapIndexed { i, (start, events) -> TurnGroup(ids[i], start, events) }
    }

    /** Only the decisions: approvals and Claude Code permissions. */
    fun isDecision(e: Event): Boolean = e is Approval || e is Permission

    /** What the sheet shows: newest turn first, only the decisions when [onlyDecisions]. */
    fun shown(trail: List<Event>, onlyDecisions: Boolean): List<TurnGroup> = group(trail)
        .map { if (onlyDecisions) it.copy(events = it.events.filter(::isDecision)) else it }
        .filter { !onlyDecisions || it.events.isNotEmpty() }
        .reversed()

    /** How a mark reads: approved, denied or YOLO, outside content. */
    enum class Tone { NEUTRAL, GOOD, WARN, BAD }

    fun tone(e: Event): Tone = when (e) {
        is Turn -> Tone.NEUTRAL
        is Tool -> if (e.isError) Tone.WARN else Tone.NEUTRAL
        is Approval -> when (e.answer) {
            Answer.APPROVED -> if (e.by?.via == "yolo") Tone.WARN else Tone.GOOD
            Answer.DENIED -> Tone.BAD
            Answer.UNANSWERED -> Tone.NEUTRAL
        }
        is Permission -> when (e.decision) { "denied" -> Tone.BAD; "approved" -> Tone.GOOD; else -> Tone.NEUTRAL }
        is Taint -> Tone.WARN
        is Redactions -> Tone.GOOD
    }
}
