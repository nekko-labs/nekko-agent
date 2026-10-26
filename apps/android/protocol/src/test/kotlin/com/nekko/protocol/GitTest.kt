package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** AN-30: git requests, the computer's phone views decoded, and git patches drawn as the Changes view's hunks. */
class GitTest {
    private fun repoFile(path: String): File = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", path)

    /** The shared cases the computer's TS and Rust are held to (phone-git.json), as the iPhone's GitTests read them. */
    private val golden: JsonObject by lazy {
        val f = repoFile("crates/nekko-remote/tests/golden/phone-git.json")
        assumeTrue("running outside the monorepo", f.exists())
        Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun view(channel: String, n: Int = 0): JsonElement =
        golden["views"]!!.jsonArray.map { it.jsonObject }.filter { it["channel"]?.jsonPrimitive?.content == channel }[n]["view"]!!

    private fun args(r: GitRequest) = JsonArray(r.args).toString()

    @Test fun `requests name the chat and only fields the computer accepts`() {
        assertEquals(GitRequest(Channels.WORKSPACE_GIT_STATUS, listOf(JsonPrimitive("session:s1"), JsonPrimitive(false))), GitRequest.status("s1"))
        assertEquals("""["session:s1",{"staged":true}]""", args(GitRequest.diff("s1", staged = true)))
        assertEquals("""["session:s1",{"limit":20,"skip":40}]""", args(GitRequest.log("s1", limit = 20, skip = 40)))
        assertEquals("""["session:s1",["a","b/c"]]""", args(GitRequest.stage("s1", listOf("a", "b/c"))))
        assertEquals("""["session:s1",{"message":"Fix"}]""", args(GitRequest.commit("s1", "Fix")))
        assertEquals("""["session:s1",{"setUpstream":true}]""", args(GitRequest.push("s1")))
        assertEquals("""["session:s1","feat",{"create":true}]""", args(GitRequest.switchBranch("s1", "feat", create = true)))
        assertEquals("""["session:s1",{"title":"T","draft":true}]""", args(GitRequest.createPr("s1", "T", draft = true)))
        assertEquals("""["session:s1",{"title":"T","draft":false,"body":"B","base":"main"}]""", args(GitRequest.createPr("s1", "T", "B", "main")))
        assertEquals("""["https://github.com/o/r/pull/1","merge"]""", args(GitRequest.prAction("https://github.com/o/r/pull/1", PrAction.MERGE)))
        assertTrue(GitRequest.prAction("u", PrAction.APPROVE).isChange)
        assertTrue(GitRequest.createPr("s1", "t").isChange)
        assertFalse(GitRequest.prChecks("u").isChange)
        assertFalse(GitRequest.prDiff("u").isChange)
        // The Change actions are the ones the computer asks a signature for.
        assertTrue("it spends the computer's model tokens", GitRequest.commitMessage("s1").isChange)
        assertFalse(GitRequest.diff("s1", staged = false).isChange)
        assertFalse(GitRequest.branches("s1").isChange)
        // Every git change can be signed (canonical JSON: no fractions).
        for (r in listOf(
            GitRequest.stage("s1", listOf("a")), GitRequest.commit("s1", "m"), GitRequest.push("s1"), GitRequest.switchBranch("s1", "b"),
            GitRequest.mergeAbort("s1"), GitRequest.commitMessage("s1"), GitRequest.unstage("s1", listOf("a")),
            GitRequest.createPr("s1", "t"), GitRequest.prAction("u", PrAction.CLOSE),
        )) {
            assertTrue(r.channel, r.isChange)
            ChangeProof.canonicalJson(JsonArray(r.args))
        }
    }

    @Test fun `the classes match the computer`() {
        val f = repoFile("crates/nekko-remote/src/phone-access.json")
        assumeTrue("running outside the monorepo", f.exists())
        val policy = Json.parseToJsonElement(f.readText()).jsonObject
        fun set(k: String) = policy[k]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
        val change = set("changeChannels")
        assertEquals("every Change channel this phone calls is signed, and nothing else is", change.filter { it in Channels.ALL }.toSet(), Channels.CHANGE)
        val read = set("readChannels")
        for (ch in listOf(
            Channels.WORKSPACE_GIT_STATUS, Channels.GIT_DIFF, Channels.GIT_LOG, Channels.GIT_SHOW, Channels.GIT_BRANCHES, Channels.GIT_COMPARE,
            Channels.PR_SESSION_LIST, Channels.PR_CHECKS, Channels.PR_DIFF,
        )) {
            assertTrue("$ch is a plain read", ch in read)
        }
    }

    @Test fun `decodes the computer's views`() {
        val status = GitStatus.from(view("workspace:gitStatus"))!!
        assertEquals("feat", status.position)
        assertEquals("1 to push · 2 to pull", status.drift)
        assertEquals("feat-wt", status.worktree)
        assertEquals(7, status.pr?.number)
        assertFalse(GitStatus.from(view("workspace:gitStatus", 1))!!.repo)

        val diff = GitDiff.from(view("git:diff"))
        val env = diff.files.first { it.path == ".env" }
        assertTrue(env.hidden)
        assertTrue("a secret file's patch never arrives", env.hunks.isEmpty())
        assertEquals(2, diff.hiddenFiles)
        val app = diff.files.first { it.path == "src/app.ts" }
        assertEquals(listOf(PhoneChanges.Kind.REMOVED, PhoneChanges.Kind.ADDED, PhoneChanges.Kind.SAME), app.hunks.first().lines.map { it.kind })
        assertEquals("?", diff.files.first { it.path == "new.txt" }.mark)
        val big = diff.files.first { it.path == "big.txt" }
        assertTrue(big.truncated)
        assertEquals("300 patch lines kept: the header and 299 lines", 299, big.hunks.first().lines.size)
        val many = GitDiff.from(view("git:diff", 1))
        assertEquals(100, many.files.size)
        assertEquals(5, many.omittedFiles)
        assertTrue(many.truncated)

        val detail = GitCommitDetail.from(view("git:show"))!!
        assertEquals("Ada Lovelace", detail.commit.author)
        assertEquals(4000, detail.commit.body?.length)
        assertEquals(listOf("First", "Second"), GitCommit.list(view("git:log")).map { it.subject })
        assertEquals(100, GitCommit.list(view("git:log", 1)).size)
        assertNotNull("the computer's dates read", GitCommit.list(view("git:log")).first().whenMs)

        val cmp = GitCompare.from(view("git:compare"))!!
        assertEquals(listOf(2, 1), listOf(cmp.ahead, cmp.behind))
        assertEquals(listOf(false, true), cmp.diff.files.map { it.hidden })

        val branches = GitBranches.from(view("git:branches"))
        assertEquals("feat", branches.current)
        assertEquals("origin/feat", branches.local.first().upstream)
        assertEquals(200, branches.remote.size)
        assertEquals(3, branches.omitted)

        val commit = GitResult.from(view("git:commit"))
        assertTrue(commit.ok)
        assertEquals("Fix it", commit.commit?.subject)
        val refused = GitResult.from(view("git:commit", 1))
        assertFalse(refused.ok)
        assertEquals(4000, refused.message.length)
        assertEquals("Fix it\n\nBecause.", GitCommitMessage.from(view("git:commitMessage"))?.message)

        val checks = PrCheckList.from(view("pr:checks"))!!
        assertEquals(PullRequest.Checks.FAILING, checks.rollup)
        assertEquals("failing first", listOf(PrCheck.State.FAIL, PrCheck.State.PASS), checks.items.map { it.state })
        assertEquals("https://github.com/o/r/pull/7", GitResult.from(view("pr:create")).url)
        assertEquals(PullRequest.State.MERGED, GitResult.from(view("pr:action")).pr?.state)
    }

    @Test fun `draws git patches as hunks`() {
        val hunks = GitFile.hunks("@@ -3,4 +3,5 @@ fn main\n a\n-b\n+B\n+C\n c\n\\ No newline at end of file\n@@ -20 +21 @@\n-x\n+y")
        assertEquals(2, hunks.size)
        assertEquals(listOf(3, 4, 4, 5, 6), hunks[0].lines.map { it.number })
        assertEquals(
            listOf(PhoneChanges.Kind.SAME, PhoneChanges.Kind.REMOVED, PhoneChanges.Kind.ADDED, PhoneChanges.Kind.ADDED, PhoneChanges.Kind.SAME),
            hunks[0].lines.map { it.kind },
        )
        assertEquals(20, hunks[1].oldStart)
        assertEquals(21, hunks[1].newStart)
        // A new file starts at 0 on the old side.
        assertEquals(listOf(1, 2), GitFile.hunks("@@ -0,0 +1,2 @@\n+one\n+two\n").first().lines.map { it.number })
        assertTrue(GitFile.hunks("").isEmpty())
        assertTrue(GitFile.hunks("not a patch").isEmpty())
    }

    @Test fun `branch helpers`() {
        val b = GitBranches(
            current = "main", local = listOf(GitBranch("main", current = true)),
            remote = listOf(GitBranch("origin/main", remote = "origin"), GitBranch("origin/feat", remote = "origin"), GitBranch("origin/HEAD", remote = "origin")),
        )
        assertEquals(listOf("feat"), b.remoteOnly.map { it.localName })
        assertEquals("main", b.compareBase)
        assertEquals("develop", b.copy(defaultBranch = "develop").compareBase)
    }

    @Test fun `a pull request's words and what a phone may do to it`() {
        val pr = PullRequest("u", 12, state = PullRequest.State.OPEN, checks = PullRequest.Checks.FAILING)
        assertEquals("#12 Open · checks failing", pr.summary)
        assertEquals("#12 Draft", pr.copy(isDraft = true, checks = PullRequest.Checks.NONE).summary)
        assertEquals(listOf(PrAction.APPROVE, PrAction.MERGE, PrAction.CLOSE), pr.actions)
        assertEquals(listOf(PrAction.REOPEN), pr.copy(state = PullRequest.State.CLOSED).actions)
        assertTrue(pr.copy(state = PullRequest.State.MERGED).actions.isEmpty())
        assertEquals(listOf(GitPrompt.COMMIT, GitPrompt.FIX_CHECKS), GitPrompt.offered(listOf(pr)))
        assertEquals(listOf(GitPrompt.COMMIT, GitPrompt.OPEN_PR), GitPrompt.offered(emptyList()))
        assertEquals(listOf(GitPrompt.COMMIT, GitPrompt.OPEN_PR), GitPrompt.offered(listOf(pr.copy(state = PullRequest.State.MERGED))))
    }
}
