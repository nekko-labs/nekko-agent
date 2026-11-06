package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.util.Base64

// The preview window's two reads from the computer (AN-35, the iPhone's
// #1095, decision 0025): `artifact:read` for a file the agent linked in the
// chat (and the files beside a linked HTML page, its assets), and
// `preview:fetch` for a loopback page the agent linked. Mirrors `Previews.swift`.

/** One preview call, ready to send (both are read class). */
data class PreviewRequest(val channel: String, val args: List<JsonElement>) {
    companion object {
        fun artifact(sessionId: String, path: String) =
            PreviewRequest(Channels.ARTIFACT_READ, listOf(JsonPrimitive(sessionId), JsonPrimitive(path)))

        fun fetch(sessionId: String, url: String) =
            PreviewRequest(Channels.PREVIEW_FETCH, listOf(JsonPrimitive(sessionId), JsonPrimitive(url), buildJsonObject { put("method", "GET") }))
    }
}

/** A file as `artifact:read` returns it. */
class ArtifactFile(
    val path: String,
    val name: String,
    val mime: String,
    val size: Long,
    /** Epoch ms; null when unknown. */
    val mtime: Long?,
    /** The bytes sent: the text as UTF-8, or the decoded base64. Empty when truncated. */
    val data: ByteArray,
    val isText: Boolean,
    /** Too large to send whole. */
    val truncated: Boolean,
) {
    val text: String? get() = if (isText) data.toString(Charsets.UTF_8) else null

    companion object {
        fun from(v: JsonElement?): ArtifactFile? {
            val o = v.obj() ?: return null
            val path = o.str("path") ?: return null
            val isText = o.str("kind") == "text"
            val data = o.str("content")?.toByteArray(Charsets.UTF_8)
                ?: o.str("base64")?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }
                ?: ByteArray(0)
            return ArtifactFile(
                path, o.str("name") ?: path.substringAfterLast('/'), o.str("mime")?.takeIf { it.isNotEmpty() } ?: PreviewUrls.mime(path),
                o.long("size") ?: data.size.toLong(), o.dbl("mtime")?.takeIf { it > 0 }?.toLong(), data, isText, o.bool("truncated"),
            )
        }
    }
}

/** A loopback response as `preview:fetch` returns it. */
class PreviewResponse(
    val url: String,
    val status: Int,
    val contentType: String,
    /** Lower-case names. */
    val headers: Map<String, String>,
    val body: ByteArray,
    val truncated: Boolean = false,
) {
    /** A 3xx comes back as is: the computer follows redirects only on the linked origin. */
    val redirectedAway: Boolean get() = status in 300..399

    companion object {
        fun from(v: JsonElement?): PreviewResponse? {
            val o = v.obj() ?: return null
            val status = o.long("status") ?: return null
            val headers = (o["headers"] as? JsonObject).orEmpty().mapNotNull { (k, h) ->
                (h as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { k.lowercase() to it }
            }.toMap()
            val body = o.str("base64")?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() } ?: ByteArray(0)
            return PreviewResponse(
                o.str("url").orEmpty(), status.toInt(), o.str("contentType") ?: headers["content-type"].orEmpty(), headers, body, o.bool("truncated"),
            )
        }
    }
}

/**
 * Where the preview web view loads from. Android's WebView resolves relative
 * links only on standard schemes, so instead of the iPhone's custom schemes
 * it uses `https` on two hosts under `.invalid` (a top-level domain that never
 * resolves) and answers every request itself (`shouldInterceptRequest`): a
 * file is `https://artifact.nekko.invalid/<absolute path>`, so a page's
 * relative links resolve to files beside it; a loopback page is
 * `https://preview.nekko.invalid/<path>?<query>` for the one origin its window
 * was opened on, so the dev server's root-relative links stay on it.
 */
object PreviewUrls {
    const val ARTIFACT_HOST = "artifact.nekko.invalid"
    const val PREVIEW_HOST = "preview.nekko.invalid"

    /**
     * Sent with every page and asset: scripts and styles may run, but only
     * from these hosts or inline, and a page can't connect, frame or post
     * anywhere else (fetch, XHR, WebSocket, beacons).
     */
    const val CONTENT_SECURITY_POLICY = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; " +
        "connect-src 'self'; frame-src 'self' data: blob:; form-action 'self'; base-uri 'self'"

    /** `/Users/a/x y.html` → `https://artifact.nekko.invalid/Users/a/x%20y.html`; `C:/x/y.html` → `…/C:/x/y.html`. */
    fun artifactUrl(path: String): String = "https://$ARTIFACT_HOST" + ChatLinks.encodePath(if (path.startsWith("/")) path else "/$path")

