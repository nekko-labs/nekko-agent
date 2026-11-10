package com.nekko.android.voice

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Ordered, addressed composer commands. Host closures must remain bound to the original chat. Main only. */
class VoiceRunner(
    private val scope: CoroutineScope,
    private val host: Host,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    data class Chat(val id: String, val title: String, val firstUserText: String = "", val archived: Boolean = false)
    data class PullRequest(val id: String, val label: String, val open: Boolean = true, val draft: Boolean = false)
    data class ShipFacts(val prs: List<PullRequest> = emptyList(), val running: Boolean = false, val questionId: String? = null)
    interface Host {
        var text: String
        fun allowed(): Boolean = true
        suspend fun send(): Boolean
        fun toast(text: String) {}
        fun tap() {}
        fun chats(): List<Chat> = emptyList()
        fun open(id: String) {}
        fun park(text: String) {}
        fun newChat() {}
        fun openSettings() {}
        fun status(): String = ""
        suspend fun ship(): ShipFacts = ShipFacts()
        /** Null only after successful merge; all proof/step-up still belongs to the host. */
        suspend fun merge(pr: PullRequest): String? = "Merge is unavailable."
        suspend fun answer(questionId: String, text: String) {}
        suspend fun complete() {}
        fun title(): String = "this chat"
    }
    class Option internal constructor(val label: String, internal val run: suspend () -> Unit)
    data class Pending(val id: Long, val message: String, val confirm: Boolean, val options: List<Option>, val expiresAt: Long)
    private val mutablePending = MutableStateFlow<Pending?>(null)
    val pending = mutablePending.asStateFlow()
    private val mutableNotice = MutableStateFlow<String?>(null)
    val notice = mutableNotice.asStateFlow()
    private val mutex = Mutex()
    private var generation = 0L
    private var ids = 0L
    private var expiry: Job? = null
    private var last = ""
    private var carried: Pair<String, Long>? = null
    private var left = false
    private var parked = false

    fun started() { generation++; carried = null; parked = false }

    /** Called after the final transcript has drained. A hold may answer a confirmation in the next hold. */
    suspend fun stopped(afterHold: Boolean = false) {
        val run = generation
        mutex.withLock { if (generation == run && !afterHold) setPending(null) }
    }

    /** Lock, background, navigation or cancellation: queued words and confirmations lose authority immediately. */
    fun abort() { generation++; carried = null; last = ""; setPending(null) }
    /** Optional graceful navigation policy: future words are draft text only, never commands. */
    fun park() { abort(); parked = true }
    fun clearNotice() { mutableNotice.value = null }

    suspend fun hear(text: String) {
        val run = generation
        mutex.withLock {
            current(run)
            if (parked) { host.park(text); return@withLock }
            left = false
            val carry = carried?.takeIf { nowMs() - it.second <= WAKE_CARRY_MS }?.first?.plus(" ").orEmpty()
            val tail = VoiceCommands.splitWakeTail(carry + text)
            carried = tail.wake.takeIf { it.isNotEmpty() }?.let { it to nowMs() }
            for (intent in VoiceCommands.split(tail.rest)) {
                current(run)
                if (left) {
                    when (intent) {
                        is VoiceIntent.Dictation -> host.park(intent.text)
                        is VoiceIntent.Unknown -> host.park(intent.text)
                        is VoiceIntent.OpenChat -> host.park(intent.text)
                        else -> Unit
                    }
                } else act(intent, run)
            }
        }
    }

    /** A tap must pass the pending id it displayed, so an old button cannot confirm a replacement. */
    suspend fun answer(intent: VoiceIntent, pendingId: Long? = null) {
        val run = generation
        mutex.withLock {
            current(run)
            if (pendingId != null && mutablePending.value?.id != pendingId) return@withLock
            act(intent, run)
        }
    }

    private suspend fun current(run: Long) {
        currentCoroutineContext().ensureActive()
        if (generation != run || !host.allowed()) throw CancellationException("Voice command is no longer authorized.")
    }

    private fun setPending(value: Pending?) {
        if (mutablePending.value?.id == value?.id) return
        expiry?.cancel()
        mutablePending.value = value
        if (value != null) {
            host.tap(); host.toast(value.message)
            expiry = scope.launch {
                delay((value.expiresAt - nowMs()).coerceAtLeast(0))
                if (mutablePending.value?.id == value.id) mutablePending.value = null
            }
        }
    }
    private fun show(text: String, done: Boolean = false) { mutableNotice.value = text; host.toast(text); if (done) host.tap() }
    private fun offer(message: String, confirm: Boolean, options: List<Option>) = setPending(Pending(++ids, message, confirm, options, nowMs() + PENDING_MS))
    private fun type(text: String, sentence: Boolean = false) {
        val current = if (sentence) host.text.trimEnd() else host.text
        val stop = if (sentence && current.isNotEmpty() && current.last() !in ".!?") "." else ""
        last = stop + (if (current.isNotEmpty() && !current.last().isWhitespace()) " " else "") + VoiceCommands.spellNekko(text)
        host.text = current + last
    }
    private suspend fun send(run: Long) {
        if (host.text.isBlank()) { show("Nothing to send"); return }
        last = ""
        val sent = host.send()
        current(run)
        show(if (sent) "Sent" else "Not sent", done = sent)
    }
    private fun open(chat: Chat) { host.open(chat.id); left = true; show("Opened ${chat.title.ifBlank { "Untitled chat" }}", true) }

    private suspend fun act(intent: VoiceIntent, run: Long) {
        current(run)
        if (mutablePending.value?.let { nowMs() >= it.expiresAt } == true) setPending(null)
        val pending = mutablePending.value
        try {
            when (intent) {
                is VoiceIntent.Dictation -> type(intent.text)
                is VoiceIntent.Unknown -> type(intent.text)
                VoiceIntent.NewSession -> { host.newChat(); left = true; setPending(null); show("New chat", true) }
                is VoiceIntent.Navigate -> if (intent.view == "settings") {
                    host.openSettings(); left = true; setPending(null); show("Opened Settings", true)
                } else show(COMPUTER_ONLY, true)
                is VoiceIntent.Go -> show(COMPUTER_ONLY, true)
                is VoiceIntent.OpenChat -> {
                    val hits = host.chats().filter { !it.archived && (it.title.contains(intent.query, true) || it.firstUserText.contains(intent.query, true)) }.take(3)
                    when (hits.size) {
                        0 -> type(intent.text)
                        1 -> { setPending(null); open(hits.first()) }
                        else -> offer("Which chat? Say 'Nekko, the first one' or tap it.", false, hits.map { Option(it.title.ifBlank { "Untitled chat" }) { open(it) } })
                    }
                }
                VoiceIntent.Yes, is VoiceIntent.Pick -> {
                    val index = if (intent is VoiceIntent.Pick) intent.n - 1 else 0
                    val matches = pending != null && (if (intent is VoiceIntent.Pick) !pending.confirm else pending.confirm)
                    val option = if (matches) pending.options.getOrNull(index) else null
                    if (option == null) show("Nothing to confirm") else {
                        // Consume BEFORE suspension, including failures and lock while an action awaits proof.
                        setPending(null)
                        option.run()
                        current(run)
                    }
                }
                VoiceIntent.No -> { setPending(null); if (pending != null) show("Cancelled", true) }
                VoiceIntent.Erase -> {
                    val removed = last.isNotEmpty() && host.text.endsWith(last)
                    if (removed) host.text = host.text.dropLast(last.length)
                    last = ""; show(if (removed) "Erased" else "Nothing to erase", removed)
                }
                VoiceIntent.Clear -> { last = ""; host.text = ""; show("Cleared", true) }
                VoiceIntent.Send -> send(run)
                VoiceIntent.Status -> show(host.status(), true)
                VoiceIntent.CompleteSession -> {
                    val title = host.title()
                    offer("Complete \"$title\"? $SAY_YES", true, listOf(Option("Confirm") {
                        val active = generation
                        current(active); host.complete(); current(active); show("Completed $title", true)
                    }))
                }
                VoiceIntent.Ship -> ship(run)
            }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { current(run); show(e.message ?: "Voice command failed.") }
    }

    private suspend fun ship(run: Long) {
        val facts = host.ship()
        current(run)
        // Options are executed in the later hold/session, so validate THEN, not against the offering generation.
        val goAhead = Option("Go ahead") {
            val active = generation
            current(active)
            if (facts.questionId != null) { host.answer(facts.questionId, GO_AHEAD); current(active); show("Sent", true) }
            else { type(GO_AHEAD, true); send(active) }
        }
        val pr = facts.prs.firstOrNull { it.open && !it.draft }
        if (pr != null) {
            val merge = Option("Merge ${pr.label}") {
                val active = generation
                current(active)
                show("Merging ${pr.label}")
                val why = host.merge(pr)
                current(active)
                show(why ?: "Merged ${pr.label}", why == null)
            }
            if (facts.questionId != null) offer("${host.title()} has a question waiting for you. Pick Merge or Go ahead.", false, listOf(merge, goAhead))
            else offer("Merge ${pr.label}? $SAY_YES", true, listOf(merge))
        } else when {
            facts.questionId != null -> goAhead.run()
            facts.running -> show("It's still working", true)
            facts.prs.isEmpty() -> goAhead.run()
            else -> show("Nothing to ship", true)
        }
    }

    companion object {
        const val PENDING_MS = 60_000L
        const val WAKE_CARRY_MS = 5_000L
        const val COMPUTER_ONLY = "That one works on the computer"
        private const val SAY_YES = "Say 'Nekko, yes' or tap Confirm."
        private const val GO_AHEAD = "Go ahead and build it."
    }
}
