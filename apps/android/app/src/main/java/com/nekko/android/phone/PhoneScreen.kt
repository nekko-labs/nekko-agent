package com.nekko.android.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
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
import androidx.compose.ui.draw.clip
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

/** A separate native destination: no remote controllers, tools or sync. Photos go to models that take them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhoneScreen(phone: PhoneChats, startChat: String? = null, openProviders: Boolean = false, addProvider: Boolean = false, startProvider: String? = null, onBack: () -> Unit) {
    val s by phone.state.collectAsStateWithLifecycle()
    if (!s.ready) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Opening phone chats…") }
        return
    }
    val scope = rememberCoroutineScope()
    // Opened from a row of the chat list (#2108): that chat, and Back returns to the list.
    var chatId by rememberSaveable { mutableStateOf(startChat) }
    // Opened from Settings → Models on This phone (#2940): on the providers, or straight on Add provider.
    var providers by rememberSaveable { mutableStateOf(openProviders) }
    var adding by remember { mutableStateOf(addProvider) }
    /** The add form's provider, set by a provider button (#2939); null starts on the first key kind. */
    var addKind by remember { mutableStateOf<String?>(null) }
    /** Anthropic's ways in, before its form: the API key, and the subscription it can't use here. */
    var anthropicChoice by remember { mutableStateOf(false) }
    /** The provider whose page is open (#2939, the iPhone's provider page). */
    var detail by rememberSaveable { mutableStateOf(startProvider) }
    /** A provider's last Test, said on its page, and whether it failed. */
    var tested by remember { mutableStateOf<Map<String, Pair<String, Boolean>>>(emptyMap()) }
    var testing by remember { mutableStateOf<String?>(null) }
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
        TopAppBar(title = { Text(if (providers) s.providers.firstOrNull { it.id == detail }?.label ?: "Models on this phone" else "This phone") }, colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper), navigationIcon = {
            TextButton(onClick = { if (providers && detail != null && detail != startProvider) detail = null else if (detail != null && detail == startProvider) onBack() else if (providers && !openProviders) providers = false else if (chatId != null && chatId != startChat) chatId = null else onBack() }) { Text("Back") }
        }, actions = { if (!providers) TextButton(onClick = { providers = true }, modifier = Modifier.testTag("phone.providers")) { Text("Providers") } })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            notice?.let { text -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(text, Modifier.weight(1f).padding(horizontal = 20.dp), color = p.inkSoft)
                TextButton(onClick = { notice = null }) { Text("Dismiss") }
            } }
            val open = s.providers.firstOrNull { it.id == detail }
            if (providers && open != null) {
                // A provider's page: on or off, Test, New key, Remove (#2939, the iPhone's #2931).
                ProviderPage(
                    provider = open,
                    status = providerStatus(open, s, tested[open.id]?.first, testing == open.id),
                    isError = testing != open.id && (tested[open.id]?.second ?: (s.errors[open.id] != null)),
                    busy = busy,
                    onEnabled = { on -> action { phone.enabled(open.id, on) } },
                    onTest = {
                        testing = open.id
                        scope.launch {
                            busy = true
                            tested = try { tested + (open.id to (phone.test(open.id) to false)) }
                            catch (e: CancellationException) { throw e }
                            catch (e: Exception) { tested + (open.id to ((e.message ?: "Test failed.") to true)) }
                            finally { testing = null; busy = false }
                        }
                    },
                    onNewKey = { keyFor = open.id },
                    onRemove = { remove = open.id },
                )
            } else if (providers) {
                LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp).testTag("phone.providerList"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    item { Text("Chats run on this phone itself, with your own key or ChatGPT sign-in, and have no tools. Keys and sign-ins stay on this phone.", color = p.inkSoft, style = MaterialTheme.typography.bodySmall) }
                    if (s.providers.isNotEmpty()) item { com.nekko.android.ui.components.SectionHeader("Providers") }
                    items(s.providers, key = { it.id }) { provider ->
                        ProviderAvatarRow(provider, providerStatus(provider, s, tested[provider.id]?.first, false), tested[provider.id]?.second ?: (s.errors[provider.id] != null)) { detail = provider.id }
                    }
                    item { com.nekko.android.ui.components.SectionHeader("Add a provider") }
                    // The providers most people reach for, each starting the add flow set to it.
                    item {
                        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalArrangement = Arrangement.spacedBy(16.dp), maxItemsInEachRow = 3) {
                            POPULAR.forEach { id ->
                                PhoneProviders.kind(id)?.let { kind ->
                                    ProviderButton(id, kind.label, enabled = !busy) {
                                        if (id == "anthropic") anthropicChoice = true else { addKind = id; adding = true }
                                    }
                                }
                            }
                        }
                    }
                    item {
                        TextButton(onClick = { addKind = null; adding = true }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp).testTag("phone.add")) { Text("+  More providers") }
                    }
                }
            } else {
                BoxWithConstraints(Modifier.weight(1f)) {
                    val availableWidth = maxWidth
                    val horizontalHinge = window.hinge?.let { it.orientation == com.nekko.protocol.Hinge.Orientation.HORIZONTAL && (it.isSeparating || it.state == com.nekko.protocol.Hinge.State.HALF_OPENED) } == true
                    val wide = maxWidth >= 600.dp && !horizontalHinge
                    val chat = s.chats.firstOrNull { it.id == chatId }
                    val list: @Composable (Modifier) -> Unit = { modifier ->
                        LazyColumn(modifier.padding(horizontal = 20.dp).testTag("phone.chatList"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            item { Text("Direct cloud chats. No computer, tools or sync.", color = p.inkSoft) }
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
                        // Only a separating vertical feature consumes space between side-by-side panes.
                        val hinge = window.hinge?.takeIf {
                            it.orientation == com.nekko.protocol.Hinge.Orientation.VERTICAL &&
                                (it.isSeparating || it.state == com.nekko.protocol.Hinge.State.HALF_OPENED)
                        }?.bounds
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
    // OpenRouter's sign-in came back and its provider was kept (#2852): the form closes.
    LaunchedEffect(s.signIn) {
        if (s.signIn == PhoneChats.SignIn.DONE) { adding = false; providers = true; notice = "${PhoneProviders.kind(s.signInKind ?: "openrouter")?.label ?: "Provider"} connected."; phone.clearSignIn() }
    }
    if (adding) {
        var failed by remember { mutableStateOf<String?>(null) }
        val context = androidx.compose.ui.platform.LocalContext.current
        ProviderForm(
            initialKind = addKind ?: PhoneProviders.kinds.first { !it.plan }.id,
            busy = busy || s.signIn == PhoneChats.SignIn.ADDING,
            failed = failed ?: s.signInError,
            onDismiss = { adding = false; addKind = null; phone.clearSignIn() },
            onSignIn = { kind ->
                failed = null
                if (kind == "chatgpt") phone.startChatGptSignIn()?.let { open(context, it) }
                else open(context, phone.startOpenRouterSignIn())
            },
            onOpen = { url -> open(context, url) },
        ) { kind, label, url, key, workspace ->
            failed = null
            scope.launch {
                busy = true
                // Checked before it is kept: a wrong key is turned down here, with the provider's reason.
                try { phone.connect(kind, label, url, key, workspace); adding = false; addKind = null; providers = true; notice = "${PhoneProviders.kind(kind)?.label ?: label} connected." }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { failed = e.message ?: "Could not check the key. Try again." }
                finally { busy = false }
            }
        }
    }
    keyFor?.let { providerId ->
        var key by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest = { keyFor = null }, title = { Text("New key") }, text = {
            OutlinedTextField(key, { key = it }, label = { Text("Key or access token") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.testTag("phone.newKey"))
        }, confirmButton = { TextButton(onClick = { action { phone.setKey(providerId, key); key = ""; keyFor = null } }, enabled = !busy) { Text("Save key") } }, dismissButton = { TextButton(onClick = { key = ""; keyFor = null }) { Text("Cancel") } })
    }
    remove?.let { id -> AlertDialog(onDismissRequest = { remove = null }, title = { Text("Remove provider and key?") }, text = { Text("Saved chats stay readable, but cannot send with this provider.") }, confirmButton = { TextButton(onClick = { action { phone.remove(id); remove = null; if (detail == id) detail = null } }, enabled = !busy) { Text("Remove provider") } }, dismissButton = { TextButton(onClick = { remove = null }) { Text("Cancel") } }) }
    forget?.let { id -> AlertDialog(onDismissRequest = { forget = null }, title = { Text("Forget this chat?") }, text = { Text("Permanently remove its messages from this device. This does not delete the provider's records.") }, confirmButton = { TextButton(onClick = { action { phone.forget(id); chatId = null; forget = null } }, enabled = !busy) { Text("Forget chat") } }, dismissButton = { TextButton(onClick = { forget = null }) { Text("Cancel") } }) }
    if (anthropicChoice) AnthropicChoiceSheet(onDismiss = { anthropicChoice = false }) {
        anthropicChoice = false
        addKind = "anthropic"
        adding = true
    }
    if (picking) {
        LaunchedEffect(Unit) { s.providers.filter { it.enabled }.forEach { phone.models(it.id) } }
        AlertDialog(onDismissRequest = { picking = false }, title = { Text("Choose a model") }, text = {
            LazyColumn { s.providers.filter { it.enabled }.forEach { provider ->
                item { Text(provider.label, style = MaterialTheme.typography.titleMedium) }
                // The key's tightest per-minute budget, once an answer has reported it (#2950).
                item { com.nekko.android.ui.chat.PhoneLimitLine(s.rateLimits[provider.id]) }
                s.errors[provider.id]?.let { error -> item { Text(error); TextButton(onClick = { action { phone.models(provider.id) } }) { Text("Retry models") } } }
                // Dated snapshots fold under the model they pin (#2950, the iPhone's #2925).
                val models = s.models[provider.id].orEmpty()
                val byId = models.associateBy { it.id }
                com.nekko.protocol.ModelSnapshots.fold(models.map { it.id }).forEach { fold ->
                    item(key = "${provider.id}/${fold.main}") {
                        var open by rememberSaveable(provider.id, fold.main) { mutableStateOf(false) }
                        Column {
                            PhoneModelRow(byId.getValue(fold.main)) { action { chatId = phone.newChat(provider.id, fold.main); picking = false } }
                            if (fold.dated.isNotEmpty()) {
                                TextButton(onClick = { open = !open }, modifier = Modifier.padding(start = 12.dp).testTag("phone.dated.${fold.main}")) {
                                    Text(
                                        if (open) androidx.compose.ui.res.stringResource(com.nekko.android.R.string.model_dated_hide)
                                        else if (fold.dated.size == 1) androidx.compose.ui.res.stringResource(com.nekko.android.R.string.model_dated_one)
                                        else androidx.compose.ui.res.stringResource(com.nekko.android.R.string.model_dated_many, fold.dated.size),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = p.inkSoft,
                                    )
                                }
                                if (open) fold.dated.forEach { id ->
                                    Box(Modifier.padding(start = 16.dp)) { PhoneModelRow(byId.getValue(id)) { action { chatId = phone.newChat(provider.id, id); picking = false } } }
                                }
                            }
                        }
                    }
                }
            } }
        }, confirmButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } })
    }
}

/** A model in this phone's picker, with its context window where the list gives one (#2950). */
@Composable
private fun PhoneModelRow(model: com.nekko.protocol.PhoneModel, onClick: () -> Unit) {
    val res = androidx.compose.ui.platform.LocalResources.current
    TextButton(onClick = onClick, modifier = Modifier.testTag("phone.model.${model.id}")) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(model.name, Modifier.weight(1f, fill = false))
            com.nekko.protocol.ModelMeta.line(local = false, contextLength = model.contextLength) { res.getString(com.nekko.android.R.string.model_context, it) }
                ?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkFaint, maxLines = 1) }
        }
    }
}

