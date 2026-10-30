package com.nekko.android.data

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.TURN_TIMEOUT_MS
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Channels
import com.nekko.protocol.Draft
import com.nekko.protocol.DraftStore
import com.nekko.protocol.OfflineFiles
import com.nekko.protocol.RelayException
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.Session
import com.nekko.protocol.SkillSummary
import com.nekko.protocol.json
import com.nekko.protocol.queuePrompt
import com.nekko.protocol.sendOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.UUID

/** The model, folder, tool policy and effort of a chat started while the computer was out of reach. */
data class NewChatSpec(
    val providerId: String,
    val modelId: String,
    val workspaceId: String? = null,
    val mode: String? = null,
    val effort: String? = null,
) {
    fun json(): JsonObject = buildJsonObject {
        put("providerId", providerId)
        put("modelId", modelId)
        workspaceId?.let { put("workspaceId", it) }
        mode?.let { put("mode", it) }
        effort?.let { put("effort", it) }
    }

    companion object {
        fun from(e: JsonElement?): NewChatSpec? {
            val o = e as? JsonObject ?: return null
            val p = o.string("providerId") ?: return null
            val m = o.string("modelId") ?: return null
            return NewChatSpec(p, m, o.string("workspaceId"), o.string("mode"), o.string("effort"))
        }
    }
}

/**
 * A prompt written while the computer was out of reach (or whose send
 * dropped), waiting to be delivered. Its [id] is the `clientMessageId` the
 * computer remembers, so sending it again after a lost answer never runs it
 * twice. The iPhone's `OutboxItem`, same file shape.
 */
