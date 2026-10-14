package com.nekko.android.haptics

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.nekko.android.chat.PhoneEvent
import com.nekko.android.data.ComputersRepository
import com.nekko.protocol.AgentEvent

/** Plays [EventHaptics] decisions on the phone's vibrator. */
class AndroidHaptics(private val context: Context, private val rules: EventHaptics, private val repo: ComputersRepository) {
    private val vibrator: Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    /** False on tablets and emulators without a motor; Settings says so. */
    val available: Boolean get() = vibrator?.hasVibrator() == true

    /** An agent event from the active computer. */
    fun onEvent(e: AgentEvent) {
        val event = PhoneEvent.of(e) ?: return
        val subAgent = repo.state.value.summaries.firstOrNull { it.id == e.sessionId }?.parentSessionId != null
        val foreground = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        rules.decide(event, foreground, quiet(), subAgent)?.let(::play)
    }

    /** Settings: let the user feel the pattern they just switched on. */
    fun preview(event: PhoneEvent) {
        if (!quiet()) play(EventHaptics.pattern(event))
    }

    /** Silent ringer or Do Not Disturb (any filter other than "all"). */
    private fun quiet(): Boolean {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        val silent = audio?.ringerMode == AudioManager.RINGER_MODE_SILENT
        val dnd = nm != null && nm.currentInterruptionFilter > NotificationManager.INTERRUPTION_FILTER_ALL
        return silent || dnd
    }

    private fun play(b: Buzz) {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        val effect = VibrationEffect.createWaveform(b.timings, -1)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Notification usage: the system's own "vibrate for notifications" setting applies too.
            v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_NOTIFICATION))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(effect, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT).build())
        }
    }
}
