package com.nekko.android

import com.nekko.android.git.GitController
import com.nekko.android.git.GitNotice
import com.nekko.android.security.ChangeCalls
import com.nekko.protocol.ChangeProof
import com.nekko.protocol.Channels
import com.nekko.protocol.GitRequest
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayException
import com.nekko.protocol.SoftwareChangeSigner
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** AN-30: the Git screen's state. Reads are plain calls; every change is a signed Change action. */
class GitControllerTest {
    /** A computer's git, answering reads and recording changes. */
    private class Repo {
        val reads = mutableListOf<GitRequest>()
        val changes = mutableListOf<GitRequest>()
        var staged = listOf<JsonObject>()
        var unstaged = listOf(
            buildJsonObject { put("path", "src/a.ts"); put("status", "modified"); put("additions", 1); put("deletions", 0); put("patch", "@@ -1 +1,2 @@\n a\n+b") },
            buildJsonObject { put("path", ".env"); put("status", "modified"); put("additions", 1); put("deletions", 1); put("patch", ""); put("hidden", true) },
        )
        var refuse: Exception? = null
        var commitOk = true

        fun read(r: GitRequest): JsonElement {
            reads += r
            refuse?.let { throw it }
            return when (r.channel) {
                Channels.WORKSPACE_GIT_STATUS -> buildJsonObject { put("repo", true); put("branch", "feat"); put("dirtyCount", 2); put("ahead", 1); put("behind", 0) }
                Channels.GIT_DIFF -> buildJsonObject {
                    val stagedSide = (r.args[1] as JsonObject)["staged"]?.jsonPrimitive?.content == "true"
                    put("files", JsonArray(if (stagedSide) staged else unstaged))
                    put("truncated", false)
                }
                Channels.PR_CHECKS -> buildJsonObject {
                    put("url", r.args[0].jsonPrimitive.content); put("checks", "failing")
                    putJsonArray("items") {
                        add(buildJsonObject { put("name", "lint"); put("state", "pass") })
                        add(buildJsonObject { put("name", "test"); put("state", "fail"); put("link", "https://example.invalid/run/1") })
                    }
                }
                Channels.GIT_LOG -> buildJsonArray { add(buildJsonObject { put("sha", "abc"); put("author", "Ada"); put("subject", "First"); putJsonArray("parents") {} }) }
                else -> JsonNull
            }
        }

        fun change(r: GitRequest): JsonElement {
            changes += r
            refuse?.let { throw it }
            return when (r.channel) {
                Channels.GIT_STAGE -> {
                    val paths = (r.args[1] as JsonArray).map { it.jsonPrimitive.content }.toSet()
                    staged = unstaged.filter { it["path"]!!.jsonPrimitive.content in paths }
                    unstaged = unstaged.filterNot { it["path"]!!.jsonPrimitive.content in paths }
                    buildJsonObject { put("ok", true); put("message", "Staged.") }
                }
                Channels.GIT_COMMIT_MESSAGE -> buildJsonObject { put("message", "Add b\n\nBecause."); put("inputTruncated", true) }
                Channels.GIT_COMMIT ->
                    if (commitOk) buildJsonObject {
                        put("ok", true); put("message", "Committed abc.")
                        putJsonObject("commit") { put("sha", "abc"); put("author", "Ada"); put("subject", "Add b") }
                    } else buildJsonObject { put("ok", false); put("message", "nothing to commit") }
                Channels.PR_CREATE -> buildJsonObject { put("ok", true); put("message", "Opened."); put("url", "https://github.com/o/r/pull/9") }
                Channels.PR_ACTION -> buildJsonObject {
                    put("ok", true); put("message", "Merged.")
                    putJsonObject("pr") { put("url", r.args[0].jsonPrimitive.content); put("number", 9); put("state", "merged") }
                }
                else -> buildJsonObject { put("ok", true); put("message", "Done.") }
            }
        }
    }

    private fun controller(repo: Repo) = GitController("s1", read = { repo.read(it) }, change = { repo.change(it) })

    @Test fun `loads the status and both sides of the index`() = runTest {
        val repo = Repo()
        val g = controller(repo)
        g.load()
        val s = g.state.value
        assertEquals("feat", s.status?.branch)
        assertEquals(listOf("src/a.ts", ".env"), s.unstaged.files.map { it.path })
        assertTrue(s.staged.files.isEmpty())
        assertEquals(setOf(Channels.WORKSPACE_GIT_STATUS, Channels.GIT_DIFF), repo.reads.map { it.channel }.toSet())
        assertTrue("a phone names the chat, never a folder", repo.reads.all { it.args.first() == JsonPrimitive("session:s1") })
        assertTrue("reading changes nothing", repo.changes.isEmpty())
    }

