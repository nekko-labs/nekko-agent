package com.nekko.protocol

import java.time.OffsetDateTime
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** A pull request (a merge request on GitLab) from the git provider connected on this phone (#2109). */
data class PhonePullRequest(
    val url: String,
    /** `owner/name` (GitLab: `group/subgroup/name`). */
    val repo: String,
    val number: Int,
    val title: String,
    val author: String? = null,
    val isDraft: Boolean = false,
    val updatedAt: Long? = null,
    /** The branch it brings in, and the one it merges into. */
    val head: String? = null,
    val base: String? = null,
    val checks: PullRequest.Checks = PullRequest.Checks.NONE,
    val review: Review? = null,
    val roles: Set<Role> = emptySet(),
) {
    /** Why it is in the list. */
    enum class Role(val wire: String) { REVIEW_REQUESTED("reviewRequested"), AUTHORED("authored"), ASSIGNED("assigned"), PROJECT("project") }
    enum class Review { APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED }

    /** The repository's own name, which is what a project folder is usually called. */
    val repoName: String get() = repo.substringAfterLast('/')
}

/** A repository the user can see on the git provider, for Projects. */
@Serializable
data class PhoneRepo(val fullName: String) {
    val name: String get() = fullName.substringAfterLast('/')
}

/** How each git provider is asked for pull requests, and how its answers read (the iPhone's PullRequestsAPI). */
object PullRequestsApi {
    /** GitHub's GraphQL address for a REST API address (`https://api.github.com`, or `https://host/api/v3` on Enterprise). */
    fun githubGraphQL(api: String): String = if (api.endsWith("/api/v3")) api.dropLast(2) + "graphql" else "$api/graphql"

    private const val FIELDS = "fragment pr on PullRequest { number title url isDraft updatedAt headRefName baseRefName reviewDecision " +
        "author { login } repository { nameWithOwner } " +
        "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }"

    private fun search(alias: String, q: String, first: Int = 40): String =
        "$alias: search(query: ${JsonPrimitive("$q is:pr is:open archived:false sort:updated-desc")}, type: ISSUE, first: $first) { nodes { ...pr } }"

    /** GitHub's search takes about 256 characters, so a long list of repos is split across searches. */
    fun repoQueries(repos: List<String>, limit: Int = 200): List<String> {
        val out = ArrayList<String>()
        var cur = ""
        for (r in repos) {
            val term = "repo:$r"
            if (cur.isNotEmpty() && cur.length + 1 + term.length > limit) { out += cur; cur = "" }
            cur += if (cur.isEmpty()) term else " $term"
        }
        if (cur.isNotEmpty()) out += cur
        return out
    }

    private fun graphql(c: PhoneConnector, h: Map<String, String>, query: String) =
        PhoneRequest(githubGraphQL(c.settings["api"] ?: "https://api.github.com"), h + ("Content-Type" to "application/json"), buildJsonObject { put("query", query) })

    /** The user's own: authored, to review, assigned. GitLab's three lists come back in that order. */
    fun mine(c: PhoneConnector, token: String): List<PhoneRequest> {
        val h = PhoneConnectors.headers(c, token)
        return when (c.kind) {
            "github" -> listOf(graphql(c, h, "query { ${search("authored", "author:@me")} ${search("reviewRequested", "review-requested:@me")} ${search("assigned", "assignee:@me")} }\n$FIELDS"))
            "gitlab" -> {
                val base = "${c.settings["site"] ?: "https://gitlab.com"}/api/v4/merge_requests?state=opened&per_page=40"
                listOfNotNull(
                    PhoneRequest("$base&scope=created_by_me", h, method = "GET"),
                    PhoneRequest("$base&scope=assigned_to_me", h, method = "GET"),
                    c.userId?.let { PhoneRequest("$base&scope=all&reviewer_username=${PhoneConnectors.query(it)}", h, method = "GET") },
                )
            }
            "bitbucket" -> c.userId?.let { listOf(PhoneRequest("https://api.bitbucket.org/2.0/pullrequests/${PhoneConnectors.query(it)}?state=OPEN&pagelen=50", h, method = "GET")) } ?: emptyList()
            else -> emptyList()
        }
    }

    /** The repositories the user can see, most recently active first. */
    fun repos(c: PhoneConnector, token: String): PhoneRequest? {
        val h = PhoneConnectors.headers(c, token)
        return when (c.kind) {
            "github" -> PhoneRequest("${c.settings["api"] ?: "https://api.github.com"}/user/repos?per_page=100&sort=pushed", h, method = "GET")
            "gitlab" -> PhoneRequest("${c.settings["site"] ?: "https://gitlab.com"}/api/v4/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at", h, method = "GET")
            "bitbucket" -> PhoneRequest("https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100&sort=-updated_on", h, method = "GET")
            else -> null
        }
    }

    /** The open pull requests of these repositories. */
    fun projects(c: PhoneConnector, token: String, repos: List<String>): List<PhoneRequest> {
        if (repos.isEmpty()) return emptyList()
        val h = PhoneConnectors.headers(c, token)
        return when (c.kind) {
            "github" -> listOf(graphql(c, h, "query { ${repoQueries(repos).mapIndexed { i, q -> search("p$i", q, first = 50) }.joinToString(" ")} }\n$FIELDS"))
            "gitlab" -> { val site = c.settings["site"] ?: "https://gitlab.com"; repos.map { PhoneRequest("$site/api/v4/projects/${PhoneConnectors.query(it)}/merge_requests?state=opened&per_page=30", h, method = "GET") } }
            "bitbucket" -> repos.map { PhoneRequest("https://api.bitbucket.org/2.0/repositories/$it/pullrequests?state=OPEN&pagelen=30", h, method = "GET") }
            else -> emptyList()
        }
    }

    private fun parseJson(body: String): JsonElement? = if (body.length > 4_000_000) null else runCatching { Json.parseToJsonElement(body) }.getOrNull()
    private fun JsonElement?.o(vararg path: String): JsonElement? = path.fold(this) { v, k -> (v as? JsonObject)?.get(k) }
    private fun JsonElement?.s(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonElement?.l(): Long? = (this as? JsonPrimitive)?.longOrNull
    private fun JsonElement?.flag(): Boolean = (this as? JsonPrimitive)?.booleanOrNull == true

    /** Pull requests in an answer, each with the role its search stands for (GitHub's aliases name it). */
    fun parse(kind: String, body: String, role: PhonePullRequest.Role): List<PhonePullRequest> {
        val v = parseJson(body) ?: return emptyList()
        return when (kind) {
            "github" -> (v.o("data") as? JsonObject).orEmpty().flatMap { (alias, result) ->
                val r = PhonePullRequest.Role.entries.firstOrNull { it.wire == alias } ?: PhonePullRequest.Role.PROJECT
                (result.o("nodes") as? JsonArray).orEmpty().mapNotNull { github(it, r) }
            }
            "gitlab" -> (v as? JsonArray).orEmpty().mapNotNull { gitlab(it, role) }
            "bitbucket" -> (v.o("values") as? JsonArray).orEmpty().mapNotNull { bitbucket(it, role) }
            else -> emptyList()
        }
    }

    fun parseRepos(kind: String, body: String): List<PhoneRepo> {
        val v = parseJson(body) ?: return emptyList()
        return when (kind) {
            "github" -> (v as? JsonArray).orEmpty().mapNotNull { it.o("full_name").s()?.let(::PhoneRepo) }
            "gitlab" -> (v as? JsonArray).orEmpty().mapNotNull { it.o("path_with_namespace").s()?.let(::PhoneRepo) }
            "bitbucket" -> (v.o("values") as? JsonArray).orEmpty().mapNotNull { it.o("full_name").s()?.let(::PhoneRepo) }
            else -> emptyList()
        }
    }

    /** GraphQL answers a 200 with `errors` when a search is refused. */
    fun graphQLError(body: String): String? {
        val v = parseJson(body) ?: return null
        val data = v.o("data")
        if (data is JsonObject) return null
        return ((v.o("errors") as? JsonArray)?.firstOrNull().o("message").s())?.take(200)
    }

    private fun github(n: JsonElement, role: PhonePullRequest.Role): PhonePullRequest? {
        val url = n.o("url").s() ?: return null
        val num = n.o("number").l() ?: return null
        val repo = n.o("repository", "nameWithOwner").s() ?: return null
        val rollup = (n.o("commits", "nodes") as? JsonArray)?.firstOrNull().o("commit", "statusCheckRollup", "state").s()
        return PhonePullRequest(
            url, repo, num.toInt(), n.o("title").s().orEmpty(),
            author = n.o("author", "login").s(), isDraft = n.o("isDraft").flag(), updatedAt = n.o("updatedAt").s()?.let(::date),
            head = n.o("headRefName").s(), base = n.o("baseRefName").s(),
            checks = when (rollup) { "SUCCESS" -> PullRequest.Checks.PASSING; "FAILURE", "ERROR" -> PullRequest.Checks.FAILING; "PENDING", "EXPECTED" -> PullRequest.Checks.PENDING; else -> PullRequest.Checks.NONE },
            review = when (n.o("reviewDecision").s()) { "APPROVED" -> PhonePullRequest.Review.APPROVED; "CHANGES_REQUESTED" -> PhonePullRequest.Review.CHANGES_REQUESTED; "REVIEW_REQUIRED" -> PhonePullRequest.Review.REVIEW_REQUIRED; else -> null },
            roles = setOf(role),
        )
    }

    private fun gitlab(m: JsonElement, role: PhonePullRequest.Role): PhonePullRequest? {
        val url = m.o("web_url").s() ?: return null
        val iid = m.o("iid").l() ?: return null
        val repo = (m.o("references", "full").s() ?: "").substringBefore('!')
        val merge = m.o("detailed_merge_status").s()
        return PhonePullRequest(
            url, repo.ifEmpty { url }, iid.toInt(), m.o("title").s().orEmpty(),
            author = m.o("author", "username").s(), isDraft = m.o("draft").flag() || m.o("work_in_progress").flag(),
            updatedAt = m.o("updated_at").s()?.let(::date), head = m.o("source_branch").s(), base = m.o("target_branch").s(),
            checks = when (merge) { "ci_must_pass" -> PullRequest.Checks.FAILING; "ci_still_running" -> PullRequest.Checks.PENDING; else -> PullRequest.Checks.NONE },
            roles = setOf(role),
        )
    }

    private fun bitbucket(b: JsonElement, role: PhonePullRequest.Role): PhonePullRequest? {
        val url = b.o("links", "html", "href").s() ?: return null
        val id = b.o("id").l() ?: return null
        return PhonePullRequest(
            url, b.o("destination", "repository", "full_name").s().orEmpty(), id.toInt(), b.o("title").s().orEmpty(),
            author = b.o("author", "nickname").s() ?: b.o("author", "display_name").s(), isDraft = b.o("draft").flag(),
            updatedAt = b.o("updated_on").s()?.let(::date), head = b.o("source", "branch", "name").s(), base = b.o("destination", "branch", "name").s(),
            roles = setOf(role),
        )
    }

    /** An ISO 8601 time, with or without fractions of a second, in epoch milliseconds. */
    fun date(s: String): Long? = runCatching { OffsetDateTime.parse(s).toInstant().toEpochMilli() }.getOrNull()

    /** One list from several answers: each pull request once, with every role it came under, newest first. */
    fun merge(lists: List<List<PhonePullRequest>>): List<PhonePullRequest> {
        val byUrl = LinkedHashMap<String, PhonePullRequest>()
        for (p in lists.flatten()) {
            val seen = byUrl[p.url]
            byUrl[p.url] = if (seen == null) p else seen.copy(roles = seen.roles + p.roles, checks = if (seen.checks == PullRequest.Checks.NONE) p.checks else seen.checks)
        }
        return byUrl.values.sortedByDescending { it.updatedAt ?: 0 }
    }
}

/** The one-tap prompts on a pull request. Each opens New chat with the words filled in; nothing is sent until Start. */
enum class PullRequestPrompt {
    REVIEW, FIX_CHECKS, ADDRESS_COMMENTS, SUMMARIZE, UPDATE, ASK;

    /** Worth offering for this pull request (Fix the failing checks only when they fail). */
    fun fits(pr: PhonePullRequest): Boolean = when (this) {
        FIX_CHECKS -> pr.checks == PullRequest.Checks.FAILING
        ADDRESS_COMMENTS -> pr.review == PhonePullRequest.Review.CHANGES_REQUESTED || PhonePullRequest.Role.AUTHORED in pr.roles
        else -> true
    }

    fun text(pr: PhonePullRequest): String {
        val head = pr.head?.let { "`$it`" } ?: "its branch"
        val base = pr.base?.let { "`$it`" } ?: "the base branch"
        val which = "pull request ${pr.url} (${pr.repo} #${pr.number}: ${pr.title})"
        return when (this) {
            REVIEW -> "Review $which. Fetch $head and read its diff against $base. Give me a prioritized list of real problems: bugs first, then risks, then cleanups, each with the file and line. Don’t change anything yet."
            FIX_CHECKS -> "The checks on $which are failing. Check out $head, find out why from the failing runs, fix it, run the tests that cover it, and push the fix to the same branch."
            ADDRESS_COMMENTS -> "Read the review comments on $which. On $head, make the changes they ask for, reply to each comment with what you did (or why not), and push."
            SUMMARIZE -> "Summarize $which: what it changes and why, how risky it is, and what a reviewer should look at closely."
            UPDATE -> "Bring $which up to date: on $head, merge in the latest $base, resolve any conflicts, run the tests, and push."
            ASK -> "About $which: "
        }
    }
}

/**
 * Where a chat about a pull request runs: the paired computer with a project folder named like the
 * repository (the active computer first), else the active one.
 */
object PullRequestPlace {
    data class Match(val computer: String, /** The folder with the repository, when one was found. */ val folder: String?)

    private fun last(path: String?) = path?.split('/', '\\')?.lastOrNull { it.isNotEmpty() }?.lowercase()

    fun find(repo: String, computers: List<Pair<String, List<WorkspaceFolder>>>, active: String?): Match? {
        val name = repo.substringAfterLast('/').lowercase()
        fun holds(f: WorkspaceFolder) = f.name.lowercase() == name || last(f.path) == name
        val ordered = computers.filter { it.first == active } + computers.filter { it.first != active }
        for ((id, folders) in ordered) folders.firstOrNull(::holds)?.let { return Match(id, it.id) }
        if (active != null && computers.any { it.first == active }) return Match(active, null)
        return computers.firstOrNull()?.let { Match(it.first, null) }
    }

    /** The repositories the paired computers' folders hold, from the repositories the provider lists. */
    fun projectRepos(folders: List<WorkspaceFolder>, repos: List<PhoneRepo>): List<PhoneRepo> {
        val names = HashSet<String>()
        for (f in folders) { names += f.name.lowercase(); last(f.path)?.let { names += it } }
        return repos.filter { it.name.lowercase() in names }
    }
}
