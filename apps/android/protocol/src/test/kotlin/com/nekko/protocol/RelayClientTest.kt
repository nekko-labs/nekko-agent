package com.nekko.protocol

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The relay client against an in-memory relay + agent. The fake plays the
 * agent's side of `crates/nekko-remote/src/agent.rs`: it opens sealed frames with the
 * room key, answers HELLO, and replies to requests.
 */
class RelayClientTest {
    private val key = E2E.randomBytes(32)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After fun tearDown() = scope.cancel()

    /** An agent that knows [known] devices and accepts [code] once. */
    inner class FakeRelay(var known: MutableSet<String> = mutableSetOf(), var code: String? = null) : WsTransport {
        val urls = CopyOnWriteArrayList<String>()
        val hellos = CopyOnWriteArrayList<JsonObject>()
        val requests = CopyOnWriteArrayList<JsonObject>()
        var current: Conn? = null
        var refuseNext: Pair<Int, String>? = null
        /** The computer's phone protocol version in its welcome (IO-32); null sends none. */
        var welcomeProtocol: Int? = null
        var answer: (JsonObject) -> JsonObject? = { req -> buildJsonObject { put("type", "res"); put("id", req["id"]!!); put("result", JsonPrimitive("ok:${req["channel"]!!.jsonPrimitive.content}")) } }

        inner class Conn(val listener: WsListener) : WsConnection {
            @Volatile var open = true
            override fun send(text: String): Boolean {
                if (!open) return false
                val env = WireJson.parseToJsonElement(text).jsonObject
                val frame = E2E.open(key, env["enc"]!!.jsonPrimitive.content).jsonObject
                when (frame["type"]!!.jsonPrimitive.content) {
                    "hello" -> {
                        hellos += frame
                        val id = frame["deviceId"]!!.jsonPrimitive.content
                        val pair = frame["pair"]?.jsonPrimitive?.content
                        val reply = when {
                            id in known -> null
                            pair != null && pair == code -> { known += id; code = null; null }
                            pair != null -> "bad-code"
                            else -> "unknown-device"
                        }
                        if (reply == null) push(buildJsonObject {
                            put("type", "welcome")
                            put("device", buildJsonObject { put("id", id); put("name", frame["name"]!!); put("platform", "android") })
                            welcomeProtocol?.let { put("protocol", it) }
                        }) else {
                            push(buildJsonObject { put("type", "denied"); put("reason", reply) })
                            drop(4001, "kicked by agent")
                        }
                    }
                    "req" -> { requests += frame; answer(frame)?.let { push(it) } }
                }
                return true
            }
            override fun close(code: Int, reason: String) { if (open) { open = false; listener.onClosed(code, reason) } }
            fun push(frame: JsonObject) = listener.onMessage(buildJsonObject { put("enc", E2E.seal(key, frame)) }.toString())
            fun plain(frame: JsonObject) = listener.onMessage(frame.toString())
            fun drop(code: Int, reason: String) { if (open) { open = false; listener.onClosed(code, reason) } }
        }

        override fun open(url: String, listener: WsListener): WsConnection {
            urls += url
            val c = Conn(listener)
            current = c
            refuseNext?.let { (code, reason) ->
                refuseNext = null
                scope.launchSoon { c.drop(code, reason) }
                return c
            }
            scope.launchSoon { listener.onOpen() }
            return c
        }
    }

    private fun CoroutineScope.launchSoon(block: () -> Unit) = async { delay(5); block() }

    private fun client(relay: FakeRelay, pair: String? = null, id: String = "dev-1", transport: WsTransport = relay) = RelayClient(
        RelayConfig(
            relayUrl = "wss://relay.test/", room = "abcd1234", key = "k&ey", keyBytes = key,
            deviceId = id, deviceName = "Pixel", pairCode = pair,
            // Generous: the first test on a cold JVM also pays for crypto setup, and no test here
            // waits for these to expire, so they only bound how long a real failure takes.
            handshakeTimeoutMs = 10_000, requestTimeoutMs = 10_000, retryBaseMs = 20, retryMaxMs = 80, offlinePollMs = 40,
        ),
        transport, scope,
    )

    private suspend fun RelayClient.await(state: RelayState) = withTimeout(10_000) { status.first { it.state == state } }

