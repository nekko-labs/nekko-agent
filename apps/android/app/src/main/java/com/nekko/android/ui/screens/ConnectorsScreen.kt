package com.nekko.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.data.Connectors
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.PhoneConnector
import com.nekko.protocol.PhoneConnectors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The services this phone is connected to (#2109, the iPhone's ConnectorsView, decision 0058): a
 * git provider for Pull requests, and the project tools the person works in. Tokens stay in this
 * phone's Keystore-sealed store and go only to their own service.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectorsScreen(connectors: Connectors, onBack: () -> Unit) {
    val p = Nekko.palette
    val s by connectors.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var connecting by remember { mutableStateOf<PhoneConnectors.Kind?>(null) }
    var removing by remember { mutableStateOf<PhoneConnector?>(null) }
    LaunchedEffect(Unit) { connectors.load() }
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.connectors_title)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.chats_back)) } },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).testTag("connectors.view")) {
            Text(stringResource(R.string.connectors_intro), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.padding(vertical = 8.dp))
            Section(stringResource(R.string.connectors_git), PhoneConnectors.Category.GIT, s, onConnect = { connecting = it }, onRemove = { removing = it })
            if (s.git.size > 1) {
                NCard(Modifier.padding(top = 8.dp)) {
                    Text(stringResource(R.string.connectors_prs_from), style = MaterialTheme.typography.titleSmall, color = p.ink)
                    s.git.forEach { c ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("connectors.gitPick.${c.kind}"), verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = s.gitProvider?.kind == c.kind, onClick = { scope.launch { connectors.selectGit(c.kind) } })
                            Text(c.label, color = p.ink)
                        }
                    }
                    Text(stringResource(R.string.connectors_prs_from_detail), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                }
            }
            Section(stringResource(R.string.connectors_tasks), PhoneConnectors.Category.TASKS, s, onConnect = { connecting = it }, onRemove = { removing = it })
        }
    }
    connecting?.let { kind -> ConnectDialog(connectors, kind, s.connector(kind.id)) { connecting = null } }
    removing?.let { c ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(R.string.connectors_disconnect_title, c.label)) },
            text = { Text(stringResource(R.string.connectors_disconnect_text)) },
            confirmButton = { TextButton(onClick = { scope.launch { connectors.disconnect(c.kind) }; removing = null }, modifier = Modifier.testTag("connectors.disconnect.confirm")) { Text(stringResource(R.string.connectors_disconnect), color = p.danger) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.chats_cancel)) } },
        )
    }
}

@Composable
private fun Section(title: String, category: PhoneConnectors.Category, s: Connectors.State, onConnect: (PhoneConnectors.Kind) -> Unit, onRemove: (PhoneConnector) -> Unit) {
    val p = Nekko.palette
    Text(title.uppercase(), style = MaterialTheme.typography.labelMedium, color = p.inkSoft, modifier = Modifier.padding(top = 16.dp, bottom = 6.dp, start = 4.dp).semantics { heading() })
    NCard {
        PhoneConnectors.kinds.filter { it.category == category }.forEachIndexed { i, kind ->
            if (i > 0) HorizontalDivider(color = p.line)
            Row(kind, s.connector(kind.id), onConnect, onRemove)
        }
    }
}

@Composable
private fun Row(kind: PhoneConnectors.Kind, c: PhoneConnector?, onConnect: (PhoneConnectors.Kind) -> Unit, onRemove: (PhoneConnector) -> Unit) {
    val p = Nekko.palette
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("connectors.row.${kind.id}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        ConnectorMark(kind)
        Column(Modifier.weight(1f)) {
            Text(kind.label, color = p.ink, style = MaterialTheme.typography.bodyLarge)
            if (c != null) {
                Text(c.account?.let { stringResource(R.string.connectors_connected_as, it) } ?: stringResource(R.string.connectors_connected), style = MaterialTheme.typography.bodySmall, color = p.success)
            } else {
                Text(stringResource(if (kind.category == PhoneConnectors.Category.GIT) R.string.connectors_git_detail else R.string.connectors_tasks_detail), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
            }
        }
        if (c != null) {
            var open by remember { mutableStateOf(false) }
            Box {
                val options = stringResource(R.string.connectors_options, kind.label)
                IconButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = options }.testTag("connectors.options.${kind.id}")) {
                    Icon(Icons.Outlined.MoreVert, contentDescription = null, tint = p.inkSoft)
                }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = p.surface) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.connectors_new_token)) }, leadingIcon = { Icon(Icons.Outlined.Key, null) }, onClick = { open = false; onConnect(kind) })
                    DropdownMenuItem(text = { Text(stringResource(R.string.connectors_disconnect), color = p.danger) }, leadingIcon = { Icon(Icons.Outlined.LinkOff, null, tint = p.danger) }, onClick = { open = false; onRemove(c) }, modifier = Modifier.testTag("connectors.disconnect.${kind.id}"))
                }
            }
        } else {
            OutlinedButton(onClick = { onConnect(kind) }, modifier = Modifier.heightIn(min = 48.dp).testTag("connectors.connect.${kind.id}")) { Text(stringResource(R.string.connectors_connect), color = p.accent) }
        }
    }
}

