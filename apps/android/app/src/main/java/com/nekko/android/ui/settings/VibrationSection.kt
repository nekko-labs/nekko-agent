package com.nekko.android.ui.settings

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.chat.PhoneEvent
import com.nekko.android.haptics.EventHaptics
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko

/** Settings → Vibration: which agent events buzz while the app is open. */
@Composable
fun VibrationSection(deps: SettingsDeps) {
    val p = Nekko.palette
    val rows = listOf(
        Triple(PhoneEvent.APPROVAL, R.string.settings_vib_approval, R.string.settings_vib_approval_detail),
        Triple(PhoneEvent.NEEDS_INPUT, R.string.settings_vib_question, R.string.settings_vib_question_detail),
        Triple(PhoneEvent.FINISHED, R.string.settings_vib_finished, R.string.settings_vib_finished_detail),
        Triple(PhoneEvent.FAILED, R.string.settings_vib_failed, R.string.settings_vib_failed_detail),
    )
    SectionHeader(stringResource(R.string.settings_vibration))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            rows.forEachIndexed { i, (event, title, detail) ->
                if (i > 0) HorizontalDivider(color = p.line)
                val key = EventHaptics.key(event)
                val on by deps.phonePrefs.flow(key).collectAsStateWithLifecycle()
                Row(
                    Modifier
                        .fillMaxWidth()
                        .toggleable(value = on, role = Role.Switch) { want ->
                            deps.phonePrefs.set(key, want)
                            // Feel the pattern you just switched on.
                            if (want) deps.haptics?.preview(event)
                        }
                        .heightIn(min = 56.dp)
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(title), style = MaterialTheme.typography.bodyLarge, color = p.ink)
                        Text(stringResource(detail), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                    }
                    Switch(checked = on, onCheckedChange = null)
                }
            }
        }
        Text(
            if (deps.haptics?.available == false) {
                stringResource(R.string.settings_vib_no_motor)
            } else {
                stringResource(R.string.settings_vib_footer)
            },
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
        )
    }
}
