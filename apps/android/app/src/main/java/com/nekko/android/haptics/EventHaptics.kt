package com.nekko.android.haptics

import com.nekko.android.chat.PhoneEvent
import com.nekko.android.data.PhonePrefs

/**
 * A vibration, as on/off timings in milliseconds (off first, like
 * `VibrationEffect.createWaveform`). Each [PhoneEvent] has its own so the
 * user can tell them apart without looking.
 */
data class Buzz(val timings: LongArray) {
    override fun equals(other: Any?) = other is Buzz && timings.contentEquals(other.timings)
    override fun hashCode() = timings.contentHashCode()
}

/**
 * When the phone vibrates for an agent event (Settings → Vibration). Pure, so
 * the rules are tested on the JVM; [AndroidHaptics] plays the result.
 *
 * - Only while the app is on screen. In the background the notification
 *   channels own sound and vibration (push, AN-6), so nothing buzzes twice.
 * - Per event, from [PhonePrefs]: the agent waiting on the user (a question,
 *   an approval) is on by default; a finished or failed reply is off.
 * - Never in silent mode or Do Not Disturb.
 * - Finished / failed of a sub-agent's chat does not count: only the chat the
 *   user started does. A sub-agent's approval or question still does, because
 *   it waits on the user all the same.
 * - At most one vibration per [GAP_MS], so a burst of events is one buzz.
 */
class EventHaptics(
    private val prefs: PhonePrefs,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var lastAt = Long.MIN_VALUE / 2

    /** What to play for [event], or null to stay still. */
    fun decide(event: PhoneEvent, foreground: Boolean, quiet: Boolean, subAgent: Boolean): Buzz? {
        if (!foreground || quiet) return null
        if (!prefs.get(key(event))) return null
        if (subAgent && (event == PhoneEvent.FINISHED || event == PhoneEvent.FAILED)) return null
        val t = now()
        if (t - lastAt < GAP_MS) return null
        lastAt = t
        return pattern(event)
    }

    companion object {
        const val GAP_MS = 1_500L

        val QUESTION = PhonePrefs.boolean("haptics.needsInput", default = true)
        val APPROVAL = PhonePrefs.boolean("haptics.approval", default = true)
        val FINISHED = PhonePrefs.boolean("haptics.finished", default = false)
        val FAILED = PhonePrefs.boolean("haptics.failed", default = false)

        fun key(e: PhoneEvent): PhonePrefs.Key<Boolean> = when (e) {
            PhoneEvent.NEEDS_INPUT -> QUESTION
            PhoneEvent.APPROVAL -> APPROVAL
            PhoneEvent.FINISHED -> FINISHED
            PhoneEvent.FAILED -> FAILED
        }

        /** Distinct shapes: approval two firm pulses, question one long, finished one short, failed three short. */
        fun pattern(e: PhoneEvent): Buzz = when (e) {
            PhoneEvent.APPROVAL -> Buzz(longArrayOf(0, 60, 90, 60))
            PhoneEvent.NEEDS_INPUT -> Buzz(longArrayOf(0, 180))
            PhoneEvent.FINISHED -> Buzz(longArrayOf(0, 40))
            PhoneEvent.FAILED -> Buzz(longArrayOf(0, 40, 70, 40, 70, 40))
        }
    }
}