/** The providers most people reach for, in the iPhone's order (#2939). */
private val POPULAR = listOf("chatgpt", "anthropic", "openai", "gemini", "openrouter", "ollama-cloud")

/** The line under a provider's name: its test or model error, else what it is and how many models it has. */
private fun providerStatus(provider: com.nekko.protocol.PhoneProvider, s: PhoneChats.State, tested: String?, testing: Boolean): String {
    if (testing) return "Testing…"
    (tested ?: s.errors[provider.id])?.let { return it }
    if (!provider.enabled) return "Off"
    val kind = PhoneProviders.kind(provider.kind)?.label ?: provider.kind
    return when (val n = s.models[provider.id]?.size ?: 0) {
        0 -> kind
        1 -> "$kind · 1 model"
        else -> "$kind · $n models"
    }
}

/** A provider's mark in a round avatar, or a key for a kind with no mark. */
@Composable
private fun ProviderAvatar(kind: String, size: androidx.compose.ui.unit.Dp) {
    val p = Nekko.palette
    Box(Modifier.size(size).background(p.surface2, androidx.compose.foundation.shape.CircleShape), contentAlignment = Alignment.Center) {
        val mark = com.nekko.android.ui.screens.providerDrawable(com.nekko.protocol.ChatCard.providerMark(kind, null))
        if (mark != null) Icon(androidx.compose.ui.res.painterResource(mark), contentDescription = null, tint = p.ink, modifier = Modifier.size(size / 2))
        else Icon(androidx.compose.material.icons.Icons.Outlined.Key, contentDescription = null, tint = p.ink, modifier = Modifier.size(size / 2))
    }
}

