package com.nekko.android.voice

import android.Manifest
import android.content.pm.PackageManager
import android.os.SystemClock
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.nekko.android.R
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.data.Remote
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.ui.security.PendingStepUp
import com.nekko.android.ui.security.StepUpSheet
import com.nekko.protocol.*
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

/** Real composer integration. Every callback is bound to this computer/chat, including after proof prompts. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChatVoiceControls(
    vm: ChatViewModel,
    enabled: Boolean,
    focused: Boolean,
    composer: VoiceComposer,
    conversationOpen: Boolean,
    onConversationClosed: () -> Unit,
    onOpenChat: (String, String?) -> Unit,
    onNewChat: (() -> Unit)?,
    onSettings: (() -> Unit)?,
) {
    val context = LocalContext.current
    val resources = LocalResources.current
    val view = LocalView.current
    val owner = LocalLifecycleOwner.current
    val appLock = LocalAppLock.current
    val scope = rememberCoroutineScope()
    val computerId = remember(vm) { vm.repo.state.value.activeId }
    val token = remember(vm, owner) { Any() }
    val currentComposer by rememberUpdatedState(composer)
    val currentFocus by rememberUpdatedState(focused)
    val currentEnabled by rememberUpdatedState(enabled)
    val openChat by rememberUpdatedState(onOpenChat)
    val newChat by rememberUpdatedState(onNewChat)
    val settings by rememberUpdatedState(onSettings)
    val closeConversation by rememberUpdatedState(onConversationClosed)
    var present by remember { mutableStateOf(true) }
    var link by remember { mutableStateOf<Remote?>(null) }
    var epoch by remember { mutableLongStateOf(0) }
    var leaseEpoch by remember { mutableLongStateOf(-1) }
    var stepUp by remember { mutableStateOf<PendingStepUp?>(null) }
    var stepResult by remember { mutableStateOf<CompletableDeferred<JsonElement>?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var permissionVersion by remember { mutableIntStateOf(0) }
    val hold = remember(vm, owner) { HoldToTalk() }
    fun baseAllowed(): Boolean {
        val state = vm.repo.state.value
        val ui = vm.ui.value
        return present && currentEnabled && vm.voiceEnabled && currentFocus &&
            owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) &&
            appLock?.status?.value?.locked != true && appLock?.covered?.value != true &&
            computerId != null && state.activeId == computerId && state.conn == RelayState.ONLINE &&
            ui.ready && ui.savedAt == null && ui.chatType != "image" && vm.repo.overlays.value[vm.sessionId] == null &&
            state.summaries.firstOrNull { it.id == vm.sessionId }?.archivedAt == null && vm.completedAt.value == null
    }
    fun voiceAllowed(): Boolean = baseAllowed() && VoiceAudioOwner.owns(token) && epoch == leaseEpoch &&
        runCatching { vm.repo.remote() === link }.getOrDefault(false)
    fun requireAllowed(expectedEpoch: Long = leaseEpoch) {
        check(voiceAllowed() && epoch == expectedEpoch) { "Voice stopped. Start again in this chat." }
    }
    fun announce(text: String) { notice = text; Toast.makeText(context, text, Toast.LENGTH_LONG).show() }

    val runner = remember(vm, owner) {
        VoiceRunner(scope, object : VoiceRunner.Host {
            private var destination: String? = null
            override var text: String
                get() = currentComposer.read().text
                set(value) { val old = currentComposer.read().text; currentComposer.replace(old, value) }
            override fun allowed() = voiceAllowed()
            override fun toast(text: String) = announce(text)
            override fun tap() { view.performHapticFeedback(if (android.os.Build.VERSION.SDK_INT >= 30) android.view.HapticFeedbackConstants.CONFIRM else android.view.HapticFeedbackConstants.VIRTUAL_KEY) }
            override fun title() = vm.ui.value.title
            override fun status(): String = when {
                vm.ui.value.approval != null -> "Waiting for your approval"
                vm.ui.value.question != null -> "Waiting for your answer"
                vm.ui.value.running -> "Working"
                else -> "Ready"
            }
            override suspend fun send(): Boolean {
                val run = leaseEpoch
                requireAllowed(run)
                val draft = currentComposer.read()
                vm.voicePreflight(true, draft, conversation = false)
                check(draft.text.isNotBlank()) { "Nothing to send." }
                vm.sendVoice(draft.text) { voiceAllowed() && epoch == run && currentComposer.read().let { !it.armed && !it.photos && !it.busy } }
                requireAllowed(run)
                // Do not overwrite anything typed during the network wait.
                currentComposer.replace(draft.text, "")
                return true
            }
            override fun chats() = vm.repo.state.value.summaries.map { VoiceRunner.Chat(it.id, it.title, archived = it.archivedAt != null) }
            override fun open(id: String) { requireAllowed(); destination = id; openChat(id, null) }
            override fun park(text: String) {
                val id = destination ?: return
                if (vm.repo.state.value.activeId == computerId && vm.repo.drafts.computerId == computerId) vm.repo.drafts.handBack(id, Draft(text = text))
            }
            override fun newChat() {
                requireAllowed()
                val go = newChat ?: error("New chat is unavailable here.")
                destination = DraftStore.NEW_CHAT; go()
            }
            override fun openSettings() { requireAllowed(); (settings ?: error("Settings is unavailable here."))() }
            override suspend fun complete() { requireAllowed(); vm.complete(); requireAllowed() }
            override suspend fun ship(): VoiceRunner.ShipFacts {
                val run = leaseEpoch
                requireAllowed(run)
                val prs = vm.pullRequests(refresh = true)
                requireAllowed(run)
                return VoiceRunner.ShipFacts(prs.map { VoiceRunner.PullRequest(it.url, "#${it.number}", it.state == PullRequest.State.OPEN, it.isDraft) }, vm.ui.value.running, vm.ui.value.question?.callId)
            }
            override suspend fun answer(questionId: String, text: String) {
                val run = leaseEpoch
                requireAllowed(run)
                vm.answerVoice(questionId, text) { voiceAllowed() && epoch == run }
            }
            override suspend fun merge(pr: VoiceRunner.PullRequest): String? {
                val run = leaseEpoch
                requireAllowed(run)
                val fresh = vm.pullRequests(refresh = true).singleOrNull { it.url == pr.id }
                requireAllowed(run)
                check(fresh != null && fresh.state == PullRequest.State.OPEN && !fresh.isDraft) { "That pull request is no longer open and ready." }
                val request = GitRequest.prAction(fresh.url, PrAction.MERGE)
                suspend fun mutate(proof: StepUpProof? = null): JsonElement = vm.repo.callChange(request.channel, request.args, proof,
                    authorize = { requireAllowed(run) }, retryKeyMissing = false)
                val raw = try { mutate() } catch (e: RelayException) {
                    if (e.refusal?.asksForStepUp != true) throw e
                    requireAllowed(run)
                    val result = CompletableDeferred<JsonElement>()
                    stepResult = result
                    stepUp = PendingStepUp("Merge #${fresh.number}") { proof ->
                        requireAllowed(run)
                        result.complete(mutate(proof))
                    }
                    try { result.await() } finally { stepUp = null; stepResult = null }
                }
                requireAllowed(run)
                val result = GitResult.from(raw)
                return if (result?.ok == true) null else result?.message?.ifBlank { null } ?: "Merge was not confirmed. Check the pull request."
            }
        })
    }
    val listening = remember(vm, owner) { VoiceListening(scope, runner) }
    fun abort() {
        epoch++
        hold.reset(); listening.abort()
        stepResult?.cancel(); stepResult = null; stepUp = null
        VoiceAudioOwner.release(token)
    }
    val abortNow by rememberUpdatedState({ abort(); closeConversation() })
    val audio = remember(vm, owner) { ConversationAudio(context) { abortNow() } }
    val safety = remember(vm, owner) { VoiceSafety(context, owner) { abortNow() } }
    val listeningState by listening.state.collectAsState()
    val pending by runner.pending.collectAsState()
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionVersion++
        notice = resources.getString(if (granted) R.string.voice_permission_granted else R.string.voice_permission_denied)
    }
    DisposableEffect(vm, owner, appLock) {
        present = true
        safety.start()
        // These collectors run even when covered; revocation is not delayed until recomposition.
        val lockJob = scope.launch(start = CoroutineStart.UNDISPATCHED) { appLock?.status?.collect { if (it.locked) abortNow() } }
        val coverJob = scope.launch(start = CoroutineStart.UNDISPATCHED) { appLock?.covered?.collect { if (it) abortNow() } }
        val connectionJob = scope.launch(start = CoroutineStart.UNDISPATCHED) { vm.repo.state.collect {
            if (!baseAllowed() || (link != null && runCatching { vm.repo.remote() !== link }.getOrDefault(true))) abortNow()
        } }
        val settingsJob = scope.launch(start = CoroutineStart.UNDISPATCHED) { vm.voiceEnabledFlow?.collect { if (!it) abortNow() } }
        val overlayJob = scope.launch(start = CoroutineStart.UNDISPATCHED) { vm.repo.overlays.collect { if (it[vm.sessionId] != null) abortNow() } }
        onDispose { present = false; abort(); lockJob.cancel(); coverJob.cancel(); connectionJob.cancel(); settingsJob.cancel(); overlayJob.cancel(); safety.close(); audio.close() }
    }
    LaunchedEffect(enabled, focused) { if (!enabled || !focused) abortNow() }
    LaunchedEffect(listeningState.error) { if (listeningState.error != null) hold.reset() }

    fun begin(held: Boolean = false, preservePending: Boolean = true) {
        check(baseAllowed()) { "Unlock and reconnect before starting voice." }
        check(audio.available()) { resources.getString(R.string.voice_unavailable) }
        // A confirmation offered by the previous held utterance survives into the next hold.
        if (!preservePending || !voiceAllowed() || listening.state.value.active) {
            val pressed = hold.holding
            abort()
            if (held && pressed) hold.press(SystemClock.elapsedRealtime(), HoldToTalk.Permission.GRANTED)
        }
        link = vm.repo.remote(); leaseEpoch = epoch
        vm.dictation?.cancel()
        VoiceAudioOwner.claim(token) { epoch++; hold.reset(); listening.abort(); stepResult?.cancel(); stepUp = null }
    }
    fun start(held: Boolean) {
        try {
            begin(held)
            listening.start(VoiceListening.IO(
                capture = { audio.capture(vm.voiceLanguage, onReady = {
                    if (held && hold.didStart(SystemClock.elapsedRealtime()) == HoldToTalk.Action.DISCARD) listening.abort()
                }) },
                finishCapture = audio::finishCapture,
                stopAudio = audio::stop,
                allowed = { voiceAllowed() && safety.foreground },
            ), held)
        } catch (e: Exception) { hold.reset(); abort(); announce(e.message ?: "Voice could not start.") }
    }

    val labels = voiceLabels()
    if (conversationOpen) VoiceConversationSheet(
        targetKey = "$computerId:${vm.sessionId}", authorized = baseAllowed(),
        isStartAuthorized = { baseAllowed() },
        isAuthorized = { voiceAllowed() && vm.ui.value.approval == null && vm.ui.value.question == null },
        // Start needs base authorization before the lease exists; the I/O callback checks its lease.
        respond = { words ->
            val run = leaseEpoch
            requireAllowed(run)
            vm.voicePreflight(true, currentComposer.read())
            vm.sendVoice(words) { voiceAllowed() && epoch == run && currentComposer.read().let { it.text.isBlank() && !it.armed && !it.photos && !it.busy } }
        },
        onDismiss = { abort(); closeConversation() }, language = vm.voiceLanguage, labels = labels,
        audioToken = token,
        onAudioRevoked = { epoch++; listening.abort() },
        beforeStart = { vm.voicePreflight(baseAllowed(), currentComposer.read()); begin(preservePending = false) },
    )
    if (!enabled || !focused) return
    // Idle alternatives must not crowd the transcript off a small phone while typing.
    // Keep this composable (and its safety collectors) alive, and never hide an active
    // capture's Stop/Finish controls, a confirmation, or an error behind the keyboard.
    val showInlineControls = !WindowInsets.isImeVisible || listeningState.active || pending != null ||
        listeningState.error != null || notice != null
    if (showInlineControls) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (listeningState.active) TextButton(onClick = { abort() }, modifier = Modifier.testTag("voice.stop")) { Text(stringResource(R.string.voice_stop)) }
        run {
            HoldToTalkButton(hold,
                permission = if (permissionVersion.let { context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED }) HoldToTalk.Permission.GRANTED else HoldToTalk.Permission.UNDETERMINED,
                enabled = baseAllowed() && !conversationOpen,
                onAction = { action -> when (action) {
                    HoldToTalk.Action.ASK_PERMISSION -> permission.launch(Manifest.permission.RECORD_AUDIO)
                    HoldToTalk.Action.START -> start(held = true)
                    HoldToTalk.Action.FINISH -> listening.finish()
                    HoldToTalk.Action.DISCARD -> abort()
                    HoldToTalk.Action.NONE -> Unit
                } }, modifier = Modifier.testTag("voice.hold"), label = stringResource(R.string.voice_hold),
                accessibilityAction = stringResource(R.string.voice_hold_accessibility),
            )
        }
        TextButton(enabled = baseAllowed() && !conversationOpen, onClick = {
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) permission.launch(Manifest.permission.RECORD_AUDIO)
            else if (listeningState.active) { listening.finish(); hold.reset() } else start(held = false)
        }, modifier = Modifier.testTag("voice.commands")) { Text(stringResource(if (listeningState.active) R.string.voice_finish else R.string.voice_commands)) }
        (listeningState.error ?: notice)?.let { Text(it, modifier = Modifier.testTag("voice.notice")) }
        if (voiceAllowed()) pending?.let { VoiceCommandPrompt(it, { intent, id -> scope.launch { runner.answer(intent, id) } }, cancelLabel = stringResource(R.string.voice_cancel)) }
    }
    if (baseAllowed()) stepUp?.let { StepUpSheet(vm.repo, it, onDone = { stepUp = null }, onDismiss = { stepResult?.cancel(); stepUp = null }) }
}
