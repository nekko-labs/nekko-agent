package com.nekko.android.ui.settings

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.lock.AppLock
import com.nekko.android.lock.AuthResult
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.lock.LocalAuthenticator
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko

/**
 * Settings → Security. Turning the lock on is free; turning it off asks for
 * the same fingerprint / face / screen lock first, so someone holding an
 * unlocked phone cannot quietly remove it. Below it, the computer's step-up
 * methods by kind (SK-7, [StepUpMethodsCard]).
 */
@Composable
fun SecuritySection(deps: SettingsDeps) {
    SectionHeader("Security")
    // The lock belongs to the app, not to Settings; MainActivity provides it.
    LocalAppLock.current?.let { AppLockCard(it) }
    StepUpMethodsCard(deps)
}

@Composable
private fun AppLockCard(lock: AppLock) {
    val p = Nekko.palette
    val context = LocalContext.current
    val auth = LocalAuthenticator.current
    val on by lock.enabled.collectAsStateWithLifecycle()
    var secure by remember { mutableStateOf(auth?.deviceSecure() ?: true) }
    var error by remember { mutableStateOf<String?>(null) }
    // The user may set a screen lock in system settings and come back.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { secure = auth?.deviceSecure() ?: true }

    val toggle: (Boolean) -> Unit = { want ->
        error = null
        when {
            want -> lock.setEnabled(true)
            auth == null || !auth.deviceSecure() -> lock.setEnabled(false)
            else -> auth.authenticate(title = "Turn off app lock", subtitle = "Confirm it’s you") { r ->
                when (r) {
                    AuthResult.Success -> lock.setEnabled(false)
                    AuthResult.Cancelled -> Unit
                    is AuthResult.Failed -> error = r.message
                }
            }
        }
    }

    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            Row(
                Modifier
                    .fillMaxWidth()
                    .toggleable(value = on, role = Role.Switch, onValueChange = toggle)
                    .heightIn(min = 56.dp)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text("App lock", style = MaterialTheme.typography.bodyLarge, color = p.ink)
                    Text(
                        "Fingerprint, face or screen lock every time you open the app",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkFaint,
                    )
                }
                // The row handles the toggle, so the switch itself is not a second target.
                Switch(checked = on, onCheckedChange = null)
            }
        }
        if (on && !secure) {
            Notice(
                "This phone has no screen lock, so the app can’t be locked. Set a PIN, pattern or password in the phone’s settings.",
                Tone.WARNING,
                Modifier.padding(top = 10.dp),
            )
            TextButton(onClick = {
                lock.expectReturn()
                try {
                    context.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS))
                } catch (_: ActivityNotFoundException) {
                    context.startActivity(Intent(Settings.ACTION_SETTINGS))
                }
            }) { Text("Open security settings") }
        }
        error?.let { Notice(it, Tone.DANGER, Modifier.padding(top = 10.dp)) }
        Text(
            "Saved on this phone. While locked nothing is shown and nothing can be approved. With the lock on, the recent-apps preview shows a plain cover instead of your chats; screenshots still work. After a restart the app doesn’t connect to your computer until you unlock.",
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
        )
    }
}
