package com.nekko.protocol

import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/**
 * Sign in with ChatGPT on the phone itself (#3244, option B): the same public
 * PKCE sign-in the Codex CLI and the desktop use, so a Plus, Pro or Business
 * plan runs this phone's chats with no API key and no computer.
 *
 * OpenAI's client only accepts `http://localhost:1455/auth/callback`, so while
 * the sign-in page is open the app listens on this phone's loopback address,
 * port 1455 ([CallbackServer]). The browser lands there with the code; the app
 * swaps it for tokens and the page sends the browser back to the app.
 *
 * The phone holds its own refresh token, apart from any computer's: OpenAI
 * replaces a refresh token each time it is used, so two installs must never
 * share one. The tokens are kept as this provider's key ([Tokens.encode]),
 * sealed like every other key, and never leave the phone.
 */
object ChatGptSignIn {
    const val CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
    const val AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
    const val TOKEN_URL = "https://auth.openai.com/oauth/token"
    const val SCOPES = "openid profile email offline_access"
    const val PORT = 1455
    const val CALLBACK_PATH = "/auth/callback"
    const val REDIRECT_URI = "http://localhost:$PORT$CALLBACK_PATH"
    /** Where the browser goes once the code is in hand: back to the app, which closes the page. */
    const val RETURN_URL = "nekko-agent://chatgpt-signed-in"
    /** How long the sign-in page may take before the listener gives up. */
    const val WAIT_MS = 10 * 60 * 1000
    /** Refresh this long before the access token runs out. */
    const val REFRESH_MARGIN_MS = 5 * 60 * 1000L
    const val SIGN_IN_FAILED = "ChatGPT didn’t finish signing in. Try again."
    const val PORT_BUSY = "Another app is using the port ChatGPT’s sign-in comes back to (1455). Close it and try again."
    const val EXPIRED = "Your ChatGPT sign-in has expired. Sign in again."

    /** What a signed-in ChatGPT provider keeps as its key. Times are milliseconds since 1970. */
    @Serializable
    data class Tokens(val access: String, val refresh: String? = null, val expiresAt: Long, val accountId: String) {
        fun encode(): String = Json.encodeToString(serializer(), this)
        fun needsRefresh(now: Long) = expiresAt - now < REFRESH_MARGIN_MS
        companion object {
            /** The key as tokens, or null when it isn't a ChatGPT sign-in. */
            fun decode(key: String?): Tokens? {
                if (key.isNullOrBlank() || key.length > 64_000) return null
                return runCatching { Json.decodeFromString(serializer(), key) }.getOrNull()
                    ?.takeIf { it.access.isNotEmpty() && it.accountId.isNotEmpty() && it.access.all { c -> c.code in 33..126 } && it.accountId.all { c -> c.code in 33..126 } }
            }
        }
    }

