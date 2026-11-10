package com.nekko.android.voice

/** iOS HoldToTalk's permission/start/release rules, with monotonic milliseconds supplied by the host. */
class HoldToTalk {
    enum class Permission { UNDETERMINED, GRANTED, DENIED }
    enum class Action { NONE, ASK_PERMISSION, START, FINISH, DISCARD }
    private var pressedAt: Long? = null
    private var startedAt: Long? = null
    private var releasedEarly = false
    val holding: Boolean get() = pressedAt != null

    fun press(nowMs: Long, permission: Permission): Action {
        if (pressedAt != null || startedAt != null) return Action.NONE
        return when (permission) {
            Permission.UNDETERMINED -> Action.ASK_PERMISSION
            Permission.DENIED -> Action.NONE
            Permission.GRANTED -> {
                pressedAt = nowMs
                releasedEarly = false
                Action.START
            }
        }
    }

    fun didStart(nowMs: Long): Action {
        if (pressedAt == null) return Action.NONE
        if (releasedEarly) { reset(); return Action.DISCARD }
        startedAt = nowMs
        return Action.NONE
    }

    fun release(nowMs: Long): Action {
        if (pressedAt == null) return Action.NONE
        val started = startedAt
        if (started == null) { releasedEarly = true; return Action.NONE }
        reset()
        return if (nowMs - started < MIN_MS) Action.DISCARD else Action.FINISH
    }

    fun reset() { pressedAt = null; startedAt = null; releasedEarly = false }
    companion object { const val MIN_MS = 400L }
}
