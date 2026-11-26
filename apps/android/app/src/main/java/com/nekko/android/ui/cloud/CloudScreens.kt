package com.nekko.android.ui.cloud

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.cloud.CloudBrowserSignIn
import com.nekko.android.cloud.SyncDeviceKeys
import com.nekko.android.ui.chat.MarkdownText
import com.nekko.android.ui.components.PixelCat
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.CloudError
import com.nekko.protocol.CloudSync
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Settings → Nekko Cloud (#2835, the iPhone's `CloudView`): sign in, join the account's end-to-end encrypted
 * sync, approve a new computer, and read synced chats with no computer online.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CloudScreen(cloud: CloudSync, signIn: CloudBrowserSignIn, keys: SyncDeviceKeys?, onBack: () -> Unit, onOpenChat: (String) -> Unit) {
    val v by cloud.view.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var approving by remember { mutableStateOf<CloudSync.Device?>(null) }
    var recovery by rememberSaveable { mutableStateOf("") }
    var inHardware by remember { mutableStateOf<Boolean?>(null) }
    val run: (suspend () -> Unit) -> Unit = { work ->
        scope.launch {
            busy = true
            try {
                work()
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = (e as? CloudError)?.message ?: e.message
            } finally {
                busy = false
            }
        }
    }
    LaunchedEffect(v.signedIn) { if (v.signedIn) run { cloud.sync() } }
    LaunchedEffect(keys, v.phase) { if (v.phase == CloudSync.Phase.IDLE) inHardware = keys?.let { runCatching { it.inSecureHardware() }.getOrNull() } }

    Scaffold(containerColor = p.paper, topBar = {
        TopAppBar(
            title = { Text(stringResource(R.string.cloud_title)) },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.settings_back)) } },
        )
    }) { padding ->
        if (v.phase == CloudSync.Phase.SIGNED_OUT) {
            Box(Modifier.padding(padding)) { CloudSignIn(cloud, signIn) }
            return@Scaffold
        }
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).testTag("cloud.page")) {
            StatusRow(v, busy)
            when (v.phase) {
                CloudSync.Phase.NEEDS_JOIN -> {
                    SectionHeader(stringResource(R.string.cloud_use_recovery))
                    OutlinedTextField(
                        recovery, { recovery = it },
                        label = { Text(stringResource(R.string.cloud_recovery_key)) },
                        placeholder = { Text("XXXXX-XXXXX-…") },
                        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                        minLines = 2, maxLines = 4,
                        modifier = Modifier.fillMaxWidth().testTag("cloud.recoveryKey"),
                    )
                    Button(
                        onClick = { run { cloud.restore(recovery); recovery = "" } },
                        enabled = !busy && recovery.count { it.isLetterOrDigit() } >= 55,
                        modifier = Modifier.padding(top = 8.dp).heightIn(min = 48.dp).testTag("cloud.unlock"),
                    ) { Text(stringResource(R.string.cloud_unlock)) }
                    Footer(stringResource(R.string.cloud_recovery_footer))
                    SectionHeader(stringResource(R.string.cloud_or_approve))
                    OutlinedButton(onClick = { run { cloud.requestJoin() } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp).testTag("cloud.requestJoin")) {
                        Text(stringResource(R.string.cloud_ask_to_join))
                    }
                    Footer(stringResource(R.string.cloud_ask_footer))
                }
                CloudSync.Phase.AWAITING_APPROVAL -> {
                    SectionHeader(stringResource(R.string.cloud_this_code))
                    val code = v.joinCode.orEmpty()
                    val spoken = stringResource(R.string.cloud_code_spoken, code.toList().joinToString(" "))
                    Text(
                        code,
                        style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Monospace),
                        fontWeight = FontWeight.SemiBold, color = p.ink, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp).semantics { contentDescription = spoken }.testTag("cloud.joinCode"),
                    )
                    OutlinedButton(onClick = { run { cloud.sync() } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.cloud_check_now)) }
                    Footer(stringResource(R.string.cloud_code_footer))
                }
                CloudSync.Phase.IDLE, CloudSync.Phase.SYNCING, CloudSync.Phase.ERROR -> {
                    SectionHeader(stringResource(R.string.cloud_synced_chats))
                    if (v.chats.isEmpty()) Text(stringResource(R.string.cloud_nothing_synced), color = p.inkSoft)
                    v.chats.forEach { c ->
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button) { onOpenChat(c.id) }
                                .heightIn(min = 56.dp).padding(vertical = 6.dp).testTag("cloud.chat.${c.id}"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(c.title, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    android.text.format.DateUtils.getRelativeTimeSpanString(c.updatedAt.toLong()).toString(),
                                    style = MaterialTheme.typography.bodySmall, color = p.inkFaint,
                                )
                            }
                            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint)
                        }
                    }
                    Footer(stringResource(R.string.cloud_synced_footer))
                    SectionHeader(stringResource(R.string.cloud_devices))
                    v.devices.filterNot { it.revoked }.forEach { d ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(vertical = 6.dp).testTag("cloud.device.${d.id}"), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(if (d.thisDevice) stringResource(R.string.cloud_this_device, d.label) else d.label, color = p.ink)
                                Text(d.fingerprint, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = p.inkFaint)
                            }
                            if (!d.trusted && !d.thisDevice && d.askedToJoin) {
                                Button(onClick = { approving = d }, enabled = !busy, modifier = Modifier.testTag("cloud.approve.${d.id}")) { Text(stringResource(R.string.cloud_approve)) }
                            }
                        }
                    }
                    Footer(stringResource(R.string.cloud_devices_footer))
                    inHardware?.let { Footer(stringResource(if (it) R.string.cloud_key_hardware else R.string.cloud_key_sealed)) }
                }
                else -> {}
            }
            error?.let { Text(it, color = p.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp).testTag("cloud.error")) }
            SectionHeader(stringResource(R.string.cloud_account))
            v.account?.let { a ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Text(a.email, color = p.ink, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(planName(a.plan), color = p.inkSoft)
                }
            }
            TextButton(onClick = { run { cloud.signOut() } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp).testTag("cloud.signOut")) {
                Text(stringResource(R.string.cloud_sign_out), color = p.danger)
            }
            Footer(stringResource(R.string.cloud_sign_out_footer))
            Spacer(Modifier.height(32.dp))
        }
    }

    approving?.let { d ->
        var code by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { approving = null },
            title = { Text(stringResource(R.string.cloud_approve_title, d.label)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.cloud_approve_body, d.label))
                    OutlinedTextField(
                        code, { code = it }, singleLine = true, placeholder = { Text("XXXX-XXXX-XXXX-XXXX") },
                        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                        modifier = Modifier.testTag("cloud.approveCode"),
                    )
                }
            },
            confirmButton = { TextButton(onClick = { val typed = code; approving = null; run { cloud.approve(d.id, typed) } }) { Text(stringResource(R.string.cloud_approve)) } },
            dismissButton = { TextButton(onClick = { approving = null }) { Text(stringResource(R.string.cloud_cancel)) } },
        )
    }
}