/** A provider as an avatar row: its mark, its name and one status line; opens its page. */
@Composable
private fun ProviderAvatarRow(provider: com.nekko.protocol.PhoneProvider, status: String, isError: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
            .clickable(role = androidx.compose.ui.semantics.Role.Button, onClick = onClick)
            .heightIn(min = 56.dp).padding(vertical = 6.dp).testTag("phone.provider.${provider.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ProviderAvatar(provider.kind, 40.dp)
        Column(Modifier.weight(1f)) {
            Text(provider.label, style = MaterialTheme.typography.bodyLarge, color = if (provider.enabled) p.ink else p.inkFaint)
            Text(status, style = MaterialTheme.typography.bodySmall, color = if (isError) p.danger else p.inkFaint, maxLines = 2)
        }
        Icon(androidx.compose.material.icons.Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(20.dp))
    }
}

/** A popular provider's button: its mark and name, starting the add flow set to it. */
@Composable
private fun ProviderButton(kind: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    Column(
        Modifier.widthIn(min = 88.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, role = androidx.compose.ui.semantics.Role.Button, onClick = onClick)
            .padding(vertical = 8.dp, horizontal = 4.dp).testTag("phone.addKind.$kind"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ProviderAvatar(kind, 48.dp)
        Text(label, style = MaterialTheme.typography.labelMedium, color = p.inkSoft, maxLines = 1)
    }
}

/** A provider's page: its mark and status, on or off, Test, New key and Remove. */
@Composable
private fun ProviderPage(
    provider: com.nekko.protocol.PhoneProvider,
    status: String,
    isError: Boolean,
    busy: Boolean,
    onEnabled: (Boolean) -> Unit,
    onTest: () -> Unit,
    onNewKey: () -> Unit,
    onRemove: () -> Unit,
) {
    val p = Nekko.palette
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).testTag("phone.providerPage"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ProviderAvatar(provider.kind, 72.dp)
            Text(provider.label, style = MaterialTheme.typography.titleMedium, color = p.ink)
            Text(status, style = MaterialTheme.typography.bodySmall, color = if (isError) p.danger else p.inkFaint, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.testTag("phone.providerStatus"))
        }
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Use on this phone", Modifier.weight(1f), color = p.ink)
            Switch(checked = provider.enabled, onCheckedChange = onEnabled, enabled = !busy, modifier = Modifier.testTag("phone.enable.${provider.id}"))
        }
        if (provider.enabled) TextButton(onClick = onTest, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Test") }
        TextButton(onClick = onNewKey, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("New key") }
        TextButton(onClick = onRemove, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Remove", color = p.danger) }
    }
}

