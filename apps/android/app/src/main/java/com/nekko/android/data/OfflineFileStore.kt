package com.nekko.android.data

import android.content.Context
import com.nekko.protocol.OfflineFiles
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.File

/**
 * Each computer's drafts and outbox as small JSON files in the app's no-backup
 * directory (`offline/<computer>/<name>.json`): never in Auto Backup or
 * device-to-device transfer, private to the app and encrypted by the system's
 * file-based encryption. Forgetting the computer deletes its folder.
 */
class OfflineFileStore(context: Context) : OfflineFiles {
    private val dir = File(context.noBackupFilesDir, "offline")

    override fun load(computerId: String, name: String): JsonElement? =
        runCatching { Json.parseToJsonElement(file(computerId, name).readText()) }.getOrNull()

    override fun save(computerId: String, name: String, value: JsonElement) {
        runCatching {
            val folder = folder(computerId).apply { mkdirs() }
            // Written whole, then renamed: a crash mid-write leaves the last good copy.
            val tmp = File(folder, "$name.tmp")
            tmp.writeText(value.toString())
            tmp.renameTo(file(computerId, name))
        }
    }

    override fun remove(computerId: String) {
        folder(computerId).deleteRecursively()
    }

    override fun removeFile(computerId: String, name: String) {
        file(computerId, name).delete()
    }

    companion object {
        /** *Keep recent chats to read offline*: on unless the user turned it off (OF-9); only the switch writes it. */
        val KEEP_TRANSCRIPTS = PhonePrefs.boolean("keep_transcripts", default = true)
    }

    /** The last computer was forgotten: nothing stays behind. */
    fun removeAll() {
        dir.deleteRecursively()
    }

    private fun file(computerId: String, name: String) = File(folder(computerId), "$name.json")

    // Computer ids are generated UUIDs; keep only safe characters regardless.
    private fun folder(computerId: String) = File(dir, computerId.filter { it.isLetterOrDigit() || it == '-' }.ifEmpty { "computer" })
}
