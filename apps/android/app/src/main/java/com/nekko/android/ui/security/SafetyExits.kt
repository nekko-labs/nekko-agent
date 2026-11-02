package com.nekko.android.ui.security

import android.content.res.Resources
import androidx.compose.ui.platform.LocalResources
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
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
class SafetyExits internal constructor(private val repo: ComputersRepository, private val scope: CoroutineScope, private val res: Resources) {
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
            SignOutResult.SENT -> res.getString(R.string.settings_signed_out_sent, name)
            SignOutResult.QUEUED -> res.getString(R.string.settings_signed_out_queued, name)
        }
    }

    fun stopRemoteAccess() = launchExit { name ->
        repo.stopRemoteAccess()
        res.getString(R.string.settings_remote_off, name)
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
            res.getString(R.string.settings_quitting, name)
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
        val name = repo.state.value.active?.name ?: res.getString(R.string.your_computer)
        busy = true
        outcome = null
        scope.launch {
            outcome = try {
                block(name) to Tone.SUCCESS
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                (e.message?.takeIf { it.isNotBlank() } ?: res.getString(R.string.settings_didnt_answer, name)) to Tone.DANGER
            } finally {
                busy = false
            }
        }
    }
}

@Composable
fun rememberSafetyExits(repo: ComputersRepository): SafetyExits {
    val scope = rememberCoroutineScope()
    val res = LocalResources.current
    return remember(repo, scope, res) { SafetyExits(repo, scope, res) }
}

/** One exit as a menu entry or a settings row: what it says, and whether it can run now. */
data class SafetyExit(val title: String, val detail: String, val icon: ImageVector, val danger: Boolean, val enabled: Boolean, val action: () -> Unit)

/**
 * The exits for the active computer, in order. Sign out works offline (the
 * computer is told later); stopping and quitting need the computer online;
 * quitting appears only when `app:info` says `quitFromPhone`.
 */
fun safetyExits(s: ComputersState, exits: SafetyExits, res: Resources): List<SafetyExit> {
    val name = s.active?.name ?: return emptyList()
    val online = s.conn == RelayState.ONLINE
    return buildList {
        add(
            SafetyExit(
                res.getString(R.string.settings_exit_sign_out),
                res.getString(R.string.settings_exit_sign_out_detail, name),
                Icons.AutoMirrored.Filled.Logout,
                danger = true,
                enabled = !exits.busy,
                action = exits::signOut,
            ),
        )
        add(
            SafetyExit(
                res.getString(R.string.settings_exit_stop, name),
                res.getString(if (online) R.string.settings_exit_stop_detail else R.string.settings_exit_must_be_online, name),
                Icons.Filled.WifiOff,
                danger = true,
                enabled = online && !exits.busy,
                action = exits::stopRemoteAccess,
            ),
        )
        if (s.quitFromPhone) {
            add(
                SafetyExit(
                    res.getString(R.string.settings_exit_quit, name),
                    res.getString(if (online) R.string.settings_exit_quit_detail else R.string.settings_exit_must_be_online, name),
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
    safetyExits(s, exits, LocalResources.current).forEach { e ->
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
        title = { Text(stringResource(R.string.settings_quit_title, computer)) },
        text = {
            Text(stringResource(R.string.settings_quit_text, computer))
        },
        confirmButton = { TextButton(onClick = exits::quit) { Text(stringResource(R.string.settings_quit), color = p.danger) } },
        dismissButton = { TextButton(onClick = exits::cancelQuit) { Text(stringResource(R.string.settings_cancel)) } },
    )
}
