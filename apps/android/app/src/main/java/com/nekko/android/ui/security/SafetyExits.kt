package com.nekko.android.ui.security

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.ComputersRepository.SignOutResult
import com.nekko.android.data.ComputersState
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.RelayState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The phone's safety exits (SK-8, decision 0018), shared by Settings → This
 * computer and the connection banner's menu: *Sign out this phone*, *Stop
 * remote access on the computer*, and *Quit Nekko Agent on the computer*
 * (behind a confirm, and only when the computer allows it). None asks for a
 * proof or a step-up: a safety exit must never be harder than the attack.
 */
class SafetyExits internal constructor(private val repo: ComputersRepository, private val scope: CoroutineScope) {
    /** The last outcome, in plain words, for the screen to show. */
    var outcome by mutableStateOf<Pair<String, Tone>?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    /** The quit confirmation is up. */
    var confirmingQuit by mutableStateOf(false)
        private set

    fun signOut() = launchExit { name ->
        when (repo.signOutThisPhone()) {
            SignOutResult.SENT -> "Signed out of $name. To use it from this phone again, pair with a new code from $name."
            SignOutResult.QUEUED -> "Signed out of $name on this phone. $name will hear it the next time this phone reaches it."
        }
    }

    fun stopRemoteAccess() = launchExit { name ->
        repo.stopRemoteAccess()
        "Remote access is off on $name and every phone was disconnected. Only $name can turn it on again (Settings → Remote access)."
    }

    fun askQuit() {
        confirmingQuit = true
    }

    fun cancelQuit() {
        confirmingQuit = false
    }

    fun quit() {
        confirmingQuit = false
        launchExit { name ->
            repo.quitComputer()
            "Nekko Agent is quitting on $name. Start it again there when you need it."
        }
    }

    /** After *Stop remote access*: dial again once the owner turned it back on at the computer. */
    fun reconnect() {
        val id = repo.state.value.activeId ?: return
        outcome = null
        scope.launch { repo.connect(id) }
    }

    private fun launchExit(block: suspend (name: String) -> String) {
        if (busy) return
        val name = repo.state.value.active?.name ?: "your computer"
        busy = true
        outcome = null
        scope.launch {
            outcome = try {
                block(name) to Tone.SUCCESS
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                (e.message?.takeIf { it.isNotBlank() } ?: "$name didn’t answer. Try again.") to Tone.DANGER
            } finally {
                busy = false
            }
        }
    }
}

@Composable
fun rememberSafetyExits(repo: ComputersRepository): SafetyExits {
    val scope = rememberCoroutineScope()
    return remember(repo, scope) { SafetyExits(repo, scope) }
}

/** One exit as a menu entry or a settings row: what it says, and whether it can run now. */
data class SafetyExit(val title: String, val detail: String, val icon: ImageVector, val danger: Boolean, val enabled: Boolean, val action: () -> Unit)

/**
 * The exits for the active computer, in order. Sign out works offline (the
 * computer is told later); stopping and quitting need the computer online;
 * quitting appears only when `app:info` says `quitFromPhone`.
 */
fun safetyExits(s: ComputersState, exits: SafetyExits): List<SafetyExit> {
    val name = s.active?.name ?: return emptyList()
    val online = s.conn == RelayState.ONLINE
    return buildList {
        add(
            SafetyExit(
                "Sign out this phone",
                "Forget $name here; $name removes this phone",
                Icons.AutoMirrored.Filled.Logout,
                danger = true,
                enabled = !exits.busy,
                action = exits::signOut,
            ),
        )
        add(
            SafetyExit(
                "Stop remote access on $name",
                if (online) "Disconnects every phone; only $name can turn it back on" else "$name must be online",
                Icons.Filled.WifiOff,
                danger = true,
                enabled = online && !exits.busy,
                action = exits::stopRemoteAccess,
            ),
        )
        if (s.quitFromPhone) {
            add(
                SafetyExit(
                    "Quit Nekko Agent on $name",
                    if (online) "Running chats stop; start it again at $name" else "$name must be online",
                    Icons.Filled.PowerSettingsNew,
                    danger = true,
                    enabled = online && !exits.busy,
                    action = exits::askQuit,
                ),
            )
        }
    }
}

/** The exits as overflow-menu entries (the connection banner's ⋮). */
@Composable
fun SafetyExitMenuItems(s: ComputersState, exits: SafetyExits, onPicked: () -> Unit) {
    val p = Nekko.palette
    safetyExits(s, exits).forEach { e ->
        DropdownMenuItem(
            text = { Text(e.title, color = if (e.danger) p.danger else p.ink) },
            leadingIcon = { Icon(e.icon, contentDescription = null, tint = if (e.danger) p.danger else p.inkSoft) },
            enabled = e.enabled,
            onClick = {
                onPicked()
                e.action()
            },
        )
    }
}

/** The quit confirmation, wherever the exits are offered. */
@Composable
fun SafetyExitDialogs(exits: SafetyExits, computer: String) {
    val p = Nekko.palette
    if (!exits.confirmingQuit) return
    AlertDialog(
        onDismissRequest = exits::cancelQuit,
        title = { Text("Quit Nekko Agent on $computer?") },
        text = {
            Text("Nekko Agent and its background service stop on $computer, and any running chats are interrupted. A phone can’t start it again: someone at $computer has to.")
        },
        confirmButton = { TextButton(onClick = exits::quit) { Text("Quit", color = p.danger) } },
        dismissButton = { TextButton(onClick = exits::cancelQuit) { Text("Cancel") } },
    )
}