    /** A sign-in's `state`, checked when the browser comes back. */
    fun state(random: java.security.SecureRandom = java.security.SecureRandom()): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(24).also(random::nextBytes))

    private fun enc(v: String) = URLEncoder.encode(v, "UTF-8").replace("+", "%20")

    /** The sign-in page, with the same parameters as the desktop's. */
    fun authorizeUrl(challenge: String, state: String): String = AUTHORIZE_URL + "?" + listOf(
        "response_type" to "code",
        "client_id" to CLIENT_ID,
        "redirect_uri" to REDIRECT_URI,
        "scope" to SCOPES,
        "code_challenge" to challenge,
        "code_challenge_method" to "S256",
        "state" to state,
    ).joinToString("&") { (k, v) -> "$k=${enc(v)}" }

    /** What came back to the listener. */
    sealed interface Callback {
        data class Code(val code: String) : Callback
        /** The person declined, or OpenAI refused (its `error`, which is never shown as is). */
        data class Refused(val error: String) : Callback
        /** Not the sign-in's answer: another path, or a stale or forged `state`. */
        data object Ignored : Callback
    }

    /** Reads the request line the browser sent (`GET /auth/callback?code=…&state=… HTTP/1.1`). */
    fun callback(requestLine: String, expectedState: String): Callback {
        val parts = requestLine.trim().split(' ')
        if (parts.size < 2 || parts[0] != "GET" || requestLine.length > 8192) return Callback.Ignored
        val target = parts[1]
        if (target.substringBefore('?') != CALLBACK_PATH) return Callback.Ignored
        val query = target.substringAfter('?', "").split('&').filter { it.isNotEmpty() }.associate { part ->
            val (k, v) = part.split('=', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            k to (runCatching { URLDecoder.decode(v, "UTF-8") }.getOrNull() ?: "")
        }
        if (query["state"] != expectedState || expectedState.isEmpty()) return Callback.Ignored
        query["error"]?.takeIf { it.isNotEmpty() }?.let { return Callback.Refused(it.take(64)) }
        val code = query["code"]?.takeIf { it.isNotEmpty() && it.length <= 4096 && it.all { c -> c.code in 33..126 } } ?: return Callback.Ignored
        return Callback.Code(code)
    }

    /** The page the browser shows after the callback; it sends the browser back to the app. */
    fun callbackPage(ok: Boolean): String {
        val title = if (ok) "Signed in to ChatGPT" else "ChatGPT sign-in didn’t finish"
        val body = if (ok) "You can go back to Nekko Agent." else "Go back to Nekko Agent and try again."
        val html = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">" +
            "<title>$title</title></head><body style=\"font-family:-apple-system,system-ui,sans-serif;padding:32px\">" +
            "<h1 style=\"font-size:20px\">$title</h1><p>$body</p><p><a href=\"$RETURN_URL\">Back to Nekko Agent</a></p>" +
            "<script>location.replace(\"$RETURN_URL\")</script></body></html>"
        val bytes = html.toByteArray(Charsets.UTF_8)
        return "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n$html"
    }

    private val formHeaders = mapOf("Content-Type" to "application/x-www-form-urlencoded", "Accept" to "application/json")
    private fun form(vararg pairs: Pair<String, String>) = pairs.joinToString("&") { (k, v) -> "$k=${enc(v)}" }

    fun tokenRequest(code: String, verifier: String) = PhoneRequest(TOKEN_URL, formHeaders, form = form(
        "grant_type" to "authorization_code", "client_id" to CLIENT_ID, "code" to code,
        "redirect_uri" to REDIRECT_URI, "code_verifier" to verifier,
    ))

    fun refreshRequest(t: Tokens): PhoneRequest? {
        val refresh = t.refresh?.takeIf { it.isNotEmpty() } ?: return null
        return PhoneRequest(TOKEN_URL, formHeaders, form = form("grant_type" to "refresh_token", "client_id" to CLIENT_ID, "refresh_token" to refresh))
    }

    /**
     * The token endpoint's answer as tokens. The account id comes from the id token's
     * `https://api.openai.com/auth.chatgpt_account_id` claim (else the previous sign-in's);
     * the expiry from the access token's `exp` (else `expires_in`). Null when it is unusable.
     */
    fun tokens(body: String, now: Long, previous: Tokens? = null): Tokens? {
        if (body.length > 200_000) return null
        val o = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return null
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        val access = str("access_token")?.takeIf { a -> a.all { it.code in 33..126 } } ?: return null
        val account = str("id_token")?.let(::accountId) ?: accountId(access) ?: previous?.accountId ?: return null
        val expiresIn = (o["expires_in"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        val expiresAt = jwtClaims(access)?.let { (it["exp"] as? JsonPrimitive)?.longOrNull }?.let { it * 1000 }
            ?: now + (expiresIn ?: 3600) * 1000
        return Tokens(access, str("refresh_token") ?: previous?.refresh, expiresAt, account)
    }

    /** A JWT's claims, unverified: only read for what this phone itself was just given. */
    fun jwtClaims(jwt: String): JsonObject? {
        val part = jwt.split('.').getOrNull(1) ?: return null
        val bytes = runCatching { Base64.getUrlDecoder().decode(part.trimEnd('=')) }.getOrNull() ?: return null
        return runCatching { Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)) as? JsonObject }.getOrNull()
    }

    fun accountId(jwt: String): String? =
        ((jwtClaims(jwt)?.get("https://api.openai.com/auth") as? JsonObject)?.get("chatgpt_account_id") as? JsonPrimitive)
            ?.takeIf { it.isString }?.content?.takeIf { id -> id.isNotEmpty() && id.length <= 128 && id.all { it.code in 33..126 } }

    /**
     * Listens on this phone's loopback address, port 1455, for the browser's one
     * callback. Only loopback: nothing on the network can reach it. Answers anything
     * else with 404 and keeps waiting; closes after the answer, a timeout or [close].
     */
    class CallbackServer private constructor(private val socket: ServerSocket) : AutoCloseable {
        companion object {
            /** Fails with [PORT_BUSY] when something else holds the port. */
            fun open(port: Int = PORT): CallbackServer = try {
                CallbackServer(ServerSocket(port, 4, InetAddress.getLoopbackAddress()).apply { reuseAddress = true })
            } catch (_: IOException) {
                throw IOException(PORT_BUSY)
            }
        }

        val port: Int get() = socket.localPort

        /** Blocks until the sign-in comes back, then answers the browser. Null on timeout or close. */
        fun await(expectedState: String, timeoutMs: Int = WAIT_MS): Callback? {
            val deadline = System.currentTimeMillis() + timeoutMs
            try {
                while (!socket.isClosed) {
                    val left = deadline - System.currentTimeMillis()
                    if (left <= 0) return null
                    socket.soTimeout = left.toInt().coerceAtLeast(1)
                    val client = try { socket.accept() } catch (_: SocketTimeoutException) { return null }
                    client.use { c ->
                        c.soTimeout = 5_000
                        val line = runCatching {
                            c.getInputStream().bufferedReader(Charsets.ISO_8859_1).readLine()
                        }.getOrNull().orEmpty()
                        val result = callback(line, expectedState)
                        val out = c.getOutputStream()
                        if (result == Callback.Ignored) {
                            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                        } else {
                            out.write(callbackPage(result is Callback.Code).toByteArray(Charsets.UTF_8))
                        }
                        out.flush()
                        if (result != Callback.Ignored) return result
                    }
                }
            } catch (_: IOException) {
                // Closed while waiting.
            } finally {
                close()
            }
            return null
        }

        override fun close() = runCatching { socket.close() }.let { }
    }
}
