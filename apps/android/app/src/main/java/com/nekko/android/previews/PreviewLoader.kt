package com.nekko.android.previews

import com.nekko.protocol.ArtifactFile
import com.nekko.protocol.PreviewError
import com.nekko.protocol.PreviewRequest
import com.nekko.protocol.PreviewResponse
import com.nekko.protocol.PreviewUrls
import com.nekko.protocol.RelayException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.JsonElement
import java.util.Locale

/**
 * The preview window's and the preview cards' reads (AN-35, the iPhone's
 * `PreviewLoader`): files through `artifact:read`, loopback pages through
 * `preview:fetch`. What came back is kept in memory per chat and path (or
 * URL), so a card's thumbnail and the window it opens read the computer once;
 * Reload asks again. Thumbnails take one of a few slots, so a long chat
 * doesn't fetch every page at once. Safe to call from the web view's threads.
 */
class PreviewLoader(
    private val read: suspend (PreviewRequest) -> JsonElement,
    /** What the cache may hold in total. */
    private val byteLimit: Int = 32 * 1024 * 1024,
    thumbnailSlots: Int = 2,
) {
    /** A body the web view can be handed: bytes and their type. */
    class Body(
        val data: ByteArray,
        val mime: String,
        val charset: String? = null,
        val status: Int = 200,
        /** Only the start of a large text file came (the computer cuts text at 1 MiB). */
        val truncated: Boolean = false,
        /** The whole file's size, when it was cut. */
        val size: Long = data.size.toLong(),
    )

    private val lock = Mutex()
    private val cache = LinkedHashMap<String, Body>(16, 0.75f, true)
    private var bytes = 0
    private val inFlight = HashMap<String, CompletableDeferred<Body>>()
    private val slots = Semaphore(thumbnailSlots)

    /** The file at [path], as `artifact:read` sent it. */
    suspend fun artifact(sessionId: String, path: String, reload: Boolean = false): Body = load("a|$sessionId|$path", reload) {
        val f = ArtifactFile.from(read(PreviewRequest.artifact(sessionId, path))) ?: throw RelayException("Your computer sent nothing to show.")
        // A large binary file comes without its bytes; a large text file comes cut.
        if (f.truncated && (f.data.isEmpty() || !f.isText)) throw RelayException("Too large to open on a phone (${megabytes(f.size)}).")
        val (mime, charset) = PreviewUrls.splitContentType(f.mime)
        Body(f.data, mime, if (f.isText) charset ?: "utf-8" else charset, truncated = f.truncated, size = f.size)
    }

    /** The loopback page or asset at [url], fetched by the computer. */
    suspend fun fetch(sessionId: String, url: String, reload: Boolean = false): Body = load("l|$sessionId|$url", reload) {
        val r = PreviewResponse.from(read(PreviewRequest.fetch(sessionId, url))) ?: throw RelayException("Your computer sent nothing to show.")
        if (r.redirectedAway) throw RelayException("The preview server sent this page somewhere else.")
        if (r.truncated) throw RelayException("Too large to open on a phone.")
        val (mime, charset) = PreviewUrls.splitContentType(r.contentType.ifEmpty { PreviewUrls.mime(url.substringBefore('?')) })
        Body(r.body, mime, charset, r.status)
    }

    /** What was read before, without asking the computer. */
    suspend fun cachedArtifact(sessionId: String, path: String): Body? = lock.withLock { cache["a|$sessionId|$path"] }

    /** Forget a chat's reads (Reload in the window). */
    suspend fun forget(sessionId: String) = lock.withLock {
        val it = cache.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (e.key.split('|', limit = 3).getOrNull(1) == sessionId) {
                bytes -= e.value.data.size
                it.remove()
            }
        }
    }

    /** Run [work] while holding a thumbnail slot; waits for one to free up. */
    suspend fun <T> withThumbnailSlot(work: suspend () -> T): T = slots.withPermit { work() }

    private suspend fun load(key: String, reload: Boolean, fetch: suspend () -> Body): Body {
        val (mine, waiting) = lock.withLock {
            if (reload) drop(key) else cache[key]?.let { return it }
            inFlight[key]?.let { return@withLock null to it }
            CompletableDeferred<Body>().also { inFlight[key] = it } to null
        }
        if (waiting != null) return waiting.await()
        val deferred = mine!!
        return try {
            fetch().also { body ->
                lock.withLock {
                    store(key, body)
                    inFlight.remove(key)
                }
                deferred.complete(body)
            }
        } catch (e: Throwable) {
            lock.withLock { inFlight.remove(key) }
            deferred.completeExceptionally(e)
            throw e
        }
    }

    private fun store(key: String, body: Body) {
        if (body.data.size > byteLimit) return
        drop(key)
        cache[key] = body
        bytes += body.data.size
        val it = cache.entries.iterator()
        while (bytes > byteLimit && it.hasNext()) {
            bytes -= it.next().value.data.size
            it.remove()
        }
    }

    private fun drop(key: String) {
        cache.remove(key)?.let { bytes -= it.data.size }
    }

    companion object {
        /** The message for a failed read. */
        fun message(e: Throwable, loopback: Boolean): String =
            PreviewError.plain(e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t reach your computer.", loopback)

        /** `12.5 MB`. */
        fun megabytes(n: Long): String {
            val mb = n / 1_000_000.0
            return if (mb >= 10) "${Math.round(mb)} MB" else String.format(Locale.ROOT, "%.1f MB", mb)
        }
    }
}
