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
import com.nekko.protocol.DenyReason
import com.nekko.protocol.LiveTurn
import com.nekko.protocol.PendingInput
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.Session
import com.nekko.protocol.Transcript
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

/** A turn can run for hours (long agent runs); don't time the request out. */
const val TURN_TIMEOUT_MS: Long = 12L * 60 * 60 * 1000

/** What [ChatController] owns: the saved session plus the live overlay. */
data class ChatState(
    val session: Session? = null,
    val turn: LiveTurn = LiveTurn(),
    val loadError: String? = null,
)

/** Connection facts the chat screen reads from the computers store. */
data class ChatEnv(
    val conn: RelayState = RelayState.IDLE,
    val denied: DenyReason? = null,
    val defaults: RemoteDefaults = RemoteDefaults(),
    val computerName: String = "your computer",
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
    val rate: Double?,
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

    /** Fold one event; returns true when the caller should [reload]. */
    fun onEvent(e: AgentEvent): Boolean {
        if (e.sessionId != sessionId) return false
        _state.update { it.copy(turn = Transcript.apply(it.turn, e)) }
        // Re-read the saved transcript when the turn ends, then drop the overlay it replaces.
        return e is AgentEvent.Done || e is AgentEvent.Error || e is AgentEvent.SessionMeta
    }

    /** Throws when the prompt couldn't be sent, so the composer can keep the text. */
    suspend fun send(text: String) {
        if (_state.value.turn.running) {
            // Same as the desktop: a prompt sent mid-run waits its turn.
            val s = Session.from(caller.call(Channels.CHAT_QUEUE, JsonPrimitive(sessionId), JsonPrimitive(text)))
            if (s != null) _state.update { it.copy(session = s) }
            return
        }
        val (providerId, modelId) = model()
        if (providerId == null || modelId == null) throw IllegalStateException("Choose a default model on your computer first.")
        val at = now()
        _state.update {
            it.copy(turn = LiveTurn(running = true, blocks = listOf(Block.User("pending-$at", text, at))))
        }
        // Resolves only when the whole turn ends; the events carry the progress.
        scope.launch {
            try {
                caller.callWithTimeout(TURN_TIMEOUT_MS, Channels.CHAT_SEND, sendOptions(sessionId, providerId, modelId, text))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(turn = it.turn.copy(running = false, error = e.message ?: "Couldn’t send that.")) }
            }
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

    private fun model(): Pair<String?, String?> = resolveModel(_state.value.session, env().defaults)

    companion object {
        /** The session's own model, else the computer's default (never the `__auto__` sentinel). */
        fun resolveModel(session: Session?, defaults: RemoteDefaults): Pair<String?, String?> {
            val providerId = session?.providerId ?: defaults.defaultProviderId
            val modelId = session?.modelId?.takeIf { it != AUTO_MODEL_ID } ?: defaults.defaultModelId
            return providerId to modelId
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
                rate = turn.rate,
            )
        }
    }
}
