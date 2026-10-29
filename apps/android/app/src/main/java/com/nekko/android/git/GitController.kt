package com.nekko.android.git

import com.nekko.protocol.Channels
import com.nekko.protocol.GitBranches
import com.nekko.protocol.GitCommit
import com.nekko.protocol.GitCommitDetail
import com.nekko.protocol.GitCommitMessage
import com.nekko.protocol.GitCompare
import com.nekko.protocol.GitDiff
import com.nekko.protocol.GitFile
import com.nekko.protocol.GitRequest
import com.nekko.protocol.GitResult
import com.nekko.protocol.GitStatus
import com.nekko.protocol.PrAction
import com.nekko.protocol.PrCheckList
import com.nekko.protocol.RelayException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement

/** What the last git change said: git's own words, and whether it worked. */
data class GitNotice(val ok: Boolean, val text: String)

/** What the Git screen draws. */
data class GitState(
    val status: GitStatus? = null,
    /** Unstaged changes, new files included. */
    val unstaged: GitDiff = GitDiff(),
    val staged: GitDiff = GitDiff(),
    val loaded: Boolean = false,
    val loading: Boolean = false,
    /** Why the last read failed. */
    val error: String? = null,
    /** A change in flight: its channel. */
    val busy: String? = null,
    val notice: GitNotice? = null,
    /** The commit message being written. */
    val message: String = "",
    /** The model's message was written from a cut diff. */
    val messageFromCutDiff: Boolean = false,
) {
    val canCommit: Boolean get() = staged.files.isNotEmpty() && message.isNotBlank() && busy == null
    val hasChanges: Boolean get() = staged.files.isNotEmpty() || unstaged.files.isNotEmpty()

    /** A file is unmerged: a merge stopped on a conflict, so it can be aborted. */
    val merging: Boolean get() = (staged.files + unstaged.files).any { it.status == GitFile.Status.CONFLICTED }
}

/**
 * Git on one chat's folder from the phone (AN-30, the iPhone's `GitModel`):
 * its status and changed files, history, branches, compare and a pull
 * request's checks and files, and the Change actions. Reads are plain calls; every change goes through [change], which
 * signs it, so the phone asks for the fingerprint, face or screen lock (once
 * per 5 minutes) and the computer checks the signature. The logic without
 * Android, like [com.nekko.android.monitors.MonitorsController].
 */
class GitController(
    val chatId: String,
    private val read: suspend (GitRequest) -> JsonElement,
    private val change: suspend (GitRequest) -> JsonElement,
) {
    private val _state = MutableStateFlow(GitState())
    val state: StateFlow<GitState> = _state.asStateFlow()

    fun setMessage(text: String) = _state.update { it.copy(message = text) }

    fun clearNotice() = _state.update { it.copy(notice = null) }

    // ---- reads ----

    /** Status, then the unstaged and staged changes, read together. */
    suspend fun load(refresh: Boolean = false) {
        _state.update { it.copy(loading = true) }
        try {
            coroutineScope {
                val s = async { read(GitRequest.status(chatId, refresh)) }
                val u = async { read(GitRequest.diff(chatId, staged = false)) }
                val st = async { read(GitRequest.diff(chatId, staged = true)) }
                val (sv, uv, stv) = Triple(s.await(), u.await(), st.await())
                _state.update { it.copy(status = GitStatus.from(sv), unstaged = GitDiff.from(uv), staged = GitDiff.from(stv), error = null) }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(error = words(e)) }
        }
        _state.update { it.copy(loading = false, loaded = true) }
    }

    suspend fun history(limit: Int = 50, skip: Int = 0): List<GitCommit> = GitCommit.list(read(GitRequest.log(chatId, limit, skip)))

    suspend fun commit(sha: String): GitCommitDetail =
        GitCommitDetail.from(read(GitRequest.show(chatId, sha))) ?: throw RelayException("Commit not found.")

    suspend fun branches(): GitBranches = GitBranches.from(read(GitRequest.branches(chatId)))

    suspend fun compare(base: String, head: String): GitCompare =
        GitCompare.from(read(GitRequest.compare(chatId, base, head))) ?: throw RelayException("Nothing to compare.")

    suspend fun checks(url: String): PrCheckList =
        PrCheckList.from(read(GitRequest.prChecks(url))) ?: throw RelayException("No checks for this pull request.")

    suspend fun prDiff(url: String): GitDiff = GitDiff.from(read(GitRequest.prDiff(url)))

    // ---- changes ----

    suspend fun stage(paths: List<String>) { act(GitRequest.stage(chatId, paths)) }
    suspend fun unstage(paths: List<String>) { act(GitRequest.unstage(chatId, paths)) }
    suspend fun stageAll() = stage(_state.value.unstaged.files.map { it.path })
    suspend fun unstageAll() = unstage(_state.value.staged.files.map { it.path })

    /** Commit what is staged with the message; the field empties when it worked. */
    suspend fun commit() {
        val text = _state.value.message.trim()
        if (text.isEmpty()) return
        if (act(GitRequest.commit(chatId, text))?.ok == true) _state.update { it.copy(message = "", messageFromCutDiff = false) }
    }

    /** Ask the computer's model for a message for what is staged, into the field. */
    suspend fun writeMessage() {
        if (_state.value.busy != null) return
        _state.update { it.copy(busy = Channels.GIT_COMMIT_MESSAGE) }
        try {
            val m = GitCommitMessage.from(change(GitRequest.commitMessage(chatId)))
            _state.update {
                if (m == null) it.copy(notice = GitNotice(false, "The model wrote no message. Try again, or write one."))
                else it.copy(message = m.message, messageFromCutDiff = m.inputTruncated, notice = null)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(notice = GitNotice(false, words(e))) }
        } finally {
            _state.update { it.copy(busy = null) }
        }
    }

    suspend fun push() { act(GitRequest.push(chatId)) }

    suspend fun switchTo(branch: String, create: Boolean = false): Boolean = act(GitRequest.switchBranch(chatId, branch, create))?.ok == true

    suspend fun abortMerge() { act(GitRequest.mergeAbort(chatId)) }

    /** Open a PR from the current branch (pushed first if it has no upstream). Its address, when it worked. */
    suspend fun createPr(title: String, body: String, base: String?, draft: Boolean): String? {
        val r = act(GitRequest.createPr(chatId, title.trim(), body, base, draft))
        return if (r?.ok == true) r.url ?: r.pr?.url else null
    }

    /** Approve, merge, close or reopen; the status isn't read again (it is the PR that changed). */
    suspend fun prAction(url: String, action: PrAction): GitResult? = act(GitRequest.prAction(url, action), reload = false)

    /** Run one change, say what happened, and read the status again. */
    private suspend fun act(request: GitRequest, reload: Boolean = true): GitResult? {
        if (_state.value.busy != null) return null
        _state.update { it.copy(busy = request.channel) }
        val result = try {
            GitResult.from(change(request)).also { r ->
                val text = r.message.ifEmpty { if (r.ok) "Done." else "Git refused it." }
                _state.update { it.copy(notice = GitNotice(r.ok, text)) }
            }
        } catch (e: CancellationException) {
            _state.update { it.copy(busy = null) }
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(notice = GitNotice(false, words(e))) }
            null
        }
        _state.update { it.copy(busy = null) }
        if (result != null && reload) load()
        return result
    }

    private fun words(e: Exception) = e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t reach your computer."
}
