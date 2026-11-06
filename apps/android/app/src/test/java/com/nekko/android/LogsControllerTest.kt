package com.nekko.android

import com.nekko.android.files.LogsController
import com.nekko.protocol.Channels
import com.nekko.protocol.FilesRequest
import com.nekko.protocol.LogText
import com.nekko.protocol.RelayException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** AN-34: the logs list, a tail and a search, read only, with the iPhone's FilesModelTests case. */
class LogsControllerTest {
    private val reads = mutableListOf<FilesRequest>()
    private var refuse: RelayException? = null

    private fun read(r: FilesRequest): JsonElement {
        reads += r
        refuse?.let { throw it }
        return when (r.channel) {
            Channels.LOGS_LIST -> Json.parseToJsonElement("""[{"id":"daemon","title":"Engine","kind":"daemon","size":10,"updatedAt":1}]""")
            Channels.LOGS_READ ->
                if ((r.args[1] as JsonObject)["query"] != null) Json.parseToJsonElement("""{"id":"daemon","size":10,"truncated":false,"query":"err","matches":[{"line":3,"text":"error"}]}""")
                else Json.parseToJsonElement("""{"id":"daemon","size":10,"truncated":true,"text":"a\nb\n"}""")
            else -> JsonNull
        }
    }

    @Test fun `lists logs, reads a tail and searches`() = runTest {
        val logs = LogsController(::read)
        logs.load()
        assertEquals(listOf("daemon"), logs.state.value.logs.map { it.id })
        val t = logs.tail("daemon")
        assertEquals("a\nb\n", t.text)
        assertTrue(t.truncated)
        val s = logs.search("daemon", "err")
        assertEquals(listOf(LogText.Match(3, "error")), s.matches)
        assertEquals(FilesRequest.log("daemon", query = "err"), reads.last())
        assertEquals("""{"tailBytes":${LogsController.TAIL_BYTES}}""", reads[1].args[1].toString())
        assertTrue("logs are read only", reads.none { it.isChange })
    }

    @Test fun `a failed read keeps the list and says why`() = runTest {
        val logs = LogsController(::read)
        logs.load()
        refuse = RelayException("Reading from this phone is turned off on Studio.")
        logs.load()
        assertEquals("Reading from this phone is turned off on Studio.", logs.state.value.error)
        assertEquals(listOf("daemon"), logs.state.value.logs.map { it.id })
        assertEquals("[]", JsonArray(reads.first().args).toString())
    }
}
