package com.nekko.android.ui.settings

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
        Triple(PhoneEvent.APPROVAL, "Needs your approval", "Two firm pulses"),
        Triple(PhoneEvent.NEEDS_INPUT, "Asks you a question", "One long pulse"),
        Triple(PhoneEvent.FINISHED, "Reply finished", "One short tap"),
        Triple(PhoneEvent.FAILED, "Reply failed", "Three short taps"),
    )
    SectionHeader("Vibration")
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
                        Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink)
                        Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                    }
                    Switch(checked = on, onCheckedChange = null)
                }
            }
        }
        Text(
            if (deps.haptics?.available == false) {
                "This device has no vibration motor, so these switches have no effect here."
            } else {
                "Saved on this phone. Only while Nekko Agent is open, never in silent mode or Do Not Disturb. A sub-agent finishing doesn’t buzz; its approvals and questions do."
            },
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
        )
    }
}
