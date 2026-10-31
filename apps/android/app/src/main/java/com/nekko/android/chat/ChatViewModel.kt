package com.nekko.android.chat

import com.nekko.android.git.GitController
import com.nekko.protocol.SavedPrompt
import com.nekko.protocol.Block
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CoroutineScope
import com.nekko.android.terminal.TerminalsController
import com.nekko.android.ui.files.FilesOverlay
import com.nekko.android.ui.files.FilesPage
import com.nekko.android.ui.files.filesOn
import com.nekko.protocol.FileRoot
import com.nekko.protocol.ChatPreviewLink
import com.nekko.android.previews.ChatPreviews
import com.nekko.android.previews.PreviewOverlay
import com.nekko.android.terminal.RepoTerminalBackend

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.ComputersState
import com.nekko.android.data.PhonePrefs
import com.nekko.android.monitors.EXPERT_MODE
import com.nekko.android.monitors.HardwareMonitorController
import com.nekko.android.voice.Dictation
import com.nekko.android.voice.DictationController
import com.nekko.android.voice.MicHardware
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.Channels
import com.nekko.protocol.Effort
import com.nekko.protocol.PullRequest
import com.nekko.protocol.PhoneChanges
import com.nekko.protocol.RelayState
import com.nekko.protocol.SkillSummary
import com.nekko.protocol.Draft
import com.nekko.android.data.OutboxItem
import com.nekko.protocol.PcSettings
import com.nekko.protocol.StepUpProof
import android.content.ContentResolver
import android.net.Uri
import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import com.nekko.protocol.Activity
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.AgentWatch
import com.nekko.protocol.AgentRows
import kotlinx.serialization.json.JsonPrimitive