    @Test fun `enrolls with the one-time code, then never resends it`() = runBlocking {
        val relay = FakeRelay(code = "ABCD2345")
        val c = client(relay, pair = "ABCD2345")
        c.connect()
        c.await(RelayState.ONLINE)
        assertEquals("wss://relay.test/relay?role=client&room=abcd1234&key=k%26ey", relay.urls.single())
        assertEquals("ABCD2345", relay.hellos.single()["pair"]!!.jsonPrimitive.content)
        assertEquals("Pixel", c.welcome.first().name)

        // Drop the socket: the reconnect HELLO must not carry the spent code.
        relay.current!!.drop(1006, "network")
        c.await(RelayState.ONLINE)
        assertEquals(2, relay.hellos.size)
        assertNull(relay.hellos[1]["pair"])
        c.close()
    }

    @Test fun `a newer computer and relay, the welcome field and the relay push frames are ignored`() = runBlocking {
        // iOS reads these (IO-30, IO-32); this client must carry on as before.
        val relay = FakeRelay(known = mutableSetOf("dev-1")).apply { welcomeProtocol = 2 }
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        assertEquals("Pixel", c.welcome.first().name)
        relay.current!!.plain(buildJsonObject { put("type", "push-registered"); put("delivers", true) })
        relay.current!!.plain(buildJsonObject { put("type", "dismiss"); put("tag", "a".repeat(32)) })
        assertEquals("ok:app:info", c.call(Channels.APP_INFO, JsonPrimitive("x")).jsonPrimitive.content)
        assertEquals(RelayState.ONLINE, c.status.first().state)
        assertEquals(1, relay.hellos.size)
        c.close()
    }

    @Test fun `calls channels with sealed requests and resolves replies`() = runBlocking {
        val c = client(FakeRelay(known = mutableSetOf("dev-1")))
        c.connect()
        val r = c.call(Channels.APP_INFO, JsonPrimitive("x"))
        assertEquals("ok:app:info", r.jsonPrimitive.content)
        c.close()
    }

