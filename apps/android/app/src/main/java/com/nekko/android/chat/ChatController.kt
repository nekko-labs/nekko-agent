package com.nekko.android.chat

import com.nekko.android.data.Outbox

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
import com.nekko.protocol.StepUpProof
import com.nekko.protocol.Transcript
import com.nekko.protocol.queuePrompt
import com.nekko.protocol.sendOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
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
import com.nekko.protocol.SavedTranscripts

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
    /** When the transcript on screen is the phone's saved copy (the computer hasn't answered yet), when it was saved. */
    val savedAt: Long? = null,
)

/** Connection facts the chat screen reads from the computers store. */
data class ChatEnv(
    val conn: RelayState = RelayState.IDLE,
    val denied: DenyReason? = null,
    val defaults: RemoteDefaults = RemoteDefaults(),
    val computerName: String = "your computer",
    /** The computer's model lists by provider, for the model's name. */
    val models: Map<String, List<ModelInfo>> = emptyMap(),
    /** Prompts sent while the computer is out of reach wait in the outbox instead of being refused. */
    val canQueue: Boolean = false,
    /** How the computer's agents delegate ([PcSettings.orchestrationStrategy]). */
    val strategy: String? = null,
    val imageGeneration: Boolean = false,
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
    /** The chat's run settings ([RunOption]). */
    val runOptions: Map<String, JsonElement> = emptyMap(),
    /** The tools this chat may not call. */
    val disabledTools: List<String> = emptyList(),
    /** The chat's own tool policy; null follows the computer's default. */
    val mode: PcSettings.ChatMode? = null,
    /** The transcript is the phone's saved copy, saved then: read-only until the computer answers (OF-5). */
    val savedAt: Long? = null,
    /** The computer is out of reach and what is sent waits on the phone: says so under the box, without blocking it. */
    val sendsLater: String? = null,
    /** A typed follow-up can run here or in a sub-agent: only while the computer can say delegation will run. */
    val offersSubagent: Boolean = false,
    val context: ContextUsage? = null,
    /** [context]'s count plus about one token per four characters streamed this turn; null until the computer answers. */
    val contextTokens: Long? = null,
    val chatType: String? = null,
    val imageParams: com.nekko.protocol.ImageChatParams? = null,
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
    /** Offline mode: every prompt is on disk until the computer lists it; null sends without one (tests, previews). */
    private val outbox: Outbox? = null,
    /** The last chats opened, kept to read offline (OF-5); null keeps none. */
    private val saved: SavedTranscripts? = null,
    /**
     * A guarded `session:setOptions` (one that widens what the agent may do without asking): sent
     * the way a mode raise is, signed with this phone's Change proof, and with [StepUpProof] when the
     * computer asked for one. Null sends it plain (tests, previews).
     */
    private val guarded: (suspend (channel: String, args: List<JsonElement>, stepUp: StepUpProof?) -> JsonElement)? = null,
    /** Generation always uses the existing authorized Change path, never an unsigned fallback. */
    private val generateImage: (suspend (JsonElement) -> JsonElement)? = null,
) {
    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    /** The reservation survives terminal events until the image RPC/authorization actually returns. */
    private class ImageSend(var job: kotlinx.coroutines.Job? = null, var error: String? = null)
    private var imageSend: ImageSend? = null
    private var imageRevision = 0L

    suspend fun reload() {
        val revision = imageRevision
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
                saved?.remove(sessionId)
                _state.update { st ->
                    // A saved copy of a chat the computer no longer has is not shown.
                    st.copy(loadError = "This chat was deleted on your computer.", session = if (st.savedAt != null) null else st.session, savedAt = null)
                }
                return
            }
            // Rust image turns are separate from activeRun. Only the phone-safe monitor
            // exposes them on reopen; its capped list can prove running, never idle.
            val imageRunning = if (session.chatType == "image") {
                try {
                    com.nekko.protocol.MonitorSummary.from(caller.call(Channels.MONITOR_SUMMARY)).running.any { it.id == sessionId }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    false
                }
            } else false
            saved?.save(session)
            val mine = pending[sessionId]
            // The computer lists these prompts: whatever the outbox still held of them was delivered.
            if (session.clientMessageIds.isNotEmpty()) outbox?.confirm(sessionId, session.clientMessageIds)
            _state.update { st ->
                val t = st.turn
                st.copy(
                    session = session,
                    savedAt = null,
                    loadError = null,
                    // Mid-turn the overlay keeps streaming; mergeLive hides what the re-read
                    // session already holds. After the turn the session has it all.
                    turn = t.copy(
                        blocks = if (t.running) t.blocks else emptyList(),
                        approval = mine?.approval,
                        question = mine?.question,
                        running = t.running || mine != null || (imageRunning && revision == imageRevision),
                    ),
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Out of reach: the saved copy (if any) says so itself, under "Saved copy from …".
            showSavedCopy()
            if (_state.value.savedAt != null && !(e is RelayException && e.fromComputer)) return
            _state.update { it.copy(loadError = e.message ?: "Could not load this chat.") }
        }
    }

    /** Paint the saved copy while nothing better is on screen: at once when the chat opens, and when the computer can't be reached. */
    fun showSavedCopy() {
        if (_state.value.session != null) return
        val copy = saved?.saved(sessionId) ?: return
        _state.update { if (it.session != null) it else it.copy(session = copy.session, savedAt = copy.savedAt, loadError = null) }
        saved.touch(sessionId)
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

    private var voiceFailure: kotlinx.coroutines.CompletableDeferred<Nothing>? = null

    /** Voice owns this request's completion, never the normal fire-and-forget/outbox send path. */
    suspend fun sendVoice(text: String, authorized: () -> Boolean): String = kotlinx.coroutines.withTimeout(300_000) {
        check(voiceFailure == null) { "A voice turn is already waiting." }
        val failure = kotlinx.coroutines.CompletableDeferred<Nothing>()
        voiceFailure = failure
        try {
            fun allowed() {
                check(authorized() && env().conn == RelayState.ONLINE) { "Voice stopped. Unlock and reconnect, then start again." }
            }
            fun preflight(session: Session?) {
                check(session?.id == sessionId) { "The selected chat changed. Voice stopped." }
                com.nekko.android.voice.VoiceTurn.preflight(session, env().conn == RelayState.ONLINE, authorized(),
                    _state.value.turn.running, outbox?.state?.value?.waitingFor(sessionId)?.isNotEmpty() == true)
                check(_state.value.savedAt == null && _state.value.turn.approval == null && _state.value.turn.question == null) { "This chat needs your attention before voice can start." }
            }
            allowed()
            preflight(_state.value.session)
            val before = Session.from(caller.call(Channels.SESSION_GET, JsonPrimitive(sessionId)))
            preflight(before)
            val pendingBefore = caller.call(Channels.CHAT_PENDING)
            check(pendingBefore is kotlinx.serialization.json.JsonObject && PendingInput.map(pendingBefore)[sessionId].let { it?.approval == null && it?.question == null }) { "This chat needs your attention before voice can send." }
            preflight(before)
            check(before != null && text.isNotBlank()) { "Nothing to send." }
            val (provider, model) = resolveModel(before, env().defaults)
            check(provider != null && model != null) { "Choose a default model on your computer first." }
            val id = newId()
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            allowed()
            _state.update { it.copy(turn = LiveTurn(running = true, blocks = listOf(Block.User("voice-$id", text, now())))) }
            coroutineScope {
                val request = async {
                    // No callWithId compatibility retry, no disk outbox, and never CHAT_QUEUE.
                    caller.callWithTimeout(300_000, Channels.CHAT_SEND, sendOptions(sessionId, provider, model, text, clientMessageId = id))
                }
                kotlinx.coroutines.selects.select<Unit> {
                    request.onAwait { }
                    failure.onAwait { }
                }
            }
            allowed()
            failure.takeIf { it.isCompleted }?.await()
            val after = Session.from(caller.call(Channels.SESSION_GET, JsonPrimitive(sessionId)))
            val pendingRaw = caller.call(Channels.CHAT_PENDING)
            val pending = PendingInput.map(pendingRaw)[sessionId]
            allowed()
            failure.takeIf { it.isCompleted }?.await()
            check(pendingRaw is kotlinx.serialization.json.JsonObject && pending?.approval == null && pending?.question == null) { "This chat needs your answer or approval. Voice stopped." }
            val reply = com.nekko.android.voice.VoiceTurn.reply(before, after, text, id)
            _state.update { it.copy(session = after, turn = LiveTurn(), savedAt = null, loadError = null) }
            reply
        } catch (e: CancellationException) {
            // Cancels the local wait only; it never aborts or resends the agent's turn.
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(turn = it.turn.copy(error = e.message)) }
            throw e
        } finally {
            if (voiceFailure === failure) voiceFailure = null
        }
    }

    /** Uses raw controller state, not a potentially one-frame-old projected question. Never answers tool approvals. */
    suspend fun answerVoice(callId: String, text: String, authorized: () -> Boolean) {
        val question = _state.value.turn.question ?: error("That question is no longer waiting.")
        check(question.callId == callId && authorized()) { "That question is no longer waiting in this chat." }
        answer(question.questions.map { AskAnswer(it.id, listOf(com.nekko.protocol.ASK_OTHER_LABEL), text) })
    }

    /** Fold one event; returns true when the caller should [reload]. */
    fun onEvent(e: AgentEvent): Boolean {
        if (e.sessionId != sessionId) return false
        if (e is AgentEvent.Done || e is AgentEvent.Error || (e is AgentEvent.Other && e.type == "image_status")) imageRevision++
        if (e is AgentEvent.Error) imageSend?.error = e.message
        val voiceProblem = when (e) {
            is AgentEvent.Error -> e.message
            is AgentEvent.Question, is AgentEvent.ApprovalRequired -> "This chat needs your answer or approval. Voice stopped."
            else -> null
        }
        if (voiceProblem != null) voiceFailure?.completeExceptionally(IllegalStateException(voiceProblem))
        _state.update { it.copy(turn = Transcript.apply(it.turn, e)) }
        // Re-read the saved transcript when the turn ends, then drop the overlay it replaces.
        return e is AgentEvent.Done || e is AgentEvent.Error || e is AgentEvent.SessionMeta
    }

    /**
     * Send a prompt. Throws when the computer turned it down, so the composer
     * can keep the text. With the outbox, the prompt is on disk until the
     * computer lists it: offline, or behind prompts already waiting for this
     * chat, it waits there; a send that gets no answer is handed to it and
     * sent again with the same id, which the computer runs once.
     */
    suspend fun send(text: String, skill: SkillSummary? = null, images: List<String> = emptyList()) {
        if (_state.value.session?.chatType == "image") {
            sendImage(text, skill, images)
            return
        }
        val ob = outbox
        val id = ob?.newId() ?: newId()
        if (ob != null) {
            if (env().conn != RelayState.ONLINE) {
                ob.add(sessionId, text, skill, images, id = id)
                return
            }
            // Anything already waiting for this chat goes first, in order.
            if (ob.state.value.waitingFor(sessionId).isNotEmpty()) {
                ob.add(sessionId, text, skill, images, id = id)
                ob.flushSoon()
                return
            }
            ob.add(sessionId, text, skill, images, id = id, direct = true)
        }
        if (_state.value.turn.running) {
            // Same as the desktop: a prompt sent mid-run waits its turn.
            try {
                val s = Session.from(callWithId(Channels.CHAT_QUEUE, id) { cid -> listOf(JsonPrimitive(sessionId), queuePrompt(text, skill, images, cid)) })
                if (s != null) _state.update { it.copy(session = s) }
                ob?.drop(id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: RelayException) {
                if (e.fromComputer || ob == null) {
                    ob?.drop(id)
                    throw e
                }
                // No answer: the outbox finds out, with the same id, when the computer is back.
                ob.endDirect(id)
            }
            return
        }
        val (providerId, modelId) = model()
        if (providerId == null || modelId == null) {
            ob?.drop(id)
            throw IllegalStateException("Choose a default model on your computer first.")
        }
        val at = now()
        _state.update {
            val shown = if (skill == null) text else "/${skill.name} $text".trim()
            it.copy(turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-$at", shown, at, images))))
        }
        // Resolves only when the whole turn ends; the events carry the progress.
        scope.launch {
            try {
                callWithId(Channels.CHAT_SEND, id, TURN_TIMEOUT_MS) { cid -> listOf(sendOptions(sessionId, providerId, modelId, text, skill, images, cid)) }
                // The turn ended. The re-read confirms the prompt; if the chat doesn't list it, the outbox settles it.
                if (ob != null) {
                    reload()
                    if (id in ob.state.value.direct) {
                        ob.endDirect(id)
                        ob.flushSoon()
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ob != null && !(e is RelayException && e.fromComputer)) {
                    // No answer (the connection dropped): it may or may not have arrived. The outbox
                    // sends it again with the same id once the computer is back, and it runs once.
                    ob.endDirect(id)
                    _state.update { st ->
                        st.copy(turn = st.turn.copy(running = false, blocks = st.turn.blocks.filterNot { it.id == "pending-$at" }))
                    }
                    return@launch
                }
                ob?.drop(id)
                _state.update { it.copy(turn = it.turn.copy(running = false, error = e.message ?: "Couldn’t send that.")) }
            }
        }
    }

    private suspend fun sendImage(text: String, skill: SkillSummary?, images: List<String>) {
        val session = _state.value.session ?: throw RelayException("Wait for this chat to load.")
        require(skill == null && images.isEmpty()) { "Image generation accepts a text prompt only. Remove attachments and skills first." }
        require(text.isNotBlank()) { "Describe the image to generate." }
        check(env().conn == RelayState.ONLINE) { "Reconnect to generate an image. Image prompts are never queued as text." }
        check(env().imageGeneration) { "This computer does not advertise image generation. Update Nekko Agent on the computer." }
        check(imageSend == null && !_state.value.turn.running && !session.running) { "Wait for this image to finish or stop it first." }
        val params = session.imageParams ?: throw RelayException("Choose and save image settings before generating.")
        val request = params.generation(sessionId, text)
        val generate = generateImage ?: throw RelayException("This phone cannot authorize image generation.")
        // Await authorization and the turn so a refusal/cancel keeps the composer's words.
        // There is no image idempotency token: never retry an ambiguous lost response automatically.
        val attempt = ImageSend()
        imageSend = attempt
        imageRevision++
        _state.update { it.copy(turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-image-${now()}", text, now())))) }
        try {
            coroutineScope {
                // Stop cancels this child, including pending Change signing, not the composer's scope.
                // ChangeCalls checks cancellation again after the system authentication returns.
                val pending = async(start = kotlinx.coroutines.CoroutineStart.LAZY) { generate(request) }
                attempt.job = pending
                pending.await()
            }
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            // image_turns.rs reports generation failures as an error event plus Ok(null).
            attempt.error?.let { throw RelayException(it) }
            reload()
            attempt.error?.let { throw RelayException(it) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(turn = it.turn.copy(running = false, error = e.message ?: "Image generation failed. Reconnect and check the chat before trying again.")) }
            throw e
        } finally {
            if (imageSend === attempt) {
                imageSend = null
                imageRevision++
                _state.update { it.copy(turn = it.turn.copy(running = false)) }
            }
        }
    }

    suspend fun setImageParams(params: com.nekko.protocol.ImageChatParams) {
        check(_state.value.session?.chatType == "image") { "Not an image chat." }
        check(env().conn == RelayState.ONLINE) { "Reconnect to change image settings." }
        check(!_state.value.turn.running) { "Wait for the image to finish." }
        caller.call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(sessionId), params.sessionOptions())
        reload()
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
            // An older computer can't tell a repeat: the outbox lets go of this one.
            outbox?.drop(id)
            call(null)
        }
    }

    fun stop() {
        imageSend?.job?.cancel(CancellationException("Image generation stopped."))
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

    /**
     * **Always allow this tool** (decision 0054), for an MCP call only ([offersToolScope]): save the
     * tool in the chat's `allowedMcpTools` (what the chat already allows, plus this one) before
     * releasing the call, so the computer stops asking for it in this chat. Never switches the chat
     * to YOLO. A refused or failed save throws and approves nothing, and the card stays; a
     * `step-up-required` refusal is thrown for the step-up sheet, which calls this again with [stepUp].
     */
    suspend fun alwaysAllowTool(stepUp: StepUpProof? = null) {
        val a = _state.value.turn.approval ?: return
        val name = a.call.name
        require(offersToolScope(name)) { "Only an MCP tool can be always allowed." }
        val allowed = ((_state.value.session?.allowedMcpTools ?: emptyList()) + name).distinct()
        val args = listOf(JsonPrimitive(sessionId), buildJsonObject { put("allowedMcpTools", JsonArray(allowed.map(::JsonPrimitive))) })
        val g = guarded
        if (g != null) g(Channels.SESSION_SET_OPTIONS, args, stepUp) else caller.call(Channels.SESSION_SET_OPTIONS, *args.toTypedArray())
        _state.update { s ->
            s.copy(
                session = s.session?.copy(allowedMcpTools = allowed),
                turn = if (s.turn.approval?.call?.id == a.call.id) s.turn.copy(approval = null) else s.turn,
            )
        }
        caller.call(Channels.TOOL_APPROVE, JsonPrimitive(sessionId), JsonPrimitive(a.call.id), JsonPrimitive(true))
    }

    suspend fun answer(answers: List<AskAnswer>) {
        val q = _state.value.turn.question ?: return
        caller.call(Channels.CHAT_ANSWER, JsonPrimitive(sessionId), JsonPrimitive(q.callId), JsonArray(answers.map { it.toJson() }))
        _state.update { if (it.turn.question?.callId == q.callId) it.copy(turn = it.turn.copy(question = null)) else it }
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

    /** Stop the reply and start the queued prompt at [index] on this chat's model. */
    suspend fun interruptQueued(index: Int) {
        if (env().conn != RelayState.ONLINE) throw RelayException(RECONNECT_TO_EDIT_QUEUE)
        val (providerId, modelId) = model()
        val args = buildList {
            add(JsonPrimitive(sessionId))
            add(JsonPrimitive(index))
            if (providerId != null && modelId != null) {
                add(buildJsonObject { put("providerId", providerId); put("modelId", modelId) })
            }
        }
        try {
            caller.call(Channels.CHAT_INTERRUPT_QUEUED, *args.toTypedArray())
        } catch (e: RelayException) {
            // The call stays open for the whole new reply, so running out of time is not a failure.
            if (e.fromComputer) throw e
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

        /** Only MCP tools offer **Always allow this tool**: their server alone says what they do (`offersToolScope` on the desktop). */
        fun offersToolScope(toolName: String): Boolean = toolName.startsWith("mcp__")

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
            val unpaired = env.conn == RelayState.DENIED || env.denied != null
            val away = !unpaired && env.conn != RelayState.ONLINE
            val image = state.session?.chatType == "image"
            val blocked = when {
                unpaired -> "This phone is no longer paired."
                image && away -> "Reconnect to generate an image. Image prompts are never queued as text."
                image && !env.imageGeneration -> "This computer does not advertise image generation. Update Nekko Agent on the computer."
                image && (state.session?.imageParams?.valid != true) -> com.nekko.protocol.ImageChatParams.INVALID
                image -> null
                // Offline mode: the prompt waits in the outbox; the model is settled when it is delivered.
                away && env.canQueue -> null
                away -> "${env.computerName} is ${if (env.conn == RelayState.OFFLINE) "offline" else "reconnecting"}."
                providerId == null || modelId == null -> "No model chosen for this chat. Set a default model on your computer."
                else -> null
            }
            val sendsLater = if (!image && away && env.canQueue) {
                "${env.computerName} is ${if (env.conn == RelayState.OFFLINE) "offline" else "reconnecting"}. What you send waits on this phone and goes when it’s back."
            } else {
                null
            }
            val saved = state.session?.let { Transcript.fromMessages(it.messages) } ?: emptyList()
            val turn = state.turn
            // Out of reach with no saved copy: say so rather than load forever.
            val notSaved = if (state.session == null && state.loadError == null && away) {
                "This chat isn’t saved on this phone yet. It shows when ${env.computerName} answers."
            } else {
                null
            }
            return ChatUi(
                ready = state.session != null || state.loadError != null || notSaved != null,
                title = plainText(state.session?.title ?: "").ifEmpty { "Chat" },
                subtitle = listOfNotNull(modelId, env.computerName).joinToString(" · "),
                blocks = com.nekko.protocol.QuestionReplies.project(Transcript.mergeLive(saved, turn.blocks)),
                running = turn.running || (image && state.session.running),
                approval = turn.approval,
                question = turn.question,
                error = state.loadError ?: turn.error ?: notSaved,
                blocked = blocked,
                sendsLater = sendsLater,
                offersSubagent = blocked == null && sendsLater == null && state.session?.canOfferSubagent(env.strategy) == true,
                savedAt = state.savedAt,
                queued = state.session?.queue ?: emptyList(),
                queuedPrompts = state.session?.queued ?: emptyList(),
                rate = turn.rate,
                skills = if (image) emptyList() else state.skills,
                omittedMessages = state.session?.omittedMessages ?: 0,
                providerId = providerId,
                modelId = modelId,
                chatType = state.session?.chatType,
                imageParams = state.session?.imageParams,
                modelName = if (image) state.session?.imageParams?.modelId ?: "Image model" else modelId?.let { id -> env.models[providerId]?.firstOrNull { it.id == id }?.name ?: id },
                effort = Effort.parse(state.session?.effort),
                runOptions = state.session?.runOptions ?: emptyMap(),
                disabledTools = state.session?.disabledTools ?: emptyList(),
                mode = state.session?.mode,
                context = state.context,
                contextTokens = liveTokens(state.context, turn),
            )
        }
    }
}
