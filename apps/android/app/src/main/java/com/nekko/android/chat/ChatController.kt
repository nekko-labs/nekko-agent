package com.nekko.android.chat

import com.nekko.android.data.Caller
import com.nekko.android.util.plainText
import com.nekko.protocol.AUTO_MODEL_ID
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Approval
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskRequest
import com.nekko.protocol.Block
import com.nekko.protocol.Channels
import com.nekko.protocol.ContextUsage
import com.nekko.protocol.DenyReason
import com.nekko.protocol.Effort
import com.nekko.protocol.LiveTurn
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.PendingInput
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.Session
import com.nekko.protocol.SkillSummary
import com.nekko.protocol.Transcript
import com.nekko.protocol.queuePrompt
import com.nekko.protocol.sendOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.contentOrNull
import kotlinx.coroutines.withContext
import kotlinx.coroutines.NonCancellable
import com.nekko.protocol.RelayException
import com.nekko.protocol.QueuedPrompt
import com.nekko.protocol.PcSettings

/** A turn can run for hours (long agent runs); don't time the request out. */
const val TURN_TIMEOUT_MS: Long = 12L * 60 * 60 * 1000

/** What [ChatController] owns: the saved session plus the live overlay. */
data class ChatState(
    val session: Session? = null,
    val turn: LiveTurn = LiveTurn(),
    val loadError: String? = null,
    /** The computer's runnable skills, re-read with the chat; empty until loaded or on an older computer. */
    val skills: List<SkillSummary> = emptyList(),
    /** The computer's count of the chat's context window (`context:preview`); null until it answers or on an older computer. */
    val context: ContextUsage? = null,
)

/** Connection facts the chat screen reads from the computers store. */
data class ChatEnv(
    val conn: RelayState = RelayState.IDLE,
    val denied: DenyReason? = null,
    val defaults: RemoteDefaults = RemoteDefaults(),
    val computerName: String = "your computer",
    /** The computer's model lists by provider, for the model's name. */
    val models: Map<String, List<ModelInfo>> = emptyMap(),
)

/** Everything the chat screen renders. Pure projection of [ChatState] + [ChatEnv]. */
data class ChatUi(
    val ready: Boolean,
    val title: String,
    val subtitle: String,
    val blocks: List<Block>,
    val running: Boolean,
    val approval: Approval?,
    val question: AskRequest?,
    val error: String?,
    val blocked: String?,
    val queued: List<String>,
    /** The queue as the computer holds it (what an edit is checked against), same order as [queued]. */
    val queuedPrompts: List<QueuedPrompt> = emptyList(),
    val rate: Double?,
    val skills: List<SkillSummary> = emptyList(),
    /** Older messages the computer kept back from the phone; they stay on the computer. */
    val omittedMessages: Int = 0,
    val providerId: String? = null,
    val modelId: String? = null,
    /** The model's name from the computer's list, else its id. */
    val modelName: String? = null,
    /** The chat's own effort; null follows the computer's setting. */
    val effort: Effort? = null,
    /** The chat's own tool policy; null follows the computer's default. */
    val mode: PcSettings.ChatMode? = null,
    val context: ContextUsage? = null,
    /** [context]'s count plus about one token per four characters streamed this turn; null until the computer answers. */
    val contextTokens: Long? = null,
)

/**
 * A chat that lives on the computer: the logic of `apps/mobile/src/chat/useRemoteChat.ts`
 * without Android. The saved session is the source of truth; while a turn
 * runs, `agent:event`s fold into a live overlay, and the session is re-read
 * when the turn ends (or after a reconnect, in case events were missed while
 * the phone was asleep).
 */
