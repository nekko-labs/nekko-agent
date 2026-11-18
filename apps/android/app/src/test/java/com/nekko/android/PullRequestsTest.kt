package com.nekko.android

import com.nekko.android.data.ConnectorHTTP
import com.nekko.android.data.Connectors
import com.nekko.android.data.PullRequests
import com.nekko.android.data.SecureStore
import com.nekko.protocol.PhonePullRequest
import com.nekko.protocol.PhoneRepo
import com.nekko.protocol.PhoneRequest
import com.nekko.protocol.PullRequest
import com.nekko.protocol.PullRequestPlace
import com.nekko.protocol.PullRequestPrompt
import com.nekko.protocol.PullRequestsApi
import com.nekko.protocol.WorkspaceFolder
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Pull requests screen (#2109): the iPhone's PullRequestsTests, case for case. */
class PullRequestsTest {
    private class Memory : SecureStore {
        val values = HashMap<String, String>()
        override suspend fun get(key: String) = values[key]
        override suspend fun set(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
    }
    private class FakeHTTP : ConnectorHTTP {
        val answers = ArrayDeque<Pair<Int, String>>()
        val requests = mutableListOf<PhoneRequest>()
        override suspend fun send(request: PhoneRequest): Pair<Int, String> { requests += request; return answers.removeFirst() }
    }

    private val secrets = Memory()
    private val http = FakeHTTP()
    private fun connectors() = Connectors(secrets, http) { 1 }
    private fun query(r: PhoneRequest) = r.body!!["query"]!!.jsonPrimitive.content

    private val ghNode = """{"number":7,"title":"Fix login","url":"https://github.com/o/app/pull/7","isDraft":false,"updatedAt":"2026-11-04T10:00:00Z","headRefName":"fix/login","baseRefName":"main","reviewDecision":"CHANGES_REQUESTED","author":{"login":"ada"},"repository":{"nameWithOwner":"o/app"},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE"}}}]}}"""
    private val ghOther = """{"number":3,"title":"Docs","url":"https://github.com/o/site/pull/3","isDraft":true,"updatedAt":"2026-11-05T10:00:00Z","headRefName":"docs","baseRefName":"main","reviewDecision":null,"author":{"login":"bob"},"repository":{"nameWithOwner":"o/site"},"commits":{"nodes":[]}}"""

    private suspend fun github(): Connectors = connectors().also { http.answers += 200 to """{"login":"ada"}"""; it.load(); it.connect("github", "ghp", emptyMap()) }

    @Test fun gitHubMineIsOneGraphQLCallWithThreeSearchesMergedByUrl() = runBlocking {
        val m = PullRequests(github(), secrets)
        http.answers += 200 to """{"data":{"authored":{"nodes":[$ghNode]},"reviewRequested":{"nodes":[$ghOther]},"assigned":{"nodes":[$ghNode]}}}"""
        m.load(PullRequests.Scope.MINE, emptyList())
        val s = m.state.value
        assertNull(s.error)
        val req = http.requests.last()
        assertEquals("https://api.github.com/graphql", req.url)
        assertTrue(query(req).contains("author:@me is:pr is:open"))
        assertTrue(query(req).contains("review-requested:@me"))
        // Each once, newest first.
        assertEquals(listOf(3, 7), s.mine.map { it.number })
        val fix = s.mine.last()
        assertEquals(setOf(PhonePullRequest.Role.AUTHORED, PhonePullRequest.Role.ASSIGNED), fix.roles)
        assertEquals(PullRequest.Checks.FAILING, fix.checks)
        assertEquals(PhonePullRequest.Review.CHANGES_REQUESTED, fix.review)
        assertEquals("fix/login", fix.head)
        assertEquals("app", fix.repoName)
        assertTrue(s.mine.first().isDraft)
    }

    @Test fun aGraphQLRefusalIsShown() = runBlocking {
        val m = PullRequests(github(), secrets)
        http.answers += 200 to """{"data":null,"errors":[{"message":"Resource not accessible by personal access token"}]}"""
        m.load(PullRequests.Scope.MINE, emptyList())
        assertEquals("GitHub: Resource not accessible by personal access token", m.state.value.error)
    }

    @Test fun projectsAreTheFoldersReposAndThePinnedOnes() = runBlocking {
        val c = github()
        val m = PullRequests(c, secrets)
        m.pin(PhoneRepo("o/site"))
        http.answers += 200 to """[{"full_name":"o/app"},{"full_name":"o/site"},{"full_name":"o/other"}]"""
        http.answers += 200 to """{"data":{"p0":{"nodes":[$ghNode,$ghOther]}}}"""
        m.load(PullRequests.Scope.PROJECTS, listOf(WorkspaceFolder("w1", "App", "/Users/me/code/app")))
        val s = m.state.value
        assertNull(s.error)
        assertEquals(listOf("o/app", "o/site"), s.projectRepos.map { it.fullName })
        assertEquals("https://api.github.com/user/repos?per_page=100&sort=pushed", http.requests[1].url)
        assertTrue(query(http.requests[2]).contains("repo:o/app repo:o/site"))
        assertEquals(2, s.projects.size)
        // Pins are kept per provider.
        val again = PullRequests(c, secrets).also { it.preparePins() }
        assertEquals(listOf(PhoneRepo("o/site")), again.state.value.pinned)
        m.unpin(PhoneRepo("o/site"))
        assertEquals(listOf("o/app"), m.state.value.projects.map { it.repo })
    }

    @Test fun longRepoListsAreSplitAcrossSearches() {
        val qs = PullRequestsApi.repoQueries((1..30).map { "some-org/repository-number-$it" })
        assertTrue(qs.size > 1)
        assertTrue(qs.all { it.length <= 200 })
        assertEquals(30, qs.joinToString(" ").split(" ").size)
    }

    @Test fun enterpriseGraphQLAddress() {
        assertEquals("https://api.github.com/graphql", PullRequestsApi.githubGraphQL("https://api.github.com"))
        assertEquals("https://git.corp.example/api/graphql", PullRequestsApi.githubGraphQL("https://git.corp.example/api/v3"))
    }

    @Test fun gitLabListsMineAssignedAndToReview() = runBlocking {
        val c = connectors()
        c.load()
        http.answers += 200 to """{"username":"ada"}"""
        c.connect("gitlab", "glpat", mapOf("site" to "https://gitlab.example.com/"))
        val m = PullRequests(c, secrets)
        val mr = """[{"web_url":"https://gitlab.example.com/g/app/-/merge_requests/4","iid":4,"title":"MR","draft":true,"updated_at":"2026-11-04T10:00:00.123Z","author":{"username":"ada"},"references":{"full":"g/app!4"},"source_branch":"feat","target_branch":"main","detailed_merge_status":"ci_still_running"}]"""
        http.answers += listOf(200 to mr, 200 to "[]", 200 to mr)
        m.load(PullRequests.Scope.MINE, emptyList())
        val s = m.state.value
        assertNull(s.error)
        assertEquals(4, http.requests.size)
        assertTrue(http.requests[1].url.startsWith("https://gitlab.example.com/api/v4/merge_requests?state=opened"))
        assertTrue(http.requests[3].url.endsWith("reviewer_username=ada"))
        assertEquals("glpat", http.requests[1].headers["PRIVATE-TOKEN"])
        val p = s.mine.single()
        assertEquals("g/app", p.repo)
        assertEquals(setOf(PhonePullRequest.Role.AUTHORED, PhonePullRequest.Role.REVIEW_REQUESTED), p.roles)
        assertEquals(PullRequest.Checks.PENDING, p.checks)
        assertTrue(p.isDraft)
        assertNotNull(p.updatedAt)
        assertEquals("https://gitlab.example.com/api/v4/projects/g%2Fsub%2Fapp/merge_requests?state=opened&per_page=30",
            PullRequestsApi.projects(c.state.value.connector("gitlab")!!, "t", listOf("g/sub/app")).first().url)
    }

    @Test fun bitbucketListsByTheUsersUuid() = runBlocking {
        val c = connectors()
        c.load()
        http.answers += 200 to """{"username":"ada","uuid":"{1234}"}"""
        c.connect("bitbucket", "t", mapOf("email" to "a@b.c"))
        val m = PullRequests(c, secrets)
        http.answers += 200 to """{"values":[{"id":9,"title":"BB","links":{"html":{"href":"https://bitbucket.org/ws/app/pull-requests/9"}},"author":{"display_name":"Ada"},"updated_on":"2026-11-04T10:00:00.123456+00:00","source":{"branch":{"name":"f"}},"destination":{"branch":{"name":"main"},"repository":{"full_name":"ws/app"}}}]}"""
        m.load(PullRequests.Scope.MINE, emptyList())
        assertEquals("https://api.bitbucket.org/2.0/pullrequests/%7B1234%7D?state=OPEN&pagelen=50", http.requests.last().url)
        assertEquals("ws/app", m.state.value.mine.first().repo)
        assertEquals("Ada", m.state.value.mine.first().author)
        // Microseconds and an offset still read.
        assertNotNull(m.state.value.mine.first().updatedAt)
    }

    @Test fun noGitProviderMeansNothingIsAsked() = runBlocking {
        val m = PullRequests(connectors(), secrets)
        m.load(PullRequests.Scope.MINE, emptyList())
        assertTrue(http.requests.isEmpty())
        assertTrue(m.state.value.mine.isEmpty())
    }

    @Test fun promptsNameThePullRequestAndItsBranches() {
        var pr = PhonePullRequest("https://github.com/o/app/pull/7", "o/app", 7, "Fix login", head = "fix/login", base = "main")
        val review = PullRequestPrompt.REVIEW.text(pr)
        assertTrue(review.contains("https://github.com/o/app/pull/7"))
        assertTrue(review.contains("`fix/login`"))
        assertTrue(review.contains("`main`"))
        assertFalse(PullRequestPrompt.FIX_CHECKS.fits(pr))
        pr = pr.copy(checks = PullRequest.Checks.FAILING)
        assertTrue(PullRequestPrompt.FIX_CHECKS.fits(pr))
        assertTrue(PullRequestPrompt.ASK.text(pr).startsWith("About pull request"))
    }

    @Test fun theChatRunsWhereTheRepositoryIs() {
        val studio = "studio" to listOf(WorkspaceFolder("s1", "site"))
        val laptop = "laptop" to listOf(WorkspaceFolder("l1", "Work", "C:\\code\\app"))
        assertEquals(PullRequestPlace.Match("laptop", "l1"), PullRequestPlace.find("o/app", listOf(studio, laptop), "studio"))
        // Else the active computer, no folder.
        assertEquals(PullRequestPlace.Match("laptop", null), PullRequestPlace.find("o/unknown", listOf(studio, laptop), "laptop"))
        // The active computer first when both hold it.
        val both = "laptop" to listOf(WorkspaceFolder("l2", "site"))
        assertEquals("laptop", PullRequestPlace.find("o/site", listOf(studio, both), "laptop")?.computer)
        assertNull(PullRequestPlace.find("o/app", emptyList(), null))
    }
}
