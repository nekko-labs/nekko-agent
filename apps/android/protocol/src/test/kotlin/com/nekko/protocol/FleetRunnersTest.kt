package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The fleet's CI runners as a phone reads them (the iPhone's FleetRunnersTests). */
class FleetRunnersTest {
    @Test fun readsTheFleetAndWordsEachRunnerLikeTheDesktop() {
        val raw = Json.parseToJsonElement(
            """
            {"orgs":[{"orgName":"Nekko Labs","computers":[
              {"deviceId":"d1","name":"Studio","online":true,"you":true,"runners":[
                {"label":"nekko-cloud-mac","state":"running","busy":1,"slots":2},
                {"label":"mini","state":"ready","busy":0,"slots":1},
                {"label":"old","state":"error","busy":0,"slots":0}]},
              {"deviceId":"d2","name":"Laptop","online":false,"runners":[{"label":"lap","state":"ready","busy":0,"slots":2}]},
              {"deviceId":"d3","name":"No runners","online":true,"runners":[]},
              {"name":"No id","online":true,"runners":[{"label":"x","state":"ready","busy":0,"slots":1}]}]}]}
            """,
        )
        val list = FleetRunnerComputer.list(raw)
        assertEquals(listOf("Studio", "Laptop"), list.map { it.name })
        assertEquals("Nekko Labs", list[0].org)
        assertTrue(list[0].you)
        assertEquals(
            listOf("CI runner nekko-cloud-mac: running a job (1 of 2 VMs)", "CI runner mini: ready (1 VM)", "CI runner old: needs attention"),
            list[0].lines,
        )
        assertEquals("an offline Mac's runner state is stale", emptyList<String>(), list[1].lines)
        assertEquals(emptyList<FleetRunnerComputer>(), FleetRunnerComputer.list(JsonNull))
    }
}
