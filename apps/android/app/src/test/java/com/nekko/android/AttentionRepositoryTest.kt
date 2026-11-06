package com.nekko.android

import com.nekko.android.connection.AttentionNotices
import com.nekko.android.data.ComputersRepository
import com.nekko.protocol.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AttentionRepositoryTest {
    private val empty = buildJsonObject {}
    private fun snapshot(id: String, approval: Boolean = false): JsonElement = Json.parseToJsonElement(
        if (approval) """{"s1":{"approval":{"call":{"id":"$id","name":"bash","input":{}},"reason":"Run","severity":"medium"}}}"""
        else """{"s1":{"question":{"callId":"$id","questions":[],"askedAt":1}}}""",
    )
    private suspend fun TestScope.connected(remotes: FakeRemotes): ComputersRepository {
        val repo = ComputersRepository(FakeStore(), remotes, backgroundScope, { "Pixel Test" }, deriveKey = { _, _ -> ByteArray(32) })
        repo.load()
        repo.pair(PairingLink("wss://relay.example.dev", "a1b2c3d4e5f60718", "00112233445566778899aabbccddeeff", pair = "ABC123", hostKey = TEST_HOST_KEY))
        runCurrent()
        remotes.last.goOnline()
        runCurrent()
        return repo
    }
    private suspend fun FakeRemote.event(raw: String) = events.emit(Events.AGENT_EVENT to Json.parseToJsonElement(raw))
    private fun assertWaiting(repo: ComputersRepository, known: Boolean) {
        val state = repo.state.value
        assertEquals(known, state.attention.known)
        assertEquals(setOf("s1"), state.attention.pending.keys)
        assertEquals(Activity.NEEDS_YOU, state.activity["s1"])
        val listed = state.copy(summaries = listOf(SessionSummary("s1", "Chat", 0, null, null, null, false, null, null, null)))
        val projection = AttentionNotices.update(listed, true, false, true)!!
        assertEquals(known, projection.authoritative)
        assertTrue(projection.resolved.isEmpty())
        assertEquals(1, projection.waiting.size)
    }

    @Test fun `remote newest question resolution rereads older input then last resolution proves zero`() = runTest {
        var pending = snapshot("newest")
        var reads = 0
        val remotes = FakeRemotes { c ->
            if (c.channel == Channels.CHAT_PENDING) { reads++; pending } else FakeRemotes.defaultAnswer(c)
        }
        val repo = connected(remotes)
        assertWaiting(repo, true)
        pending = snapshot("older") // Never delivered as an event to this phone.
        remotes.last.event("""{"type":"question_resolved","sessionId":"s1","callId":"newest"}""")
        runCurrent()
        assertWaiting(repo, false)
        advanceTimeBy(100); runCurrent()
        assertWaiting(repo, true)
        assertEquals("older", repo.state.value.attention.pending["s1"]?.question?.callId)
        pending = empty
        remotes.last.event("""{"type":"question_resolved","sessionId":"s1","callId":"older"}""")
        runCurrent()
        assertWaiting(repo, false)
        advanceTimeBy(100); runCurrent()
        assertTrue(repo.state.value.attention.known)
        assertTrue(repo.state.value.attention.pending.isEmpty())
        assertNull(repo.state.value.activity["s1"])
        assertEquals(3, reads)
    }

    @Test fun `successful local approval rereads newest only snapshot before clearing last input`() = runTest {
        var pending = snapshot("newest", approval = true)
        val remotes = FakeRemotes { c -> if (c.channel == Channels.CHAT_PENDING) pending else FakeRemotes.defaultAnswer(c) }
        val repo = connected(remotes)
        pending = snapshot("older", approval = true)
        repo.caller.call(Channels.TOOL_APPROVE, JsonPrimitive("s1"), JsonPrimitive("newest"), JsonPrimitive(true))
        assertWaiting(repo, false)
        runCurrent(); advanceTimeBy(100); runCurrent()
        assertWaiting(repo, true)
        assertEquals("older", repo.state.value.attention.pending["s1"]?.approval?.call?.id)
        pending = empty
        repo.caller.callWithTimeout(1_000, Channels.TOOL_APPROVE, JsonPrimitive("s1"), JsonPrimitive("older"), JsonPrimitive(false))
        assertWaiting(repo, false)
        runCurrent(); advanceTimeBy(100); runCurrent()
        assertTrue(repo.state.value.attention.known)
        assertTrue(repo.state.value.attention.pending.isEmpty())
    }

    @Test fun `legacy dismiss burst and failed malformed or timed out reads preserve notices without polling`() = runTest {
        var reads = 0
        var response: suspend () -> JsonElement = { snapshot("newest") }
        val remotes = FakeRemotes { c ->
            if (c.channel == Channels.CHAT_PENDING) { reads++; response() } else FakeRemotes.defaultAnswer(c)
        }
        val repo = connected(remotes)
        for (bad in listOf<JsonElement?>(null, JsonNull, JsonPrimitive("not an object"), Json.parseToJsonElement("""{"s1":{"question":{}}}"""))) {
            response = { bad ?: error("offline") }
            repeat(8) { remotes.last.dismissals.emit(E2E.activityTag("s1")) }
            runCurrent()
            assertWaiting(repo, false)
            val before = reads
            advanceTimeBy(100); runCurrent()
            assertEquals(before + 1, reads)
            assertWaiting(repo, false)
            advanceTimeBy(20_000); runCurrent()
            assertEquals("failed reads do not poll", before + 1, reads)
        }
        response = { CompletableDeferred<JsonElement>().await() }
        remotes.last.dismissals.emit(E2E.activityTag("s1"))
        runCurrent(); advanceTimeBy(100); runCurrent()
        val beforeTimeout = reads
        advanceTimeBy(5_000); runCurrent()
        assertWaiting(repo, false)
        advanceTimeBy(20_000); runCurrent()
        assertEquals(beforeTimeout, reads)
        response = { empty }
        remotes.last.dismissals.emit(E2E.activityTag("s1"))
        runCurrent(); advanceTimeBy(100); runCurrent()
        assertTrue(repo.state.value.attention.known)
        assertTrue(repo.state.value.attention.pending.isEmpty())
    }

    @Test fun `resolution during delayed empty snapshot keeps notice until newer read sees older input`() = runTest {
        val remotes = FakeRemotes { c -> if (c.channel == Channels.CHAT_PENDING) snapshot("newest") else FakeRemotes.defaultAnswer(c) }
        val repo = connected(remotes)
        val stale = CompletableDeferred<JsonElement>()
        val fresh = CompletableDeferred<JsonElement>()
        var reads = 0
        remotes.handler = { c ->
            if (c.channel == Channels.CHAT_PENDING) { if (++reads == 1) stale.await() else fresh.await() }
            else FakeRemotes.defaultAnswer(c)
        }
        val refresh = launch { repo.refresh() }
        runCurrent()
        remotes.last.event("""{"type":"question_resolved","sessionId":"s1","callId":"newest"}""")
        runCurrent()
        stale.complete(empty)
        refresh.join()
        assertWaiting(repo, false)
        advanceTimeBy(100); runCurrent()
        assertWaiting(repo, false)
        fresh.complete(snapshot("older"))
        runCurrent()
        assertWaiting(repo, true)
        assertEquals("older", repo.state.value.attention.pending["s1"]?.question?.callId)
    }

    @Test fun `event during coalesced read requires one followup and delayed older snapshot cannot clear new input`() = runTest {
        val remotes = FakeRemotes { c -> if (c.channel == Channels.CHAT_PENDING) snapshot("newest") else FakeRemotes.defaultAnswer(c) }
        val repo = connected(remotes)
        val stale = CompletableDeferred<JsonElement>()
        var reads = 0
        remotes.handler = { c ->
            if (c.channel == Channels.CHAT_PENDING) { if (++reads == 1) stale.await() else snapshot("older") }
            else FakeRemotes.defaultAnswer(c)
        }
        remotes.last.dismissals.emit(E2E.activityTag("s1"))
        runCurrent(); advanceTimeBy(100); runCurrent()
        repeat(5) { remotes.last.event("""{"type":"question_resolved","sessionId":"s1","callId":"newest"}""") }
        runCurrent()
        stale.complete(empty)
        runCurrent()
        assertWaiting(repo, false)
        advanceTimeBy(100); runCurrent()
        assertWaiting(repo, true)
        assertEquals(2, reads)
        advanceTimeBy(20_000); runCurrent()
        assertEquals(2, reads)
    }

    @Test fun `same remote reconnect invalidates old socket snapshot and fresh read restores authority`() = runTest {
        val remotes = FakeRemotes { c -> if (c.channel == Channels.CHAT_PENDING) snapshot("newest") else FakeRemotes.defaultAnswer(c) }
        val repo = connected(remotes)
        val stale = CompletableDeferred<JsonElement>()
        remotes.handler = { c -> if (c.channel == Channels.CHAT_PENDING) stale.await() else FakeRemotes.defaultAnswer(c) }
        val refresh = launch { repo.refresh() }
        runCurrent()
        remotes.last.status.value = RelayStatus(RelayState.CONNECTING)
        runCurrent()
        assertWaiting(repo, false)
        remotes.handler = { c -> if (c.channel == Channels.CHAT_PENDING) snapshot("older") else FakeRemotes.defaultAnswer(c) }
        remotes.last.goOnline()
        runCurrent()
        assertWaiting(repo, true)
        stale.complete(empty)
        refresh.join()
        assertWaiting(repo, true)
        assertEquals("older", repo.state.value.attention.pending["s1"]?.question?.callId)
    }
}
