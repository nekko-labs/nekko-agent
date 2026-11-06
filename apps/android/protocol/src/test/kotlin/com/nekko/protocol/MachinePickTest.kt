package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The iPhone's MachinePickTests: a local-model chat starts on a free paired computer. */
class MachinePickTest {
    private val idle = ComputerUse()
    private val atDesk = ComputerUse(userActive = true)
    private val on = RelayState.ONLINE

    @Test fun `a free computer wins over the one used last when that one is busy`() {
        val pick = MachinePicker.pick(listOf(MachineCandidate("mac", on, running = 1, use = atDesk), MachineCandidate("pc", on, use = idle)), "mac")
        assertEquals(MachinePick("pc", MachinePick.Reason.FREE, listOf("mac")), pick)
    }

    @Test fun `someone at the keyboard counts as busy`() {
        val pick = MachinePicker.pick(listOf(MachineCandidate("mac", on, use = atDesk), MachineCandidate("pc", on, use = idle)), "mac")
        assertEquals("pc", pick.computerId)
    }

    @Test fun `with both free the one used last stays`() {
        val pick = MachinePicker.pick(listOf(MachineCandidate("pc", on, use = idle), MachineCandidate("mac", on, use = idle)), "mac")
        assertEquals(MachinePick("mac", MachinePick.Reason.FREE), pick)
    }

    @Test fun `on battery or hot loses a tie`() {
        val pick = MachinePicker.pick(listOf(MachineCandidate("laptop", on, use = ComputerUse(strained = true)), MachineCandidate("studio", on, use = idle)), null)
        assertEquals("studio", pick.computerId)
    }

    @Test fun `a computer that does not say counts as free but below one that does`() {
        assertEquals("new", MachinePicker.pick(listOf(MachineCandidate("old", on), MachineCandidate("new", on, use = idle)), null).computerId)
        val only = MachinePicker.pick(listOf(MachineCandidate("mac", on, running = 2), MachineCandidate("old", on)), "mac")
        assertEquals(MachinePick("old", MachinePick.Reason.FREE, listOf("mac")), only)
    }

    @Test fun `offline or without a model server is never picked`() {
        val pick = MachinePicker.pick(
            listOf(
                MachineCandidate("mac", on, running = 1),
                MachineCandidate("asleep", RelayState.OFFLINE),
                MachineCandidate("cloudy", on, use = idle, hasLocalModel = false),
            ),
            "mac",
        )
        assertEquals(MachinePick("mac", MachinePick.Reason.ALL_BUSY), pick)
    }

    @Test fun `all busy falls back to the one used last`() {
        val pick = MachinePicker.pick(listOf(MachineCandidate("pc", on, use = atDesk), MachineCandidate("mac", on, running = 3)), "mac")
        assertEquals(MachinePick("mac", MachinePick.Reason.ALL_BUSY), pick)
    }

    @Test fun `none online keeps the one used last`() {
        val pick = MachinePicker.pick(listOf(MachineCandidate("pc", RelayState.OFFLINE), MachineCandidate("mac", RelayState.CONNECTING)), "mac")
        assertEquals(MachinePick("mac", MachinePick.Reason.NONE_AVAILABLE), pick)
    }

    @Test fun `the computer says only yes or no`() {
        val raw = Json.parseToJsonElement("""{"userActive":false,"chatActive":false,"headless":true,"strain":["hot"]}""")
        assertEquals(ComputerUse(userActive = false, chatActive = false, headless = true, strained = true), ComputerUse.from(raw))
        assertNull("an older computer has no activity:state", ComputerUse.from(null))
        assertNull(ComputerUse.from(Json.parseToJsonElement("""{"error":"nope"}""")))
    }
}
