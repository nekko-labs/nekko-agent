package com.nekko.android.feedback

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Settings → Send feedback: the prompt to copy for an agent, the quick note's
 * request to Nekko Cloud, and the GitHub link. Same contract as the desktop and
 * iPhone apps (#1004).
 *
 * Pure so it is tested on the JVM; FeedbackSheet feeds it the app's version and
 * the phone's OS and CPU type. Nothing else about the phone or the person is
 * ever sent.
 */
object Feedback {
    const val ENDPOINT = "https://nekko-agent-api.fly.dev/v1/feedback"
    const val REPO_URL = "https://github.com/nekko-labs/nekko-agent"
    const val NEW_ISSUE_URL = "$REPO_URL/issues/new/choose"

    /** The quick note's limit; the server refuses longer ones. */
    const val MAX_CHARS = 4000

    /** The counter shows from here on, so it only appears when it matters. */
    const val COUNTER_FROM = 3600

    /** What "Include app info" adds. Every field is optional; unknown ones are left out. */
    data class AppInfo(
        val version: String?,
        val osVersion: String?,
        val arch: String?,
        val app: String = "android",
        val os: String = "Android",
    ) {
        /** Only the characters and lengths the server accepts, so the note is never refused for them. */
        fun sanitized() = AppInfo(
            version = clean(version, 32),
            osVersion = clean(osVersion, 32),
            arch = clean(arch, 16),
            app = clean(app, 32) ?: "android",
            os = clean(os, 32) ?: "Android",
        )
    }

    /** The prompt "Copy for an agent" puts on the clipboard. */
    fun agentPrompt(info: AppInfo): String = """
        |I want to send feedback about Nekko Agent to the team that makes it (Nekko Labs). Please help me file it as a GitHub issue on $REPO_URL.
        |
        |1. Ask me what happened and what I expected (for a bug, the steps to reproduce it), or what I'd like it to do (for an idea).
        |2. Search the existing issues first, and if one already covers it, show me so I can add to it instead.
        |3. Draft a short title and description and show them to me. File the issue only after I approve, for example with `gh issue create --repo nekko-labs/nekko-agent`, or give me the text to paste into $NEW_ISSUE_URL.
        |4. Leave out anything personal: names, email addresses, file paths, keys and tokens, and chat contents.
        |
        |${appLine(info)}
    """.trimMargin()

    /** "App: Nekko Agent 0.1.0 (android, Android 15, arm64-v8a)", leaving out what isn't known. */
    fun appLine(info: AppInfo): String {
        val i = info.sanitized()
        val os = listOfNotNull(i.os, i.osVersion).joinToString(" ")
        val parts = listOf(i.app, os, i.arch.orEmpty()).filter { it.isNotEmpty() }
        val name = listOfNotNull("Nekko Agent", i.version).joinToString(" ")
        return "App: $name" + if (parts.isEmpty()) "" else " (${parts.joinToString(", ")})"
    }

    /** The note to send, trimmed and capped, or null when there is nothing to send. */
    fun message(text: String): String? = text.trim().take(MAX_CHARS).ifEmpty { null }

    /** "3812 / 4000" once the note is near the limit, else null. */
    fun counter(length: Int): String? = if (length < COUNTER_FROM) null else "$length / $MAX_CHARS"

    /** The request body; the `app` key is there only when the person turned "Include app info" on. */
    fun body(message: String, info: AppInfo?): String = buildJsonObject {
        put("message", message)
        if (info != null) {
            val i = info.sanitized()
            put("app", buildJsonObject {
                put("app", i.app)
                i.version?.let { put("version", it) }
                put("os", i.os)
                i.osVersion?.let { put("osVersion", it) }
                i.arch?.let { put("arch", it) }
            })
        }
    }.toString()

    sealed interface Outcome {
        data object Sent : Outcome
        data class Failed(val message: String) : Outcome
    }

    /** What the server's answer means for the person: 202 is the only success. */
    fun outcome(status: Int): Outcome = when (status) {
        202 -> Outcome.Sent
        429 -> Outcome.Failed("Too many notes. Try again later.")
        400 -> Outcome.Failed("Nekko Cloud couldn’t accept this note. Try shortening it.")
        else -> Outcome.Failed("Couldn’t send the note. Try again in a moment.")
    }

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
    }

    /** POSTs [body] off the main thread. Never throws: no network is a [Outcome.Failed] too. */
    suspend fun send(body: String, url: String = ENDPOINT, http: OkHttpClient = client): Outcome =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(url)
                .post(body.toRequestBody("application/json".toMediaType()))
                .build()
            try {
                http.newCall(request).execute().use { outcome(it.code) }
            } catch (_: IOException) {
                Outcome.Failed("Couldn’t reach Nekko Cloud. Check your connection and try again.")
            }
        }

    private val UNSAFE = Regex("[^A-Za-z0-9 ._+-]")

    private fun clean(s: String?, max: Int): String? =
        s?.replace(UNSAFE, "")?.trim()?.take(max)?.trim()?.ifEmpty { null }
}
