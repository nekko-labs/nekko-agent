package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** AN-33: files requests, and the computer's phone views decoded from the cases its TS and Rust are held to (the iPhone's FilesTests). */
class FilesTest {
    private val golden: JsonObject by lazy {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-remote/tests/golden/phone-files.json")
        assumeTrue("running outside the monorepo", f.exists())
        Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun view(channel: String, n: Int = 0): JsonElement =
        golden["views"]!!.jsonArray.map { it.jsonObject }.filter { it["channel"]?.jsonPrimitive?.content == channel }[n]["view"]!!

    private fun args(r: FilesRequest) = JsonArray(r.args).toString()
    private val hash = "a".repeat(64)

    @Test fun `requests name a folder by id and only fields the computer accepts`() {
        assertEquals("""[{"sessionId":"s1"},""]""", args(FilesRequest.list(FileRoot.Chat("s1"))))
        assertEquals("""[{"workspaceId":"w1"},"src"]""", args(FilesRequest.list(FileRoot.Folder("w1"), "src")))
        assertEquals("""[{"sessionId":"s1"},"read",50]""", args(FilesRequest.search(FileRoot.Chat("s1"), "read")))
        assertEquals("""[{"sessionId":"s1"},"a.md"]""", args(FilesRequest.read(FileRoot.Chat("s1"), "a.md")))
        val w = FilesRequest.write(FileRoot.Chat("s1"), "a.md", "x", hash)
        assertEquals("""[{"sessionId":"s1"},"a.md","x",{"expectHash":"$hash"}]""", args(w))
        assertTrue(w.isChange)
        assertFalse(FilesRequest.read(FileRoot.Chat("s1"), "a.md").isChange)
        // A save can be signed (canonical JSON: no fractions).
        ChangeProof.canonicalJson(JsonArray(w.args))
    }

    @Test fun `the requests are the ones the computer accepts`() {
        // Each request this phone sends is a case the computer screens without a refusal.
        val ok = golden["screens"]!!.jsonArray.map { it.jsonObject }.filter { it["error"] == null }
        val accepted = ok.flatMap { c -> listOfNotNull(c["args"], c["callArgs"]).map { c["channel"]!!.jsonPrimitive.content to it.toString() } }.toSet()
        for (r in listOf(
            FilesRequest.list(FileRoot.Chat("s1")), FilesRequest.list(FileRoot.Folder("w1")), FilesRequest.read(FileRoot.Chat("s1"), "src/main.rs"),
            FilesRequest.write(FileRoot.Chat("s1"), "notes.md", "# Notes\n", hash), FilesRequest.search(FileRoot.Chat("s1"), "readme", limit = 20),
        )) {
            assertTrue("${r.channel} ${args(r)}", (r.channel to args(r)) in accepted)
        }
    }

    @Test fun `decodes what the computer sends`() {
        val l = FileListing.from(view("files:list"))!!
        assertEquals(listOf("src", "README.md"), l.entries.map { it.path })
        assertEquals("two counted by the computer, three more left out on the way", 5, l.hiddenSecrets)
        assertTrue(l.entries[0].dir)
        assertTrue(l.entries[1].link)
        val many = FileListing.from(view("files:list", 1))!!
        assertEquals(500, many.entries.size)
        assertTrue(many.truncated)
        assertEquals(listOf("README.md", "docs/readme.txt"), FileSearch.from(view("files:search")).hits.map { it.path })
        val f = FileContent.from(view("files:read"))!!
        assertEquals(FileContent.Kind.TEXT, f.kind)
        assertEquals("rust", f.language)
        assertEquals(listOf("fn main() {}"), f.lines)
        assertTrue(f.canEdit)
        val img = FileContent.from(view("files:read", 1))!!
        assertEquals(FileContent.Kind.IMAGE, img.kind)
        assertNotNull(img.image)
        assertFalse(img.canEdit)
        assertNull("only data:image URLs reach the phone", FileContent.from(view("files:read", 2))!!.image)
        assertEquals(FileSaveResult.Saved("a".repeat(64)), FileSaveResult.from(view("files:write")))
        assertEquals(FileSaveResult.Conflict("b".repeat(64)), FileSaveResult.from(view("files:write", 1)))
    }

    @Test fun `files errors are said plainly`() {
        assertEquals("No such chat.", FilesError.plain("not-found: no such chat"))
        assertEquals("This file may hold secrets, so it never leaves the computer.", FilesError.plain("secret-file: this file may hold secrets and is never shown"))
        assertEquals("Something else: kept", FilesError.plain("Something else: kept"))
        assertEquals("This file may hold secrets, so it never leaves Studio.", PhoneRefusal.parse("Not allowed from a paired phone (value-invalid): secret file")?.message("Studio"))
    }

    @Test fun `computer paths are absolute or refused`() {
        assertTrue(WorkspacePath.isAbsolute("/Users/ada/code"))
        assertTrue(WorkspacePath.isAbsolute("C:\\Users\\ada"))
        assertTrue(WorkspacePath.isAbsolute("\\\\server\\share"))
        assertFalse(WorkspacePath.isAbsolute("code/app"))
        assertFalse(WorkspacePath.isAbsolute("C:code"))
        assertFalse(WorkspacePath.isAbsolute("\\\\server"))
        assertFalse(WorkspacePath.isAbsolute("/a\nb"))
        assertEquals(JsonPrimitive("w1"), (FileRoot.Folder("w1").json as JsonObject)["workspaceId"])
    }
}
