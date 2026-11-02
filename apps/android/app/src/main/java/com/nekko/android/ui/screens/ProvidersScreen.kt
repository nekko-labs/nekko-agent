package com.nekko.android.ui.screens

import androidx.compose.ui.platform.LocalResources
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ComputersRepository
import com.nekko.android.providers.ProviderSetupController
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ProviderSaveResult
import com.nekko.protocol.ProviderSetup
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RelayState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Settings → On <computer> → Providers (AN-36, the iPhone's computer page
 * Providers section and *Add a provider* sheet): the computer's model
 * providers with their switches, and adding one with a key sealed to the
 * computer before it leaves the phone (decision 0016).
 */
@Composable
fun ProvidersScreen(repo: ComputersRepository, onBack: () -> Unit) {
    val setup = remember(repo) {
        ProviderSetupController(
            read = { channel -> repo.caller.call(channel) },
            change = { channel, args, timeout -> repo.callChange(channel, args, timeoutMs = timeout) },
            changed = { repo.refresh() },
        )
    }
    var adding by rememberSaveable { mutableStateOf(false) }
    Box(Modifier.fillMaxSize().background(Nekko.palette.paper), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) {
            if (adding) AddProviderPage(repo, setup) { adding = false } else ProviderList(repo, setup, onBack) { adding = true }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Page(title: String, onBack: () -> Unit, close: Boolean = false, actions: @Composable () -> Unit = {}, content: @Composable (PaddingValues) -> Unit) {
    val p = Nekko.palette
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                title = { Text(title, modifier = Modifier.semantics { heading() }) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        if (close) Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.settings_cancel))
                        else Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.settings_back))
                    }
                },
                actions = { actions() },
            )
        },
        content = content,
    )
}

@Composable
private fun ProviderList(repo: ComputersRepository, setup: ProviderSetupController, onBack: () -> Unit, add: () -> Unit) {
    val p = Nekko.palette
    val c by repo.state.collectAsStateWithLifecycle()
    val computer = c.active?.name ?: stringResource(R.string.your_computer)
    val online = c.conn == RelayState.ONLINE
    val res = LocalResources.current
    val offlineNote = stringResource(R.string.settings_connect_to_change_providers, computer)
    val noneNote = stringResource(R.string.settings_no_providers_yet, computer)
    val addLabel = stringResource(R.string.settings_add_provider)
    val sealNote = stringResource(R.string.settings_provider_note, computer)
    val scope = rememberCoroutineScope()
    var switching by remember { mutableStateOf(emptySet<String>()) }
    var error by remember { mutableStateOf<String?>(null) }
    fun flip(provider: PublicProvider, on: Boolean) {
        switching = switching + provider.id
        scope.launch {
            try {
                setup.setEnabled(provider.id, on)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: res.getString(R.string.settings_provider_change_failed)
            } finally {
                switching = switching - provider.id
            }
        }
    }
    Page(stringResource(R.string.settings_providers), onBack) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).testTag("providers.list"), contentPadding = PaddingValues(vertical = 8.dp)) {
            if (!online) item { Note(offlineNote, Modifier.padding(16.dp)) }
            if (c.providers.isEmpty() && online) item { Note(noneNote, Modifier.padding(16.dp)) }
            items(c.providers, key = { it.id }) { pr ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 8.dp).testTag("providers.row"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(pr.label, style = MaterialTheme.typography.bodyLarge, color = if (pr.enabled) p.ink else p.inkSoft)
                        Text(ProviderSetup.kindName(pr.kind), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                    }
                    if (pr.id in switching) CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.padding(end = 12.dp).size(20.dp))
                    // A change on the computer (the fingerprint or screen lock); the row waits for its answer.
                    Switch(
                        checked = pr.enabled, onCheckedChange = { flip(pr, it) }, enabled = online && pr.id !in switching,
                        colors = SwitchDefaults.colors(checkedTrackColor = p.success),
                        modifier = Modifier.semantics { contentDescription = pr.label },
                    )
                }
                HorizontalDivider(color = p.line, modifier = Modifier.padding(start = 16.dp))
            }
            item {
                TextButton(onClick = add, enabled = online, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp).testTag("providers.add")) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(addLabel, modifier = Modifier.padding(start = 8.dp))
                }
                Note(
                    sealNote,
                    Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
        }
    }
    error?.let { e ->
        AlertDialog(onDismissRequest = { error = null }, text = { Text(e) }, confirmButton = { TextButton(onClick = { error = null }) { Text(stringResource(R.string.settings_ok)) } })
    }
}