class ChatController(
    val sessionId: String,
    private val caller: Caller,
    private val scope: CoroutineScope,
    private val env: () -> ChatEnv,
    private val now: () -> Long = System::currentTimeMillis,
    /** Each prompt's `clientMessageId`: a repeat of it is taken once only. */
    private val newId: () -> String = { java.util.UUID.randomUUID().toString() },
) {
    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    suspend fun reload() {
        try {
            val (raw, pending) = coroutineScope {
                val s = async { caller.call(Channels.SESSION_GET, JsonPrimitive(sessionId)) }
                val p = async {
                    try {
                        PendingInput.map(caller.call(Channels.CHAT_PENDING))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        emptyMap()
                    }
                }
                s.await() to p.await()
            }
            scope.launch { loadSkills() }
            scope.launch { loadContext() }
            val session = Session.from(raw)
            if (session == null) {
                _state.update { it.copy(loadError = "This chat was deleted on your computer.") }
                return
            }
            val mine = pending[sessionId]
            _state.update { st ->
                val t = st.turn
                st.copy(
                    session = session,
                    loadError = null,
                    // Mid-turn the overlay keeps streaming; mergeLive hides what the re-read
                    // session already holds. After the turn the session has it all.
                    turn = t.copy(
                        blocks = if (t.running) t.blocks else emptyList(),
                        approval = mine?.approval,
                        question = mine?.question,
                        running = t.running || mine != null,
                    ),
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(loadError = e.message ?: "Could not load this chat.") }
        }
    }

    /**
     * The computer's skills, read again each time the chat loads, so what was
     * installed or removed there shows up here. A computer that doesn't serve
     * them (older version) or a failed read keeps the list it had.
     */
    suspend fun loadSkills() {
        try {
            val list = SkillSummary.list(caller.call(Channels.SKILLS_RUNNABLE))
            _state.update { it.copy(skills = list) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep the previous list; the menu just offers what it last knew.
        }
    }

    /**
     * The chat's context totals, the same estimate as the desktop's gauge, read with
     * the chat and after each turn. An older computer refuses it; the ring stays empty.
     */
    suspend fun loadContext() {
        try {
            val c = ContextUsage.from(caller.call(Channels.CONTEXT_PREVIEW, JsonPrimitive(sessionId))) ?: return
            _state.update { it.copy(context = c) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep the last count.
        }
    }

    /**
     * Change this chat's model or effort on the computer, then re-read it. The computer
     * takes only a level, so the phone can't go back to "computer default". Throws so
     * the sheet can say why.
     */
    suspend fun setOptions(providerId: String? = null, modelId: String? = null, effort: Effort? = null) {
        val patch = buildJsonObject {
            providerId?.let { put("providerId", it) }
            modelId?.let { put("modelId", it) }
            effort?.let { put("effort", it.wire) }
        }
        if (patch.isEmpty()) return
        caller.call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(sessionId), patch)
        reload()
    }

    /** Fold one event; returns true when the caller should [reload]. */
    fun onEvent(e: AgentEvent): Boolean {
        if (e.sessionId != sessionId) return false
        _state.update { it.copy(turn = Transcript.apply(it.turn, e)) }
        // Re-read the saved transcript when the turn ends, then drop the overlay it replaces.
        return e is AgentEvent.Done || e is AgentEvent.Error || e is AgentEvent.SessionMeta
    }

    /** Throws when the prompt couldn't be sent, so the composer can keep the text. */
    suspend fun send(text: String, skill: SkillSummary? = null, images: List<String> = emptyList()) {
        val id = newId()
        if (_state.value.turn.running) {
            // Same as the desktop: a prompt sent mid-run waits its turn.
            val s = Session.from(callWithId(Channels.CHAT_QUEUE, id) { cid -> listOf(JsonPrimitive(sessionId), queuePrompt(text, skill, images, cid)) })
            if (s != null) _state.update { it.copy(session = s) }
            return
        }
        val (providerId, modelId) = model()
        if (providerId == null || modelId == null) throw IllegalStateException("Choose a default model on your computer first.")
        val at = now()
        _state.update {
            val shown = if (skill == null) text else "/${skill.name} $text".trim()
            it.copy(turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-$at", shown, at, images))))
        }
        // Resolves only when the whole turn ends; the events carry the progress.
        scope.launch {
            try {
                callWithId(Channels.CHAT_SEND, id, TURN_TIMEOUT_MS) { cid -> listOf(sendOptions(sessionId, providerId, modelId, text, skill, images, cid)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(turn = it.turn.copy(running = false, error = e.message ?: "Couldn’t send that.")) }
            }
        }
    }

    /**
     * [channel] with the prompt's `clientMessageId`. A computer from before
     * exactly-once delivery refuses the unknown key: then the prompt goes as
     * before, without it.
     */
    private suspend fun callWithId(channel: String, id: String, timeoutMs: Long? = null, args: (String?) -> List<JsonElement>): JsonElement {
        suspend fun call(cid: String?) = args(cid).toTypedArray().let { a ->
            if (timeoutMs == null) caller.call(channel, *a) else caller.callWithTimeout(timeoutMs, channel, *a)
        }
        return try {
            call(id)
        } catch (e: RelayException) {
            if (!e.refusedClientMessageId) throw e
            call(null)
        }
    }

    fun stop() {
        scope.launch {
            try {
                caller.call(Channels.CHAT_ABORT, JsonPrimitive(sessionId))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Nothing to show: the turn either ends or keeps streaming.
            }
        }
    }

    suspend fun approve(ok: Boolean) {
        val a = _state.value.turn.approval ?: return
        _state.update { it.copy(turn = it.turn.copy(approval = null)) }
        caller.call(Channels.TOOL_APPROVE, JsonPrimitive(sessionId), JsonPrimitive(a.call.id), JsonPrimitive(ok))
    }

    suspend fun answer(answers: List<AskAnswer>) {
        val q = _state.value.turn.question ?: return
        _state.update { it.copy(turn = it.turn.copy(question = null)) }
        caller.call(Channels.CHAT_ANSWER, JsonPrimitive(sessionId), JsonPrimitive(q.callId), JsonArray(answers.map { it.toJson() }))
    }

    // ---- the queue and forks (AN-29, the iPhone's IO-22 / IO-23) ----

    /**
     * Change the queued prompt at [index] before it runs, or remove it ([text]
     * null). The computer refuses when that prompt no longer reads [expect] (it
     * started, or the queue moved). Never offline: an edit made then could land
     * after the prompt ran. The queue is read again either way.
     */
    suspend fun editQueued(index: Int, expect: String, text: String?) {
        if (env().conn != RelayState.ONLINE) throw RelayException(RECONNECT_TO_EDIT_QUEUE)
        try {
            caller.call(Channels.CHAT_EDIT_QUEUED, JsonPrimitive(sessionId), JsonPrimitive(index), QueuedPrompt.edit(expect, text))
        } finally {
            withContext(NonCancellable) { reload() }
        }
    }

    /** Where a fork from [block] cuts the chat, and what goes back in the new chat's message box. */
    data class ForkPoint(val before: String?, val seed: String?)

    /**
     * A prompt: the new chat ends before it, with that prompt to edit and send
     * (the desktop's split). A reply or step: the new chat keeps everything up
     * to the next prompt. Null for a block not saved yet (a reply streaming).
     */
    fun forkPoint(block: Block): ForkPoint? {
        val messages = _state.value.session?.messages ?: return null
        val at = messages.indexOfFirst { m -> m.id == block.id || m.toolCalls.any { it.id == block.id } }
        if (at < 0) return null
        val m = messages[at]
        if (block is Block.User && m.role == "user") {
            return ForkPoint(m.id, m.skill?.let { (name, input) -> "/$name $input".trim() } ?: m.content)
        }
        return ForkPoint(messages.drop(at + 1).firstOrNull { it.role == "user" }?.id, null)
    }

    /** The saved messages' and tool calls' ids, kept per session: whether a block can be forked, cheaply. */
    private var savedIds: Pair<Session?, Set<String>> = null to emptySet()

    /** Whether [block] is saved on the computer (not a reply still streaming), so the chat can be forked from it. */
    fun isSaved(block: Block): Boolean {
        val session = _state.value.session ?: return false
        if (savedIds.first !== session) {
            savedIds = session to session.messages.flatMapTo(HashSet()) { m -> listOf(m.id) + m.toolCalls.map { it.id } }
        }
        return block.id in savedIds.second
    }

    /** Fork this chat on the computer from [block]: the new chat's id and the prompt for its message box. */
    suspend fun fork(block: Block): Pair<String, String?> {
        val point = forkPoint(block) ?: throw RelayException("Wait for this reply to finish, then fork.")
        val args = listOfNotNull(JsonPrimitive(sessionId), point.before?.let(::JsonPrimitive))
        val made = caller.call(Channels.SESSION_FORK, *args.toTypedArray()) as? kotlinx.serialization.json.JsonObject
        val id = made?.get("id")?.let { (it as? JsonPrimitive)?.contentOrNull } ?: throw RelayException("Your computer didn’t fork the chat.")
        return id to point.seed?.takeIf { it.isNotEmpty() }
    }

    private fun model(): Pair<String?, String?> = resolveModel(_state.value.session, env().defaults)

    companion object {
        /** Editing the computer's queue needs the computer. */
        const val RECONNECT_TO_EDIT_QUEUE = "Reconnect to change the queue. The computer may start the prompt meanwhile."

        /** The session's own model, else the computer's default (never the `__auto__` sentinel). */
        fun resolveModel(session: Session?, defaults: RemoteDefaults): Pair<String?, String?> {
            val providerId = session?.providerId ?: defaults.defaultProviderId
            val modelId = session?.modelId?.takeIf { it != AUTO_MODEL_ID } ?: defaults.defaultModelId
            return providerId to modelId
        }

        /** Mid-turn the computer's count lags: add about one token per four characters streamed, as the desktop's live gauge does. */
        fun liveTokens(context: ContextUsage?, turn: LiveTurn): Long? {
            val used = context?.usedTokens ?: return null
            if (!turn.running) return used
            val chars = turn.blocks.sumOf { b ->
                when (b) {
                    is Block.User -> b.text.length
                    is Block.Assistant -> b.text.length + (b.reasoning?.length ?: 0)
                    is Block.Tool -> b.label.length + (b.output?.length ?: 0)
                }
            }
            return used + (chars + 3) / 4
        }

        fun project(state: ChatState, env: ChatEnv): ChatUi {
            val (providerId, modelId) = resolveModel(state.session, env.defaults)
            val blocked = when {
                env.conn == RelayState.DENIED || env.denied != null -> "This phone is no longer paired."
                env.conn != RelayState.ONLINE ->
                    "${env.computerName} is ${if (env.conn == RelayState.OFFLINE) "offline" else "reconnecting"}."
                providerId == null || modelId == null -> "No model chosen for this chat. Set a default model on your computer."
                else -> null
            }
            val saved = state.session?.let { Transcript.fromMessages(it.messages) } ?: emptyList()
            val turn = state.turn
            return ChatUi(
                ready = state.session != null || state.loadError != null,
                title = plainText(state.session?.title ?: "").ifEmpty { "Chat" },
                subtitle = listOfNotNull(modelId, env.computerName).joinToString(" · "),
                blocks = Transcript.mergeLive(saved, turn.blocks),
                running = turn.running,
                approval = turn.approval,
                question = turn.question,
                error = state.loadError ?: turn.error,
                blocked = blocked,
                queued = state.session?.queue ?: emptyList(),
                queuedPrompts = state.session?.queued ?: emptyList(),
                rate = turn.rate,
                skills = state.skills,
                omittedMessages = state.session?.omittedMessages ?: 0,
                providerId = providerId,
                modelId = modelId,
                modelName = modelId?.let { id -> env.models[providerId]?.firstOrNull { it.id == id }?.name ?: id },
                effort = Effort.parse(state.session?.effort),
                mode = state.session?.mode,
                context = state.context,
                contextTokens = liveTokens(state.context, turn),
            )
        }
    }
}