/** Android wrapper around [ChatController]: wires it to the repository's state and events. */
class ChatViewModel(
    val sessionId: String,
    val repo: ComputersRepository,
    /** The phone's microphone and its settings; null keeps dictation off (tests, previews). */
    mic: MicHardware? = null,
    private val phonePrefs: PhonePrefs? = null,
) : ViewModel() {
    private val controller = ChatController(sessionId, repo.caller, viewModelScope, { env(repo.state.value) }, outbox = repo.outbox, saved = repo.transcripts)

    /** Dictation into this chat's message box (Settings → Dictation). */
    val dictation: DictationController? = if (mic == null || phonePrefs == null) null else DictationController(
        scope = viewModelScope,
        caller = repo.caller,
        hardware = mic,
        settings = { phonePrefs.get(Dictation.ENGINE) to phonePrefs.get(Dictation.LANGUAGE) },
        computer = {
            val s = repo.state.value
            DictationController.computerVoice(repo.caller, s.conn == RelayState.ONLINE, s.pcSettings.voiceEnabled)
        },
        computerName = { repo.state.value.active?.name ?: "your computer" },
    )

    /** Simple or Expert (the phone's choice, every chat); always Simple without prefs (tests, previews). */
    val expert: StateFlow<Boolean> = phonePrefs?.flow(EXPERT_MODE) ?: MutableStateFlow(false)
    fun setExpert(on: Boolean) { phonePrefs?.set(EXPERT_MODE, on) }

    /** Expert mode's hardware and loaded models; the screen polls it only while Expert is on and the chat is visible. */
    val hardware = HardwareMonitorController(repo.caller) { repo.state.value.active?.name ?: "your computer" }

    /** The model and effort sheet: change the chat's model or effort on the computer. Throws so the sheet can say why. */
    suspend fun setOptions(providerId: String? = null, modelId: String? = null, effort: Effort? = null) =
        controller.setOptions(providerId, modelId, effort)

    /** The computer's state, for the model picker and the Monitor's model names. */
    val computers: StateFlow<ComputersState> = repo.state

    /** A loaded model's name from the computer's lists, else its id. */
    fun modelName(id: String): String = repo.state.value.models.values.firstNotNullOfOrNull { l -> l.firstOrNull { it.id == id }?.name } ?: id

    /** The model picker in the sheet lists every enabled provider's models. */
    suspend fun loadModels() = repo.loadAllModels()

    /** One provider's models, for the chat's model name; a failed read leaves the id showing. */
    suspend fun loadModels(providerId: String) {
        try {
            repo.loadModels(providerId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }


    /** Git on this chat's folder (AN-30): reads plain, changes signed with the phone's Change key. */
    fun git(): GitController = GitController(
        sessionId,
        read = { r -> repo.caller.call(r.channel, *r.args.toTypedArray()) },
        // A model-written message can take a while; a push or a switch too.
        change = { r -> repo.callChange(r.channel, r.args, timeoutMs = if (r.channel == Channels.GIT_COMMIT_MESSAGE) 90_000 else 150_000) },
    )

    /** Change or remove a queued prompt before it runs (AN-29); the computer checks it still reads [expect]. */
    suspend fun editQueued(index: Int, expect: String, text: String?) = controller.editQueued(index, expect, text)

    /** Whether [block] is saved, so the chat can be forked from it. */
    fun canFork(block: Block): Boolean = controller.isSaved(block)

    /** Fork this chat from [block]: the new chat's id and the prompt for its message box. */
    suspend fun fork(block: Block): Pair<String, String?> = controller.fork(block).also { repo.reloadList() }

    /** The prompts saved on the computer, offered by `/` beside its skills. */
    val prompts: StateFlow<List<SavedPrompt>> = repo.state.map { it.pcSettings.prompts }.distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.state.value.pcSettings.prompts)

    /** Git (AN-30) over this chat, at its status or straight at one pull request (from the chip). */
    data class GitOverlay(val git: GitController, val pr: PullRequest?)

    /**
     * Git and the Terminals (AN-31) open over this chat. They live in the
     * repository by chat id, so opening or folding the phone keeps them open.
     */
    val gitOpen: StateFlow<GitOverlay?> = repo.overlays.map { it[sessionId] as? GitOverlay }
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.overlays.value[sessionId] as? GitOverlay)

    fun openGit(pr: PullRequest? = null) = repo.setOverlay(sessionId, GitOverlay(git(), pr))

    fun closeGit() = repo.setOverlay(sessionId, null)

    val terminalsOpen: StateFlow<TerminalsController?> = repo.overlays.map { it[sessionId] as? TerminalsController }
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.overlays.value[sessionId] as? TerminalsController)

    fun openTerminals() = repo.setOverlay(sessionId, TerminalsController(sessionId, RepoTerminalBackend(repo), repo.appScope))

    fun closeTerminals() {
        (repo.overlays.value[sessionId] as? TerminalsController)?.hide()
        repo.setOverlay(sessionId, null)
    }

    /** This chat's files (AN-33), over the chat like Git. */
    val filesOpen: StateFlow<FilesOverlay?> = repo.overlays.map { it[sessionId] as? FilesOverlay }
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.overlays.value[sessionId] as? FilesOverlay)

    fun openFiles() = repo.setOverlay(sessionId, FilesOverlay(FilesPage.Folder(filesOn(repo, FileRoot.Chat(sessionId)), "", "Files")))

    fun closeFiles() = repo.setOverlay(sessionId, null)

    /** A file or loopback page the agent linked, open over this chat (AN-35). */
    val previewOpen: StateFlow<PreviewOverlay?> = repo.overlays.map { it[sessionId] as? PreviewOverlay }
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.overlays.value[sessionId] as? PreviewOverlay)

    fun openPreview(link: ChatPreviewLink) = repo.setOverlay(sessionId, PreviewOverlay(link))

    fun closePreview() = repo.setOverlay(sessionId, null)

    /** What the replies in this chat open their links and cards with. */
    val previews = ChatPreviews(sessionId, repo.previews, ::openPreview)

    /** Whether the active computer is connected (the terminal screens open and reopen on it). */
    val online: StateFlow<Boolean> = repo.state.map { it.conn == RelayState.ONLINE }.distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.state.value.conn == RelayState.ONLINE)

    val computerName: String get() = repo.state.value.active?.name ?: "your computer"

    /** The pull requests this chat opened, with their state and checks (read only, `pr:sessionList`). */
    suspend fun pullRequests(refresh: Boolean = false): List<PullRequest> =
        PullRequest.list(repo.caller.call(Channels.PR_SESSION_LIST, JsonPrimitive(sessionId), JsonPrimitive(refresh)))

    override fun onCleared() {
        dictation?.cancel()
    }

    val ui: StateFlow<ChatUi> = combine(controller.state, repo.state.map(this::env).distinctUntilChanged()) { s, e ->
        ChatController.project(s, e)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, ChatController.project(controller.state.value, env(repo.state.value)))

    init {
        // Instant paint (OF-6): the saved copy at once, replaced in place when the computer answers.
        controller.showSavedCopy()
        // Load when the computer is reachable, and again after every reconnect.
        viewModelScope.launch {
            repo.state.map { it.conn }.distinctUntilChanged().collect { if (it == RelayState.ONLINE) controller.reload() }
        }
        viewModelScope.launch {
            repo.events.collect { e -> if (controller.onEvent(e)) launch { controller.reload() } }
        }
    }

    private val _watches = MutableStateFlow<List<AgentWatch>>(emptyList())
    /** The chat's durable watches (`session:watches`), for the watch rows' live chips. */
    val watches: StateFlow<List<AgentWatch>> = _watches.asStateFlow()

    /** This chat's subagent chats (the list hides them) and their live activity, for the delegation rows. */
    data class Subagents(val children: List<SessionSummary> = emptyList(), val activity: Map<String, Activity> = emptyMap())

    val subagents: StateFlow<Subagents> = repo.state.map { s ->
        val children = s.summaries.filter { it.parentSessionId == sessionId }
        Subagents(children, s.activity.filterKeys { id -> children.any { it.id == id } })
    }.distinctUntilChanged().stateIn(viewModelScope, SharingStarted.Eagerly, Subagents())

    private fun calls(tool: String) = ui.value.blocks.any { it is Block.Tool && it.name == tool }

    /**
     * Re-read what the agent-work rows show beyond the transcript: the watches,
     * and the child chats when the transcript delegates. Failures keep the last state.
     */
    suspend fun refreshAgentState() {
        if (calls(AgentRows.WATCH_TOOL)) {
            runCatching { AgentWatch.list(repo.caller.call(Channels.SESSION_WATCHES, JsonPrimitive(sessionId))) }
                .onSuccess { _watches.value = it }
        }
        if (calls(AgentRows.SUBAGENT_TOOL)) runCatching { repo.reloadList() }
    }

    init {
        // Re-read when the transcript first holds a watch or a delegation, and after each turn.
        viewModelScope.launch {
            ui.map { u -> Triple(u.blocks.any { it is Block.Tool && it.name == AgentRows.WATCH_TOOL },
                u.blocks.any { it is Block.Tool && it.name == AgentRows.SUBAGENT_TOOL }, u.running) }
                .distinctUntilChanged()
                .collect { (watch, agent, _) -> if (watch || agent) refreshAgentState() }
        }
        // While a watch is armed, its chip is re-read every 15 s (the desktop's cadence).
        viewModelScope.launch {
            while (true) {
                delay(15_000)
                if (_watches.value.any { it.status == AgentWatch.Status.ACTIVE }) refreshAgentState()
            }
        }
    }

    /** When this chat was completed on the computer; null while it is active. */
    val completedAt: StateFlow<Long?> = repo.state.map { s -> s.summaries.firstOrNull { it.id == sessionId }?.archivedAt }
        .distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.state.value.summaries.firstOrNull { it.id == sessionId }?.archivedAt)

    /** Bring this completed chat back to the active list. */
    suspend fun restore() = repo.restoreChat(sessionId)

    /** Whether this chat is pinned on the computer. */
    val pinned: StateFlow<Boolean> = repo.state.map { s -> s.summaries.firstOrNull { it.id == sessionId }?.pinned == true }
        .distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.state.value.summaries.firstOrNull { it.id == sessionId }?.pinned == true)

    /** The chat's ⋮ → Rename, Pin, Complete and Chat mode: each changes the chat on the computer, then re-reads it. */
    suspend fun rename(title: String) {
        repo.renameChat(sessionId, title)
        controller.reload()
    }

    suspend fun setPinned(pinned: Boolean) = repo.setPinned(sessionId, pinned)

    suspend fun complete() = repo.completeChat(sessionId)

    /** Raising the mode is signed; a step-up refusal is thrown for the sheet, which passes its [stepUp]. */
    suspend fun setMode(mode: PcSettings.ChatMode, stepUp: StepUpProof? = null) {
        repo.setChatMode(sessionId, mode, stepUp)
        controller.reload()
    }

    /** What the chat runs with when it has no mode of its own: the computer's default. */
    val defaultMode: PcSettings.ChatMode get() = repo.state.value.pcSettings.effectiveMode

    /** Whether the computer lets phones see a chat's changes (`phoneChanges`, set on the computer). */
    val changesAllowed: StateFlow<Boolean> = repo.state.map { it.pcSettings.phoneChanges }.distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.state.value.pcSettings.phoneChanges)

    private val _insert = MutableStateFlow<String?>(null)
    /** Text to add to the message box (a quoted line from Changes); the composer takes it once. */
    val insert: StateFlow<String?> = _insert.asStateFlow()
    fun quote(text: String) { _insert.value = text }
    fun inserted() { _insert.value = null }

    /** The Changes sheet's state: loading (null fields), loaded, or the reason it couldn't. */
    data class ChangesLoad(val changes: PhoneChanges? = null, val error: String? = null)

    private val _changes = MutableStateFlow(ChangesLoad())
    val changes: StateFlow<ChangesLoad> = _changes.asStateFlow()

    /** What the agent changed in this chat; the computer refuses unless it allows phones to see changes. */
    fun loadChanges() {
        _changes.update { it.copy(error = null) }
        viewModelScope.launch {
            _changes.value = try {
                ChangesLoad(PhoneChanges.from(repo.caller.callWithTimeout(30_000, Channels.CHANGES_LIST, JsonPrimitive(sessionId))))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ChangesLoad(_changes.value.changes, e.message ?: "Couldn’t load changes.")
            }
        }
    }

    suspend fun send(text: String, skill: SkillSummary? = null, images: List<String> = emptyList()) = controller.send(text, skill, images)

    /** Photos waiting in the message box; kept here so a rotation doesn't drop them. */
    val photos = PhotoTray<ImageBitmap>()

    // ---- the draft (offline mode): what the message box holds survives leaving the chat and the app ending ----

    /** The draft as the chat opened: the message box starts from it. */
    val savedDraft: Draft = repo.drafts.draft(sessionId)
    private var draftText = savedDraft.text
    private var draftSkill = savedDraft.skill

    init {
        photos.seed(savedDraft.images.mapNotNull { url -> ImageAttachments.preview(url)?.let { url to it } })
        // A photo added or removed is saved like a typed word.
        viewModelScope.launch {
            photos.state.map { s -> s.photos.map { it.dataUrl } }.distinctUntilChanged().collect { saveDraft() }
        }
    }

    /** This chat's prompts waiting in the outbox, oldest first, shown as *Waiting to send*. */
    val waiting: StateFlow<List<OutboxItem>> = repo.outbox.state.map { it.waitingFor(sessionId) }.distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.outbox.state.value.waitingFor(sessionId))

    /** The prompt being delivered now (its Edit and Delete wait). */
    val sendingId: StateFlow<String?> = repo.outbox.state.map { it.sendingId }.distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val _restore = MutableStateFlow<Draft?>(null)
    /**
     * A prompt back from the outbox (Edit, or refused by the computer), merged in
     * front of what was typed: the message box takes it once ([restored]).
     */
    val restore: StateFlow<Draft?> = _restore.asStateFlow()

    /** Why the computer turned the last prompt down; shown above the box until the next send. */
    val refusal: StateFlow<String?> = repo.drafts.drafts.map { it[sessionId]?.refusal }.distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, savedDraft.refusal)

    init {
        // The outbox put a prompt back in this chat's draft: show it in the box.
        viewModelScope.launch {
            repo.drafts.drafts.map { it[sessionId] }.distinctUntilChanged().collect { d ->
                if (d != null && (d.text != draftText || d.skill?.name != draftSkill?.name || d.images != photos.state.value.photos.map { it.dataUrl })) {
                    draftText = d.text
                    draftSkill = d.skill
                    val have = photos.state.value.photos.map { it.dataUrl }.toSet()
                    photos.seed(d.images.filter { it !in have }.mapNotNull { url -> ImageAttachments.preview(url)?.let { url to it } })
                    _restore.value = d
                }
            }
        }
    }

    fun restored() { _restore.value = null }

    /** *Waiting to send* → Edit: back into the box. */
    fun editWaiting(id: String) { repo.outbox.takeBack(id) }

    /** *Waiting to send* → Delete. */
    fun deleteWaiting(id: String) { repo.outbox.remove(id) }

    /** *Waiting to send* → Send now: try again at once. */
    fun sendWaitingNow() = repo.outbox.flushSoon()

    /** The refusal note was read: drop it from the draft. */
    fun dismissRefusal() {
        val d = repo.drafts.draft(sessionId)
        if (d.refusal != null) repo.drafts.set(sessionId, d.copy(refusal = null))
    }

    /** The message box changed: its text and armed skill (by name, resolved against the computer's skills). */
    fun draftChanged(text: String, skillName: String?) {
        draftText = text
        draftSkill = when {
            skillName == null -> null
            draftSkill?.name == skillName -> draftSkill
            else -> ui.value.skills.firstOrNull { it.name == skillName } ?: SkillSummary(skillName, "", "", "")
        }
        saveDraft()
    }

    private fun saveDraft() {
        val photosNow = photos.state.value.photos.map { it.dataUrl }
        val d = repo.drafts.draft(sessionId)
        // Emptied by a send: the refusal note has been answered too.
        val refusal = d.refusal.takeUnless { draftText.isBlank() && draftSkill == null && photosNow.isEmpty() }
        repo.drafts.set(sessionId, d.copy(text = draftText, skill = draftSkill, images = photosNow, refusal = refusal))
    }

    /** Picked files or a camera shot → the tray, scaled and encoded off the main thread. */
    fun addPhotos(resolver: ContentResolver, uris: List<Uri>, afterEach: (Uri) -> Unit = {}) {
        if (uris.isEmpty()) return
        val n = photos.begin(uris.size)
        uris.drop(n).forEach(afterEach)
        uris.take(n).forEach { uri ->
            viewModelScope.launch {
                try {
                    val (url, preview) = ImageAttachments.encode(resolver, uri)
                    photos.added(url, preview)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    photos.failed("Couldn’t read that image.")
                } finally {
                    afterEach(uri)
                }
            }
        }
    }
    fun stop() = controller.stop()
    suspend fun approve(ok: Boolean) = controller.approve(ok)
    suspend fun answer(answers: List<AskAnswer>) = controller.answer(answers)

    private fun env(s: ComputersState) = ChatEnv(
        conn = s.conn,
        denied = s.denied,
        defaults = s.defaults,
        computerName = s.active?.name ?: "your computer",
        models = s.models,
        canQueue = true,
    )
}