@Composable
private fun StatusRow(v: CloudSync.View, busy: Boolean) {
    val p = Nekko.palette
    Row(Modifier.fillMaxWidth().padding(vertical = 16.dp).semantics(mergeDescendants = true) {}.testTag("cloud.status"), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(headline(v.phase), style = MaterialTheme.typography.titleMedium, color = p.ink)
            subline(v).takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkSoft) }
        }
        if (busy || v.syncing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = p.accent)
    }
}

@Composable
internal fun headline(phase: CloudSync.Phase): String = stringResource(
    when (phase) {
        CloudSync.Phase.SIGNED_OUT -> R.string.cloud_signed_out
        CloudSync.Phase.NEEDS_PLAN -> R.string.cloud_needs_plan
        CloudSync.Phase.NOT_SET_UP -> R.string.cloud_not_set_up
        CloudSync.Phase.NEEDS_JOIN -> R.string.cloud_needs_join
        CloudSync.Phase.AWAITING_APPROVAL -> R.string.cloud_awaiting
        CloudSync.Phase.SYNCING -> R.string.cloud_syncing
        CloudSync.Phase.IDLE -> R.string.cloud_idle
        CloudSync.Phase.ERROR -> R.string.cloud_error
    },
)

@Composable
private fun subline(v: CloudSync.View): String = when (v.phase) {
    CloudSync.Phase.NEEDS_PLAN -> stringResource(R.string.cloud_needs_plan_detail)
    CloudSync.Phase.NOT_SET_UP -> stringResource(R.string.cloud_not_set_up_detail)
    CloudSync.Phase.NEEDS_JOIN -> stringResource(R.string.cloud_needs_join_detail)
    CloudSync.Phase.AWAITING_APPROVAL -> stringResource(R.string.cloud_awaiting_detail)
    CloudSync.Phase.IDLE, CloudSync.Phase.SYNCING, CloudSync.Phase.ERROR ->
        if (v.chats.size == 1) stringResource(R.string.cloud_chats_one) else stringResource(R.string.cloud_chats_many, v.chats.size)
    CloudSync.Phase.SIGNED_OUT -> ""
}

