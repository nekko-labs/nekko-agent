package com.nekko.android.voice

import com.nekko.android.connection.StatusDashboard
import com.nekko.protocol.LiveCardState

/** Deterministic computer-scoped grammar. No focused chat and no general action executor. */
class NekkoVoice {
    data class Target(val id: String, val name: String)
    data class Context(val computerId: String, val computerName: String, val online: Boolean, val loaded: Boolean,
                       val card: LiveCardState, val targets: List<Target>)
    sealed interface Result {
        data class Message(val text: String) : Result
        data class Send(val computerId: String, val sessionId: String, val text: String) : Result
    }
    private data class Pending(val computerId: String, val target: Target, val text: String, val expires: Long)
    private var pending: Pending? = null
    fun cancel() { pending = null }

    fun dispatch(speech: String, c: Context, now: Long = System.currentTimeMillis()): Result {
        val words = speech.trim()
        if (words.lowercase() in listOf("cancel", "no", "never mind")) {
            cancel()
            return Result.Message("Cancelled. Nothing sent.")
        }
        if (words.lowercase() in listOf("status", "agent status", "what is happening", "what is happening?")) {
            cancel()
            val stale = if (c.online && c.loaded) "" else "Offline or stale. Last known "
            return Result.Message("$stale${c.computerName}: ${StatusDashboard.summary(c.card)}. ${StatusDashboard.detail(c.card)}")
        }
        val match = Regex("^(confirm send to|send to) (.+?)(?: saying |:)(.+)$", RegexOption.IGNORE_CASE).matchEntire(words)
        if (match == null) {
            cancel()
            return Result.Message("Not sent. Say status, or send to an exact chat name saying the message. Open app for approvals, stopping work, or other actions.")
        }
        val name = match.groupValues[2].trim()
        val text = match.groupValues[3].trim()
        val targets = c.targets.filter { it.name.isNotBlank() && it.name.equals(name, ignoreCase = true) }
        if (!c.loaded || targets.size != 1 || text.isBlank()) {
            cancel()
            return Result.Message("Not sent. Target missing, ambiguous, or unavailable. Open app to choose the exact chat and message.")
        }
        val target = targets.single()
        if (match.groupValues[1].startsWith("confirm", ignoreCase = true)) {
            val old = pending
            cancel()
            if (old == null || old.expires <= now || old.computerId != c.computerId || old.target != target || old.text != text) {
                return Result.Message("Not sent. Confirmation expired or target/message changed. Start again or open app.")
            }
            return Result.Send(c.computerId, target.id, text)
        }
        pending = Pending(c.computerId, target, text, now + 60_000)
        return Result.Message("Nothing sent yet. To confirm, say confirm send to, then the same exact chat name saying the same message. Or say cancel. Open app to review.")
    }
}

/** Authentication and foreground checks apply both before capture and before routing its result. */
object VoiceAccess {
    fun allowed(resumed: Boolean, locked: Boolean, covered: Boolean, sameComputer: Boolean, denied: Boolean): Boolean =
        resumed && !locked && !covered && sameComputer && !denied
}

/** Invalidates callbacks across cancel, backgrounding, permission dialogs and computer changes. */
class VoiceGeneration {
    private var generation = 0L
    fun begin(): Long = ++generation
    fun cancel() { generation++ }
    fun accepts(token: Long): Boolean = token == generation
}
