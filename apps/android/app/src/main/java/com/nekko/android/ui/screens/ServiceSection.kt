package com.nekko.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.nekko.android.R
import com.nekko.android.computer.ServiceManagementModel
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.security.PendingStepUp
import com.nekko.android.ui.security.StepUpSheet
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ServiceAction
import com.nekko.protocol.ServiceNote
import com.nekko.protocol.ServiceNote.Kind
import com.nekko.protocol.ServiceUpdate
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The computer page's *Nekko Agent service* (#2059, the iPhone's ComputerServiceSection): its
 * state, its updater, and Check, Download, Install and Restart when the computer allows it.
 * Restart and install ask first and may need a step-up; nothing restarts the operating system.
 */
@Composable
fun ServiceSection(repo: ComputersRepository, computerId: String, computerName: String) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val model = remember(repo, computerId) { ServiceManagementModel(repo.serviceLink(computerId)) }
    val ui by model.ui.collectAsStateWithLifecycle()
    val s by repo.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Read again whenever the active computer or its connection changes, or the page comes back;
    // only a working updater is polled, and polling never sends a change.
    LaunchedEffect(model, s.activeId, s.conn) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            model.connectionChanged()
            while (true) {
                delay(2_000)
                model.poll()
            }
        }
    }

    SectionHeader(stringResource(R.string.service_title))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard(Modifier.testTag("service.section")) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!ui.online) {
                    Text(stringResource(R.string.service_offline), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.testTag("service.offline"))
                } else {
                    if (ui.loading) Busy(stringResource(R.string.service_reading))
                    ui.inFlight?.let { Busy(stringResource(actionTitle(it)), Modifier.testTag("service.inFlight")) }
                    if (ui.status != null) Fact(stringResource(R.string.service_status), stringResource(R.string.service_running), Modifier.testTag("service.status"))
                    if (ui.status?.manageServiceFromPhone == false) {
                        Text(stringResource(R.string.service_opt_in, computerName), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.testTag("service.optIn"))
                    }
                    ui.update?.let { u ->
                        Fact(stringResource(R.string.service_updater), stringResource(updateLabel(u.state)), Modifier.testTag("service.updateState"))
                        u.version?.let { Fact(stringResource(R.string.service_update_version), it) }
                        val percent = u.percent
                        if (u.state == ServiceUpdate.State.DOWNLOADING && percent != null) {
                            Text(stringResource(R.string.service_downloaded_percent, percent.toInt()), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                            LinearProgressIndicator(progress = { (percent / 100).toFloat() }, modifier = Modifier.fillMaxWidth(), color = p.accent, trackColor = p.surface2)
                        }
                    }
                    TextButton(
                        onClick = { scope.launch { model.refresh() } },
                        enabled = !ui.loading && ui.inFlight == null,
                        modifier = Modifier.testTag("service.refresh"),
                    ) {
                        Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text(stringResource(R.string.service_refresh), modifier = Modifier.padding(start = 6.dp))
                    }
                    if (ui.status?.manageServiceFromPhone == true) {
                        for (a in listOf(ServiceAction.UPDATE_CHECK, ServiceAction.UPDATE_DOWNLOAD, ServiceAction.UPDATE_INSTALL, ServiceAction.RESTART)) {
                            HorizontalDivider(color = p.line)
                            val reason = model.disabledReason(a, ui)
                            TextButton(
                                onClick = { scope.launch { model.request(a) } },
                                enabled = reason == null,
                                modifier = Modifier.heightIn(min = 48.dp).testTag("service.${a.wire}"),
                            ) { Text(stringResource(actionTitle(a)), color = if (reason == null) (if (a.needsConfirmation) p.danger else p.accent) else p.inkFaint) }
                            if (reason != null && ui.inFlight == null && !ui.loading) {
                                Text(noteText(reason, computerName), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.padding(start = 12.dp))
                            }
                        }
                    }
                }
                ui.notice?.let { n ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("service.notice")) {
                        Icon(Icons.Outlined.Info, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(18.dp))
                        Text(noteText(n, computerName), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                    }
                }
                ui.problem?.let { n ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("service.problem")) {
                        Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = p.danger, modifier = Modifier.size(18.dp))
                        val unknown = if (ui.outcomeUnknown) " " + stringResource(R.string.service_outcome_unknown) else ""
                        Text(noteText(n, computerName) + unknown, style = MaterialTheme.typography.bodySmall, color = p.danger)
                    }
                }
            }
        }
        Text(stringResource(R.string.service_footer), style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp))
    }

    ui.confirming?.let { a ->
        AlertDialog(
            onDismissRequest = { model.cancelConfirmation() },
            title = { Text(stringResource(actionTitle(a))) },
            text = { Text(stringResource(if (a == ServiceAction.RESTART) R.string.service_confirm_restart else R.string.service_confirm_install)) },
            confirmButton = {
                TextButton(onClick = { scope.launch { model.confirm() } }, modifier = Modifier.testTag("service.confirm")) {
                    Text(stringResource(actionTitle(a)), color = p.danger)
                }
            },
            dismissButton = { TextButton(onClick = { model.cancelConfirmation() }, modifier = Modifier.testTag("service.cancel")) { Text(stringResource(R.string.settings_cancel)) } },
        )
    }
    ui.stepUp?.let { a ->
        val name = stringResource(actionTitle(a))
        val pending = remember(a) { PendingStepUp(name) { proof -> model.stepUpRetry(proof) } }
        StepUpSheet(repo, pending, onDone = {}, onDismiss = { model.stepUpCancelled() })
    }
}