data class OutboxItem(
    val id: String,
    /** The chat it goes to: its id, or `new-<id>` for a chat started offline until the computer creates it. */
    val chatKey: String,
    /** The chat's id on the computer; null only for a new chat not created yet. */
    val chatId: String?,
    val text: String,
    val skill: SkillSummary? = null,
    val images: List<String> = emptyList(),
    /** Set for a chat started offline: what to create it with. */
    val newChat: NewChatSpec? = null,
    val createdAt: Long,
    /** Why the last try didn't get through (it is tried again); null before any try. */
    val lastError: String? = null,
) {
    /** The prompt as one line, as the transcript and the chat list show it. */
    val preview: String
        get() {
            val t = text.replace('\n', ' ').trim()
            if (skill != null) return "/${skill.name}" + if (t.isEmpty()) "" else " $t"
            if (t.isEmpty()) return if (images.size == 1) "1 photo" else "${images.size} photos"
            return t
        }

    /** The draft this prompt becomes when it is taken back (Edit) or refused. */
    fun asDraft(refusal: String? = null): Draft {
        val n = newChat.takeIf { chatId == null }
        return Draft(text, skill, images, n?.providerId, n?.modelId, n?.workspaceId, n?.mode, n?.effort, refusal)
    }

    /** Where that draft goes: the chat's message box, or New chat's while the chat doesn't exist. */
    val draftKey: String get() = chatId ?: DraftStore.NEW_CHAT

    fun json(): JsonObject = buildJsonObject {
        put("id", id)
        put("chatKey", chatKey)
        put("text", text)
        put("createdAt", createdAt)
        chatId?.let { put("chatId", it) }
        skill?.let { put("skill", it.json()) }
        if (images.isNotEmpty()) put("images", JsonArray(images.map(::JsonPrimitive)))
        newChat?.let { put("newChat", it.json()) }
        lastError?.let { put("lastError", it) }
    }

    companion object {
        fun from(e: JsonElement?): OutboxItem? {
            val o = e as? JsonObject ?: return null
            val item = OutboxItem(
                id = o.string("id") ?: return null,
                chatKey = o.string("chatKey") ?: return null,
                chatId = o.string("chatId"),
                text = o.string("text") ?: "",
                skill = SkillSummary.from(o["skill"]),
                images = (o["images"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList(),
                newChat = NewChatSpec.from(o["newChat"]),
                createdAt = (o["createdAt"] as? JsonPrimitive)?.longOrNull ?: 0,
                lastError = o.string("lastError"),
            )
            // Nowhere to deliver it: kept out rather than tried forever.
            return item.takeUnless { it.chatId == null && it.newChat == null }
        }
    }
}

private fun JsonObject.string(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

/** What the outbox shows: what waits, which one is going now, and chats started offline the computer created. */
data class OutboxState(
    val items: List<OutboxItem> = emptyList(),
    /** Prompts an open chat is sending itself right now: on disk, but not shown as waiting. */
    val direct: Set<String> = emptySet(),
    /** The prompt being delivered now: its Edit and Delete wait until it is settled. */
    val sendingId: String? = null,
    /** Chats started offline that the computer has created: their `chatKey` → the chat's id. */
    val created: Map<String, String> = emptyMap(),
) {
    /** What waits to be delivered (not what an open chat is sending right now). */
    val waiting: List<OutboxItem> get() = items.filter { it.id !in direct }

    /** The prompts waiting for one chat (its id, or a new chat's key), oldest first. */
    fun waitingFor(chat: String): List<OutboxItem> = waiting.filter { it.chatKey == chat || it.chatId == chat }

    /** Chats started offline that the computer hasn't created yet, one item each. */
    val pendingNewChats: List<OutboxItem> get() = items.filter { it.chatId == null }.distinctBy { it.chatKey }
}

/**
 * One computer's outbox: prompts written offline (or whose send dropped),
 * saved to disk the moment they are added and delivered in order, one at a
 * time, when the computer is reachable again (on connect, on return to the
 * foreground, on a network change). A chat that is running gets the prompt in
 * its queue. Each prompt carries its `clientMessageId`, and it leaves the
 * outbox only when the computer's copy of the chat lists that id, so a
 * connection lost mid-send means "send again", never "maybe lost" or "twice".
 * When the computer refuses one (chat deleted, no model, …) it goes back to its
 * draft with the reason. Approvals and question answers are never queued. The
 * iPhone's `Outbox` (NekkoKit/Outbox.swift).
 */
class Outbox(
    private val files: OfflineFiles?,
    private val drafts: DraftStore,
    /** The live connection to the active computer, or null while it isn't online. */
    private val caller: () -> Caller?,
    private val defaults: () -> RemoteDefaults,
    private val scope: CoroutineScope,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val now: () -> Long = System::currentTimeMillis,
    private val pollMs: Long = 500,
    private val confirmTimeoutMs: Long = 45_000,
) {
    private val _state = MutableStateFlow(OutboxState())
    val state: StateFlow<OutboxState> = _state.asStateFlow()

    /** Called after each delivery, with the chat's id. */
    @Volatile var onDelivered: ((OutboxItem, String) -> Unit)? = null

    private var computerId: String? = null
    @Volatile private var flushing = false
    /** The last `error` event per chat: the reason a `chat:send` the computer answered was not taken. */
    private val lastErrors = HashMap<String, String>()

    fun newId(): String = newId.invoke()

    /** Show [computerId]'s outbox. */
    @Synchronized
    fun load(computerId: String?) {
        this.computerId = computerId
        lastErrors.clear()
        val v = computerId?.let { files?.load(it, FILE) } as? JsonObject
        val items = if (v != null && (v["v"] as? JsonPrimitive)?.longOrNull == VERSION) {
            (v["items"] as? JsonArray)?.mapNotNull { OutboxItem.from(it) } ?: emptyList()
        } else {
            emptyList()
        }
        _state.value = OutboxState(items = items)
    }

    /**
     * Put a prompt in the outbox, saved before this returns. [chatId] null with
     * [newChat] starts a chat there once the computer is back. [direct]: an
     * open chat is sending it itself; the outbox leaves it alone unless that
     * send drops ([endDirect]).
     */
    @Synchronized
    fun add(
        chatId: String?,
        text: String,
        skill: SkillSummary? = null,
        images: List<String> = emptyList(),
        newChat: NewChatSpec? = null,
        id: String = newId(),
        direct: Boolean = false,
    ): OutboxItem {
        val s = _state.value
        s.items.firstOrNull { it.id == id }?.let { existing ->
            if (!direct) _state.update { it.copy(direct = it.direct - id) }
            return existing
        }
        val item = OutboxItem(id, chatId ?: "new-$id", chatId, text, skill, images, newChat.takeIf { chatId == null }, now())
        _state.update { it.copy(items = it.items + item, direct = if (direct) it.direct + id else it.direct - id) }
        save()
        return item
    }

    /** The open chat's send of [id] got no answer: it waits like any other now. */
    @Synchronized
    fun endDirect(id: String) = _state.update { it.copy(direct = it.direct - id) }

    /** The computer's copy of [chatId] lists these ids: those prompts were delivered. */
    @Synchronized
    fun confirm(chatId: String, ids: List<String>) {
        val done = ids.toSet()
        val s = _state.value
        if (s.items.none { it.chatId == chatId && it.id in done && it.id != s.sendingId }) return
        _state.update { st ->
            st.copy(items = st.items.filterNot { it.chatId == chatId && it.id in done && it.id != st.sendingId }, direct = st.direct - done)
        }
        save()
    }

    /** The computer refused (or took) the open chat's send: it is settled there, not here. */
    @Synchronized
    fun drop(id: String) {
        val had = _state.value.items.any { it.id == id }
        _state.update { s -> s.copy(items = s.items.filterNot { it.id == id }, direct = s.direct - id) }
        if (had) save()
    }

    /** Delete: the prompt is dropped. False while it is being delivered. */
    @Synchronized
    fun remove(id: String): Boolean {
        val s = _state.value
        if (s.sendingId == id || id in s.direct || s.items.none { it.id == id }) return false
        _state.update { st -> st.copy(items = st.items.filterNot { it.id == id }) }
        save()
        return true
    }

    /**
     * Edit: the prompt goes back to its message box's draft (in front of
     * anything typed there). Returns the draft's key, or null while it is
     * being delivered.
     */
    @Synchronized
    fun takeBack(id: String): String? {
        val s = _state.value
        if (s.sendingId == id || id in s.direct) return null
        val item = s.items.firstOrNull { it.id == id } ?: return null
        drafts.handBack(item.draftKey, item.asDraft())
        _state.update { st -> st.copy(items = st.items.filterNot { it.id == id }) }
        save()
        return item.draftKey
    }

    /** The computer's events: an `error` for a chat is the reason a send was turned down. */
    @Synchronized
    fun onEvent(e: AgentEvent) {
        if (e is AgentEvent.Error) lastErrors[e.sessionId] = e.message
    }

    // ---- delivering ----

    internal sealed interface Outcome {
        data class Delivered(val chatId: String) : Outcome
        data class Refused(val reason: String) : Outcome
        /** It didn't get through (no connection, no answer yet): try again later. */
        data class Later(val why: String) : Outcome
        /** Try again now (the chat started running: it goes in the queue). */
        data object Again : Outcome
    }

    /** Deliver in the background (connect, foreground, network change, a new prompt). */
    fun flushSoon() {
        scope.launch { flush() }
    }

    /**
     * Deliver what is waiting, oldest first, one at a time. Stops at the first
     * prompt that can't get through now; the next connect, foreground or
     * network change tries again.
     */
    suspend fun flush() {
        val c = caller() ?: return
        synchronized(this) {
            if (flushing || _state.value.waiting.isEmpty()) return
            flushing = true
        }
        try {
            var again = 0
            while (true) {
                if (caller() !== c) return
                val item = _state.value.waiting.firstOrNull() ?: return
                _state.update { it.copy(sendingId = item.id) }
                when (val outcome = deliver(item, c)) {
                    is Outcome.Delivered -> {
                        val current = _state.value.items.firstOrNull { it.id == item.id } ?: item
                        synchronized(this) {
                            _state.update { s -> s.copy(items = s.items.filterNot { it.id == item.id }) }
                            save()
                        }
                        onDelivered?.invoke(current, outcome.chatId)
                        again = 0
                    }
                    is Outcome.Refused -> {
                        val current = _state.value.items.firstOrNull { it.id == item.id } ?: item
                        synchronized(this) {
                            drafts.handBack(current.draftKey, current.asDraft(refusal = outcome.reason))
                            _state.update { s -> s.copy(items = s.items.filterNot { it.id == item.id }) }
                            save()
                        }
                        again = 0
                    }
                    Outcome.Again -> {
                        if (again < 2) {
                            again++
                        } else {
                            update(item.id) { it.copy(lastError = BUSY) }
                            return
                        }
                    }
                    is Outcome.Later -> {
                        update(item.id) { it.copy(lastError = outcome.why) }
                        return
                    }
                }
            }
        } finally {
            synchronized(this) { flushing = false }
            _state.update { it.copy(sendingId = null) }
        }
    }

    private suspend fun deliver(item: OutboxItem, c: Caller): Outcome {
        var chatId = item.chatId
        if (chatId == null) {
            val spec = item.newChat ?: return Outcome.Refused(NO_CHAT)
            try {
                val made = c.call(Channels.SESSION_CREATE, *listOfNotNull(spec.workspaceId?.let(::JsonPrimitive)).toTypedArray())
                val s = Session.from(made) ?: return Outcome.Refused("Your computer didn’t create the chat.")
                // Saved before anything else, so trying again never makes a second chat.
                synchronized(this) {
                    _state.update { st ->
                        st.copy(
                            items = st.items.map { if (it.chatKey == item.chatKey) it.copy(chatId = s.id) else it },
                            created = st.created + (item.chatKey to s.id),
                        )
                    }
                    save()
                    drafts.move(item.chatKey, s.id)
                }
                chatId = s.id
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return outcome(e)
            }
        }
        val id = chatId ?: return Outcome.Refused(NO_CHAT)
        try {
            item.newChat?.let { spec ->
                // A chat started offline: its model and tool policy (again on a retry, which changes nothing).
                val withMode = buildJsonObject {
                    put("providerId", spec.providerId)
                    put("modelId", spec.modelId)
                    spec.mode?.let { put("mode", it) }
                    spec.effort?.let { put("effort", it) }
                }
                try {
                    c.call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(id), withMode)
                } catch (e: RelayException) {
                    // A mode above the computer's default needs the fingerprint or screen lock, which a
                    // prompt sent from the queue can't ask for: it goes out under the default mode instead.
                    if (spec.mode == null || e.refusal?.code != "proof-required") throw e
                    c.call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(id), JsonObject(withMode - "mode"))
                    update(item.id) { it.copy(lastError = MODE_NOT_RAISED) }
                }
            }
            val session = Session.from(c.call(Channels.SESSION_GET, JsonPrimitive(id))) ?: return Outcome.Refused(DELETED)
            // Sent before (the answer was lost): delivered.
            if (item.id in session.clientMessageIds) return Outcome.Delivered(id)
            if (session.running) {
                val queued = Session.from(c.call(Channels.CHAT_QUEUE, JsonPrimitive(id), queuePrompt(item.text, item.skill, item.images, item.id)))
                if (queued != null && item.id in queued.clientMessageIds) return Outcome.Delivered(id)
                return Outcome.Refused(if (queued == null) DELETED else "Your computer didn’t take this prompt.")
            }
            // A chat started offline runs on the model picked for it; any other on its own, else the default.
            val (p, m) = item.newChat?.let { it.providerId to it.modelId } ?: ChatController.resolveModel(session, defaults())
            if (p == null || m == null) return Outcome.Refused("No model chosen for this chat. Set a default model on your computer.")
            synchronized(this) { lastErrors.remove(id) }
            // `chat:send` answers when the whole turn ends (maybe hours): the prompt counts as delivered once the chat lists its id.
            val send = CompletableDeferred<Throwable?>()
            val job = scope.launch {
                try {
                    c.callWithTimeout(TURN_TIMEOUT_MS, Channels.CHAT_SEND, sendOptions(id, p, m, item.text, item.skill, item.images, item.id))
                    send.complete(null)
                } catch (e: CancellationException) {
                    send.complete(e)
                    throw e
                } catch (e: Exception) {
                    send.complete(e)
                }
            }
            var waited = 0L
            while (true) {
                delay(pollMs)
                waited += pollMs
                val finished = send.isCompleted
                try {
                    val s = Session.from(c.call(Channels.SESSION_GET, JsonPrimitive(id))) ?: return Outcome.Refused(DELETED)
                    if (item.id in s.clientMessageIds) return Outcome.Delivered(id)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (!finished) return outcome(e)
                }
                if (finished) {
                    val error = send.await()
                        // Answered, and the chat doesn't have it: the computer turned it down.
                        ?: return Outcome.Refused(synchronized(this) { lastErrors[id] } ?: "Your computer didn’t start this prompt.")
                    if (error is RelayException && error.fromComputer && error.message.orEmpty().contains("already", ignoreCase = true)) return Outcome.Again
                    return outcome(error)
                }
                if (waited >= confirmTimeoutMs) {
                    return Outcome.Later("No answer from your computer yet.")
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return outcome(e)
        }
    }

    private fun update(id: String, change: (OutboxItem) -> OutboxItem) = synchronized(this) {
        if (_state.value.items.none { it.id == id }) return@synchronized
        _state.update { s -> s.copy(items = s.items.map { if (it.id == id) change(it) else it }) }
        save()
    }

    private fun save() {
        val id = computerId ?: return
        val f = files ?: return
        f.save(id, FILE, buildJsonObject {
            put("v", VERSION)
            put("items", JsonArray(_state.value.items.map { it.json() }))
        })
    }

    companion object {
        const val FILE = "outbox"
        const val VERSION = 1L

        /** A refusal when the computer answered with an error; otherwise try again later. */
        internal fun outcome(e: Throwable): Outcome {
            if (e is RelayException && e.fromComputer) return Outcome.Refused(if (e.refusedClientMessageId) NEEDS_UPDATE else e.message.orEmpty())
            return Outcome.Later(e.message ?: "Couldn’t reach your computer.")
        }

        private const val NO_CHAT = "This prompt has no chat to go to."
        private const val DELETED = "This chat was deleted on your computer."
        const val BUSY = "Your computer is busy with this chat. It will be sent when it’s free."

        /**
         * A computer from before exactly-once delivery: the outbox never sends
         * without the id (a resend could run twice), so the prompt goes back to
         * its draft, saying why.
         */
        const val NEEDS_UPDATE = "Update Nekko Agent on your computer to send prompts written offline. Send it again from here."

        /** A chat started offline asked for fewer approvals than the computer's default. */
        const val MODE_NOT_RAISED =
            "Sent with your computer’s default approvals: allowing fewer needs your fingerprint or screen lock, which a queued prompt can’t ask for. Change it in the chat."
    }
}
