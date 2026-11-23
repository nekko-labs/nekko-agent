package com.nekko.protocol

import java.net.Socket
import java.util.Base64
import kotlin.concurrent.thread
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Sign in with ChatGPT on the phone (#3244, option B). */
class ChatGptSignInTest {
    private fun b64(s: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray())
    private fun jwt(claims: String) = "${b64("{\"alg\":\"none\"}")}.${b64(claims)}.sig"
    private val idToken = jwt("""{"email":"a@b.c","https://api.openai.com/auth":{"chatgpt_account_id":"acct-123"}}""")
    private val access = jwt("""{"exp":1800000000}""")
    private val tokens = ChatGptSignIn.Tokens(access, "refresh-1", 1_800_000_000_000, "acct-123")
    private val provider = PhoneProviders.make("p", "chatgpt", "ChatGPT", null, tokens.encode())

    @Test fun authorizeUrlMatchesTheDesktops() {
        val url = ChatGptSignIn.authorizeUrl("chal", "st")
        assertTrue(url.startsWith("https://auth.openai.com/oauth/authorize?"))
        val q = url.substringAfter('?').split('&').associate { it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        assertEquals(mapOf(
            "response_type" to "code", "client_id" to "app_EMoamEEZ73f0CkXaXp7hrann",
            "redirect_uri" to "http://localhost:1455/auth/callback", "scope" to "openid profile email offline_access",
            "code_challenge" to "chal", "code_challenge_method" to "S256", "state" to "st",
        ), q)
        assertFalse("spaces are %20, not +", url.contains('+'))
    }

    @Test fun readsOnlyItsOwnCallback() {
        assertEquals(ChatGptSignIn.Callback.Code("c-1"), ChatGptSignIn.callback("GET /auth/callback?code=c-1&state=st HTTP/1.1", "st"))
        assertEquals(ChatGptSignIn.Callback.Refused("access_denied"), ChatGptSignIn.callback("GET /auth/callback?error=access_denied&state=st HTTP/1.1", "st"))
        for (line in listOf(
            "GET /auth/callback?code=c-1&state=other HTTP/1.1", // forged or stale state
            "GET /auth/callback?code=c-1 HTTP/1.1",
            "GET /favicon.ico HTTP/1.1",
            "POST /auth/callback?code=c-1&state=st HTTP/1.1",
            "GET /auth/callback?state=st HTTP/1.1",
            "",
        )) assertEquals(line, ChatGptSignIn.Callback.Ignored, ChatGptSignIn.callback(line, "st"))
        assertEquals(ChatGptSignIn.Callback.Ignored, ChatGptSignIn.callback("GET /auth/callback?code=c&state= HTTP/1.1", ""))
    }

    @Test fun theCallbackPageSendsTheBrowserBackToTheApp() {
        val page = ChatGptSignIn.callbackPage(true)
        assertTrue(page.startsWith("HTTP/1.1 200 OK\r\n"))
        assertTrue(page.contains("nekko-agent://chatgpt-signed-in"))
        val body = page.substringAfter("\r\n\r\n")
        assertEquals(body.toByteArray().size, Regex("Content-Length: (\\d+)").find(page)!!.groupValues[1].toInt())
    }

    @Test fun tokenAndRefreshRequestsAreFormEncoded() {
        val t = ChatGptSignIn.tokenRequest("c 1", "ver")
        assertEquals("https://auth.openai.com/oauth/token", t.url)
        assertEquals("application/x-www-form-urlencoded", t.headers["Content-Type"])
        assertNull(t.body)
        assertEquals("grant_type=authorization_code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code=c%201&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_verifier=ver", t.form)
        assertEquals("grant_type=refresh_token&client_id=app_EMoamEEZ73f0CkXaXp7hrann&refresh_token=refresh-1", ChatGptSignIn.refreshRequest(tokens)!!.form)
        assertNull(ChatGptSignIn.refreshRequest(tokens.copy(refresh = null)))
    }

    @Test fun readsTheAccountAndExpiryFromTheTokens() {
        val got = ChatGptSignIn.tokens("""{"access_token":"$access","refresh_token":"r","id_token":"$idToken","expires_in":10}""", now = 0)!!
        assertEquals(ChatGptSignIn.Tokens(access, "r", 1_800_000_000_000, "acct-123"), got)
        // A refresh may leave out the id and refresh tokens: the old ones are kept.
        val plain = "plain-token"
        val renewed = ChatGptSignIn.tokens("""{"access_token":"$plain","expires_in":60}""", now = 1_000, previous = tokens)!!
        assertEquals(ChatGptSignIn.Tokens(plain, "refresh-1", 61_000, "acct-123"), renewed)
        // No account anywhere: unusable.
        assertNull(ChatGptSignIn.tokens("""{"access_token":"$plain"}""", now = 0))
        assertNull(ChatGptSignIn.tokens("""{"error":"invalid_grant"}""", now = 0))
        assertNull(ChatGptSignIn.tokens("not json", now = 0))
    }

    @Test fun tokensRoundTripAsTheKeyAndSayWhenToRefresh() {
        assertEquals(tokens, ChatGptSignIn.Tokens.decode(tokens.encode()))
        assertNull(ChatGptSignIn.Tokens.decode("sk-an-api-key"))
        assertNull(ChatGptSignIn.Tokens.decode(null))
        assertFalse(tokens.needsRefresh(tokens.expiresAt - 10 * 60_000))
        assertTrue(tokens.needsRefresh(tokens.expiresAt - 60_000))
    }

    @Test fun aChatGptProviderNeedsASignInAndKeepsItsAddress() {
        assertEquals("https://chatgpt.com/backend-api", provider.baseUrl)
        for (bad in listOf<() -> Unit>(
            { PhoneProviders.make("p", "chatgpt", "ChatGPT", null, "sk-key") },
            { PhoneProviders.make("p", "chatgpt", "ChatGPT", null, null) },
            { PhoneProviders.make("p", "chatgpt", "ChatGPT", "https://evil.example.com", tokens.encode()) },
        )) try { bad(); fail("accepted") } catch (_: IllegalArgumentException) {}
    }

    @Test fun chatsGoToTheResponsesApiInTheCodexShape() {
        val req = PhoneProviders.chatRequest(provider, tokens.encode(), "gpt-5.5", listOf(
            PhoneMessage("1", "user", "Hi", 1, images = listOf("data:image/png;base64,AAAA")),
            PhoneMessage("2", "assistant", "Hello", 2),
            PhoneMessage("3", "user", "More", 3),
        ), system = "Be brief.")
        assertEquals("https://chatgpt.com/backend-api/codex/responses", req.url)
        assertEquals("Bearer $access", req.headers["Authorization"])
        assertEquals("acct-123", req.headers["chatgpt-account-id"])
        assertEquals("responses=experimental", req.headers["OpenAI-Beta"])
        assertEquals("codex_cli_rs", req.headers["originator"])
        assertEquals("text/event-stream", req.headers["Accept"])
        val b = req.body!!
        assertEquals("Be brief.", b["instructions"]!!.jsonPrimitive.content)
        assertEquals(false, b["store"]!!.jsonPrimitive.boolean)
        assertEquals(true, b["stream"]!!.jsonPrimitive.boolean)
        // The Codex backend fails the whole request on a token cap or temperature.
        assertFalse(b.containsKey("max_tokens") || b.containsKey("max_output_tokens") || b.containsKey("temperature") || b.containsKey("messages"))
        assertEquals(Json.parseToJsonElement("""[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"Hi"},{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"More"}]}
        ]"""), b["input"])
    }

    @Test fun theModelListIsThePlansOwn() {
        val req = PhoneProviders.modelsRequest(provider, tokens.encode())!!
        assertEquals("https://chatgpt.com/backend-api/codex/models?client_version=0.171.0", req.url)
        assertEquals("GET", req.method)
        assertEquals("acct-123", req.headers["chatgpt-account-id"])
        val models = PhoneProviders.models("""{"models":[
            {"slug":"gpt-5.5-mini","display_name":"GPT-5.5 mini","priority":5},
            {"slug":"gpt-5.5","display_name":"GPT-5.5","priority":1},
            {"slug":"hidden","visibility":"hide"},
            {"slug":"unpicked","show_in_picker":false},
            {"id":"no-name"}
        ]}""", "chatgpt")
        assertEquals(listOf("gpt-5.5", "gpt-5.5-mini", "no-name"), models.map { it.id })
        assertEquals("GPT-5.5", models.first().name)
        assertNull("no key check: the model list already needs the sign-in", PhoneProviders.keyCheckRequest(provider, tokens.encode()))
    }

    @Test fun readsTheResponsesStream() {
        val p = PhoneStreamParser()
        fun frame(event: String, json: String): List<PhoneStreamEvent> { p.line("event: $event"); p.line("data: $json"); return p.line("") }
        assertEquals(emptyList<PhoneStreamEvent>(), frame("response.created", """{"type":"response.created","response":{"id":"r","error":null}}"""))
        assertEquals(listOf(PhoneStreamEvent.Text("Hel")), frame("response.output_text.delta", """{"type":"response.output_text.delta","delta":"Hel"}"""))
        assertEquals(listOf(PhoneStreamEvent.Text("lo")), frame("response.output_text.delta", """{"type":"response.output_text.delta","delta":"lo"}"""))
        assertEquals(emptyList<PhoneStreamEvent>(), frame("response.reasoning_summary_text.delta", """{"type":"response.reasoning_summary_text.delta","delta":"thinking"}"""))
        assertEquals(listOf(PhoneStreamEvent.Usage(12, 3), PhoneStreamEvent.Done), frame("response.completed", """{"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}"""))
        assertEquals("nothing after completion", emptyList<PhoneStreamEvent>(), frame("response.output_text.delta", """{"type":"response.output_text.delta","delta":"x"}"""))

        val failed = PhoneStreamParser()
        failed.line("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"secret detail\"}}}")
        val out = failed.line("")
        assertTrue(out.single() is PhoneStreamEvent.Failure)
        assertFalse("the provider's own text is never shown", (out.single() as PhoneStreamEvent.Failure).message.contains("secret"))
    }

    @Test fun explainsAnExpiredSignInAndThePlanLimit() {
        assertEquals(ChatGptSignIn.EXPIRED, PhoneProviders.failure(401, kind = "chatgpt"))
        assertEquals("You’ve reached your ChatGPT plan’s limit. Try again in 2 min.", PhoneProviders.failure(429, headers = mapOf("retry-after" to "120"), kind = "chatgpt"))
    }

    @Test fun theListenerTakesOnlyItsCallbackOnLoopback() {
        val server = ChatGptSignIn.CallbackServer.open(0)
        val port = server.port
        var got: ChatGptSignIn.Callback? = null
        val t = thread { got = server.await("st", timeoutMs = 10_000) }
        fun get(path: String): String = Socket("127.0.0.1", port).use { s ->
            s.getOutputStream().write("GET $path HTTP/1.1\r\nHost: localhost\r\n\r\n".toByteArray())
            s.getInputStream().readBytes().toString(Charsets.UTF_8)
        }
        assertTrue(get("/favicon.ico").startsWith("HTTP/1.1 404"))
        assertTrue(get("/auth/callback?code=c&state=forged").startsWith("HTTP/1.1 404"))
        val page = get("/auth/callback?code=the-code&state=st")
        assertTrue(page.contains("nekko-agent://chatgpt-signed-in"))
        t.join(5_000)
        assertEquals(ChatGptSignIn.Callback.Code("the-code"), got)
        // Closed after the answer.
        try { Socket("127.0.0.1", port).close(); fail("still listening") } catch (_: java.io.IOException) {}
    }

    @Test fun theListenerGivesUpAfterItsTimeAndSaysWhenThePortIsTaken() {
        val server = ChatGptSignIn.CallbackServer.open(0)
        assertNull(server.await("st", timeoutMs = 200))
        val held = java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())
        try {
            ChatGptSignIn.CallbackServer.open(held.localPort)
            fail("opened a taken port")
        } catch (e: java.io.IOException) {
            assertEquals(ChatGptSignIn.PORT_BUSY, e.message)
        } finally { held.close() }
    }
}
