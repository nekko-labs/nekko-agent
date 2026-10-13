package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * The slice of the host's IPC surface the phone uses. Channel names mirror
 * `packages/shared/src/ipc.ts` and are pinned by `WireTest` against that file.
 *
 * Decoding is deliberately hand-written over [JsonElement] narrow projections:
 * the host sends far more than the phone reads, adds fields over time, and
 * `providers:list` / `settings:get` carry secrets that must never be decoded
 * into app state.
 */
object Channels {
    const val SETTINGS_GET = "settings:get"
    const val PROVIDERS_LIST = "providers:list"
    const val MODELS_LIST = "models:list"
    const val SESSIONS_SUMMARIES = "sessions:summaries"
    const val SESSION_CREATE = "session:create"
    const val SESSION_GET = "session:get"
    const val SESSION_SET_OPTIONS = "session:setOptions"
    const val CHAT_SEND = "chat:send"
    const val CHAT_ABORT = "chat:abort"
    const val CHAT_QUEUE = "chat:queue"
    const val CHAT_PENDING = "chat:pending"
    const val CHAT_ANSWER = "chat:answer"
    const val TOOL_APPROVE = "tool:approve"
    const val WORKSPACE_LIST = "workspace:list"
    const val APP_INFO = "app:info"

    val ALL = listOf(
        SETTINGS_GET, PROVIDERS_LIST, MODELS_LIST, SESSIONS_SUMMARIES, SESSION_CREATE, SESSION_GET,
        SESSION_SET_OPTIONS, CHAT_SEND, CHAT_ABORT, CHAT_QUEUE, CHAT_PENDING, CHAT_ANSWER, TOOL_APPROVE,
        WORKSPACE_LIST, APP_INFO,
    )
}

object Events {
    const val AGENT_EVENT = "agent:event"
}

/** `sendChat` errors unless the session names a concrete, enabled model. */
const val AUTO_MODEL_ID = "__auto__"

val WireJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