    @Test fun `stage, write a commit message and commit`() = runTest {
        val repo = Repo()
        val g = controller(repo)
        g.load()
        assertFalse(g.state.value.canCommit)
        g.stage(listOf("src/a.ts"))
        assertEquals(listOf("src/a.ts"), g.state.value.staged.files.map { it.path })
        assertEquals(GitNotice(true, "Staged."), g.state.value.notice)
        g.writeMessage()
        assertEquals("Add b\n\nBecause.", g.state.value.message)
        assertTrue(g.state.value.messageFromCutDiff)
        assertTrue(g.state.value.canCommit)
        g.commit()
        assertEquals("the field empties once committed", "", g.state.value.message)
        assertEquals(listOf(Channels.GIT_STAGE, Channels.GIT_COMMIT_MESSAGE, Channels.GIT_COMMIT), repo.changes.map { it.channel })
        assertEquals("""["session:s1",{"message":"Add b\n\nBecause."}]""", JsonArray(repo.changes.last().args).toString())
        assertTrue(repo.changes.all { it.isChange })
    }

    @Test fun `git's refusal keeps the message and says why`() = runTest {
        val repo = Repo().apply { commitOk = false }
        val g = controller(repo)
        g.setMessage("Try")
        g.commit()
        assertEquals("Try", g.state.value.message)
        assertEquals(GitNotice(false, "nothing to commit"), g.state.value.notice)
    }

    @Test fun `the computer's refusal is shown plainly`() = runTest {
        val repo = Repo().apply { refuse = RelayException("Changes from this phone are turned off on Studio.") }
        val g = controller(repo)
        g.push()
        assertEquals(GitNotice(false, "Changes from this phone are turned off on Studio."), g.state.value.notice)
        assertNull(g.state.value.busy)
        g.load()
        assertEquals("Changes from this phone are turned off on Studio.", g.state.value.error)
    }

    @Test fun `history reads a page`() = runTest {
        val repo = Repo()
        val g = controller(repo)
        assertEquals("Ada", g.history().first().author)
        assertEquals("""["session:s1",{"limit":50,"skip":0}]""", JsonArray(repo.reads.single().args).toString())
    }

    @Test fun `opens a pull request, reads its checks failing first, and merges it`() = runTest {
        val repo = Repo()
        val g = controller(repo)
        assertEquals("https://github.com/o/r/pull/9", g.createPr("  Add b ", "", "main", draft = true))
        assertEquals("""["session:s1",{"title":"Add b","draft":true,"base":"main"}]""", JsonArray(repo.changes.single().args).toString())
        val checks = g.checks("https://github.com/o/r/pull/9")
        assertEquals(listOf("test", "lint"), checks.items.map { it.name })
        val readsBefore = repo.reads.size
        val merged = g.prAction("https://github.com/o/r/pull/9", com.nekko.protocol.PrAction.MERGE)
        assertEquals(com.nekko.protocol.PullRequest.State.MERGED, merged?.pr?.state)
        assertEquals(GitNotice(true, "Merged."), g.state.value.notice)
        assertEquals("""["https://github.com/o/r/pull/9","merge"]""", JsonArray(repo.changes.last().args).toString())
        assertEquals("a PR action doesn't re-read the folder", readsBefore, repo.reads.size)
        assertTrue(repo.changes.all { it.isChange })
    }

    /** Git changes signed for real and checked by the computer's rules (the same proof checks as nekkod). */
    @Test fun `git changes are signed and the computer's switch still applies`() = runTest {
        var changeOn = true
        val signer = SoftwareChangeSigner.generate()
        val config = RelayConfig("wss://relay.example.dev", "room", "key", ByteArray(32), "phone-1", "Pixel Test")
        val remote = FakeRemote(config) { c ->
            val p = c.proof ?: throw RelayException("Not allowed from a paired phone (proof-required): ${c.channel}")
            val text = ChangeProof.payload("phone-1", c.channel, JsonArray(c.args), p["ts"]!!.jsonPrimitive.content.toLong())
            val sig = java.util.Base64.getDecoder().decode(p["sig"]!!.jsonPrimitive.content)
            check(ChangeProof.verify(signer.publicKey(), text, sig)) { "bad proof" }
            if (!changeOn && c.channel != ChangeProof.KEY_CHANNEL) throw RelayException("Not allowed from a paired phone (change-off): ${c.channel}")
            buildJsonObject { put("ok", true); put("message", c.channel) }
        }
        val calls = ChangeCalls(remote, signer, "phone-1", "Studio")
        val g = GitController("s1", read = { JsonNull }, change = { r -> calls.call(r.channel, r.args) })
        g.stage(listOf("a.txt"))
        g.push()
        assertEquals(listOf(ChangeProof.KEY_CHANNEL, Channels.GIT_STAGE, Channels.GIT_PUSH), remote.channels())
        assertEquals(GitNotice(true, Channels.GIT_PUSH), g.state.value.notice)
        changeOn = false
        g.abortMerge()
        assertEquals(
            "Changes from this phone are turned off on Studio. Turn them on in Remote access → What phones can do.",
            g.state.value.notice?.text,
        )
    }
}
