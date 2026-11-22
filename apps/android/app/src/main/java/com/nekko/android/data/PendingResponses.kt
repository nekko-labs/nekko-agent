package com.nekko.android.data

import com.nekko.protocol.Approval
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskRequest
import com.nekko.protocol.Channels
import com.nekko.protocol.OfflineFiles
import com.nekko.protocol.PendingInput
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * A phone-local response to one question or approval, bound to the exact request the person saw
 * (decision 0081, the iPhone's ResponseMessage, #2497). [request] is that request's snapshot;
 * [payload] is what goes to the computer: the answers, or Allow / Deny.
 */
data class ResponseMessage(
    val id: String,
    val sessionId: String,
    val callId: String,
    val kind: Kind,
    val request: JsonObject,
    val payload: JsonElement,
    /** What the person said, as the message shows it. */
    val text: String,
    val status: Status = Status.WAITING,
    val error: String? = null,
) {
    enum class Kind(val wire: String) { ANSWER("answer"), APPROVAL("approval") }

    enum class Status(val wire: String) { WAITING("waiting"), SENDING("sending"), FAILED("failed"), STALE("stale"), SENT("sent") }

    /** The original request's identifier, shown under the message. */
    val pendingId: String get() = "${kind.wire}:$callId"

    val unsent: Boolean get() = status != Status.SENT

    /** Retry and Cancel: only while it isn't being sent and hasn't been. */
    val actionable: Boolean get() = unsent && status != Status.SENDING

    fun json(): JsonObject = buildJsonObject {
        put("id", id)
        put("sessionId", sessionId)
        put("callId", callId)
        put("kind", kind.wire)
        put("request", request)
        put("payload", payload)
        put("text", text)
        // A send cut short by the app closing is waiting again at the next start, never "sent".
        put("status", (if (status == Status.SENDING) Status.WAITING else status).wire)
        error?.let { put("error", it) }
    }

    companion object {
        fun from(e: JsonElement?): ResponseMessage? {
            val o = e as? JsonObject ?: return null
            fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            val kind = Kind.entries.firstOrNull { it.wire == str("kind") } ?: return null
            val status = Status.entries.firstOrNull { it.wire == str("status") } ?: return null
            return ResponseMessage(
                id = str("id") ?: return null,
                sessionId = str("sessionId") ?: return null,
                callId = str("callId") ?: return null,
                kind = kind,
                request = o["request"] as? JsonObject ?: return null,
                payload = o["payload"] ?: return null,
                text = str("text") ?: return null,
                status = if (status == Status.SENDING) Status.WAITING else status,
                error = str("error"),
            )
        }

        /** A question's snapshot: what must still be pending, unchanged, for an answer to go. */
        fun request(q: AskRequest): JsonObject = buildJsonObject {
            put("callId", q.callId)
            put("askedAt", q.askedAt)
            put("questions", buildJsonArray {
                q.questions.forEach { x ->
                    add(buildJsonObject {
                        put("id", x.id)
                        put("header", x.header)
                        put("question", x.question)
                        put("multiSelect", x.multiSelect)
                        put("options", buildJsonArray {
                            x.options.forEach { o -> add(buildJsonObject { put("label", o.label); put("description", o.description?.let(::JsonPrimitive) ?: JsonNull) }) }
                        })
                    })
                }
            })
        }

        /** An approval's snapshot: the same call, tool, input, reason and severity. */
        fun request(a: Approval): JsonObject = buildJsonObject {
            put("callId", a.call.id)
            put("name", a.call.name)
            put("input", a.call.input)
            put("reason", a.reason)
            put("severity", a.severity.name.lowercase())
        }
    }
}

/**
 * One computer's answers and one-time approvals, kept until they reach the computer (decision
 * 0081, the iPhone's PendingResponses, #2497). Separate from the prompt outbox.
 *
 * - Before every send, `chat:pending` is read afresh: the message goes only if the same chat still
 *   waits on the same request, unchanged. A replaced or answered request makes it *No longer
 *   pending*, never an answer to something else.
 * - One send at a time; a switch of computer or connection mid-way stops it.
 * - A failure never sends again by itself: Retry does, with the same check. Cancel removes an
 *   unsent message; one being sent can't be recalled.
 * - Always allow, notification and voice actions never come here: they stay online-only.
 *
 * [connection] is the live link to this computer while it is active and online, else null;
 * compared by identity.
 */
class PendingResponses(
    private val files: OfflineFiles?,
    private val connection: () -> Caller?,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private val _items = MutableStateFlow<List<ResponseMessage>>(emptyList())
    val items: StateFlow<List<ResponseMessage>> = _items.asStateFlow()

    private var computerId: String? = null
    @Volatile private var generation = 0
    private val gate = Any()
    private var flushing = false
    private var flushRequested = false

    /** Show [computerId]'s messages (none for null); a send under way for another computer stops. */
    fun load(computerId: String?) = synchronized(gate) {
        generation++
        this.computerId = computerId
        val list = computerId?.let { files?.load(it, FILE) } as? JsonArray
        _items.value = list?.mapNotNull { ResponseMessage.from(it) } ?: emptyList()
    }

    fun messagesFor(sessionId: String): List<ResponseMessage> = _items.value.filter { it.sessionId == sessionId }

    /** The question already has a message: its card steps aside for it. */
    fun contains(sessionId: String, question: AskRequest): Boolean =
        _items.value.any { it.sessionId == sessionId && it.kind == ResponseMessage.Kind.ANSWER && it.request == ResponseMessage.request(question) }

    fun contains(sessionId: String, approval: Approval): Boolean =
        _items.value.any { it.sessionId == sessionId && it.kind == ResponseMessage.Kind.APPROVAL && it.request == ResponseMessage.request(approval) }

    fun answer(sessionId: String, question: AskRequest, answers: List<AskAnswer>) {
        val text = answers.joinToString("\n") { a ->
            val header = question.questions.firstOrNull { it.id == a.questionId }?.header?.takeIf { it.isNotEmpty() }
            val said = (a.labels + listOfNotNull(a.note?.takeIf { it.isNotBlank() })).joinToString(", ")
            listOfNotNull(header, said).joinToString(": ")
        }
        enqueue(sessionId, question.callId, ResponseMessage.Kind.ANSWER, ResponseMessage.request(question), JsonArray(answers.map { it.toJson() }), text)
    }

    fun approve(sessionId: String, approval: Approval, ok: Boolean, words: (Boolean, String) -> String = { yes, tool -> "${if (yes) "Allow" else "Deny"} $tool" }) {
        enqueue(sessionId, approval.call.id, ResponseMessage.Kind.APPROVAL, ResponseMessage.request(approval), JsonPrimitive(ok), words(ok, approval.call.name))
    }

    private fun enqueue(sessionId: String, callId: String, kind: ResponseMessage.Kind, request: JsonObject, payload: JsonElement, text: String) = synchronized(gate) {
        if (computerId == null) return@synchronized
        // A second tap on the same request adds nothing.
        if (_items.value.any { it.sessionId == sessionId && it.kind == kind && it.request == request }) return@synchronized
        _items.update { it + ResponseMessage(newId(), sessionId, callId, kind, request, payload, text) }
        save()
    }

    /** Remove an unsent message; one being sent stays, as it can't be recalled. */
    fun cancel(id: String) = synchronized(gate) {
        _items.update { list -> list.filterNot { it.id == id && it.actionable } }
        save()
    }

    /** Try again, with the same fresh check; the caller then runs [flush]. */
    fun retry(id: String): Boolean = synchronized(gate) {
        val m = _items.value.firstOrNull { it.id == id && it.actionable } ?: return@synchronized false
        update(m.id, ResponseMessage.Status.WAITING, null)
        true
    }

    /** Send what waits, one at a time, each after a fresh check that its request still waits unchanged. */
    suspend fun flush() {
        synchronized(gate) {
            if (flushing) { flushRequested = true; return }
            flushing = true
        }
        val epoch = generation
        try {
            val link = connection() ?: return
            // A failed one goes again too, as on the iPhone: the fresh check below is what makes that
            // safe (an answer that did land, its acknowledgement lost, finds nothing pending).
            for (m in _items.value.filter { it.unsent && it.status != ResponseMessage.Status.STALE }) {
                if (generation != epoch || connection() !== link) return
                if (_items.value.none { it.id == m.id && it.actionable }) continue
                update(m.id, ResponseMessage.Status.SENDING, null)
                try {
                    val raw = link.call(Channels.CHAT_PENDING)
                    if (generation != epoch) return
                    if (connection() !== link) { update(m.id, ResponseMessage.Status.WAITING, null); return }
                    if (raw !is JsonObject) throw IllegalStateException("Could not verify the original request.")
                    val pending = PendingInput.map(raw)[m.sessionId]
                    val current = when (m.kind) {
                        ResponseMessage.Kind.ANSWER -> pending?.question?.let { ResponseMessage.request(it) }
                        ResponseMessage.Kind.APPROVAL -> pending?.approval?.let { ResponseMessage.request(it) }
                    }
                    if (current != m.request) {
                        update(m.id, ResponseMessage.Status.STALE, STALE)
                        continue
                    }
                    val channel = if (m.kind == ResponseMessage.Kind.ANSWER) Channels.CHAT_ANSWER else Channels.TOOL_APPROVE
                    link.call(channel, JsonPrimitive(m.sessionId), JsonPrimitive(m.callId), m.payload)
                    if (generation != epoch) return
                    update(m.id, ResponseMessage.Status.SENT, null)
                } catch (e: CancellationException) {
                    if (generation == epoch) update(m.id, ResponseMessage.Status.WAITING, null)
                    throw e
                } catch (e: Exception) {
                    if (generation != epoch) return
                    update(m.id, ResponseMessage.Status.FAILED, e.message?.takeIf { it.isNotBlank() } ?: "Couldn't send it.")
                }
            }
        } finally {
            val again = synchronized(gate) {
                flushing = false
                val r = flushRequested || generation != epoch
                flushRequested = false
                r
            }
            if (again) flush()
        }
    }

    private fun update(id: String, status: ResponseMessage.Status, error: String?) = synchronized(gate) {
        _items.update { list -> list.map { if (it.id == id) it.copy(status = status, error = error) else it } }
        save()
    }

    private fun save() {
        val id = computerId ?: return
        files?.save(id, FILE, JsonArray(_items.value.map { it.json() }))
    }

    companion object {
        const val FILE = "pending-responses"
        const val STALE = "The original request is no longer pending."
    }
}
