package com.nekko.android

import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.RemoteFactory
import com.nekko.protocol.Activity
import com.nekko.protocol.Channels
import com.nekko.protocol.Events
import com.nekko.protocol.NetworkPath
import com.nekko.protocol.PairingLink
import com.nekko.protocol.RelayState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Every paired computer stays connected (`stayConnected`, the iPhone's fleet):
 * switching hands the links over instead of dialing again.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FleetTest {
    private val key = "00112233445566778899aabbccddeeff"
    /** Each computer proves itself with its own key: pairing one the phone knows by its key re-pairs that computer. */
    private val hostKeys = mapOf("aaaa" to TEST_HOST_KEY, "bbbb" to "BE4Fn5F4K5mkw+MBYHvdQT/kC5NZN9rHpVgZBu5TJjT8ZDQi5gfJoAAZUNSiXhFQAHF+CVRUTY3F9l4HofyGWbA=")
    private fun link(room: String) = PairingLink("wss://relay.example.dev", room, key, hostKey = hostKeys.getValue(room))

    /** Each computer (room) answers with its own chats and folder. */
    private class Rooms : RemoteFactory {
        val created = CopyOnWriteArrayList<FakeRemote>()
        fun of(room: String) = created.last { it.config.room == room }
        /** What each computer still waits on (`chat:pending`); none set answers null. */
        val pending = java.util.concurrent.ConcurrentHashMap<String, () -> JsonElement>()

        override fun create(config: com.nekko.protocol.RelayConfig, scope: kotlinx.coroutines.CoroutineScope) =
            FakeRemote(config) { c -> answer(config.room, c) }.also { created += it }

        private fun answer(room: String, c: Call): JsonElement = when (c.channel) {
            Channels.SESSIONS_SUMMARIES -> Json.parseToJsonElement("""[{"id":"${room}1","title":"One","updatedAt":5}]""")
            Channels.WORKSPACE_LIST -> Json.parseToJsonElement("""[{"id":"w-$room","name":"App"}]""")
            Channels.APP_INFO -> Json.parseToJsonElement("""{"version":"0.9.0","platform":"win32"}""")
            Channels.CHAT_PENDING -> pending[room]?.invoke() ?: FakeRemotes.defaultAnswer(c)
            // `aaaa` has someone at its keyboard; both have Ollama, `bbbb` with its `small` model loaded.
            Channels.ACTIVITY_STATE -> Json.parseToJsonElement("""{"userActive":${room == "aaaa"},"chatActive":false,"headless":false,"strain":[]}""")
            Channels.PROVIDERS_LIST -> Json.parseToJsonElement("""[{"id":"ollama","kind":"ollama","label":"Ollama","enabled":true}]""")
            Channels.MODELS_LIST -> Json.parseToJsonElement("""[{"id":"big","name":"Big"},{"id":"small","name":"Small","loaded":${room != "aaaa"}}]""")
            else -> FakeRemotes.defaultAnswer(c)
        }
    }

    private fun TestScope.repo(store: FakeStore, remotes: Rooms, stay: Boolean = true): ComputersRepository {
        var n = 0
        return ComputersRepository(
            store = store,
            remotes = remotes,
            scope = backgroundScope,
            deviceName = { "Pixel Test" },
            deriveKey = { _, _ -> ByteArray(32) { it.toByte() } },
            newId = { "id-${++n}" },
            now = { 1_000L },
            summariesDebounceMs = 10,
            draftDebounceMs = 0,
            stayConnected = stay,
        )
    }

    @Test
    fun `the computer left behind keeps its link and switching back takes it over`() = runTest {
        val remotes = Rooms()
        val repo = repo(FakeStore(), remotes)
        val a = repo.pair(link("aaaa"))
        val ca = remotes.of("aaaa")
        ca.goOnline()
        runCurrent()

        // Another computer becomes active: the first is neither closed nor dialed again.
        val b = repo.pair(link("bbbb"))
        val cb = remotes.of("bbbb")
        runCurrent()
        assertEquals(2, remotes.created.size)
        assertFalse("the computer left behind stays connected", ca.closed)
        assertEquals(b, repo.state.value.activeId)
        assertEquals(RelayState.ONLINE, repo.state.value.connOf(a))
        assertEquals(listOf("aaaa1"), repo.state.value.peers.getValue(a).summaries.map { it.id })
        assertEquals("Windows PC", repo.state.value.computers.first { it.id == a }.name)
        cb.goOnline()
        runCurrent()

        // Who is running there, from its own event stream; the list is read again when a turn ends.
        ca.events.tryEmit(Events.AGENT_EVENT to buildJsonObject { put("type", "text"); put("sessionId", "aaaa1"); put("delta", "hi") })
        runCurrent()
        assertEquals(Activity.RUNNING, repo.state.value.peers.getValue(a).activity["aaaa1"])
        assertNull(repo.state.value.activity["aaaa1"])
        val reads = ca.channels().count { it == Channels.SESSIONS_SUMMARIES }
        ca.events.tryEmit(Events.AGENT_EVENT to buildJsonObject { put("type", "done"); put("sessionId", "aaaa1") })
        runCurrent()
        advanceTimeBy(20)
        runCurrent()
        assertEquals(reads + 1, ca.channels().count { it == Channels.SESSIONS_SUMMARIES })

        // Switching back: online at once, its chats on screen, no new connection.
        repo.connect(a)
        runCurrent()
        assertEquals(a, repo.state.value.activeId)
        assertEquals(RelayState.ONLINE, repo.state.value.conn)
        assertEquals(listOf("aaaa1"), repo.state.value.summaries.map { it.id })
        assertEquals(2, remotes.created.size)
        assertFalse(cb.closed)
        assertEquals(RelayState.ONLINE, repo.state.value.connOf(b))
        assertNull(repo.state.value.peers[a])
        repo.remote().call(Channels.SESSION_GET, JsonPrimitive("aaaa1"))
        assertTrue("the active computer is now the first one", ca.channels().contains(Channels.SESSION_GET))
    }

    @Test
    fun `load dials every computer, the phone's moves reach every link and forgetting closes one`() = runTest {
        val store = FakeStore()
        val first = Rooms()
        val setup = repo(store, first)
        val a = setup.pair(link("aaaa"))
        setup.pair(link("bbbb"))
        runCurrent()

        // Relaunch: one connection per paired computer.
        val remotes = Rooms()
        val repo = repo(store, remotes)
        repo.load()
        runCurrent()
        assertEquals(2, remotes.created.size)
        assertTrue(remotes.created.all { it.connected })
        val peer = remotes.of("aaaa")
        assertEquals(RelayState.CONNECTING, repo.state.value.connOf(a))
        peer.goOnline()
        runCurrent()
        assertEquals(listOf("aaaa1"), repo.state.value.peers.getValue(a).summaries.map { it.id })

        repo.nudge()
        repo.networkChanged(NetworkPath.CELLULAR)
        assertEquals(1, peer.nudges)
        assertTrue(peer.paths.contains("changed" to NetworkPath.CELLULAR))

        repo.forget(a)
        runCurrent()
        assertTrue(peer.closed)
        assertNull(repo.state.value.peers[a])
    }

    @Test
    fun `New chat asks every computer and picks the free one with a model there`() = runTest {
        val remotes = Rooms()
        val repo = repo(FakeStore(), remotes)
        val b = repo.pair(link("bbbb"))
        remotes.of("bbbb").goOnline()
        runCurrent()
        val a = repo.pair(link("aaaa"))
        remotes.of("aaaa").goOnline()
        runCurrent()
        assertEquals(a, repo.state.value.activeId)

        val pick = repo.pickMachine(lastUsed = a)
        assertEquals(com.nekko.protocol.MachinePick(b, com.nekko.protocol.MachinePick.Reason.FREE, listOf(a)), pick)
        for (r in remotes.created) {
            val asked = r.calls.filter { it.channel == Channels.ACTIVITY_STATE }
            assertTrue(asked.isNotEmpty())
            assertTrue("never sets the threshold", asked.all { it.args.isEmpty() })
        }
        // The model there: the one asked for if it has it, else one already loaded.
        assertEquals("ollama" to "big", repo.localModel(b, listOf("ollama" to "big")))
        assertEquals("ollama" to "small", repo.localModel(b, listOf("ollama" to "gone")))

        // Offline, it is neither asked nor picked.
        remotes.of("bbbb").status.value = com.nekko.protocol.RelayStatus(RelayState.OFFLINE)
        runCurrent()
        assertEquals(com.nekko.protocol.MachinePick(a, com.nekko.protocol.MachinePick.Reason.ALL_BUSY), repo.pickMachine(lastUsed = a))
    }

    /**
     * The phone was away from a fleet computer when its question was answered and
     * the turn ended: the events that end a wait reach only a connected phone, so
     * the reconnect read is what settles "Needs you".
     */
    @Test
    fun `a fleet computer's reconnect read settles needs you the phone missed`() = runTest {
        val remotes = Rooms()
        val repo = repo(FakeStore(), remotes)
        val a = repo.pair(link("aaaa"))
        val ca = remotes.of("aaaa")
        ca.goOnline()
        runCurrent()
        repo.pair(link("bbbb"))
        remotes.of("bbbb").goOnline()
        runCurrent()
        fun activity() = repo.state.value.peers.getValue(a).activity
        fun question(sid: String, id: String) = Json.parseToJsonElement(
            """{"type":"question","sessionId":"$sid","request":{"callId":"$id","questions":[]}}""",
        )
        ca.events.tryEmit(Events.AGENT_EVENT to question("aaaa1", "q1"))
        ca.events.tryEmit(Events.AGENT_EVENT to question("aaaa2", "q2"))
        runCurrent()
        assertEquals(Activity.NEEDS_YOU, activity()["aaaa1"])
        assertEquals(Activity.NEEDS_YOU, activity()["aaaa2"])

        // Away: both are answered there and nothing waits any more.
        fun reconnect() {
            ca.status.value = com.nekko.protocol.RelayStatus(RelayState.CONNECTING)
            runCurrent()
            ca.goOnline()
            runCurrent()
        }
        remotes.pending["aaaa"] = { Json.parseToJsonElement("{}") }
        reconnect()
        assertNull("answered while the phone was away: nothing needs you", activity()["aaaa1"])
        assertNull(activity()["aaaa2"])

        // A computer that still waits keeps it; one asked while away is shown.
        remotes.pending["aaaa"] = { Json.parseToJsonElement("""{"aaaa2":{"question":{"callId":"q3","questions":[]}}}""") }
        reconnect()
        assertNull(activity()["aaaa1"])
        assertEquals(Activity.NEEDS_YOU, activity()["aaaa2"])

        // A computer that could not say what waits leaves it as it was.
        remotes.pending["aaaa"] = { JsonNull }
        reconnect()
        assertEquals(Activity.NEEDS_YOU, activity()["aaaa2"])

        // A question that arrives with the read still needs you, whatever the read says.
        remotes.pending["aaaa"] = {
            ca.events.tryEmit(Events.AGENT_EVENT to question("aaaa1", "q4"))
            Json.parseToJsonElement("{}")
        }
        reconnect()
        assertEquals(Activity.NEEDS_YOU, activity()["aaaa1"])
        assertNull(activity()["aaaa2"])
    }

    @Test
    fun `without stayConnected the computer left behind is closed as before`() = runTest {
        val remotes = Rooms()
        val repo = repo(FakeStore(), remotes, stay = false)
        repo.pair(link("aaaa"))
        repo.pair(link("bbbb"))
        runCurrent()
        assertTrue(remotes.of("aaaa").closed)
        assertTrue(repo.state.value.peers.isEmpty())
    }
}
