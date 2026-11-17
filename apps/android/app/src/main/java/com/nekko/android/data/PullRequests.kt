package com.nekko.android.data

import com.nekko.protocol.PhoneConnector
import com.nekko.protocol.PhoneConnectors
import com.nekko.protocol.PhonePullRequest
import com.nekko.protocol.PhoneRepo
import com.nekko.protocol.PhoneRequest
import com.nekko.protocol.PullRequestPlace
import com.nekko.protocol.PullRequestsApi
import com.nekko.protocol.WorkspaceFolder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * The Pull requests screen (#2109, the iPhone's PullRequestsModel): the selected git provider's
 * pull requests that involve the person (Mine), and the open ones in the repositories the paired
 * computers' folders hold plus the ones pinned here (Projects). Asked straight from this phone,
 * with its own token (decision 0058); never through a computer.
 */
class PullRequests(private val connectors: Connectors, private val secrets: SecureStore) {
    enum class Scope { MINE, PROJECTS }

    data class State(
        val mine: List<PhonePullRequest> = emptyList(),
        val projects: List<PhonePullRequest> = emptyList(),
        /** Every repository the provider lists for the person (for pinning). */
        val repos: List<PhoneRepo> = emptyList(),
        /** Projects' repositories: the folders' and the pinned ones. */
        val projectRepos: List<PhoneRepo> = emptyList(),
        val pinned: List<PhoneRepo> = emptyList(),
        val loading: Boolean = false,
        val loaded: Set<Scope> = emptySet(),
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    /** The kind the lists are from: a change of provider starts them over. */
    private var kind: String? = null
    private val pinsSerializer = MapSerializer(String.serializer(), ListSerializer(PhoneRepo.serializer()))

    val provider: PhoneConnector? get() = connectors.state.value.gitProvider

    suspend fun load(scope: Scope, folders: List<WorkspaceFolder>) {
        connectors.load()
        val c = provider
        val token = c?.let { connectors.token(it.kind) }
        if (c == null || token == null) {
            _state.update { it.copy(mine = emptyList(), projects = emptyList(), error = null) }
            return
        }
        if (kind != c.kind) {
            kind = c.kind
            _state.value = State(pinned = loadPins(c.kind))
        }
        _state.update { it.copy(loading = true) }
        try {
            when (scope) {
                Scope.MINE -> {
                    val list = fetch(PullRequestsApi.mine(c, token), c, PhonePullRequest.Role.AUTHORED)
                    _state.update { it.copy(mine = list) }
                }
                Scope.PROJECTS -> {
                    var repos = _state.value.repos
                    if (repos.isEmpty()) PullRequestsApi.repos(c, token)?.let { r ->
                        val (status, body) = connectors.http.send(r)
                        if (status !in 200..299) throw IllegalStateException(PhoneConnectors.failure(c.label, status, body))
                        repos = PullRequestsApi.parseRepos(c.kind, body)
                    }
                    val list = PullRequestPlace.projectRepos(folders, repos).toMutableList()
                    _state.value.pinned.forEach { if (it !in list) list += it }
                    val prs = fetch(PullRequestsApi.projects(c, token, list.map { it.fullName }), c, PhonePullRequest.Role.PROJECT)
                    _state.update { it.copy(repos = repos, projectRepos = list, projects = prs) }
                }
            }
            _state.update { it.copy(error = null, loaded = it.loaded + scope, loading = false) }
        } catch (e: CancellationException) {
            _state.update { it.copy(loading = false) }
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(error = e.message ?: "Couldn’t load pull requests.", loaded = it.loaded + scope, loading = false) }
        }
    }

    private suspend fun fetch(requests: List<PhoneRequest>, c: PhoneConnector, role: PhonePullRequest.Role): List<PhonePullRequest> {
        // GitLab's three lists are mine, assigned and to review, in that order.
        val gitlabRoles = listOf(PhonePullRequest.Role.AUTHORED, PhonePullRequest.Role.ASSIGNED, PhonePullRequest.Role.REVIEW_REQUESTED)
        val lists = requests.mapIndexed { i, request ->
            val (status, body) = connectors.http.send(request)
            if (status !in 200..299) throw IllegalStateException(PhoneConnectors.failure(c.label, status, body))
            if (c.kind == "github") PullRequestsApi.graphQLError(body)?.let { throw IllegalStateException("${c.label}: $it") }
            val each = if (c.kind == "gitlab" && role != PhonePullRequest.Role.PROJECT) gitlabRoles[minOf(i, 2)] else role
            PullRequestsApi.parse(c.kind, body, each)
        }
        return PullRequestsApi.merge(lists)
    }

    suspend fun pin(repo: PhoneRepo) {
        if (repo in _state.value.pinned) return
        _state.update { it.copy(pinned = it.pinned + repo) }
        savePins()
    }

    suspend fun unpin(repo: PhoneRepo) {
        _state.update { s ->
            val pinned = s.pinned - repo
            s.copy(pinned = pinned, projectRepos = s.projectRepos.filterNot { it == repo && it !in pinned }, projects = s.projects.filterNot { it.repo == repo.fullName })
        }
        savePins()
    }

    private suspend fun allPins(): Map<String, List<PhoneRepo>> =
        secrets.get(PINS)?.let { runCatching { Json.decodeFromString(pinsSerializer, it) }.getOrNull() } ?: emptyMap()

    private suspend fun loadPins(kind: String): List<PhoneRepo> = allPins()[kind].orEmpty()

    private suspend fun savePins() {
        val k = provider?.kind ?: return
        secrets.set(PINS, Json.encodeToString(pinsSerializer, allPins() + (k to _state.value.pinned)))
    }

    /** Pins read before a first load (the pin sheet opened on a fresh screen). */
    suspend fun preparePins() {
        connectors.load()
        val k = provider?.kind ?: return
        if (kind != k) { kind = k; _state.value = State(pinned = loadPins(k)) }
    }

    companion object {
        const val PINS = "phone.pinnedRepos.v1"
    }
}