/**
 * A connector's brand mark on a quiet tile, as the desktop's connector cards draw it: the
 * service's own colours, and GitHub and Linear (monochrome marks) in the ink so they read in both themes.
 */
@Composable
fun ConnectorMark(kind: PhoneConnectors.Kind, size: Dp = 32.dp) {
    val p = Nekko.palette
    val res = when (kind.id) {
        "github" -> R.drawable.connector_github
        "gitlab" -> R.drawable.connector_gitlab
        "bitbucket" -> R.drawable.connector_bitbucket
        "linear" -> R.drawable.connector_linear
        "jira" -> R.drawable.connector_jira
        "floop" -> R.drawable.connector_floop
        "asana" -> R.drawable.connector_asana
        "clickup" -> R.drawable.connector_clickup
        "trello" -> R.drawable.connector_trello
        "todoist" -> R.drawable.connector_todoist
        else -> null
    }
    Box(Modifier.size(size).clip(RoundedCornerShape(size * 0.28f)).background(p.surface2).testTag("connectors.mark.${kind.id}"), contentAlignment = Alignment.Center) {
        if (res != null) {
            androidx.compose.foundation.Image(
                painterResource(res), contentDescription = null, modifier = Modifier.size(size * 0.6f),
                colorFilter = if (kind.id in setOf("github", "linear")) ColorFilter.tint(p.ink) else null,
            )
        } else Icon(Icons.Outlined.Checklist, contentDescription = null, tint = p.accent, modifier = Modifier.size(size * 0.5f))
    }
}

/** Connect one service: its fields and token. Connect checks the token with a real call and keeps nothing if it is turned down. */
@Composable
private fun ConnectDialog(connectors: Connectors, kind: PhoneConnectors.Kind, existing: PhoneConnector?, onDone: () -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    // Reconnecting keeps the address and email it had.
    var values by remember { mutableStateOf(existing?.settings.orEmpty()) }
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDone() },
        title = { Text(stringResource(R.string.connectors_connect_title, kind.label)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                kind.fields.forEach { f ->
                    OutlinedTextField(
                        values[f.id].orEmpty(), { v -> values = values + (f.id to v) },
                        label = { Text(f.label) }, placeholder = { Text(f.placeholder) }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = if (f.isUrl) KeyboardType.Uri else if (f.id == "email") KeyboardType.Email else KeyboardType.Text, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth().testTag("connect.field.${f.id}"),
                    )
                }
                OutlinedTextField(
                    token, { token = it }, label = { Text(kind.tokenName) }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().testTag("connect.token"),
                )
                Text(kind.hint + " " + stringResource(R.string.connectors_kept_here), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                failed?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger, modifier = Modifier.testTag("connect.error")) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && token.isNotBlank(),
                onClick = {
                    busy = true
                    failed = null
                    scope.launch {
                        try {
                            connectors.connect(kind.id, token, values)
                            token = ""
                            onDone()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            failed = e.message ?: "Couldn’t connect."
                        } finally {
                            busy = false
                        }
                    }
                },
                modifier = Modifier.testTag("connect.save"),
            ) { if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.connectors_connect)) }
        },
        dismissButton = { TextButton(onClick = onDone, enabled = !busy) { Text(stringResource(R.string.chats_cancel)) } },
    )
}