    /** The absolute path an artifact URL names (decoded, query and fragment dropped); null for any other URL. */
    fun artifactPath(url: String): String? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != "https" || uri.host?.lowercase() != ARTIFACT_HOST) return null
        var path = uri.rawPath?.let { ChatLinks.percentDecode(it) ?: it } ?: return null
        if (!path.startsWith("/")) return null
        if (path.length >= 4 && path[1].isLetter() && path[2] == ':' && path[3] == '/') path = path.substring(1)
        return path
    }

    /** `http://localhost:5173/app?x=1` → `https://preview.nekko.invalid/app?x=1`. */
    fun previewUrl(loopback: String): String? {
        val uri = runCatching { URI(loopback) }.getOrNull() ?: return null
        val path = uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
        return "https://$PREVIEW_HOST$path" + (uri.rawQuery?.let { "?$it" } ?: "") + (uri.rawFragment?.let { "#$it" } ?: "")
    }

    /** The loopback URL a preview request stands for, on the window's [origin]; null for anything else. */
    fun upstream(url: String, origin: String): String? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != "https" || uri.host?.lowercase() != PREVIEW_HOST || uri.port >= 0) return null
        val o = runCatching { URI(origin) }.getOrNull() ?: return null
        val host = o.host ?: return null
        val path = uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
        return "${o.scheme?.lowercase() ?: "http"}://$host${if (o.port >= 0) ":${o.port}" else ""}$path" + (uri.rawQuery?.let { "?$it" } ?: "")
    }

    /** Whether the web view may load [url]: only its own hosts, `about:` and inline data. */
    fun isAllowed(url: String): Boolean {
        val lower = url.lowercase()
        if (lower.startsWith("about:") || lower.startsWith("data:") || lower.startsWith("blob:")) return true
        val uri = runCatching { URI(url) }.getOrNull() ?: return false
        return uri.scheme?.lowercase() == "https" && uri.port < 0 && uri.host?.lowercase() in setOf(ARTIFACT_HOST, PREVIEW_HOST)
    }

    fun mime(path: String): String = when (path.substringAfterLast('/').substringAfterLast('.', "").lowercase()) {
        "html", "htm" -> "text/html"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "md", "markdown" -> "text/markdown"
        "txt" -> "text/plain"
        "json", "map" -> "application/json"
        "csv" -> "text/csv"
        "pdf" -> "application/pdf"
        "css" -> "text/css"
        "js", "mjs", "cjs" -> "text/javascript"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "ttf" -> "font/ttf"
        "otf" -> "font/otf"
        "ico" -> "image/x-icon"
        "avif" -> "image/avif"
        "mp4" -> "video/mp4"
        "webm" -> "video/webm"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "wasm" -> "application/wasm"
        "xml" -> "application/xml"
        else -> "application/octet-stream"
    }

    /** `text/html; charset=utf-8` → (`text/html`, `utf-8`). */
    fun splitContentType(s: String): Pair<String, String?> {
        val parts = s.split(';').map { it.trim() }
        val mime = parts.first().lowercase()
        val charset = parts.drop(1).firstOrNull { it.lowercase().startsWith("charset=") }?.substring("charset=".length)?.trim('"', '\'')
        return (mime.ifEmpty { "application/octet-stream" }) to charset
    }
}

/**
 * The preview calls' errors said plainly. The computer's start with a code
 * (`not-linked: this file was not linked in this chat`); its gate's refusals
 * read `Not allowed from a paired phone (<code>): <detail>`.
 */
object PreviewError {
    fun plain(message: String, loopback: Boolean): String {
        PhoneRefusal.parse(message)?.let { r ->
            return when (r.code) {
                "channel-denied" -> "Your computer can’t open previews for a phone yet. Update Nekko on it."
                "value-invalid", "option-denied" ->
                    if (loopback) "Your computer won’t open this address for a phone." else "Your computer won’t open this file for a phone."
                else -> message
            }
        }
        val colon = message.indexOf(": ")
        if (colon < 0) return message
        val rest = message.substring(colon + 2)
        return when (message.substring(0, colon)) {
            "not-linked" -> if (loopback) "This preview wasn’t linked in this chat." else "This file wasn’t linked in this chat."
            "unreachable" -> "The preview server on your computer isn’t running."
            "timeout" -> "The preview server on your computer didn’t answer."
            "secret-file" -> "This file may hold secrets, so it never leaves your computer."
            "not-a-file" -> "That’s a folder, not a file."
            "not-found" -> if ("chat" in rest) "This chat is no longer on your computer." else "This file is no longer on your computer."
            "too-large" -> "Too large to open on a phone."
            "bad-request" -> if (loopback) "Your computer can’t open this address." else "Your computer can’t open this file."
            else -> message
        }
    }
}
