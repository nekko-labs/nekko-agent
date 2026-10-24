package com.nekko.android.ui.security

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ComputersRepository
import com.nekko.android.security.CredentialManagerKeys
import com.nekko.android.security.StepUpController
import com.nekko.android.security.StepUpUi
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.StepUpProof
import kotlinx.coroutines.launch

/**
 * A guarded action that came back `step-up-required` (or another step-up
 * refusal) and is waiting for the second factor: [action] says what it is in
 * plain words, [retry] sends it again with the step-up.
 */
class PendingStepUp(val action: String, val retry: suspend (StepUpProof) -> Unit)

/**
 * The step-up sheet (SK-7): *Confirm with your security key*, a **Use a code**
 * fallback, the action's name and target, and the hardware-key note. Opens
 * over the screen whose guarded call was refused; [onDone] runs once the call
 * went through, [onDismiss] on Cancel (nothing changed).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StepUpSheet(repo: ComputersRepository, pending: PendingStepUp, onDone: () -> Unit, onDismiss: () -> Unit) {
    val p = Nekko.palette
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val computer = repo.state.value.active?.name ?: "your computer"
    val controller = remember(pending) {
        StepUpController(
            challenge = { repo.stepUpChallenge() },
            retry = pending.retry,
            keys = CredentialManagerKeys(context),
            computer = computer,
        )
    }
    val ui by controller.ui.collectAsStateWithLifecycle()
    var code by rememberSaveable(pending) { mutableStateOf("") }
    var codeOpen by rememberSaveable(pending) { mutableStateOf(false) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    LaunchedEffect(controller) { controller.open() }
    LaunchedEffect(ui.phase) { if (ui.phase == StepUpUi.Phase.DONE) onDone() }
    // Only a code is registered (or keys can't be asked from here): show the field straight away.
    val showCode = ui.offersCode && (codeOpen || !ui.offersKey)

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = p.paper) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .navigationBarsPadding()
                .imePadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                if (ui.offersKey) "Confirm with your security key" else "Confirm it’s you",
                style = MaterialTheme.typography.titleMedium,
                color = p.ink,
                modifier = Modifier.semantics { heading() },
            )
            Text(pending.action, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)

            when (ui.phase) {
                StepUpUi.Phase.LOADING, StepUpUi.Phase.DONE -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                StepUpUi.Phase.NO_METHOD -> Notice(
                    "$computer asks for a security key or a code, but none it has can answer from a phone. Do this on $computer.",
                    Tone.WARNING,
                )
                StepUpUi.Phase.READY -> {
                    if (ui.offersKey) {
                        Text(
                            "Touch your key when it blinks, or hold it to the back of the phone. A passkey on this phone works too.",
                            style = MaterialTheme.typography.bodySmall,
                            color = p.inkFaint,
                        )
                        Button(
                            onClick = { scope.launch { controller.useKey() } },
                            enabled = !ui.busy,
                            colors = ButtonDefaults.buttonColors(containerColor = p.accent, contentColor = p.accentInk),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) {
                            Icon(Icons.Filled.Key, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text("Use security key or passkey")
                        }
                    } else if (ui.keysUnavailable) {
                        Text(
                            "Security keys and passkeys for $computer can’t be used from this phone yet.",
                            style = MaterialTheme.typography.bodySmall,
                            color = p.inkFaint,
                        )
                    }
                    if (showCode) {
                        val submit = { scope.launch { controller.useCode(code) }; Unit }
                        OutlinedTextField(
                            value = code,
                            onValueChange = { v -> code = v.filter { it.isDigit() || it == ' ' }.take(7) },
                            label = { Text("Code from your authenticator app") },
                            singleLine = true,
                            enabled = !ui.busy,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                            keyboardActions = KeyboardActions(onDone = { submit() }),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedButton(
                            onClick = submit,
                            enabled = !ui.busy && code.isNotBlank(),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) { Text("Confirm with code") }
                    } else if (ui.offersCode) {
                        TextButton(onClick = { codeOpen = true }, enabled = !ui.busy) { Text("Use a code") }
                    }
                    if (ui.busy) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                            Text("Checking with $computer…", style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                        }
                    }
                }
            }
            ui.error?.let {
                Notice(it, Tone.DANGER, Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
            HardwareKeyNote()
            Spacer(Modifier.size(8.dp))
        }
    }
}