@Composable
private fun Busy(text: String, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator(strokeWidth = 2.dp, color = Nekko.palette.accent, modifier = Modifier.size(16.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkSoft)
    }
}

@Composable
private fun Fact(label: String, value: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = Nekko.palette.ink)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = Nekko.palette.inkSoft)
    }
}

private fun actionTitle(a: ServiceAction) = when (a) {
    ServiceAction.RESTART -> R.string.service_restart
    ServiceAction.UPDATE_STATE -> R.string.service_refresh
    ServiceAction.UPDATE_CHECK -> R.string.service_update_check
    ServiceAction.UPDATE_DOWNLOAD -> R.string.service_update_download
    ServiceAction.UPDATE_INSTALL -> R.string.service_update_install
}

private fun updateLabel(s: ServiceUpdate.State) = when (s) {
    ServiceUpdate.State.IDLE -> R.string.service_update_idle
    ServiceUpdate.State.CHECKING -> R.string.service_update_checking
    ServiceUpdate.State.AVAILABLE -> R.string.service_update_available
    ServiceUpdate.State.DOWNLOADING -> R.string.service_update_downloading
    ServiceUpdate.State.DOWNLOADED -> R.string.service_update_downloaded
    ServiceUpdate.State.NONE -> R.string.service_update_none
    ServiceUpdate.State.ERROR -> R.string.service_update_error
}

/** A note in the phone's language, with the computer's own words after it when it gave some. */
@Composable
private fun noteText(n: ServiceNote, computer: String): String {
    val base = when (n.kind) {
        Kind.OFFLINE -> stringResource(R.string.service_note_offline)
        Kind.WAIT -> stringResource(R.string.service_note_wait)
        Kind.RECONNECT_FIRST -> stringResource(R.string.service_note_reconnect_first)
        Kind.UPDATE_HOST -> stringResource(R.string.service_note_update_host)
        Kind.REFRESH_FIRST -> stringResource(R.string.service_note_refresh_first)
        Kind.OPT_IN -> stringResource(R.string.service_opt_in, computer)
        Kind.DOWNLOAD_FIRST -> stringResource(R.string.service_note_download_first)
        Kind.CHECK_FIRST -> stringResource(R.string.service_note_check_first)
        Kind.UPDATER_BUSY -> stringResource(R.string.service_note_updater_busy)
        Kind.CAP_SUPERVISOR -> stringResource(R.string.service_cap_supervisor)
        Kind.CAP_NATIVE_UPDATER -> stringResource(R.string.service_cap_native_updater)
        Kind.CAP_NOT_PACKAGED -> stringResource(R.string.service_cap_not_packaged)
        Kind.CAP_FEED -> stringResource(R.string.service_cap_feed)
        Kind.CAP_PACKAGED_INSTALL -> stringResource(R.string.service_cap_packaged_install)
        Kind.CAP_LOCAL_APPROVAL -> stringResource(R.string.service_cap_local_approval)
        Kind.CAP_LAYOUT -> stringResource(R.string.service_cap_layout)
        Kind.CAP_ALREADY_REQUESTED -> stringResource(R.string.service_cap_already_requested)
        Kind.CAP_OTHER -> stringResource(R.string.service_cap_other)
        Kind.CONNECTION_CHANGED -> stringResource(R.string.service_note_connection_changed)
        Kind.UNSUPPORTED_RESPONSE -> stringResource(R.string.service_note_unsupported_response)
        Kind.UNREADABLE_UPDATE -> stringResource(R.string.service_note_unreadable_update)
        Kind.UPDATER_FAILED -> stringResource(R.string.service_note_updater_failed)
        Kind.NOT_ACCEPTED -> stringResource(R.string.service_note_not_accepted)
        Kind.NOT_SUPPORTED_HERE -> stringResource(R.string.service_note_not_supported_here)
        Kind.SERVICE_UNAVAILABLE -> stringResource(R.string.service_note_unavailable)
        Kind.SERVICE_BUSY -> stringResource(R.string.service_note_busy)
        Kind.NOT_READY -> stringResource(R.string.service_note_not_ready)
        Kind.INVALID -> stringResource(R.string.service_note_invalid)
        Kind.HOST_TOO_OLD -> stringResource(R.string.service_note_host_too_old)
        Kind.NOT_CONFIRMED -> stringResource(R.string.service_note_not_confirmed, computer)
        Kind.OTHER -> n.detail ?: stringResource(R.string.service_note_failed)
        Kind.RESTART_ACCEPTED -> stringResource(R.string.service_note_restart_accepted)
        Kind.INSTALL_ACCEPTED -> stringResource(R.string.service_note_install_accepted)
    }
    return if (n.kind != Kind.OTHER && n.detail != null) "$base ${n.detail}" else base
}
