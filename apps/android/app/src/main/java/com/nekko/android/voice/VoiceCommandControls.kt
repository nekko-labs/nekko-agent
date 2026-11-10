package com.nekko.android.voice

import android.os.SystemClock
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** Parent routes answers through VoiceRunner.answer(intent, pending.id), never directly to Option.run. */
@Composable
fun VoiceCommandPrompt(
    pending: VoiceRunner.Pending,
    onAnswer: (VoiceIntent, Long) -> Unit,
    modifier: Modifier = Modifier,
    cancelLabel: String = "Cancel",
) {
    Surface(modifier, shape = MaterialTheme.shapes.medium, tonalElevation = 2.dp) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(pending.message)
            pending.options.forEachIndexed { index, option ->
                Button(onClick = { onAnswer(if (pending.confirm) VoiceIntent.Yes else VoiceIntent.Pick(index + 1), pending.id) }) { Text(option.label) }
            }
            TextButton(onClick = { onAnswer(VoiceIntent.No, pending.id) }) { Text(cancelLabel) }
        }
    }
}

/**
 * Pointer release/cancellation adapter for HoldToTalk. The host calls hold.didStart from recognizer onReady.
 * TalkBack/keyboard activation toggles start/release; cancellation/disposal always discards.
 * Permission responses never call START: ask once, then hold/activate again after it is granted.
 */
@Composable
fun HoldToTalkButton(
    hold: HoldToTalk,
    permission: HoldToTalk.Permission,
    enabled: Boolean,
    onAction: (HoldToTalk.Action) -> Unit,
    modifier: Modifier = Modifier,
    label: String = "Hold to talk",
    accessibilityAction: String = "Start or finish dictation",
) {
    val action by rememberUpdatedState(onAction)
    DisposableEffect(hold, enabled) {
        if (!enabled) { hold.reset(); action(HoldToTalk.Action.DISCARD) }
        onDispose { hold.reset(); action(HoldToTalk.Action.DISCARD) }
    }
    Surface(
        modifier = modifier.semantics {
            role = Role.Button
            if (!enabled) disabled()
            onClick(label = accessibilityAction) {
                if (!enabled) false else {
                    action(if (hold.holding) hold.release(SystemClock.elapsedRealtime()) else hold.press(SystemClock.elapsedRealtime(), permission))
                    true
                }
            }
        }.pointerInput(hold, enabled, permission) {
            if (enabled) detectTapGestures(onPress = {
                var released = false
                try {
                    action(hold.press(SystemClock.elapsedRealtime(), permission))
                    released = tryAwaitRelease()
                    if (released) action(hold.release(SystemClock.elapsedRealtime()))
                } finally {
                    // Also covers pointerInput cancellation on permission/target changes.
                    if (!released) { hold.reset(); action(HoldToTalk.Action.DISCARD) }
                }
            })
        },
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.secondaryContainer,
    ) { Text(label, Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) }
}