internal fun JsonElement?.obj(): JsonObject? = this as? JsonObject
internal fun JsonElement?.arr(): JsonArray? = this as? JsonArray
internal fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
internal fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }
internal fun JsonObject.dbl(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull
internal fun JsonObject.bool(k: String): Boolean = (this[k] as? JsonPrimitive)?.booleanOrNull == true
internal fun JsonObject.isSet(k: String): Boolean = this[k] != null && this[k] !is JsonNull

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

data class ToolCall(val id: String, val name: String, val input: JsonObject) {
    companion object {
        fun from(e: JsonElement?): ToolCall? {
            val o = e.obj() ?: return null
            return ToolCall(o.str("id") ?: return null, o.str("name") ?: return null, o["input"].obj() ?: JsonObject(emptyMap()))
        }
    }
}

data class ToolResult(val toolCallId: String, val output: String, val isError: Boolean) {
    companion object {
        fun from(e: JsonElement?): ToolResult? {
            val o = e.obj() ?: return null
            val output = when (val v = o["output"]) {
                is JsonPrimitive -> v.contentOrNull ?: ""
                null, JsonNull -> ""
                else -> v.toString()
            }
            return ToolResult(o.str("toolCallId") ?: return null, output, o.bool("isError"))
        }
    }
}

data class ChatMessage(
    val id: String,
    val role: String,
    val content: String,
    val reasoning: String? = null,
    val createdAt: Long? = null,
    val imageCount: Int = 0,
    val skill: Pair<String, String>? = null,
    val toolCalls: List<ToolCall> = emptyList(),
    val toolResult: ToolResult? = null,
    val interrupted: Boolean = false,
) {
    companion object {
        fun from(e: JsonElement?): ChatMessage? {
            val o = e.obj() ?: return null
            val skill = o["skill"].obj()?.let { s -> (s.str("name") ?: return@let null) to (s.str("input") ?: "") }
            return ChatMessage(
                id = o.str("id") ?: return null,
                role = o.str("role") ?: return null,
                content = o.str("content") ?: "",
                reasoning = o.str("reasoning"),
                createdAt = o.long("createdAt"),
                imageCount = o["images"].arr()?.size ?: 0,
                skill = skill,
                toolCalls = o["toolCalls"].arr()?.mapNotNull { ToolCall.from(it) } ?: emptyList(),
                toolResult = ToolResult.from(o["toolResult"]),
                interrupted = o.bool("interrupted"),
            )
        }
    }
}

data class Session(
    val id: String,
    val title: String,
    val providerId: String?,
    val modelId: String?,
    val workspaceId: String?,
    val messages: List<ChatMessage>,
    val queue: List<String>,
    val updatedAt: Long,
) {
    companion object {
        fun from(e: JsonElement?): Session? {
            val o = e.obj() ?: return null
            return Session(
                id = o.str("id") ?: return null,
                title = o.str("title") ?: "",
                providerId = o.str("providerId"),
                modelId = o.str("modelId"),
                workspaceId = o.str("workspaceId"),
                messages = o["messages"].arr()?.mapNotNull { ChatMessage.from(it) } ?: emptyList(),
                // Queue entries may be plain strings or {text, images, skill}; the phone shows text.
                queue = o["queue"].arr()?.mapNotNull { q ->
                    (q as? JsonPrimitive)?.contentOrNull ?: q.obj()?.str("text")
                } ?: emptyList(),
                updatedAt = o.long("updatedAt") ?: 0,
            )
        }
    }
}

data class SessionSummary(
    val id: String,
    val title: String,
    val updatedAt: Long,
    val modelId: String?,
    val lastReplyText: String?,
    val firstUserText: String?,
    val archived: Boolean,
    val parentSessionId: String?,
    val taskId: String?,
    val trainingRunId: String?,
) {
    /** Real, top-level, unarchived chats: what the phone's list shows. */
    val isVisible: Boolean get() = !archived && parentSessionId == null && taskId == null && trainingRunId == null

    companion object {
        fun from(e: JsonElement?): SessionSummary? {
            val o = e.obj() ?: return null
            return SessionSummary(
                id = o.str("id") ?: return null,
                title = o.str("title") ?: "",
                updatedAt = o.long("updatedAt") ?: 0,
                modelId = o.str("modelId"),
                lastReplyText = o.str("lastReplyText"),
                firstUserText = o.str("firstUserText"),
                archived = o.isSet("archivedAt") && o.long("archivedAt") != 0L,
                parentSessionId = o.str("parentSessionId"),
                taskId = o.str("taskId"),
                trainingRunId = o.str("trainingRunId"),
            )
        }

        fun visible(list: JsonElement?): List<SessionSummary> =
            list.arr()?.mapNotNull { from(it) }?.filter { it.isVisible }?.sortedByDescending { it.updatedAt } ?: emptyList()
    }
}

/** A provider as the phone keeps it: never the API key, base URL or token reference. */
data class PublicProvider(val id: String, val kind: String, val label: String, val enabled: Boolean) {
    companion object {
        fun list(e: JsonElement?): List<PublicProvider> = e.arr()?.mapNotNull { p ->
            val o = p.obj() ?: return@mapNotNull null
            PublicProvider(o.str("id") ?: return@mapNotNull null, o.str("kind") ?: "", o.str("label") ?: o.str("id")!!, o.bool("enabled"))
        } ?: emptyList()
    }
}

/** The settings fields the phone reads (`settings:get` returns far more, including secrets). */
data class RemoteDefaults(val defaultProviderId: String? = null, val defaultModelId: String? = null) {
    companion object {
        fun from(e: JsonElement?): RemoteDefaults {
            val o = e.obj() ?: return RemoteDefaults()
            return RemoteDefaults(o.str("defaultProviderId"), o.str("defaultModelId"))
        }
    }
}

data class ModelInfo(val id: String, val providerId: String, val name: String, val loaded: Boolean) {
    companion object {
        fun list(e: JsonElement?): List<ModelInfo> = e.arr()?.mapNotNull { m ->
            val o = m.obj() ?: return@mapNotNull null
            val id = o.str("id") ?: return@mapNotNull null
            ModelInfo(id, o.str("providerId") ?: "", o.str("name")?.ifBlank { null } ?: id, o.bool("loaded"))
        } ?: emptyList()
    }
}

data class WorkspaceFolder(val id: String, val name: String) {
    companion object {
        fun list(e: JsonElement?): List<WorkspaceFolder> = e.arr()?.mapNotNull { w ->
            val o = w.obj() ?: return@mapNotNull null
            WorkspaceFolder(o.str("id") ?: return@mapNotNull null, o.str("name") ?: "Folder")
        } ?: emptyList()
    }
}

data class AppInfo(val version: String?, val platform: String?) {
    companion object {
        fun from(e: JsonElement?): AppInfo = e.obj().let { AppInfo(it?.str("version"), it?.str("platform")) }
    }
}

// ---------------------------------------------------------------------------
// Ask / approvals
// ---------------------------------------------------------------------------

data class AskOption(val label: String, val description: String?)
data class AskQuestion(val id: String, val header: String, val question: String, val options: List<AskOption>, val multiSelect: Boolean)
data class AskRequest(val callId: String, val questions: List<AskQuestion>, val askedAt: Long) {
    companion object {
        fun from(e: JsonElement?): AskRequest? {
            val o = e.obj() ?: return null
            val qs = o["questions"].arr()?.mapNotNull { q ->
                val qo = q.obj() ?: return@mapNotNull null
                AskQuestion(
                    id = qo.str("id") ?: return@mapNotNull null,
                    header = qo.str("header") ?: "",
                    question = qo.str("question") ?: "",
                    options = qo["options"].arr()?.mapNotNull { op ->
                        op.obj()?.let { oo -> oo.str("label")?.let { AskOption(it, oo.str("description")) } }
                    } ?: emptyList(),
                    multiSelect = qo.bool("multiSelect"),
                )
            } ?: emptyList()
            return AskRequest(o.str("callId") ?: return null, qs, o.long("askedAt") ?: 0)
        }
    }
}

/** The label every question carries for an answer that isn't on the list (shared/ask.ts). */
const val ASK_OTHER_LABEL = "Something else"

data class AskAnswer(val questionId: String, val labels: List<String>, val note: String? = null) {
    fun toJson(): JsonObject = buildJsonObject {
        put("questionId", questionId)
        put("labels", buildJsonArray { labels.forEach { add(JsonPrimitive(it)) } })
        note?.takeIf { it.isNotBlank() }?.let { put("note", it) }
    }
}

enum class Severity { LOW, MEDIUM, HIGH;
    companion object { fun parse(s: String?) = when (s) { "high" -> HIGH; "medium" -> MEDIUM; else -> LOW } }
}

data class Approval(val call: ToolCall, val reason: String, val severity: Severity)

data class PendingInput(val sessionId: String, val approval: Approval?, val question: AskRequest?) {
    companion object {
        /** `chat:pending` → `Record<sessionId, PendingInput>`. */
        fun map(e: JsonElement?): Map<String, PendingInput> = e.obj()?.mapNotNull { (sid, v) ->
            val o = v.obj() ?: return@mapNotNull null
            val a = o["approval"].obj()?.let { ao ->
                ToolCall.from(ao["call"])?.let { Approval(it, ao.str("reason") ?: "", Severity.parse(ao.str("severity"))) }
            }
            sid to PendingInput(sid, a, AskRequest.from(o["question"]))
        }?.toMap() ?: emptyMap()
    }
}

// ---------------------------------------------------------------------------
// Agent events (shared/chat.ts AgentEvent); unknown types decode to Other.
// ---------------------------------------------------------------------------

sealed interface AgentEvent {
    val sessionId: String

    data class Text(override val sessionId: String, val delta: String) : AgentEvent
    data class Reasoning(override val sessionId: String, val delta: String) : AgentEvent
    data class ToolCallStarted(override val sessionId: String, val call: ToolCall) : AgentEvent
    data class ApprovalRequired(override val sessionId: String, val approval: Approval) : AgentEvent
    data class ToolResultReady(override val sessionId: String, val result: ToolResult) : AgentEvent
    data class Question(override val sessionId: String, val request: AskRequest) : AgentEvent
    data class QuestionResolved(override val sessionId: String, val callId: String) : AgentEvent
    data class Usage(override val sessionId: String, val outputTokens: Long, val outputMs: Long?) : AgentEvent
    data class Retry(override val sessionId: String) : AgentEvent
    data class Done(override val sessionId: String, val messageId: String?) : AgentEvent
    data class Error(override val sessionId: String, val message: String) : AgentEvent
    data class SessionMeta(override val sessionId: String) : AgentEvent
    data class Other(override val sessionId: String, val type: String) : AgentEvent

    companion object {
        fun from(e: JsonElement?): AgentEvent? {
            val o = e.obj() ?: return null
            val sid = o.str("sessionId") ?: return null
            return when (val t = o.str("type")) {
                "text" -> Text(sid, o.str("delta") ?: "")
                "reasoning" -> Reasoning(sid, o.str("delta") ?: "")
                "tool_call" -> ToolCallStarted(sid, ToolCall.from(o["call"]) ?: return null)
                "tool_approval_required" -> ApprovalRequired(
                    sid, Approval(ToolCall.from(o["call"]) ?: return null, o.str("reason") ?: "", Severity.parse(o.str("severity"))),
                )
                "tool_result" -> ToolResultReady(sid, ToolResult.from(o["result"]) ?: return null)
                "question" -> Question(sid, AskRequest.from(o["request"]) ?: return null)
                "question_resolved" -> QuestionResolved(sid, o.str("callId") ?: return null)
                "usage" -> Usage(sid, o.long("outputTokens") ?: 0, o.long("outputMs"))
                "retry" -> Retry(sid)
                "done" -> Done(sid, o.str("messageId"))
                "error" -> Error(sid, o.str("message") ?: "Something went wrong.")
                "session_meta" -> SessionMeta(sid)
                null -> null
                else -> Other(sid, t)
            }
        }
    }
}

/** `chat:send` argument (SendOptions). Only the fields the phone uses. */
fun sendOptions(sessionId: String, providerId: String, modelId: String, text: String): JsonObject = buildJsonObject {
    put("sessionId", sessionId)
    put("providerId", providerId)
    put("modelId", modelId)
    put("text", text)
}
