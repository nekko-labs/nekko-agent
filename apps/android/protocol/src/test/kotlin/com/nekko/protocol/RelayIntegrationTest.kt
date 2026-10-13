package com.nekko.protocol

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters
import java.io.File
import java.net.ServerSocket
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * The Android relay client against the real thing: the relay (apps/relay/dist),
 * a headless agent (apps/server/dist in relay-agent mode, TS loop) and a fake
 * OpenAI-compatible model. Proves the phone path end to end: enrollment with
 * the one-time code, the host's channels, a streamed chat turn, a guarded tool
 * call approved from the phone, and denial of strangers and a spent code.
 *
 * Opt-in. Needs a root build (shared, core, host, server, relay) and Node:
 *   NEKKO_ITEST=1 ./gradlew :protocol:test --tests '*RelayIntegrationTest*'
 */
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class RelayIntegrationTest {
    companion object {
        private val root = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..")
        private val procs = mutableListOf<Process>()
        private val room = E2E.toHex(E2E.randomBytes(8))
        private val key = E2E.toHex(E2E.randomBytes(16))
        private lateinit var keyBytes: ByteArray
        private var relayUrl = ""
        @Volatile private var pairCode = ""

        private fun freePort() = ServerSocket(0).use { it.localPort }

        private fun node(vararg args: String, env: Map<String, String> = emptyMap()): Process =
            ProcessBuilder("node", *args).directory(root).apply {
                environment().putAll(env)
                redirectErrorStream(true)
            }.start().also { procs += it }

        @BeforeClass @JvmStatic fun start() {
            assumeTrue("set NEKKO_ITEST=1 to run", System.getenv("NEKKO_ITEST") == "1")
            assumeTrue("build apps/relay and apps/server first", File(root, "apps/relay/dist/index.js").exists() && File(root, "apps/server/dist/index.js").exists())
            keyBytes = E2E.deriveKey(key, room)
            val relayPort = freePort()
            val modelPort = freePort()
            relayUrl = "ws://127.0.0.1:$relayPort"

            node("apps/android/scripts/fake-model.mjs", modelPort.toString()).drain()
            node("apps/relay/dist/index.js", env = mapOf(
                "NEKKO_RELAY_PORT" to relayPort.toString(), "NEKKO_RELAY_HOST" to "127.0.0.1",
                "NEKKO_RELAY_ALLOW_UNAUTHENTICATED" to "1",
            )).drain()
            Thread.sleep(800)

            val data = Files.createTempDirectory("nekko-android-itest-").toFile()
            File(data, "settings.json").writeText("""
                {"providers":[{"id":"fake","kind":"openai-compat","label":"Fake","baseUrl":"http://127.0.0.1:$modelPort/v1","apiKey":"sk-should-never-reach-the-phone","enabled":true}],
                 "defaultProviderId":"fake","defaultModelId":"fake-model"}
            """.trimIndent())
            val agent = node("apps/server/dist/index.js", env = mapOf(
                "NEKKO_RELAY_URL" to relayUrl, "NEKKO_ROOM" to room, "NEKKO_PAIR_KEY" to key,
                "NEKKO_DATA_DIR" to data.absolutePath, "NEKKO_AGENT_LOOP" to "ts",
            ))
            Thread {
                agent.inputStream.bufferedReader().forEachLine { line ->
                    Regex("pairing code \\(10 min\\): ([A-Z2-9]+)").find(line)?.let { pairCode = it.groupValues[1] }
                }
            }.apply { isDaemon = true }.start()
            repeat(150) { if (pairCode.isEmpty()) Thread.sleep(100) }
            assertTrue("agent printed a pairing code", Regex("^[A-Z2-9]{8}$").matches(pairCode))
        }

        private fun Process.drain() = Thread { inputStream.bufferedReader().forEachLine { } }.apply { isDaemon = true }.start()

        @AfterClass @JvmStatic fun stop() {
            procs.forEach { it.destroy(); it.waitFor(3, TimeUnit.SECONDS) }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun client(pair: String? = null, deviceId: String = UUID.randomUUID().toString()) = RelayClient(
        RelayConfig(relayUrl, room, key, keyBytes, deviceId, "Android itest", pairCode = pair, requestTimeoutMs = 30_000),
        OkHttpTransport(), scope,
    )

    private suspend fun RelayClient.awaitState(s: RelayState) = withTimeout(10_000) { status.first { it.state == s } }

    @Test fun a_refusesAStrangerWithoutACode() = runBlocking {
        val c = client()
        c.connect()
        val s = c.awaitState(RelayState.DENIED)
        assertTrue(s.denied in setOf(DenyReason.UNKNOWN_DEVICE, DenyReason.KICKED))
        scope.cancel()
    }

    @Test fun b_enrollsDrivesTheHostStreamsATurnAndApprovesATool() = runBlocking {
        val deviceId = UUID.randomUUID().toString()
        val c = client(pairCode, deviceId)
        val agentEvents = c.events.mapNotNull { (ch, p) -> if (ch == Events.AGENT_EVENT) AgentEvent.from(p) else null }
        c.connect()
        c.awaitState(RelayState.ONLINE)
        assertEquals("Android itest", withTimeout(5_000) { c.welcome.first() }.name)

        val info = AppInfo.from(c.call(Channels.APP_INFO))
        assertTrue(!info.version.isNullOrBlank())
        val rawProviders = c.call(Channels.PROVIDERS_LIST)
        val providers = PublicProvider.list(rawProviders)
        // The host also lists its built-in engine; the point is that keys never survive.
        assertTrue(providers.contains(PublicProvider("fake", "openai-compat", "Fake", true)))
        assertTrue("the raw reply does carry the key", rawProviders.toString().contains("sk-should-never"))
        assertFalse(providers.toString().contains("sk-"))
        assertEquals(RemoteDefaults("fake", "fake-model"), RemoteDefaults.from(c.call(Channels.SETTINGS_GET)))
        println("itest: enrolled as ${deviceId.take(8)}, host ${info.version}, ${providers.size} public providers")

        // 1. A plain streamed turn.
        val session = Session.from(c.call(Channels.SESSION_CREATE))!!
        val streamed = async { agentEvents.takeWhile { !(it is AgentEvent.Done && it.sessionId == session.id) }.toList() }
        c.callWithTimeout(60_000, Channels.CHAT_SEND, sendOptions(session.id, "fake", "fake-model", "Say hello"))
        val mine = withTimeout(10_000) { streamed.await() }.filter { it.sessionId == session.id }
        assertEquals("Hello from your computer.", mine.filterIsInstance<AgentEvent.Text>().joinToString("") { it.delta })
        var turn = mine.fold(LiveTurn(running = true)) { t, e -> Transcript.apply(t, e) }
        turn = Transcript.apply(turn, AgentEvent.Done(session.id, null))
        assertFalse(turn.running)

        val saved = Session.from(c.call(Channels.SESSION_GET, JsonPrimitive(session.id)))!!
        assertEquals(listOf("user", "assistant"), saved.messages.map { it.role })
        assertEquals("Hello from your computer.", (Transcript.fromMessages(saved.messages).last() as Block.Assistant).text)
        assertTrue(SessionSummary.visible(c.call(Channels.SESSIONS_SUMMARIES)).any { it.id == session.id })
        println("itest: streamed ${mine.size} events into ${session.id}, saved ${saved.messages.size} messages")

        // 2. A guarded tool call: the phone sees the approval, denies it, and the turn ends.
        val s2 = Session.from(c.call(Channels.SESSION_CREATE))!!
        val approval = async { withTimeout(30_000) { agentEvents.first { it is AgentEvent.ApprovalRequired && it.sessionId == s2.id } as AgentEvent.ApprovalRequired } }
        val done = async { withTimeout(60_000) { agentEvents.first { (it is AgentEvent.Done || it is AgentEvent.Error) && it.sessionId == s2.id } } }
        val send = scope.launch { runCatching { c.callWithTimeout(60_000, Channels.CHAT_SEND, sendOptions(s2.id, "fake", "fake-model", "please approve a cleanup")) } }
        val a = approval.await().approval
        assertEquals("bash", a.call.name)
        assertEquals("rm -rf ./nekko-itest-dist", a.call.input["command"]!!.jsonPrimitive.content)
        val pending = PendingInput.map(c.call(Channels.CHAT_PENDING))
        assertEquals(a.call.id, pending[s2.id]?.approval?.call?.id)
        c.call(Channels.TOOL_APPROVE, JsonPrimitive(s2.id), JsonPrimitive(a.call.id), JsonPrimitive(false))
        done.await()
        send.join()
        val afterDeny = Session.from(c.call(Channels.SESSION_GET, JsonPrimitive(s2.id)))!!
        val tool = Transcript.fromMessages(afterDeny.messages).filterIsInstance<Block.Tool>().single()
        assertEquals(a.call.id, tool.id)
        assertTrue(PendingInput.map(c.call(Channels.CHAT_PENDING))[s2.id]?.approval == null)
        println("itest: approval for `${a.call.input["command"]}` (${a.severity}) denied from the phone; tool ${tool.status}")

        // 3. Reconnecting as the same device works without a code.
        c.close()
        val again = client(null, deviceId)
        again.connect()
        again.awaitState(RelayState.ONLINE)
        again.close()
        println("itest: reconnected as the same device without a code")

        // 4. The one-time code is spent: another phone presenting it is refused.
        val replay = client(pairCode)
        replay.connect()
        val s = replay.awaitState(RelayState.DENIED)
        assertTrue(s.denied in setOf(DenyReason.BAD_CODE, DenyReason.KICKED))
        println("itest: spent code refused (${s.denied})")
        scope.cancel()
    }
}
