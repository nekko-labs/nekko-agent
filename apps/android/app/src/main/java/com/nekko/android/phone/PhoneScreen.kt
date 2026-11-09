package com.nekko.android.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import com.nekko.android.ui.chat.ChatColumns
import com.nekko.android.ui.panes.TabletopSplit
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.ui.chat.MarkdownText
import com.nekko.android.ui.panes.rememberWindowPosture
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.PhoneChat
import com.nekko.protocol.PhoneProviders
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** A separate native destination: no remote controllers, tools, attachments or sync. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhoneScreen(phone: PhoneChats, onBack: () -> Unit) {
    val s by phone.state.collectAsStateWithLifecycle()
    if (!s.ready) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Opening phone chats…") }
        return
    }
    val scope = rememberCoroutineScope()
    var chatId by rememberSaveable { mutableStateOf<String?>(null) }
    var providers by rememberSaveable { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    var keyFor by remember { mutableStateOf<String?>(null) }
    var remove by remember { mutableStateOf<String?>(null) }
    var forget by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val p = Nekko.palette
    val window = rememberWindowPosture()
    val action: (suspend () -> Unit) -> Unit = { block -> scope.launch {
        busy = true
        try { block() } catch (e: CancellationException) { throw e } catch (_: Exception) { notice = "Could not complete this action. Check the address, key and connection." } finally { busy = false }
    }; Unit }
    Scaffold(containerColor = p.paper, topBar = {
        TopAppBar(title = { Text(if (providers) "Phone providers" else "This phone") }, colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper), navigationIcon = {
            TextButton(onClick = { if (providers) providers = false else if (chatId != null) chatId = null else onBack() }) { Text("Back") }
        }, actions = { if (!providers) TextButton(onClick = { providers = true }, modifier = Modifier.testTag("phone.providers")) { Text("Providers") } })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            notice?.let { text -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(text, Modifier.weight(1f).padding(horizontal = 20.dp), color = p.inkSoft)
                TextButton(onClick = { notice = null }) { Text("Dismiss") }
            } }
            if (providers) {
                LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    item { Text("Keys stay on this device. Chats go directly to your provider.", color = p.inkSoft) }
                    item { Button(onClick = { adding = true }, enabled = !busy, modifier = Modifier.testTag("phone.add")) { Text("Add provider") } }
                    items(s.providers, key = { it.id }) { provider ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(provider.label, style = MaterialTheme.typography.titleMedium, color = p.ink)
                                    Text(PhoneProviders.kind(provider.kind)?.label.orEmpty(), color = p.inkSoft)
                                }
                                Switch(checked = provider.enabled, onCheckedChange = { action { phone.enabled(provider.id, it) } }, enabled = !busy, modifier = Modifier.testTag("phone.enable.${provider.id}"))
                            }
                            Row {
                                if (provider.enabled) TextButton(onClick = { action { notice = phone.test(provider.id) } }, enabled = !busy) { Text("Test") }
                                TextButton(onClick = { keyFor = provider.id }, enabled = !busy) { Text("New key") }
                                TextButton(onClick = { remove = provider.id }, enabled = !busy) { Text("Remove") }
                            }
                            s.errors[provider.id]?.let { Text(it, color = p.inkSoft) }
                        }
                    }
                    item { Text("Claude and ChatGPT subscriptions and local model servers need a computer.", color = p.inkSoft, modifier = Modifier.padding(vertical = 20.dp)) }
                }
            } else {
                BoxWithConstraints(Modifier.weight(1f)) {
                    val availableWidth = maxWidth
                    val horizontalHinge = window.hinge?.let { it.orientation == com.nekko.protocol.Hinge.Orientation.HORIZONTAL && (it.isSeparating || it.state == com.nekko.protocol.Hinge.State.HALF_OPENED) } == true
                    val wide = maxWidth >= 600.dp && !horizontalHinge
                    val chat = s.chats.firstOrNull { it.id == chatId }
                    val list: @Composable (Modifier) -> Unit = { modifier ->
                        LazyColumn(modifier.padding(horizontal = 20.dp).testTag("phone.chatList"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            item { Text("Direct cloud chats. No computer, tools, photos or sync.", color = p.inkSoft) }
                            item { Button(onClick = { if (s.providers.none { it.enabled }) { providers = true } else picking = true }, modifier = Modifier.testTag("phone.new")) { Text("New chat") } }
                            if (s.chats.isEmpty()) item { Text("Add a provider to start a chat here.", color = p.inkSoft) }
                            items(s.chats, key = { it.id }) { c -> TextButton(onClick = { chatId = c.id }, modifier = Modifier.fillMaxWidth().testTag("phone.open.${c.id}")) {
                                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start) {
                                    Text(c.title, color = if (c.id == chatId) p.accent else p.ink)
                                    Text(if (c.id in s.running) "Replying…" else c.modelId, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                                }
                            } }
                        }
                    }
                    if (wide) Row(Modifier.fillMaxSize().testTag("phone.expanded")) {
                        val hinge = window.hinge?.bounds
                        val listWidth = hinge?.x?.dp ?: (availableWidth * .35f)
                        list(Modifier.width(listWidth).fillMaxHeight())
                        if (hinge != null) Spacer(Modifier.width(hinge.width.dp))
                        Box(Modifier.weight(1f)) { if (chat != null) PhoneConversation(phone, chat, chat.id in s.running, { forget = chat.id }) else Text("Choose a chat", Modifier.padding(20.dp), color = p.inkSoft) }
                    } else if (chat != null) PhoneConversation(phone, chat, chat.id in s.running, { forget = chat.id })
                    else list(Modifier.fillMaxSize())
                }
            }
        }
    }
    if (adding) ProviderForm(onDismiss = { adding = false }) { kind, label, url, key, workspace ->
        action { phone.add(kind, label, url, key, workspace); adding = false; notice = "Provider saved. Test it before starting a chat." }
    }
    keyFor?.let { providerId ->
        var key by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { keyFor = null }, title = { Text("New key") }, text = {
            OutlinedTextField(key, { key = it }, label = { Text("Key or access token") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.testTag("phone.newKey"))
        }, confirmButton = { TextButton(onClick = { action { phone.setKey(providerId, key); key = ""; keyFor = null } }, enabled = !busy) { Text("Save key") } }, dismissButton = { TextButton(onClick = { key = ""; keyFor = null }) { Text("Cancel") } })
    }
    remove?.let { id -> AlertDialog(onDismissRequest = { remove = null }, title = { Text("Remove provider and key?") }, text = { Text("Saved chats stay readable, but cannot send with this provider.") }, confirmButton = { TextButton(onClick = { action { phone.remove(id); remove = null } }, enabled = !busy) { Text("Remove provider") } }, dismissButton = { TextButton(onClick = { remove = null }) { Text("Cancel") } }) }
    forget?.let { id -> AlertDialog(onDismissRequest = { forget = null }, title = { Text("Forget this chat?") }, text = { Text("Permanently remove its messages from this device. This does not delete the provider's records.") }, confirmButton = { TextButton(onClick = { action { phone.forget(id); chatId = null; forget = null } }, enabled = !busy) { Text("Forget chat") } }, dismissButton = { TextButton(onClick = { forget = null }) { Text("Cancel") } }) }
    if (picking) {
        LaunchedEffect(Unit) { s.providers.filter { it.enabled }.forEach { phone.models(it.id) } }
        AlertDialog(onDismissRequest = { picking = false }, title = { Text("Choose a model") }, text = {
            LazyColumn { s.providers.filter { it.enabled }.forEach { provider ->
                item { Text(provider.label, style = MaterialTheme.typography.titleMedium) }
                s.errors[provider.id]?.let { error -> item { Text(error); TextButton(onClick = { action { phone.models(provider.id) } }) { Text("Retry models") } } }
                items(s.models[provider.id].orEmpty()) { model -> TextButton(onClick = { action { chatId = phone.newChat(provider.id, model.id); picking = false } }, modifier = Modifier.testTag("phone.model.${model.id}")) { Text(model.name) } }
            } }
        }, confirmButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } })
    }
}

