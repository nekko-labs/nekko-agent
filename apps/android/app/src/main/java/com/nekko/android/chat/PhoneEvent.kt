package com.nekko.android.chat

import com.nekko.protocol.AgentEvent

/**
 * The moments of a computer chat worth telling the user about when they are not looking at it:
 * the reply finished or failed, or the agent is waiting on them. What reacts to them (a
 * notification, a vibration) is decided elsewhere; this is only the vocabulary.
 */
enum class PhoneEvent {
    /** The reply is complete. */
    FINISHED,

    /** The turn ended with an error. Not raised when the user pressed Stop. */
    FAILED,

    /** The agent asked a question (`ask_user`) and waits for an answer. */
    NEEDS_INPUT,

    /** The agent wants to run something that needs the user's Allow / Deny. */
    APPROVAL,
    ;

    companion object {
        /**
         * The error message of a turn the user stopped: `packages/core/src/agent/loop.ts` and
         * `crates/nekko-loop/src/run.rs` both report an aborted run as exactly this.
         */
        const val STOPPED = "Stopped"

        /**
         * What [e] means for the user, or null for the events in between (text, tool steps,
         * usage). Pure: the same events [ChatController.onEvent] folds, nothing else.
         */
        fun of(e: AgentEvent): PhoneEvent? = when (e) {
            is AgentEvent.Done -> FINISHED
            is AgentEvent.Error -> if (e.message == STOPPED) null else FAILED
            is AgentEvent.Question -> NEEDS_INPUT
            is AgentEvent.ApprovalRequired -> APPROVAL
            is AgentEvent.Text,
            is AgentEvent.Reasoning,
            is AgentEvent.ToolCallStarted,
            is AgentEvent.ToolResultReady,
            is AgentEvent.QuestionResolved,
            is AgentEvent.Usage,
            is AgentEvent.Retry,
            is AgentEvent.SessionMeta,
            is AgentEvent.Other,
            -> null
        }
    }
}
