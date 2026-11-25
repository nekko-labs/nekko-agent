package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import org.junit.Test
import java.io.File

/** Main-thread cost of keeping a saved copy of a 300-message chat (a smoke run unless NEKKO_BENCH_OUT is set). */
class SavedTranscriptsBench {
    /** Real files, as the app's `OfflineFileStore` writes them (a temp file, then a rename). */
    private class DiskFiles(val dir: File) : OfflineFiles {
        override fun load(computerId: String, name: String): JsonElement? =
            runCatching { WireJson.parseToJsonElement(File(dir, "$computerId-$name.json").readText()) }.getOrNull()
        override fun save(computerId: String, name: String, value: JsonElement) {
            val tmp = File(dir, "$computerId-$name.tmp")
            tmp.writeText(value.toString())
            tmp.renameTo(File(dir, "$computerId-$name.json"))
        }
        override fun remove(computerId: String) {}
        override fun removeFile(computerId: String, name: String) { File(dir, "$computerId-$name.json").delete() }
    }

    private fun session(extra: Int): Session {
        val messages = ArrayList<ChatMessage>()
        for (i in 0 until 75) {
            messages += ChatMessage("u$i", "user", "Please look at the build and fix the failing step number $i, then run the tests.")
            messages += ChatMessage("a$i", "assistant", "I will check it.\n\n## Summary\n" + "Some prose about the change. ".repeat(30))
            messages += ChatMessage("t$i", "tool", "", toolResult = ToolResult("c$i", "line of output\n".repeat(40), false))
            messages += ChatMessage("r$i", "assistant", "Done. " + "The tests pass and the build is green again. ".repeat(10))
        }
        messages += ChatMessage("x", "assistant", "tail $extra")
        return Session("s1", "Fix the build", "openai", "gpt-x", null, messages, 0, emptyList(), 1L + extra)
    }

    /** The caller's time per `save`, in ms, sorted: [n] saves, each followed by waiting for the queue to finish (not counted). */
    private fun time(store: SavedTranscripts, io: BackgroundIO?, n: Int, session: (Int) -> Session): List<Double> = (1..n).map { k ->
        val s = session(k)
        val t0 = System.nanoTime()
        store.save(s)
        val dt = (System.nanoTime() - t0) / 1e6
        io?.waitUntilIdle()
        dt
    }.sorted()

    private fun line(label: String, v: List<Double>) = "%s caller_ms median=%.3f p90=%.3f max=%.3f\n".format(label, v[v.size / 2], v[(v.size * 9) / 10], v.last())

    @Test
    fun saveOnTheCallersThread() {
        val measure = System.getenv("NEKKO_BENCH_OUT") != null
        val n = if (measure) 60 else 3
        val dir = kotlin.io.path.createTempDirectory("saved-bench").toFile()
        val report = StringBuilder()
        try {
            for (queued in listOf(false, true)) {
                val io = if (queued) BackgroundIO("bench") else null
                val store = SavedTranscripts(io = io).apply { use(DiskFiles(dir), "c1") }
                // A changed chat: one more message each time, as after every turn.
                time(store, io, n) { session(it) } // warm up
                val changed = time(store, io, n) { session(1_000 + it) }
                // The same chat again: a new Session with the same content, as after a reconnect re-read.
                val same = time(store, io, n) { session(1_000 + n) }
                report.append(line(if (queued) "queued, changed chat:" else "caller's thread, changed chat:", changed))
                report.append(line(if (queued) "queued, same chat:   " else "caller's thread, same chat:   ", same))
            }
        } finally {
            dir.deleteRecursively()
        }
        println(report)
        System.getenv("NEKKO_BENCH_OUT")?.let { File(it).writeText(report.toString()) }
    }
}