/**
 * Pick a kind, paste the key, name it. The key lives only in this page's
 * memory (never in saved state, so not across a fold either) and is dropped
 * the moment the save returns, whatever happened.
 */
@Composable
private fun AddProviderPage(repo: ComputersRepository, setup: ProviderSetupController, onClose: () -> Unit) {
    val p = Nekko.palette
    val c by repo.state.collectAsStateWithLifecycle()
    val computer = c.active?.name ?: stringResource(R.string.your_computer)
    val res = LocalResources.current
    val scope = rememberCoroutineScope()
    var kindId by rememberSaveable { mutableStateOf(ProviderSetup.KINDS[0].id) }
    val kind = ProviderSetup.kind(kindId) ?: ProviderSetup.KINDS[0]
    var key by remember { mutableStateOf("") }
    var label by rememberSaveable { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<ProviderSaveResult?>(null) }
    BackHandler(onBack = onClose)
    fun save() {
        val name = label.trim().ifEmpty { kind.label }
        val id = ProviderSetup.id(name, kind.id, c.providers.map { it.id })
        busy = true
        failed = null
        scope.launch {
            try {
                saved = setup.save(id, kind.id, name, if (kind.takesUrl) url.ifBlank { kind.defaultUrl } else null, if (kind.needsKey) key else null)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed = e.message ?: res.getString(R.string.settings_provider_save_failed)
            } finally {
                // The key is dropped the moment the call returns.
                key = ""
                busy = false
            }
        }
    }
    val done = saved
    Page(stringResource(R.string.settings_add_provider), onClose, close = done == null, actions = {
        when {
            done != null -> TextButton(onClick = onClose) { Text(stringResource(R.string.settings_done)) }
            busy -> CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.padding(horizontal = 16.dp).size(22.dp))
            else -> TextButton(
                onClick = ::save, enabled = !(kind.needsKey && key.isBlank()) && c.conn == RelayState.ONLINE,
                modifier = Modifier.testTag("provider.save"),
            ) { Text(stringResource(R.string.settings_save_to, computer), maxLines = 1) }
        }
    }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (done != null) {
                Label(stringResource(R.string.settings_saved_models, computer))
                if (done.models.isEmpty()) Note(stringResource(R.string.settings_saved_no_models, computer))
                done.models.take(12).forEach { Text(it.name, style = MaterialTheme.typography.bodyLarge, color = p.ink) }
                if (done.models.size > 12) Note(stringResource(R.string.settings_and_n_more, done.models.size - 12))
                return@Column
            }
            Label(stringResource(R.string.settings_kind))
            ProviderSetup.KINDS.chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { k ->
                        val on = k.id == kind.id
                        Text(
                            k.label, textAlign = TextAlign.Center, fontWeight = FontWeight.SemiBold,
                            color = if (on) p.accentInk else p.ink, style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f).clip(RoundedCornerShape(12.dp))
                                .background(if (on) p.accent else p.surface)
                                .border(1.dp, if (on) p.accent else p.line, RoundedCornerShape(12.dp))
                                .clickable(role = Role.RadioButton) {
                                    kindId = k.id
                                    if (!k.needsKey) key = ""
                                    if (!k.takesUrl) url = ""
                                }
                                .semantics { selected = on }
                                .padding(vertical = 14.dp),
                        )
                    }
                    if (row.size == 1) Spacer(Modifier.weight(1f))
                }
            }
            if (kind.needsKey) {
                Label(stringResource(R.string.settings_api_key))
                OutlinedTextField(
                    key, { key = it }, singleLine = true, placeholder = { Text(stringResource(R.string.settings_paste_key)) },
                    visualTransformation = PasswordVisualTransformation(),
                    // A password field: the keyboard neither learns nor suggests it.
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth().testTag("provider.key"),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Filled.Lock, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(16.dp).padding(top = 2.dp))
                    Note(stringResource(R.string.settings_sealed_note, computer))
                }
            }
            if (kind.takesUrl) {
                Label(stringResource(R.string.settings_address))
                OutlinedTextField(
                    url, { url = it }, singleLine = true, placeholder = { Text(kind.defaultUrl) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().testTag("provider.url"),
                )
                Note(stringResource(R.string.settings_localhost_note, computer))
            }
            Label(stringResource(R.string.settings_name))
            OutlinedTextField(
                label, { label = it }, singleLine = true, placeholder = { Text(kind.label) },
                modifier = Modifier.fillMaxWidth().testTag("provider.label"),
            )
            failed?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = p.danger, modifier = Modifier.testTag("provider.error")) }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = Nekko.palette.inkFaint, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
}

@Composable
private fun Note(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkSoft, modifier = modifier)
}
