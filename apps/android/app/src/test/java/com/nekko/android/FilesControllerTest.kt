package com.nekko.android

import com.nekko.android.files.FileEditController
import com.nekko.android.files.FilesController
import com.nekko.protocol.Channels
import com.nekko.protocol.FileRoot
import com.nekko.protocol.FilesRequest
import com.nekko.protocol.PhoneRefusal
import com.nekko.protocol.RelayException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** AN-33: browsing, reading and saving a chat's files, with the iPhone's FilesModelTests cases. */
class FilesControllerTest {
    private val h1 = "1".repeat(64)
    private val h2 = "2".repeat(64)
    private val h3 = "3".repeat(64)

    /** A computer with one file; [onComputer] changes it there, as the owner would. */
    private class Computer(var text: String, var hash: String) {
        val reads = mutableListOf<FilesRequest>()
        val changes = mutableListOf<FilesRequest>()
        var refuse: RelayException? = null
        var next = ""
        var gone = false

        suspend fun read(r: FilesRequest): JsonElement {
            reads += r
            refuse?.let { throw it }
            return when (r.channel) {
                Channels.FILES_LIST -> Json.parseToJsonElement("""{"path":"","entries":[{"name":"notes.md","path":"notes.md","dir":false,"size":6}]}""")
                Channels.FILES_SEARCH -> Json.parseToJsonElement("""{"hits":[{"name":"notes.md","path":"notes.md"}],"truncated":false,"complete":true}""")
                Channels.FILES_READ -> Json.parseToJsonElement(
                    """{"path":"notes.md","name":"notes.md","size":6,"hash":"$hash","kind":"text","content":${Json.encodeToString(text)},"markdown":true,"editable":true}""",
                )
                else -> JsonNull
            }
        }

        suspend fun change(r: FilesRequest): JsonElement {
            changes += r
            refuse?.let { throw it }
            if (gone) return Json.parseToJsonElement("""{"ok":false,"error":"conflict"}""")
            val expect = (r.args[3] as kotlinx.serialization.json.JsonObject)["expectHash"]!!.jsonPrimitive.content
            if (expect != hash) return Json.parseToJsonElement("""{"ok":false,"error":"conflict","hash":"$hash"}""")
            text = r.args[2].jsonPrimitive.content
            hash = next
            return Json.parseToJsonElement("""{"ok":true,"hash":"$hash"}""")
        }
    }

    private fun files(c: Computer) = FilesController(FileRoot.Chat("s1"), c::read, c::change)

    @Test fun `lists, searches and opens by folder id only`() = runTest {
        val c = Computer("# Hi\n", h1)
        val f = files(c)
        assertEquals(listOf("notes.md"), f.list().entries.map { it.name })
        assertEquals(listOf("notes.md"), f.search("note").hits.map { it.path })
        val file = f.open("notes.md")
        assertTrue(file.canEdit)
        assertEquals(listOf("# Hi"), file.lines)
        // Every read names the chat, never a path on the computer; none is signed.
        assertTrue(c.reads.all { JsonArray(it.args).toString().startsWith("""[{"sessionId":"s1"}""") })
        assertTrue(c.changes.isEmpty())
    }

    @Test fun `saves over the version read, then tracks the new hash`() = runTest {
        val c = Computer("# Hi\n", h1)
        val f = files(c)
        val e = FileEditController("notes.md", f, f.open("notes.md"))
        assertFalse("nothing to save yet", e.canSave())
        e.edit("# Hello\n")
        assertTrue(e.canSave())
        c.next = h2
        assertTrue(e.save())
        assertEquals("# Hello\n", c.text)
        assertEquals(h2, e.state.value.hash)
        assertFalse(e.state.value.dirty)
        // A second save is checked against the hash the first one returned.
        e.edit("# Hello again\n")
        c.next = h3
        assertTrue(e.save())
        assertEquals(listOf(h1, h2), c.changes.map { (it.args[3] as kotlinx.serialization.json.JsonObject)["expectHash"]!!.jsonPrimitive.content })
    }

    @Test fun `a change on the computer asks to reload or overwrite`() = runTest {
        val c = Computer("# Hi\n", h1)
        val f = files(c)
        val e = FileEditController("notes.md", f, f.open("notes.md"))
        e.edit("mine\n")
        // The owner edits it on the computer meanwhile.
        c.text = "theirs\n"
        c.hash = h2
        assertFalse(e.save())
        assertTrue(e.state.value.conflict)
        assertTrue(e.state.value.canOverwrite)
        assertFalse("Save waits for the owner's choice", e.canSave())
        assertEquals("theirs\n", c.text)
        // Save over it: checked against the newer version, not the one first read.
        c.next = h3
        assertTrue(e.overwrite())
        assertEquals("mine\n", c.text)
        assertFalse(e.state.value.conflict)
        // Or reload, losing the edits.
        e.edit("again\n")
        c.text = "newest\n"
        c.hash = h1
        assertFalse(e.save())
        e.reload()
        assertEquals("newest\n", e.state.value.draft)
        assertEquals(h1, e.state.value.hash)
        assertFalse(e.state.value.conflict)
    }

    @Test fun `refusals are said plainly and hide Save`() = runTest {
        val c = Computer("# Hi\n", h1)
        val f = files(c)
        val e = FileEditController("notes.md", f, f.open("notes.md"))
        e.edit("x")
        c.refuse = RelayException("Changes from this phone are turned off on Studio.", PhoneRefusal("change-off", "files:write"))
        assertFalse(e.save())
        assertEquals("Changes from this phone are turned off on Studio.", e.state.value.error)
        assertTrue(f.changeOff.value)
        assertFalse(e.canSave())
        // A files error code comes back in words.
        c.refuse = RelayException("secret-file: this file may hold secrets and is never shown")
        val err = runCatching { f.open(".env") }.exceptionOrNull()
        assertEquals("This file may hold secrets, so it never leaves the computer.", err?.message)
        c.refuse = RelayException("Reading from this phone is turned off on Studio.", PhoneRefusal("read-off", "files:list"))
        runCatching { f.list() }
        assertTrue(f.readOff.value)
        c.refuse = null
        f.list()
        assertFalse(f.readOff.value)
    }

    @Test fun `a phone never saves more than it could read`() = runTest {
        val c = Computer("small\n", h1)
        val f = files(c)
        val e = FileEditController("notes.md", f, f.open("notes.md"))
        e.edit("x".repeat(FileEditController.WRITE_BYTES + 1))
        assertTrue(e.state.value.tooLarge)
        assertFalse(e.save())
        assertTrue(c.changes.isEmpty())
        assertTrue(e.state.value.error!!.contains("256 KB"))
        // A file gone from the computer is never created again from a phone.
        e.edit("ok\n")
        c.gone = true
        assertFalse(e.save())
        assertTrue(e.state.value.conflict)
        assertFalse(e.state.value.canOverwrite)
        assertFalse(e.overwrite())
        assertEquals(1, c.changes.size)
    }
}
