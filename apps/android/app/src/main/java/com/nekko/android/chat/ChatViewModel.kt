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
import com.nekko.android.terminal.RepoTerminalBackend

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.ComputersState
import com.nekko.android.data.PhonePrefs
import com.nekko.android.voice.Dictation
import com.nekko.android.voice.DictationController
import com.nekko.android.voice.MicHardware
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.Channels
import com.nekko.protocol.PullRequest
import com.nekko.protocol.PhoneChanges
import com.nekko.protocol.RelayState
import com.nekko.protocol.SkillSummary
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
import kotlinx.serialization.json.JsonPrimitive

/** Android wrapper around [ChatController]: wires it to the repository's state and events. */
class ChatViewModel(
    val sessionId: String,
    val repo: ComputersRepository,
    /** The phone's microphone and its settings; null keeps dictation off (tests, previews). */
    mic: MicHardware? = null,
    phonePrefs: PhonePrefs? = null,
) : ViewModel() {
    private val controller = ChatController(sessionId, repo.caller, viewModelScope, { env(repo.state.value) })

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
        // Load when the computer is reachable, and again after every reconnect.
        viewModelScope.launch {
            repo.state.map { it.conn }.distinctUntilChanged().collect { if (it == RelayState.ONLINE) controller.reload() }
        }
        viewModelScope.launch {
            repo.events.collect { e -> if (controller.onEvent(e)) launch { controller.reload() } }
        }
    }

    /** When this chat was completed on the computer; null while it is active. */
    val completedAt: StateFlow<Long?> = repo.state.map { s -> s.summaries.firstOrNull { it.id == sessionId }?.archivedAt }
        .distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.state.value.summaries.firstOrNull { it.id == sessionId }?.archivedAt)

    /** Bring this completed chat back to the active list. */
    suspend fun restore() = repo.restoreChat(sessionId)

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
    )
}
