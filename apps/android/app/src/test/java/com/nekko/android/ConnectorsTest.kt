package com.nekko.android

import com.nekko.android.data.ConnectorHTTP
import com.nekko.android.data.Connectors
import com.nekko.android.data.SecureStore
import com.nekko.protocol.PhoneConnectors
import com.nekko.protocol.PhoneRequest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** This phone's own connectors (#2109): the iPhone's ConnectorsTests, case for case. */
class ConnectorsTest {
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
    private var t = 1_000L
    private fun make() = Connectors(secrets, http) { ++t }.also { runBlocking { it.load() } }

    private fun refused(block: suspend () -> Unit): String? = try { runBlocking { block() }; null } catch (e: IllegalArgumentException) { e.message }

    @Test fun connectChecksTheTokenAndKeepsItOnlyInItsSlot() = runBlocking {
        val m = make()
        http.answers += 200 to """{"login":"octocat","id":1}"""
        val c = m.connect("github", " ghp_secret ", emptyMap())
        assertEquals("octocat", c.account)
        assertEquals("https://api.github.com", c.settings["api"])
        val req = http.requests.first()
        assertEquals("GET", req.method)
        assertEquals("https://api.github.com/user", req.url)
        assertEquals("Bearer ghp_secret", req.headers["Authorization"])
        assertEquals("ghp_secret", secrets.values[PhoneConnectors.tokenSlot("github")])
        assertFalse(secrets.values[Connectors.SLOT]!!.contains("ghp_secret"))
        // A second launch reads it back, and it is the git provider.
        val again = make()
        assertEquals(listOf(c), again.state.value.connectors)
        assertEquals("github", again.state.value.gitProvider?.kind)
    }

    @Test fun aTokenTheServiceTurnsDownIsNotKept() {
        val m = make()
        http.answers += 401 to """{"message":"Bad credentials"}"""
        assertEquals("GitHub turned the token down (401): Bad credentials", refused { m.connect("github", "nope", emptyMap()) })
        assertTrue(m.state.value.connectors.isEmpty())
        assertNull(secrets.values[PhoneConnectors.tokenSlot("github")])
    }

    @Test fun linearErrorsInA200AreARefusal() {
        val m = make()
        http.answers += 200 to """{"errors":[{"message":"Authentication required"}]}"""
        assertEquals("Linear turned the token down: Authentication required", refused { m.connect("linear", "lin_bad", emptyMap()) })
        assertNull(m.state.value.connector("linear"))
        assertEquals("lin_bad", http.requests.first().headers["Authorization"])
        assertEquals("{ viewer { name email } }", http.requests.first().body!!["query"]!!.jsonPrimitive.content)
    }

    @Test fun fieldsAreCheckedBeforeAnythingIsSent() {
        val m = make()
        assertEquals("Fill in Email.", refused { m.connect("jira", "t", mapOf("site" to "https://team.atlassian.net")) })
        // Tokens go over https only.
        assertEquals("Site must be a full https:// address.", refused { m.connect("jira", "t", mapOf("site" to "http://team.atlassian.net", "email" to "a@b.c")) })
        assertEquals("Site must be a full https:// address.", refused { m.connect("jira", "t", mapOf("site" to "https://user:pw@team.atlassian.net", "email" to "a@b.c")) })
        assertEquals("Paste the token.", refused { m.connect("floop", " ", mapOf("url" to "https://f.example")) })
        assertEquals("The token must contain only printable ASCII.", refused { m.connect("github", "a\nX-Evil: 1", emptyMap()) })
        assertTrue(http.requests.isEmpty())
    }

    @Test fun jiraAndBitbucketUseBasicAuthWithTheEmail() {
        val jira = PhoneConnectors.make("jira", "tok", mapOf("site" to "https://t.atlassian.net/", "email" to "a@b.c"), 1)
        assertEquals("https://t.atlassian.net", jira.settings["site"])
        val r = PhoneConnectors.whoAmI(jira, "tok")
        assertEquals("https://t.atlassian.net/rest/api/3/myself", r.url)
        assertEquals("Basic " + Base64.getEncoder().encodeToString("a@b.c:tok".toByteArray()), r.headers["Authorization"])
        val bb = PhoneConnectors.make("bitbucket", "tok", mapOf("email" to "a@b.c"), 1)
        assertEquals(r.headers["Authorization"], PhoneConnectors.whoAmI(bb, "tok").headers["Authorization"])
    }

    @Test fun trelloSendsItsKeyAndTokenInTheQuery() {
        val c = PhoneConnectors.make("trello", "t&k", mapOf("key" to "abc"), 1)
        val r = PhoneConnectors.whoAmI(c, "t&k")
        assertTrue(r.url, r.url.endsWith("&key=abc&token=t%26k"))
        assertNull(r.headers["Authorization"])
    }

    @Test fun accountNames() {
        assertEquals("gl", PhoneConnectors.account("gitlab", """{"username":"gl"}"""))
        assertEquals("Ada", PhoneConnectors.account("jira", """{"displayName":"Ada"}"""))
        assertEquals("Ada", PhoneConnectors.account("asana", """{"data":{"name":"Ada"}}"""))
        assertEquals("ada", PhoneConnectors.account("clickup", """{"user":{"username":"ada"}}"""))
        assertNull(PhoneConnectors.account("floop", "[]"))
    }

    @Test fun selectingTheGitProviderAndDisconnecting() = runBlocking {
        val m = make()
        http.answers += listOf(200 to """{"login":"a"}""", 200 to """{"username":"b"}""", 200 to """{"data":{"viewer":{"name":"c"}}}""")
        m.connect("github", "1", emptyMap())
        m.connect("gitlab", "2", emptyMap())
        m.connect("linear", "3", emptyMap())
        assertEquals(listOf("github", "gitlab"), m.state.value.git.map { it.kind })
        assertEquals(listOf("linear"), m.state.value.tasks.map { it.kind })
        assertEquals("github", m.state.value.gitProvider?.kind)
        // Only a git provider can be the git provider.
        m.selectGit("linear")
        assertEquals("github", m.state.value.gitProvider?.kind)
        m.selectGit("gitlab")
        assertEquals("gitlab", make().state.value.gitProvider?.kind)
        m.disconnect("gitlab")
        assertNull(secrets.values[PhoneConnectors.tokenSlot("gitlab")])
        assertEquals("github", m.state.value.gitProvider?.kind)
    }

    @Test fun aFailureNeverEchoesALongBody() {
        val said = PhoneConnectors.failure("GitHub", 500, """{"message":"${"x".repeat(5000)}"}""")
        assertTrue(said.length < 260)
        if (said.isEmpty()) fail()
    }
}