/**
 * Anthropic's ways in (#2939, the iPhone's `AnthropicChoiceSheet`). The API key works here. The
 * Claude subscription is shown dimmed, with a sad Nekko and the reason: Anthropic doesn't allow it
 * from a phone.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AnthropicChoiceSheet(onDismiss: () -> Unit, onUseKey: () -> Unit) {
    val p = Nekko.palette
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.paper) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).testTag("anthropicChoice"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Claude", style = MaterialTheme.typography.titleMedium, color = p.ink)
            Row(
                Modifier.fillMaxWidth().clip(androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
                    .clickable(role = androidx.compose.ui.semantics.Role.Button, onClick = onUseKey)
                    .heightIn(min = 56.dp).padding(vertical = 6.dp).testTag("anthropicChoice.apiKey"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                ProviderAvatar("anthropic", 40.dp)
                Column(Modifier.weight(1f)) {
                    Text("API key", style = MaterialTheme.typography.bodyLarge, color = p.ink)
                    Text("From console.anthropic.com, kept on this phone.", style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(vertical = 6.dp).testTag("anthropicChoice.subscription")
                    .unavailableItem(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                com.nekko.android.ui.components.SadNekko(56.dp)
                Column(Modifier.weight(1f)) {
                    Text("Claude subscription", style = MaterialTheme.typography.bodyLarge, color = p.inkFaint)
                    Text(
                        "Sorry, Anthropic doesn’t allow a Claude subscription to be used from a phone. Use it on a computer, or add an API key here.",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkFaint,
                    )
                }
            }
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("Cancel") }
        }
    }
}

/** Read as one dimmed, unavailable item: TalkBack says it can't be chosen. */
private fun Modifier.unavailableItem() = this.then(
    Modifier.semantics(mergeDescendants = true) { disabled() },
)

