package com.nekko.android.ui.security

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.data.PhonePrefs
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.PcSettings.ChatMode

/**
 * The phone's own settings for composables deep in a screen that aren't handed them
 * (MainActivity provides them). Null in previews and tests: then nothing is saved and the
 * YOLO warning always shows.
 */
val LocalPhonePrefs = staticCompositionLocalOf<PhonePrefs?> { null }

/**
 * The warning before YOLO (decision 0054), as on the desktop (`YoloWarning.tsx`): YOLO never
 * asks, so the egress gate that asks before data leaves a chat that read the web or a tool's
 * output is off too.
 */
object YoloWarning {
    /**
     * **Don't warn me again**, kept on this phone only (never on the computer, whose own
     * `skipYoloWarning` is the desktop's). Settings → Security → Warn before YOLO clears it.
     */
    val SKIP = PhonePrefs.boolean("skipYoloWarning", default = false)

    /** Whether switching from [current] (null: unknown) to [next] shows the warning first. */
    fun needed(current: ChatMode?, next: ChatMode, skip: Boolean): Boolean =
        next == ChatMode.YOLO && current != ChatMode.YOLO && !skip

    object Tags {
        const val DIALOG = "yolo.warning"
        const val SKIP = "yolo.warning.skip"
        const val KEEP_ASKING = "yolo.warning.keepAsking"
        const val TURN_ON = "yolo.warning.turnOn"
    }
}

/** Whether this phone skips the YOLO warning (**Don't warn me again** was ticked). */
@Composable
fun skipsYoloWarning(): Boolean {
    val prefs = LocalPhonePrefs.current ?: return false
    val skip by prefs.flow(YoloWarning.SKIP).collectAsState()
    return skip
}

/**
 * **Turn on YOLO?** Shared by every place the phone can turn YOLO on (a chat's mode, the
 * computer's default for new chats). **Keep asking** is the safe way out and changes nothing;
 * **Turn on YOLO** goes ahead, after saving **Don't warn me again** on this phone when ticked.
 */
@Composable
fun YoloWarningDialog(onKeepAsking: () -> Unit, onTurnOn: () -> Unit) {
    val p = Nekko.palette
    val prefs = LocalPhonePrefs.current
    var skip by rememberSaveable { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onKeepAsking,
        modifier = Modifier.testTag(YoloWarning.Tags.DIALOG),
        title = { Text(stringResource(R.string.no_restrictions_warning_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.no_restrictions_warning_text), style = MaterialTheme.typography.bodyMedium, color = p.ink)
                Text(stringResource(R.string.no_restrictions_warning_recommend), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .toggleable(value = skip, role = Role.Checkbox) { skip = it }
                        .testTag(YoloWarning.Tags.SKIP),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    // The row handles the toggle, so the box itself is not a second target.
                    Checkbox(checked = skip, onCheckedChange = null)
                    Text(stringResource(R.string.yolo_warning_skip), style = MaterialTheme.typography.bodyMedium, color = p.ink)
                }
                Text(stringResource(R.string.yolo_warning_skip_detail), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    if (skip) prefs?.set(YoloWarning.SKIP, true)
                    onTurnOn()
                },
                modifier = Modifier.testTag(YoloWarning.Tags.TURN_ON),
            ) { Text(stringResource(R.string.no_restrictions_warning_turn_on), color = p.danger) }
        },
        dismissButton = {
            TextButton(onClick = onKeepAsking, modifier = Modifier.testTag(YoloWarning.Tags.KEEP_ASKING)) {
                Text(stringResource(R.string.yolo_warning_keep_asking))
            }
        },
    )
}
