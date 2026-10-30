package com.nekko.android

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.chat.ChatState
import com.nekko.protocol.Channels
import com.nekko.protocol.OfflineFiles
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import com.nekko.protocol.SavedTranscripts
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SavedCopyTest {
    private class Files : OfflineFiles {
        val map = HashMap<String, JsonElement>()
        override fun load(computerId: String, name: String) = map["$computerId/$name"]
        override fun save(computerId: String, name: String, value: JsonElement) { map["$computerId/$name"] = value }
        override fun remove(computerId: String) { map.keys.removeAll { it.startsWith("$computerId/") } }
        override fun removeFile(computerId: String, name: String) { map.remove("$computerId/$name") }
    }

    private val session = buildJsonObject {
        put("id", "s1")
        put("title", "Release notes")
        put("updatedAt", 1)
        put("queue", JsonArray(emptyList()))
        put("messages", buildJsonArray {
            add(buildJsonObject { put("id", "u"); put("role", "user"); put("content", "Group them by area") })
            add(buildJsonObject { put("id", "a"); put("role", "assistant"); put("content", "Done: 4 areas.") })
        })
    }
    private val online = ChatEnv(RelayState.ONLINE, null, RemoteDefaults("p", "m"), "Mac", canQueue = true)
    private val offline = online.copy(conn = RelayState.OFFLINE)

    private fun saved(files: Files) = SavedTranscripts(now = { 42L }).apply { use(files, "c1") }

    @Test
    fun `each read is saved, and the next open paints it at once, read-only, until the computer answers`() = runTest {
        val files = Files()
        var reachable = true
        val caller = FakeCaller { c ->
            if (!reachable) throw RelayException("Could not reach your computer.")
            if (c.channel == Channels.SESSION_GET) session else JsonNull
        }
        ChatController("s1", caller, backgroundScope, { online }, saved = saved(files)).reload()

        // Opened again with the computer out of reach.
        reachable = false
        val chat = ChatController("s1", caller, backgroundScope, { offline }, saved = saved(files))
        chat.showSavedCopy()
        assertEquals(42L, chat.state.value.savedAt)
        chat.reload()
        val ui = ChatController.project(chat.state.value, offline)
        assertTrue(ui.ready)
        assertNull("no error: the note says it is a saved copy", ui.error)
        assertEquals(42L, ui.savedAt)
        assertEquals(2, ui.blocks.size)

        // The computer answers: the live chat replaces it in place.
        reachable = true
        chat.reload()
        assertNull(chat.state.value.savedAt)
    }

    @Test
    fun `a chat the computer no longer has loses its copy`() = runTest {
        val files = Files()
        val store = saved(files)
        var gone = false
        val caller = FakeCaller { c -> if (c.channel == Channels.SESSION_GET && !gone) session else JsonNull }
        val chat = ChatController("s1", caller, backgroundScope, { online }, saved = store)
        chat.reload()
        assertNotNull(store.saved("s1"))
        gone = true
        chat.reload()
        assertNull(store.saved("s1"))
        assertEquals("This chat was deleted on your computer.", chat.state.value.loadError)
    }

    @Test
    fun `out of reach with no copy says so instead of loading forever`() {
        val ui = ChatController.project(ChatState(), offline)
        assertTrue(ui.ready)
        assertEquals("This chat isn’t saved on this phone yet. It shows when Mac answers.", ui.error)
    }
}