/** A web page in the browser: a provider's key page, or OpenRouter's sign-in, which comes back to the app. */
private fun open(context: android.content.Context, url: String) {
    try { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) } catch (_: android.content.ActivityNotFoundException) {}
}

/**
 * Add a provider to this phone (#2852, the iPhone's #2853). OpenRouter is one button: a browser
 * sign-in hands the key back. Kinds with a key page are guided: open it, copy the key, come back
 * and tap Paste, and the provider is checked and kept by itself. The others keep the full form.
 */
@Composable
private fun ProviderForm(
    initialKind: String,
    busy: Boolean,
    failed: String?,
    onDismiss: () -> Unit,
    onSignIn: (String) -> Unit,
    onOpen: (String) -> Unit,
    onSave: (String, String, String, String, String) -> Unit,
) {
    var kindId by remember { mutableStateOf(initialKind) }
    val kind = PhoneProviders.kind(kindId)!!
    var label by remember { mutableStateOf(kind.label) }
    var url by remember { mutableStateOf(kind.defaultUrl) }
    var key by remember { mutableStateOf("") }
    var workspace by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var choosing by remember { mutableStateOf(false) }
    var opened by remember { mutableStateOf(false) }
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val guided = kind.keyPage != null
    val save = {
        try { PhoneProviders.make("check", kindId, label, url, key, workspace); error = null; onSave(kindId, label, url, key, workspace) }
        catch (e: IllegalArgumentException) { error = e.message }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Add phone provider") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { choosing = !choosing }, modifier = Modifier.testTag("phone.kind")) { Text(kind.label) }
            if (choosing) PhoneProviders.kinds.forEach { k -> TextButton(onClick = { kindId = k.id; label = k.label; url = k.defaultUrl; key = ""; opened = false; error = null; choosing = false }, modifier = Modifier.testTag("phone.kind.${k.id}")) { Text(k.label) } }
            Text(kind.hint)
            // ChatGPT (#3244): the sign-in is the whole form; there is no key to paste.
            if (kind.plan) {
                Button(onClick = { onSignIn(kind.id) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("phone.signIn")) { Text("Sign in with ${kind.label}") }
                Text("Approve in the browser and come back. This phone keeps its own sign-in, sealed by its keystore; your computers keep theirs.", style = MaterialTheme.typography.bodySmall)
                Text("OpenAI’s terms are written around its own apps, so this is offered as-is. An OpenAI API key works too.", style = MaterialTheme.typography.bodySmall)
                if (busy) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Text("Signing in…", style = MaterialTheme.typography.bodySmall)
                }
                failed?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("phone.addError")) }
                return@Column
            }
            if (kind.signIn) {
                Button(onClick = { onSignIn(kind.id) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("phone.signIn")) { Text("Sign in with ${kind.label}") }
                Text("Approve in the browser and the key comes back to this phone.", style = MaterialTheme.typography.bodySmall)
                Text("Or use a key", style = MaterialTheme.typography.labelLarge)
            }
            // A kind with a key page needs no name or address: its own are used.
            if (!guided) {
                OutlinedTextField(label, { label = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.testTag("phone.label"))
                OutlinedTextField(url, { url = it }, label = { Text("HTTPS address") }, singleLine = true, modifier = Modifier.testTag("phone.url"))
            }
            kind.keyPage?.let { page ->
                val site = runCatching { java.net.URI(page).host }.getOrNull().orEmpty()
                OutlinedButton(onClick = { opened = true; onOpen(page) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("phone.openKeyPage")) { Text("Open $site") }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(key, { key = it }, label = { Text(if (kindId == "vertex") "Access token" else "API key") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.weight(1f).testTag("phone.key"))
                if (guided && key.isEmpty()) {
                    // One tap: the copied key is pasted, checked and kept.
                    FilledTonalButton(onClick = {
                        val pasted = clipboard.getText()?.text?.trim().orEmpty()
                        if (pasted.isNotEmpty()) { key = pasted; save() } else error = "Nothing to paste. Copy the key first."
                    }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp).testTag("phone.paste")) { Text("Paste") }
                }
            }
            if (kindId == "anthropic") OutlinedTextField(workspace, { workspace = it }, label = { Text("Workspace ID (optional)") }, singleLine = true)
            Text(if (opened) "Copy the key, come back and tap Paste. Nekko checks it and connects." else "Kept on this phone only, sealed by its keystore.", style = MaterialTheme.typography.bodySmall)
            if (busy) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Text("Checking the key…", style = MaterialTheme.typography.bodySmall)
            }
            (error ?: failed)?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("phone.addError")) }
        }
    }, confirmButton = { if (!kind.plan) TextButton(onClick = { save() }, enabled = !busy, modifier = Modifier.testTag("phone.save")) { Text("Add") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
private fun PhoneConversation(phone: PhoneChats, chat: PhoneChat, running: Boolean, onForget: () -> Unit) {
    var text by rememberSaveable(chat.id) { mutableStateOf("") }
    val p = Nekko.palette
    val s by phone.state.collectAsStateWithLifecycle()
    val canSend = s.providers.any { it.id == chat.providerId && it.enabled }
    // Photos stay on the phone until Send; only a model known not to take them loses the button.
    val takesPhotos = phone.acceptsImages(chat.providerId, chat.modelId)
    val context = androidx.compose.ui.platform.LocalContext.current
    val lock = com.nekko.android.lock.LocalAppLock.current
    val scope = rememberCoroutineScope()
    val photos = remember(chat.id) { com.nekko.android.chat.PhotoTray<androidx.compose.ui.graphics.ImageBitmap>() }
    val photoState by photos.state.collectAsStateWithLifecycle()
    val pick = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(PhoneProviders.MAX_IMAGES),
    ) { uris ->
        lock?.returned()
        val n = photos.begin(uris.size)
        uris.take(n).forEach { uri ->
            scope.launch {
                try {
                    val (url, preview) = com.nekko.android.chat.ImageAttachments.encode(context.contentResolver, uri)
                    photos.added(url, preview)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    photos.failed("Couldn’t read that photo.")
                }
            }
        }
    }
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
            // One subtitle, model ⟶ This phone, instead of a "no tools" banner (#2950, the iPhone's #2921).
            Column(Modifier.weight(1f)) {
                Text(chat.title, color = p.ink, style = MaterialTheme.typography.titleMedium)
                Row(Modifier.testTag("phone.place"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(chat.modelId, color = p.inkSoft, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f, fill = false))
                    com.nekko.android.ui.chat.PlaceConnector()
                    Text(androidx.compose.ui.res.stringResource(com.nekko.android.R.string.chats_this_phone), color = p.inkSoft, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                }
            }
            TextButton(onClick = onForget) { Text("Forget") }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 20.dp).testTag("phone.transcript"), state = list, verticalArrangement = Arrangement.spacedBy(20.dp)) {
            items(chat.messages, key = { it.id }) { m -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (m.role == "user") "You" else "Nekko", color = p.inkSoft, style = MaterialTheme.typography.labelMedium)
                m.images?.takeIf { it.isNotEmpty() }?.let { sent -> SentPhotos(sent) }
                if (m.text.isNotEmpty()) MarkdownText(text = m.text, color = p.ink)
                if (m.error == PhoneChats.STREAMING && m.text.isEmpty()) Text("Thinking…", color = p.inkSoft)
                if (m.error != null && m.error != PhoneChats.STREAMING) Text(m.error.orEmpty(), color = p.inkSoft)
            } }
        }
        }
        }, controls = {
        if (!canSend) Text("Enable this provider to send. Removed providers leave chats read-only.", Modifier.padding(20.dp), color = p.inkSoft)
        if (photoState.photos.isNotEmpty() || photoState.busy) Box(Modifier.padding(horizontal = 20.dp)) {
            com.nekko.android.ui.chat.PhotoStrip(photoState.photos, photoState.adding, photos::remove)
        }
        photoState.error?.let { Text(it, Modifier.padding(horizontal = 20.dp), color = p.inkSoft) }
        // The key's per-minute budget once an answer has reported it, quiet until it nears (#2950).
        val phoneState by phone.state.collectAsStateWithLifecycle()
        com.nekko.android.ui.chat.PhoneLimitLine(phoneState.rateLimits[chat.providerId], Modifier.padding(horizontal = 24.dp))
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (takesPhotos) TextButton(onClick = {
                photos.clearError()
                lock?.expectReturn()
                pick.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly))
            }, enabled = canSend && !running && photoState.room > 0, modifier = Modifier.testTag("phone.photos")) { Text("Photos") }
            OutlinedTextField(text, { text = it }, enabled = canSend && !running, label = { Text("Message") }, modifier = Modifier.weight(1f).testTag("phone.message"), maxLines = 5)
            if (running) TextButton(onClick = { phone.stop(chat.id) }, modifier = Modifier.testTag("phone.stop")) { Text("Stop") }
            else Button(onClick = {
                val sent = if (takesPhotos) photos.take().map { it.dataUrl } else emptyList()
                phone.send(chat.id, text, images = sent); text = ""
            }, enabled = canSend && !photoState.busy && (text.isNotBlank() || photoState.photos.isNotEmpty()), modifier = Modifier.testTag("phone.send")) { Text("Send") }
        }
        if (!running && canSend && chat.messages.lastOrNull()?.role == "assistant") TextButton(onClick = { phone.send(chat.id, "", retry = true) }, modifier = Modifier.testTag("phone.retry")) { Text("Retry last reply") }
        })
    }
}

/** The photos a message was sent with, as thumbnails above its text. */
@Composable
private fun SentPhotos(photos: List<String>) {
    val previews = remember(photos) { photos.map { com.nekko.android.chat.ImageAttachments.preview(it) } }
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.testTag("phone.sentPhotos")) {
        previews.forEachIndexed { i, preview ->
            val shape = androidx.compose.foundation.shape.RoundedCornerShape(14.dp)
            if (preview != null) androidx.compose.foundation.Image(preview, "Photo ${i + 1} of ${photos.size}", Modifier.size(96.dp).clip(shape), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
            else Box(Modifier.size(96.dp).clip(shape).background(Nekko.palette.surface2))
        }
    }
}
