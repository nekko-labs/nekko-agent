package com.nekko.android.data

import android.content.Context
import com.nekko.protocol.SavedChatList
import kotlinx.serialization.json.Json
import java.io.File

/** Where saved chat lists live, one per paired computer (see [SavedChatList]). */
interface ChatListCache {
    fun load(computerId: String): SavedChatList?
    fun save(computerId: String, list: SavedChatList)
    fun remove(computerId: String)
}

/**
 * The saved lists as small JSON files in the app's no-backup directory: never
 * in Auto Backup or device-to-device transfer, private to the app and encrypted
 * by the system's file-based encryption.
 */
class ChatListFiles(context: Context) : ChatListCache {
    private val dir = File(context.noBackupFilesDir, "chat-lists")

    override fun load(computerId: String): SavedChatList? =
        runCatching { SavedChatList.from(Json.parseToJsonElement(file(computerId).readText())) }.getOrNull()

    override fun save(computerId: String, list: SavedChatList) {
        runCatching {
            dir.mkdirs()
            val tmp = File(dir, "${name(computerId)}.tmp")
            tmp.writeText(list.json().toString())
            tmp.renameTo(file(computerId))
        }
    }

    override fun remove(computerId: String) {
        file(computerId).delete()
    }

    /** The setting was turned off, or the last computer forgotten: nothing stays behind. */
    fun removeAll() {
        dir.deleteRecursively()
    }

    private fun file(computerId: String) = File(dir, "${name(computerId)}.json")

    // Computer ids are generated UUIDs; keep only safe characters regardless.
    private fun name(computerId: String) = computerId.filter { it.isLetterOrDigit() || it == '-' }.ifEmpty { "computer" }

    companion object {
        // On unless the user turned it off (OF-9): only the switch writes the key, so an install that never touched it reads the default.
        val ENABLED = PhonePrefs.boolean("keep_chat_list", default = true)
    }
}
