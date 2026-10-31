package com.nekko.android.connection

import com.nekko.android.data.PhonePrefs
import com.nekko.protocol.Activity
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.LiveCard
import com.nekko.protocol.LiveChat
import com.nekko.protocol.LiveChatState
import com.nekko.protocol.LiveLevel
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.Transcript

/**
 * The Lock Screen card (the iPhone's one Live Activity card) on Android: the
 * keep-alive Live Update notification shows the chat that most needs you,
 * built by [LiveCard] from what the phone saw of each run. Pure, so it is
 * JVM-tested; the notification is drawn by [Notices.keepAlive].
 */
object LiveCards {
    /**
     * Settings → Connection → Lock Screen card. Unset until the first start,
     * which stores the iPhone's first level: Minimal with the app lock on,
     * Standard with it off. Changing the app lock later doesn't change it.
     */
    val LEVEL: PhonePrefs.Key<LiveLevel?> = PhonePrefs.key("liveCard.level", null, { it?.wire.orEmpty() }, { LiveLevel.parse(it) })

    fun firstLevel(appLock: Boolean): LiveLevel = if (appLock) LiveLevel.MINIMAL else LiveLevel.STANDARD

    /** What the phone saw of one chat's run, from its events. */
    data class Run(
        val step: String = "",
        val needsYou: Boolean = false,
        /** The tool call waiting for approval; null for a question. */
        val callId: String? = null,
        val severity: String? = null,
        /** Seconds, on [now]'s clock. */
        val startedAt: Double? = null,
        val finishedAt: Double? = null,
        val failed: Boolean = false,
    ) {
        val finished: Boolean get() = finishedAt != null
    }

    /** The run after [e] at [now] (seconds); a finished run that sees a new event starts again. */
    fun next(run: Run?, e: AgentEvent, now: Double): Run? {
        val r = if (run == null || run.finished) Run(startedAt = now) else run
        return when (e) {
            is AgentEvent.Text -> if (r.needsYou) r else r.copy(step = "Writing…")
            is AgentEvent.Reasoning -> if (r.needsYou) r else r.copy(step = "Thinking…")
            is AgentEvent.ToolCallStarted -> if (r.needsYou) r else r.copy(step = Transcript.toolLabel(e.call))
            is AgentEvent.ApprovalRequired -> r.copy(
                step = Transcript.toolLabel(e.approval.call), needsYou = true, callId = e.approval.call.id,
                severity = e.approval.severity.name.lowercase(),
            )
            is AgentEvent.Question -> r.copy(step = e.request.questions.firstOrNull()?.question.orEmpty(), needsYou = true, callId = null, severity = null)
            is AgentEvent.ToolResultReady, is AgentEvent.QuestionResolved -> r.copy(needsYou = false, callId = null, severity = null)
            is AgentEvent.Done -> r.copy(needsYou = false, callId = null, severity = null, finishedAt = now)
            is AgentEvent.Error -> r.copy(needsYou = false, callId = null, severity = null, finishedAt = now, failed = true)
            else -> run
        }
    }

    /**
     * Every chat the card may show: running or needing you (the computer's
     * activity is the truth; the run adds its step and waiting call), finished
     * within the card's tail, or idle with a watch armed. Only the chats the
     * phone lists: not subagents, tasks or training runs.
     */
    fun chats(summaries: List<SessionSummary>, activity: Map<String, Activity>, runs: Map<String, Run>, now: Double): List<LiveChat> =
        summaries.mapNotNull { s ->
            val run = runs[s.id]
            val state = when {
                activity[s.id] == Activity.NEEDS_YOU -> LiveChatState.NEEDS_YOU
                activity[s.id] == Activity.RUNNING -> LiveChatState.WORKING
                run?.finished == true && now - run.finishedAt!! <= LiveCard.FINISHED_TAIL -> if (run.failed) LiveChatState.FAILED else LiveChatState.DONE
                s.activeWatchCount > 0 && !s.archived -> LiveChatState.WATCHING
                else -> return@mapNotNull null
            }
            val busy = state == LiveChatState.NEEDS_YOU || state == LiveChatState.WORKING
            LiveChat(
                id = s.id,
                short = LiveCard.shortTitle(s.title),
                state = state,
                step = when {
                    state == LiveChatState.WATCHING -> "Watching PR…"
                    busy && run != null && !run.finished -> run.step.ifEmpty { if (state == LiveChatState.NEEDS_YOU) "Needs you" else "Working…" }
                    state == LiveChatState.NEEDS_YOU -> "Needs you"
                    state == LiveChatState.WORKING -> "Working…"
                    else -> ""
                },
                reply = LiveCard.replyLine(s.lastReplyText),
                closeWord = LiveCard.closeWord(s.id, state == LiveChatState.FAILED),
                finishedAt = run?.finishedAt?.takeIf { !busy },
                startedAt = run?.startedAt?.takeIf { busy && !run.finished },
                callId = run?.callId?.takeIf { state == LiveChatState.NEEDS_YOU && run.needsYou },
                severity = run?.severity?.takeIf { state == LiveChatState.NEEDS_YOU && run.needsYou },
            )
        }

    /** The generic line for a state: Minimal's only words, and the locked screen's at Standard and Detailed. */
    fun generic(state: LiveChatState): String = when (state) {
        LiveChatState.NEEDS_YOU -> "Needs you"
        LiveChatState.WORKING -> "Working…"
        LiveChatState.WATCHING -> "Watching PR…"
        LiveChatState.DONE -> "Done"
        LiveChatState.FAILED -> "Failed"
    }

    /** The chat after [focus] on [chats], to cycle with Next. */
    fun after(chatIds: List<String>, focus: String?): String? {
        if (chatIds.isEmpty()) return null
        val i = chatIds.indexOf(focus)
        return chatIds[(i + 1).mod(chatIds.size)]
    }
}