@Composable
private fun ProviderForm(onDismiss: () -> Unit, onSave: (String, String, String, String, String) -> Unit) {
    var kindId by remember { mutableStateOf("anthropic") }
    val kind = PhoneProviders.kind(kindId)!!
    var label by remember { mutableStateOf(kind.label) }
    var url by remember { mutableStateOf(kind.defaultUrl) }
    var key by remember { mutableStateOf("") }
    var workspace by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var choosing by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Add phone provider") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { choosing = !choosing }, modifier = Modifier.testTag("phone.kind")) { Text(kind.label) }
            if (choosing) PhoneProviders.kinds.forEach { k -> TextButton(onClick = { kindId = k.id; label = k.label; url = k.defaultUrl; key = ""; choosing = false }) { Text(k.label) } }
            Text(kind.hint)
            OutlinedTextField(label, { label = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.testTag("phone.label"))
            OutlinedTextField(url, { url = it }, label = { Text("HTTPS address") }, singleLine = true, modifier = Modifier.testTag("phone.url"))
            OutlinedTextField(key, { key = it }, label = { Text(if (kindId == "vertex") "Access token" else "API key") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.testTag("phone.key"))
            if (kindId == "anthropic") OutlinedTextField(workspace, { workspace = it }, label = { Text("Workspace ID (optional)") }, singleLine = true)
            error?.let { Text(it) }
        }
    }, confirmButton = { TextButton(onClick = {
        try { PhoneProviders.make("check", kindId, label, url, key, workspace); onSave(kindId, label, url, key, workspace); key = "" }
        catch (e: IllegalArgumentException) { error = e.message }
    }, modifier = Modifier.testTag("phone.save")) { Text("Save provider") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
private fun PhoneConversation(phone: PhoneChats, chat: PhoneChat, running: Boolean, onForget: () -> Unit) {
    var text by rememberSaveable(chat.id) { mutableStateOf("") }
    val p = Nekko.palette
    val s by phone.state.collectAsStateWithLifecycle()
    val canSend = s.providers.any { it.id == chat.providerId && it.enabled }
    val window = rememberWindowPosture()
    val density = LocalDensity.current
    var topDp by remember { mutableFloatStateOf(0f) }
    val horizontal = window.hinge?.takeIf { it.orientation == com.nekko.protocol.Hinge.Orientation.HORIZONTAL && (it.isSeparating || it.state == com.nekko.protocol.Hinge.State.HALF_OPENED) }
    val tabletop = horizontal?.let { TabletopSplit((it.bounds.y - topDp).coerceAtLeast(0f).dp, it.bounds.height.dp) }
    val list = androidx.compose.foundation.lazy.rememberLazyListState()
    LaunchedEffect(chat.messages.lastOrNull()?.text, chat.messages.size) { if (chat.messages.isNotEmpty()) list.animateScrollToItem(chat.messages.size) }
    Box(Modifier.fillMaxSize().testTag("phone.conversation").onGloballyPositioned { topDp = with(density) { it.positionInWindow().y.toDp().value } }) {
        ChatColumns(top = 0.dp, tabletop = tabletop, transcript = { modifier ->
        Column(modifier) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(chat.title, Modifier.weight(1f), color = p.ink, style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = onForget) { Text("Forget") }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 20.dp), state = list, verticalArrangement = Arrangement.spacedBy(20.dp)) {
            item { Text("${chat.modelId} · No tools or computer access", color = p.inkSoft, style = MaterialTheme.typography.bodySmall) }
            items(chat.messages, key = { it.id }) { m -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (m.role == "user") "You" else "Nekko", color = p.inkSoft, style = MaterialTheme.typography.labelMedium)
                if (m.text.isNotEmpty()) MarkdownText(text = m.text, color = p.ink)
                if (m.error == PhoneChats.STREAMING && m.text.isEmpty()) Text("Thinking…", color = p.inkSoft)
                if (m.error != null && m.error != PhoneChats.STREAMING) Text(m.error.orEmpty(), color = p.inkSoft)
            } }
        }
        }
        }, controls = {
        if (!canSend) Text("Enable this provider to send. Removed providers leave chats read-only.", Modifier.padding(20.dp), color = p.inkSoft)
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(text, { text = it }, enabled = canSend && !running, label = { Text("Message") }, modifier = Modifier.weight(1f).testTag("phone.message"), maxLines = 5)
            if (running) TextButton(onClick = { phone.stop(chat.id) }, modifier = Modifier.testTag("phone.stop")) { Text("Stop") }
            else Button(onClick = { phone.send(chat.id, text); text = "" }, enabled = canSend && text.isNotBlank(), modifier = Modifier.testTag("phone.send")) { Text("Send") }
        }
        if (!running && canSend && chat.messages.lastOrNull()?.role == "assistant") TextButton(onClick = { phone.send(chat.id, "", retry = true) }, modifier = Modifier.testTag("phone.retry")) { Text("Retry last reply") }
        })
    }
}