    @Test fun `waits for the handshake before sending a request`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay)
        c.connect()
        val r = async { c.call(Channels.SESSIONS_SUMMARIES) }
        assertEquals("ok:sessions:summaries", r.await().jsonPrimitive.content)
        assertEquals(1, relay.requests.size)
        assertEquals(0, relay.requests.single()["args"]!!.jsonArray.size)
        c.close()
    }

    @Test fun `a socket that opens before open() returns still says hello`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        // Like OkHttp on a fast network: onOpen on another thread while open() is still returning.
        val early = object : WsTransport {
            override fun open(url: String, listener: WsListener): WsConnection {
                val c = relay.open(url, object : WsListener {
                    override fun onOpen() {}
                    override fun onMessage(text: String) = listener.onMessage(text)
                    override fun onClosed(code: Int, reason: String) = listener.onClosed(code, reason)
                })
                Thread { listener.onOpen() }.start()
                Thread.sleep(50) // the callback is already waiting when open() returns
                return c
            }
        }
        val c = client(relay, transport = early)
        c.connect()
        assertEquals("ok:app:info", c.call(Channels.APP_INFO).jsonPrimitive.content)
        assertEquals(1, relay.hellos.size)
        c.close()
    }

    @Test fun `host errors reject the call`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.answer = { req -> buildJsonObject { put("type", "res"); put("id", req["id"]!!); put("error", "no such session") } }
        val c = client(relay)
        c.connect()
        try { c.call(Channels.SESSION_GET, JsonPrimitive("s")); fail() } catch (e: RelayException) { assertEquals("no such session", e.message) }
        c.close()
    }

    @Test fun `delivers events and ignores frames sealed with another key`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        val got = async { withTimeout(2_000) { c.events.first() } }
        delay(20)
        relay.current!!.listener.onMessage(buildJsonObject { put("enc", E2E.seal(E2E.randomBytes(32), buildJsonObject { put("type", "event") })) }.toString())
        relay.current!!.listener.onMessage("not json")
        relay.current!!.push(buildJsonObject {
            put("type", "event"); put("channel", Events.AGENT_EVENT)
            put("payload", buildJsonObject { put("type", "text"); put("sessionId", "s"); put("delta", "hi") })
        })
        val (ch, payload) = got.await()
        assertEquals(Events.AGENT_EVENT, ch)
        assertEquals(AgentEvent.Text("s", "hi"), AgentEvent.from(payload))
        c.close()
    }

    @Test fun `a stranger is denied and stays denied`() = runBlocking {
        val relay = FakeRelay()
        val c = client(relay)
        c.connect()
        val s = c.await(RelayState.DENIED)
        assertEquals(DenyReason.UNKNOWN_DEVICE, s.denied)
        delay(150)
        assertEquals(1, relay.urls.size) // no reconnect loop after a denial
        try { c.call(Channels.APP_INFO); fail() } catch (e: RelayException) { assertTrue(e.message!!.contains("no longer paired")) }
    }

    @Test fun `a wrong pairing code is denied as bad-code`() = runBlocking {
        val c = client(FakeRelay(code = "RIGHT234"), pair = "WRONG234")
        c.connect()
        assertEquals(DenyReason.BAD_CODE, c.await(RelayState.DENIED).denied)
    }

    @Test fun `revocation mid-connection (kick 4001) is terminal and fails in-flight calls`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.answer = { null } // never answer
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        val inflight = async { runCatching { c.call(Channels.CHAT_PENDING) } }
        delay(50)
        relay.current!!.drop(4001, "kicked by agent")
        assertEquals(DenyReason.KICKED, c.await(RelayState.DENIED).denied)
        assertTrue(inflight.await().exceptionOrNull() is RelayException)
    }

    @Test fun `a bad pairing key is terminal`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.refuseNext = 1008 to "bad pairing key"
        val c = client(relay)
        c.connect()
        assertEquals(DenyReason.BAD_KEY, c.await(RelayState.DENIED).denied)
    }

    @Test fun `an offline computer is polled, then the handshake completes`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.refuseNext = 1008 to "room not paired (agent offline)"
        val c = client(relay)
        c.connect()
        c.await(RelayState.OFFLINE)
        c.await(RelayState.ONLINE)
        assertEquals(2, relay.urls.size)
        c.close()
    }

    @Test fun `agent-offline then agent-online repeats the handshake on the same socket`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        relay.current!!.plain(buildJsonObject { put("type", "agent-offline") })
        c.await(RelayState.OFFLINE)
        relay.current!!.plain(buildJsonObject { put("type", "agent-online") })
        c.await(RelayState.ONLINE)
        assertEquals(1, relay.urls.size)
        assertEquals(2, relay.hellos.size)
        c.close()
    }

    @Test fun `reconnect drops a live socket and dials a fresh one`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.answer = { null } // never answer: the call must fail, not hang
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        val old = relay.current!!
        val inflight = async { runCatching { c.call(Channels.CHAT_PENDING) } }
        delay(50)
        c.reconnect()
        assertTrue(inflight.await().exceptionOrNull() is RelayException)
        assertTrue(!old.open)
        c.await(RelayState.ONLINE)
        assertEquals(2, relay.urls.size)
        assertEquals(2, relay.hellos.size)
        // The old socket's late close must not schedule another dial.
        delay(150)
        assertEquals(2, relay.urls.size)
        c.close()
    }

    @Test fun `reconnect skips the backoff while the relay is unreachable`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        relay.refuseNext = 1006 to "network down"
        val c = RelayClient(
            RelayConfig(
                relayUrl = "wss://relay.test/", room = "abcd1234", key = "k", keyBytes = key, deviceId = "dev-1", deviceName = "Pixel",
                handshakeTimeoutMs = 2_000, requestTimeoutMs = 2_000, retryBaseMs = 60_000, retryMaxMs = 60_000,
            ),
            relay, scope,
        )
        c.connect()
        withTimeout(2_000) { c.status.first { it.state == RelayState.CONNECTING && it.detail == "network down" } }
        c.reconnect() // without it the next try would be a minute away
        c.await(RelayState.ONLINE)
        assertEquals(2, relay.urls.size)
        c.close()
    }

    @Test fun `reconnect does nothing once closed or denied`() = runBlocking {
        val closed = FakeRelay(known = mutableSetOf("dev-1"))
        val a = client(closed)
        a.connect(); a.await(RelayState.ONLINE); a.close()
        a.reconnect()
        delay(100)
        assertEquals(1, closed.urls.size)
        assertEquals(RelayState.IDLE, a.state)

        val stranger = FakeRelay()
        val b = client(stranger)
        b.connect(); b.await(RelayState.DENIED)
        b.reconnect()
        delay(100)
        assertEquals(1, stranger.urls.size)
        assertEquals(RelayState.DENIED, b.state)
    }

    @Test fun `close stops reconnecting and rejects new calls`() = runBlocking {
        val relay = FakeRelay(known = mutableSetOf("dev-1"))
        val c = client(relay)
        c.connect()
        c.await(RelayState.ONLINE)
        c.close()
        assertEquals(RelayState.IDLE, c.state)
        delay(150)
        assertEquals(1, relay.urls.size)
        try { c.call(Channels.APP_INFO); fail() } catch (e: RelayException) { assertEquals("Not connected.", e.message) }
    }
}
