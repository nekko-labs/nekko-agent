package com.nekko.android.ui.settings

import androidx.annotation.StringRes
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Password
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.security.StepUpController
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.Pill
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.security.HardwareKeyNote
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.RelayState
import com.nekko.protocol.StepUpChallenge
import com.nekko.protocol.StepUpMethod
import kotlinx.coroutines.CancellationException

/** What a kind of method is called on screen. */
@StringRes
fun stepUpMethodLabelRes(m: StepUpMethod): Int = when (m) {
    StepUpMethod.SECURITY_KEY -> R.string.settings_method_key
    StepUpMethod.PASSKEY -> R.string.settings_method_passkey
    StepUpMethod.TOTP -> R.string.settings_method_totp
}

/** The same in English, as the JVM tests read it. */
fun stepUpMethodLabel(m: StepUpMethod): String = when (m) {
    StepUpMethod.SECURITY_KEY -> "Security key"
    StepUpMethod.PASSKEY -> "Passkey"
    StepUpMethod.TOTP -> "One-time code"
}

private fun stepUpMethodIcon(m: StepUpMethod): ImageVector = when (m) {
    StepUpMethod.SECURITY_KEY -> Icons.Filled.Key
    StepUpMethod.PASSKEY -> Icons.Filled.Smartphone
    StepUpMethod.TOTP -> Icons.Filled.Password
}

/** The line under Settings → Security's step-up card for what the computer said. */
@Composable
private fun stepUpStatusText(computer: String, c: StepUpChallenge?): String = when {
    c == null -> stringResource(R.string.settings_step_up_shows_once, computer)
    c.required -> stringResource(R.string.settings_step_up_on_line)
    else -> stringResource(R.string.settings_step_up_off_line, computer)
}

/** The same in English, as the JVM tests read it. */
internal fun stepUpStatusLine(computer: String, c: StepUpChallenge?): String = when {
    c == null -> "Shows once $computer is connected."
    c.required -> "On: raising a chat’s mode from this phone asks for one of these."
    else -> "Off on $computer. Turn it on there in Settings → Security."
}

/**
 * Settings → Security, step-up part (SK-7): the methods registered on the
 * active computer, by kind only (the computer never tells a phone more), and
 * whether step-up is on there. Methods are added and removed on the computer.
 * The hardware-key note is always shown here, connected or not.
 */
@Composable
fun StepUpMethodsCard(deps: SettingsDeps) {
    val p = Nekko.palette
    val c by deps.repo.state.collectAsStateWithLifecycle()
    val active = c.active
    val online = c.conn == RelayState.ONLINE
    var status by remember(active?.id) { mutableStateOf<StepUpChallenge?>(null) }
    var error by remember(active?.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(active?.id, online) {
        if (active == null || !online) return@LaunchedEffect
        try {
            status = deps.repo.stepUpChallenge()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        }
    }

    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
        if (active != null) {
            NCard {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.settings_step_up_on, active.name), style = MaterialTheme.typography.bodyLarge, color = p.ink, modifier = Modifier.weight(1f))
                    status?.let { Pill(if (it.required) stringResource(R.string.settings_on) else stringResource(R.string.settings_off), if (it.required) Tone.SUCCESS else Tone.FAINT) }
                }
                Text(
                    error ?: stepUpStatusText(active.name, status),
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkFaint,
                )
                status?.let { s ->
                    HorizontalDivider(color = p.line)
                    StepUpController.KIND_ORDER.forEach { kind -> MethodRow(kind, kind in s.methods) }
                    if (s.methods.any { it.isFido2 } && !s.offersKey) {
                        Text(
                            stringResource(R.string.settings_keys_cant_answer, active.name),
                            style = MaterialTheme.typography.bodySmall,
                            color = p.inkFaint,
                        )
                    }
                }
            }
            Text(
                stringResource(R.string.settings_step_up_footer, active.name),
                style = MaterialTheme.typography.bodySmall,
                color = p.inkFaint,
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
            )
        }
        HardwareKeyNote()
    }
}

@Composable
private fun MethodRow(kind: StepUpMethod, registered: Boolean) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(stepUpMethodIcon(kind), contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(20.dp))
        Text(stringResource(stepUpMethodLabelRes(kind)), style = MaterialTheme.typography.bodyMedium, color = p.ink, modifier = Modifier.weight(1f))
        Text(if (registered) stringResource(R.string.settings_registered) else stringResource(R.string.settings_none), style = MaterialTheme.typography.bodySmall, color = if (registered) p.success else p.inkFaint)
    }
}