@Composable
internal fun planName(plan: String): String = stringResource(
    when (plan) {
        "team" -> R.string.cloud_plan_enterprise
        "pro" -> R.string.cloud_plan_pro
        else -> R.string.cloud_plan_free
    },
)

@Composable
private fun Footer(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkSoft, modifier = Modifier.padding(top = 6.dp, bottom = 4.dp))
}

/**
 * Sign in to Nekko Cloud (the iPhone's `CloudSignInView`): Apple, GitHub or Google in the browser, which comes
 * back on `nekko-agent://cloud-callback`, or an emailed 6-digit code.
 */
@Composable
private fun CloudSignIn(cloud: CloudSync, signIn: CloudBrowserSignIn) {
    val p = Nekko.palette
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var email by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var sent by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val finishing by signIn.finishing.collectAsStateWithLifecycle()
    val browserError by signIn.error.collectAsStateWithLifecycle()
    fun msg(e: Exception) = (e as? CloudError)?.message ?: e.message
    fun verify() {
        if (busy) return
        scope.launch {
            busy = true
            try { cloud.verifyCode(email.trim(), code); error = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = msg(e); code = "" } finally { busy = false }
        }
    }
    fun oauth(provider: String) {
        scope.launch {
            busy = true
            signIn.clearError()
            try {
                val start = cloud.oauthStart(provider)
                signIn.started(start.verifier)
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(start.url)))
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = msg(e)
            } finally {
                busy = false
            }
        }
    }
    val working = busy || finishing
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp).testTag("cloud.signIn"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(Modifier.size(72.dp).clip(RoundedCornerShape(18.dp)).background(p.accentSoft), contentAlignment = Alignment.Center) {
            PixelCat(Modifier.size(44.dp))
        }
        Text(
            stringResource(if (sent) R.string.cloud_check_email else R.string.cloud_sign_in_title),
            style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = p.ink, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            if (sent) stringResource(R.string.cloud_sent_code, email.trim()) else stringResource(R.string.cloud_sign_in_body),
            style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, textAlign = TextAlign.Center,
        )
        if (sent) {
            OutlinedTextField(
                code,
                { typed ->
                    code = typed.filter { it.isDigit() }.take(6)
                    if (code.length == 6) verify()
                },
                label = { Text(stringResource(R.string.cloud_code_label)) },
                singleLine = true,
                textStyle = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Monospace, textAlign = TextAlign.Center),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth().testTag("cloud.code"),
            )
            Button(onClick = ::verify, enabled = !working && code.length == 6, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(stringResource(if (busy) R.string.cloud_signing_in else R.string.cloud_sign_in))
            }
            TextButton(onClick = { sent = false; code = "" }) { Text(stringResource(R.string.cloud_different_email), color = p.inkSoft) }
        } else {
            ProviderButton(stringResource(R.string.cloud_continue_apple), Brand.APPLE, !working) { oauth("apple") }
            ProviderButton(stringResource(R.string.cloud_continue_github), Brand.GITHUB, !working) { oauth("github") }
            ProviderButton(stringResource(R.string.cloud_continue_google), Brand.GOOGLE, !working) { oauth("google") }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HorizontalDivider(Modifier.weight(1f), color = p.line)
                Text(stringResource(R.string.cloud_or), style = MaterialTheme.typography.labelSmall, color = p.inkFaint)
                HorizontalDivider(Modifier.weight(1f), color = p.line)
            }
            OutlinedTextField(
                email, { email = it }, singleLine = true, placeholder = { Text("you@example.com") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().testTag("cloud.email"),
            )
            Button(
                onClick = {
                    scope.launch {
                        busy = true
                        try { cloud.sendCode(email.trim()); sent = true; error = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = msg(e) } finally { busy = false }
                    }
                },
                enabled = !working && email.contains('@'),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("cloud.sendCode"),
            ) { Text(stringResource(if (busy) R.string.cloud_sending else R.string.cloud_email_me)) }
        }
        if (finishing) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = p.accent)
        (error ?: browserError)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger, textAlign = TextAlign.Center, modifier = Modifier.testTag("cloud.signInError")) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            Icon(Icons.Outlined.Lock, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(16.dp))
            Text(stringResource(R.string.cloud_privacy), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
    }
}

