package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// New chat's Automatic (2026-11-05, decision 0051): a chat on a local model
// starts on a paired computer that is free, so nobody has to know which one is.
// The user can still pick one. The iPhone's MachinePick.swift, same rules.

/**
 * Whether someone is using a computer (`activity:state`): yes/no answers only;
 * the computer never tells a phone how long it has been idle, its battery
 * level or its temperatures.
 */
data class ComputerUse(
    /** Someone is at the keyboard, or a chat they started is replying. */
    val userActive: Boolean = false,
    /** A chat a person started is replying there. */
    val chatActive: Boolean = false,
    /** No input to read (a server or Docker): nobody sits at it. */
    val headless: Boolean = false,
    /** On battery, low or hot: heavy work is better elsewhere. */
    val strained: Boolean = false,
) {
    companion object {
        /** Null when the computer didn't answer with one (an older build). */
        fun from(e: JsonElement?): ComputerUse? {
            val o = e.obj() ?: return null
            if ((o["userActive"] as? JsonPrimitive)?.booleanOrNull == null) return null
            return ComputerUse(o.bool("userActive"), o.bool("chatActive"), o.bool("headless"), !o["strain"].arr().isNullOrEmpty())
        }
    }
}

/** One paired computer as Automatic sees it. */
data class MachineCandidate(
    val id: String,
    val conn: RelayState,
    /** Chats replying there now, from the fleet's event streams. */
    val running: Int = 0,
    /** What the computer said about its use; null when it didn't (an older build, or the read failed). */
    val use: ComputerUse? = null,
    /** It has an enabled model server (Ollama, LM Studio, llama.cpp, vLLM). */
    val hasLocalModel: Boolean = true,
) {
    /** Lower is freer: 0 nobody uses it, 1 no chat but it didn't say, 2 someone is at it, 3 a chat is replying. */
    internal val busyness: Int
        get() = when {
            running > 0 || use?.chatActive == true -> 3
            use?.userActive == true -> 2
            use == null -> 1
            else -> 0
        }
}

/** Where Automatic starts a chat, and why. */
data class MachinePick(
    val computerId: String?,
    val reason: Reason,
    /** Computers passed over because they were busy (the one used last), for the line under Run on. */
    val skipped: List<String> = emptyList(),
) {
    enum class Reason {
        /** The computer is free. */
        FREE,
        /** Every computer that can run it is busy: the one used last, as before Automatic. */
        ALL_BUSY,
        /** No computer that can run a local model is online: the one used last. */
        NONE_AVAILABLE,
    }
}

object MachinePicker {
    /**
     * The freest online computer with a local model. Ties go to the one used
     * last, then to one not on battery or hot, then to pairing order. With
     * none free, the one used last.
     */
    fun pick(candidates: List<MachineCandidate>, lastUsed: String?): MachinePick {
        val able = candidates.filter { it.conn == RelayState.ONLINE && it.hasLocalModel }
        if (able.isEmpty()) return MachinePick(lastUsed ?: candidates.firstOrNull()?.id, MachinePick.Reason.NONE_AVAILABLE)
        val best = able.withIndex().sortedWith(
            compareBy<IndexedValue<MachineCandidate>> { it.value.busyness }
                .thenBy { if (it.value.id == lastUsed) 0 else 1 }
                .thenBy { if (it.value.use?.strained == true) 1 else 0 }
                .thenBy { it.index },
        ).first().value
        if (best.busyness <= 1) {
            val skipped = able.filter { it.id == lastUsed && it.busyness > 1 }.map { it.id }
            return MachinePick(best.id, MachinePick.Reason.FREE, skipped)
        }
        return MachinePick(if (able.any { it.id == lastUsed }) lastUsed else best.id, MachinePick.Reason.ALL_BUSY)
    }
}
