package com.nekko.android.data

import android.content.Context
import com.nekko.protocol.BackgroundIO
import com.nekko.protocol.CoalescedWriter
import com.nekko.protocol.SavedChatList
import kotlinx.serialization.json.Json
import java.io.File

/** Where saved chat lists live, one per paired computer (see [SavedChatList]). */
interface ChatListCache {
    fun load(computerId: String): SavedChatList?
    fun save(computerId: String, list: SavedChatList)
    fun remove(computerId: String)
    /** Hand any write still waiting to the background queue now (the app is going to the background). */
    fun flush() {}
}

/**
 * The saved lists as small JSON files in the app's no-backup directory: never
 * in Auto Backup or device-to-device transfer, private to the app and encrypted
 * by the system's file-based encryption.
 */
class ChatListFiles(context: Context, private val io: BackgroundIO? = null) : ChatListCache {
    private val dir = File(context.noBackupFilesDir, "chat-lists")

    /** The newest list per computer waits here a moment, so a burst of refreshes is one write on the background queue (#3413). */
    private val writer = CoalescedWriter<SavedChatList>(io) { id, list -> write(id, list) }

    override fun load(computerId: String): SavedChatList? =
        writer.pending(computerId)
            ?: runCatching { SavedChatList.from(Json.parseToJsonElement(file(computerId).readText())) }.getOrNull()

    override fun save(computerId: String, list: SavedChatList) = writer.submit(computerId, list)

    override fun flush() = writer.flushNow()

    override fun remove(computerId: String) {
        writer.cancel(computerId)
        inOrder { file(computerId).delete() }
    }

    /** The setting was turned off, or the last computer forgotten: nothing stays behind. */
    fun removeAll() {
        writer.cancelAll()
        inOrder { dir.deleteRecursively() }
    }

    private fun write(computerId: String, list: SavedChatList) {
        runCatching {
            dir.mkdirs()
            val tmp = File(dir, "${name(computerId)}.tmp")
            tmp.writeText(list.json().toString())
            tmp.renameTo(file(computerId))
        }
    }

    /** After the writes asked for before it, so a removal never overtakes one. */
    private fun inOrder(work: () -> Unit) = if (io == null) work() else io.run(work)

    private fun file(computerId: String) = File(dir, "${name(computerId)}.json")

    // Computer ids are generated UUIDs; keep only safe characters regardless.
    private fun name(computerId: String) = computerId.filter { it.isLetterOrDigit() || it == '-' }.ifEmpty { "computer" }

    companion object {
        // On unless the user turned it off (OF-9): only the switch writes the key, so an install that never touched it reads the default.
        val ENABLED = PhonePrefs.boolean("keep_chat_list", default = true)
    }
}