private enum class Brand { APPLE, GITHUB, GOOGLE }

/**
 * A sign-in button with its mark. Apple's is solid black with white words (white on black in dark themes), as its
 * guidelines ask; GitHub and Google sit on the plain surface with a hairline.
 */
@Composable
private fun ProviderButton(label: String, brand: Brand, enabled: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    val dark = p.paper.luminanceIsDark()
    val apple = brand == Brand.APPLE
    val container = if (apple) (if (dark) Color.White else Color.Black) else p.surface
    val content = if (apple) (if (dark) Color.Black else Color.White) else p.ink
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).background(container)
            .then(if (apple) Modifier else Modifier.border(1.dp, p.line, RoundedCornerShape(12.dp)))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp).testTag("cloud.oauth.${brand.name.lowercase()}"),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Apple's own mark comes with the brand marks (#2938); until then its button is words only.
        when (brand) {
            Brand.APPLE -> {}
            Brand.GITHUB -> Icon(painterResource(R.drawable.connector_github), contentDescription = null, tint = content, modifier = Modifier.size(20.dp))
            Brand.GOOGLE -> Icon(painterResource(R.drawable.provider_google), contentDescription = null, tint = Color.Unspecified, modifier = Modifier.size(20.dp))
        }
        if (brand != Brand.APPLE) Spacer(Modifier.size(8.dp))
        Text(label, color = content.copy(alpha = if (enabled) 1f else 0.5f), fontWeight = FontWeight.Medium)
    }
}

private fun Color.luminanceIsDark() = (0.299f * red + 0.587f * green + 0.114f * blue) < 0.5f

/** A synced chat, read only, decrypted on this phone (the iPhone's `SyncedChatView`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncedChatScreen(cloud: CloudSync, chatId: String, onBack: () -> Unit) {
    val v by cloud.view.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val chat = v.chats.firstOrNull { it.id == chatId }
    Scaffold(containerColor = p.paper, topBar = {
        TopAppBar(
            title = { Text(chat?.title ?: "Chat", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.settings_back)) } },
        )
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp).testTag("cloud.syncedChat"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Outlined.Lock, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(14.dp))
                Text(stringResource(R.string.cloud_read_only), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
            }
            chat?.messages.orEmpty().forEach { m ->
                if (m.role == "user") {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                        Text(m.text, color = p.ink, modifier = Modifier.clip(RoundedCornerShape(14.dp)).background(p.accentSoft).padding(10.dp))
                    }
                } else {
                    MarkdownText(text = m.text, color = p.ink)
                }
            }
        }
    }
}

/**
 * The Nekko Cloud profile atop Settings (#2940, the iPhone's `ProfileRow`): an avatar (your initial, or the cat
 * when signed out), your email, and one line on the plan and sync; signed out, an invitation to sign in.
 */
@Composable
fun CloudProfileRow(cloud: CloudSync, onClick: () -> Unit) {
    val v by cloud.view.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val account = v.account?.takeIf { v.signedIn }
    val title = account?.email ?: stringResource(R.string.cloud_sign_in_title)
    val detail = if (account == null) stringResource(R.string.cloud_profile_signed_out) else {
        val plan = planName(account.plan)
        val state = when (v.phase) {
            CloudSync.Phase.SIGNED_OUT -> null
            else -> headline(v.phase)
        }
        state?.let { stringResource(R.string.cloud_plan_and_state, plan, it) } ?: plan
    }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp).semantics(mergeDescendants = true) {}.testTag("settings.cloud"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.size(56.dp).background(p.surface2, CircleShape), contentAlignment = Alignment.Center) {
            val initial = account?.email?.firstOrNull()?.uppercaseChar()
            if (initial != null) Text(initial.toString(), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = p.accent)
            else PixelCat(Modifier.size(30.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkFaint, maxLines = 2)
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(20.dp))
    }
}
