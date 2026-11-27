package com.nekko.android

import com.nekko.android.data.ComputersRepository
import com.nekko.protocol.AccountIdentity
import com.nekko.protocol.AccountKeyring
import com.nekko.protocol.DenyReason
import com.nekko.protocol.FleetBinding
import com.nekko.protocol.FleetLink
import com.nekko.protocol.PairingLink
import com.nekko.protocol.Reach
import com.nekko.protocol.RelayRoute
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.RouteChoice
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Devices of one Nekko Cloud account connect without pairing (decision 0126): a paired computer's routes gain the
 * `reach` record's, and a computer with no pairing shows from the account and is dialed with the account HELLO.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AccountReachTest {
    private val tailnet = "ws://100.64.1.2:7777"
    private val cloud = "wss://relay.nekko.example/r/abc"
    private val cloud2 = "wss://relay2.nekko.example/r/abc"
    private val secret = "00112233445566778899aabbccddeeff"
    private val ring = AccountKeyring(ByteArray(64) { it.toByte() })
    private val identity = AccountIdentity(ring, "acct-1", 3, "phone-dev-1")

    private fun reach(room: String = "aaaa", routes: List<String> = listOf(cloud), hostKey: String = TEST_HOST_KEY, id: String = "mac-dev-1", name: String = "Studio Mac") =
        Reach(id, name, routes, room, secret, hostKey)

    private fun TestScope.repo(
        store: FakeStore, remotes: FakeRemotes, flow: MutableStateFlow<List<Reach>>, signedIn: () -> AccountIdentity? = { identity },
        refresh: (suspend () -> Unit)? = null,
    ): ComputersRepository {
        var n = 0
        return ComputersRepository(
            store = store, remotes = remotes, scope = backgroundScope, deviceName = { "Pixel Test" },
            deriveKey = { _, _ -> ByteArray(32) { it.toByte() } }, newId = { "id-${++n}" }, now = { 1_000L },
            summariesDebounceMs = 10, draftDebounceMs = 0, stayConnected = true,
            accountReach = flow, accountIdentity = { signedIn() }, refreshAccount = refresh,
        )
    }

    private fun link(room: String = "aaaa") = PairingLink(tailnet, room, secret, hostKey = TEST_HOST_KEY)

    @Test
    fun `a paired computer whose room matches gains the record's routes without its pairing being rewritten`() = runTest {
        val store = FakeStore()
        val flow = MutableStateFlow<List<Reach>>(emptyList())
        val remotes = FakeRemotes()
        val repo = repo(store, remotes, flow)
        repo.load()
        val id = repo.pair(link())
        runCurrent()
        val saved = store.map[ComputersRepository.INDEX_KEY]
        assertEquals(listOf(tailnet), repo.state.value.computers.single().routes)
        remotes.created.last().status.value = RelayStatus(RelayState.OFFLINE)

        flow.value = listOf(reach())
        runCurrent()
        val c = repo.state.value.computers.single()
        assertEquals("still one computer, the paired one", id, c.id)
        assertFalse(c.fromAccount)
        assertEquals(listOf(tailnet, cloud), c.routes)
        assertEquals("the saved pairing is untouched", saved, store.map[ComputersRepository.INDEX_KEY])
        assertFalse(store.map.values.any { it.contains(cloud) })
        // Not online, so it dials again at once with the merged routes, still as itself: no account HELLO.
        val dialed = remotes.created.last()
        assertEquals(listOf(tailnet, cloud), listOf(dialed.config.relayUrl) + dialed.config.alts)
        assertNull(dialed.config.fleetHello)
        assertFalse(dialed.config.deviceId.startsWith("fleet:"))

        // Connect through keeps working over the merged routes.
        repo.setRouteChoice(id, RouteChoice.DIRECT)
        runCurrent()
        assertEquals(listOf(tailnet), repo.state.value.computers.single().routes)
        repo.setRouteChoice(id, RouteChoice.CLOUD)
        runCurrent()
        assertEquals(listOf(cloud), repo.state.value.computers.single().routes)
        assertEquals(RelayRoute.INTERNET, RelayRoute.of(cloud))

        // The record is tombstoned: the merged routes go, the pairing's stay.
        flow.value = emptyList()
        runCurrent()
        assertEquals(listOf(tailnet), repo.state.value.computers.single().routes)
        assertEquals(emptyList<String>(), repo.state.value.computers.single().accountRoutes)
    }

    @Test
    fun `a record for another computer's key adds no route`() = runTest {
        val flow = MutableStateFlow<List<Reach>>(emptyList())
        val repo = repo(FakeStore(), FakeRemotes(), flow)
        repo.load()
        repo.pair(link())
        flow.value = listOf(reach(hostKey = "SOMEONE-ELSE"))
        runCurrent()
        assertEquals(listOf(tailnet), repo.state.value.computers.single().routes)
        assertTrue(repo.state.value.computers.none { it.fromAccount })
    }

    @Test
    fun `a computer with no pairing shows from the account and is dialed with the account HELLO`() = runTest {
        val store = FakeStore()
        val flow = MutableStateFlow<List<Reach>>(emptyList())
        val remotes = FakeRemotes()
        val repo = repo(store, remotes, flow)
        repo.load()
        flow.value = listOf(reach(routes = listOf(cloud, tailnet, cloud2)))
        runCurrent()
        val c = repo.state.value.computers.single()
        assertTrue(c.fromAccount)
        assertEquals("Studio Mac", c.name)
        assertEquals("account:mac-dev-1", c.id)
        assertEquals(listOf(cloud, tailnet, cloud2), c.routes)
        assertNull("never saved with the pairings", store.map[ComputersRepository.INDEX_KEY]?.takeIf { it.contains("mac-dev-1") })

        repo.connect(c.id)
        runCurrent()
        val cfg = remotes.created.last().config
        assertEquals("fleet:phone-dev-1", cfg.deviceId)
        assertEquals("aaaa", cfg.room)
        assertEquals(secret, cfg.key)
        assertEquals(TEST_HOST_KEY, cfg.hostKey)
        assertNull("an account HELLO never carries a pairing code", cfg.pairCode)
        assertEquals("android", cfg.platform)
        assertEquals(cloud, cfg.relayUrl)
        assertEquals(listOf(tailnet, cloud2), cfg.alts)
        val fleet = cfg.fleetHello!!(FleetBinding("aaaa", "chal", "hostE", "clientE", "helloK"))!!
        assertEquals("phone-dev-1", fleet["deviceId"].toString().trim('"'))

        // Nothing to revoke: forgetting it is a no-op, and signing out of Nekko Cloud takes it away.
        repo.forget(c.id)
        assertEquals(1, repo.state.value.computers.size)
        flow.value = emptyList()
        runCurrent()
        assertTrue(repo.state.value.computers.isEmpty())
        assertNull(repo.state.value.activeId)
    }

    @Test
    fun `pairing a computer that showed from the account leaves one entry`() = runTest {
        val flow = MutableStateFlow(listOf(reach()))
        val repo = repo(FakeStore(), FakeRemotes(), flow)
        repo.load()
        assertTrue(repo.state.value.computers.single().fromAccount)
        repo.pair(link())
        runCurrent()
        val c = repo.state.value.computers.single()
        assertFalse(c.fromAccount)
        assertEquals(listOf(tailnet, cloud), c.routes)
        // Forgetting the pairing brings the account's entry back.
        repo.forget(c.id)
        runCurrent()
        assertTrue(repo.state.value.computers.single().fromAccount)
    }

    @Test
    fun `signed out or locked, the account computer sends no HELLO`() = runTest {
        val remotes = FakeRemotes()
        val flow = MutableStateFlow(listOf(reach()))
        val repo = repo(FakeStore(), remotes, flow, signedIn = { null })
        repo.load()
        runCurrent()
        val cfg = remotes.created.last().config
        assertNull(cfg.fleetHello!!(FleetBinding("aaaa", "chal", "hostE", "clientE", "helloK")))
    }

    @Test
    fun `a record that changes redials the active account computer`() = runTest {
        val remotes = FakeRemotes()
        val flow = MutableStateFlow(listOf(reach()))
        val repo = repo(FakeStore(), remotes, flow)
        repo.load()
        runCurrent()
        val before = remotes.created.size
        flow.value = listOf(reach(routes = listOf(cloud2)))
        runCurrent()
        assertTrue(remotes.created.size > before)
        assertEquals(cloud2, remotes.created.last().config.relayUrl)
    }

    @Test
    fun `fleet-device is retried once after a sync catch-up`() = runTest {
        val remotes = FakeRemotes()
        var refreshed = 0
        val flow = MutableStateFlow(listOf(reach()))
        val repo = repo(FakeStore(), remotes, flow, refresh = { refreshed++ })
        repo.load()
        runCurrent()
        val first = remotes.created.last()
        first.status.value = RelayStatus(RelayState.DENIED, "fleet-device", DenyReason.FLEET_DEVICE)
        runCurrent()
        assertEquals(1, refreshed)
        val second = remotes.created.last()
        assertTrue("dialed again", second !== first)
        // Refused again: no loop.
        second.status.value = RelayStatus(RelayState.DENIED, "fleet-device", DenyReason.FLEET_DEVICE)
        runCurrent()
        assertEquals(1, refreshed)
        assertEquals(DenyReason.FLEET_DEVICE, repo.state.value.denied)
        assertNotNull(FleetLink.accountRefusalText("fleet-device"))
    }
}
