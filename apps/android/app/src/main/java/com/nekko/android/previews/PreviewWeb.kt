package com.nekko.android.previews

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.core.graphics.createBitmap
import androidx.core.net.toUri
import com.nekko.protocol.ChatLinkTarget
import com.nekko.protocol.ChatLinks
import com.nekko.protocol.ChatPreviewLink
import com.nekko.protocol.PreviewUrls
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayInputStream

// The isolated web view behind the preview window and the live thumbnails
// (AN-35, the iPhone's `PreviewWeb.swift`). What it shows is code the agent
// wrote, so it gets nothing of the app: no JavaScript bridge, no file or
// content access, no cookies, no new windows, and no network. Every request
// is answered here (`shouldInterceptRequest`), from the computer over the
// relay, on two `https` hosts under `.invalid` that never resolve; anything
// else gets an empty 403, every answer carries a Content-Security-Policy that
// keeps the page's own connections on those hosts, and navigation off them
// is cancelled (a tapped web link opens in the browser instead).

/** What a chat gives the replies in it: where a tapped file or page opens, and the reads behind cards. */
class ChatPreviews(val sessionId: String, val loader: PreviewLoader, val open: (ChatPreviewLink) -> Unit)

/** Set by the chat screen around its messages; null elsewhere, where links to files stay text. */
val LocalChatPreviews = staticCompositionLocalOf<ChatPreviews?> { null }

/** A preview open over a chat; kept in the repository by chat id so folding the phone keeps it open. */
class PreviewOverlay(val link: ChatPreviewLink)

/** What a preview web view loads, and where it reads it from. */
class PreviewSource(
    val sessionId: String,
    val loader: PreviewLoader,
    /** The page on the app's hosts. */
    val url: String,
    /** A loopback page's link: the scheme, host and port its requests go to. */
    val origin: String?,
)

sealed interface PreviewWebState {
    data object Loading : PreviewWebState
    data class Loaded(val web: WebView) : PreviewWebState
    data class Failed(val message: String) : PreviewWebState
}

object PreviewWeb {
    /** How long one request may wait for the computer before the page gets an error. */
    private const val REQUEST_MS = 30_000L

    /** A web view that shows [source] and nothing else. */
    @SuppressLint("SetJavaScriptEnabled")
    fun create(context: Context, source: PreviewSource, interactive: Boolean, onState: (PreviewWebState) -> Unit): WebView {
        val web = WebView(context)
        web.settings.apply {
            // Prototypes are interactive; nothing from the app is exposed to their scripts.
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
            builtInZoomControls = interactive
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        CookieManager.getInstance().setAcceptCookie(false)
        web.isLongClickable = interactive
        if (!interactive) {
            web.isFocusable = false
            web.isVerticalScrollBarEnabled = false
            web.importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        web.webViewClient = Client(source, interactive, onState)
        web.loadUrl(source.url)
        return web
    }

    /** Stop and forget everything a page stored (its local storage lives per host, shared across chats). */
    fun dispose(web: WebView) {
        web.stopLoading()
        web.loadUrl("about:blank")
        web.destroy()
        WebStorage.getInstance().deleteAllData()
    }

    /** A picture of what [web] shows now, or null when it isn't laid out. */
    fun snapshot(web: WebView): Bitmap? {
        if (web.width <= 0 || web.height <= 0) return null
        val b = createBitmap(web.width, web.height)
        web.draw(android.graphics.Canvas(b))
        return b
    }

    private class Client(val source: PreviewSource, val interactive: Boolean, val onState: (PreviewWebState) -> Unit) : WebViewClient() {
        private val main = Handler(Looper.getMainLooper())
        private val loopback = source.origin != null

        private fun post(state: PreviewWebState) = main.post { onState(state) }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val url = request.url.toString()
            val method = request.method.uppercase()
            if (method != "GET" && method != "HEAD") return refused(405)
            return try {
                val body = runBlocking {
                    withTimeout(REQUEST_MS) {
                        PreviewUrls.artifactPath(url)?.let { return@withTimeout source.loader.artifact(source.sessionId, it) }
                        val origin = source.origin
                        val upstream = if (origin != null) PreviewUrls.upstream(url, origin) else null
                        if (upstream != null) source.loader.fetch(source.sessionId, upstream) else null
                    }
                } ?: return refused(403)
                val headers = mapOf(
                    "Content-Security-Policy" to PreviewUrls.CONTENT_SECURITY_POLICY,
                    "Cache-Control" to "no-store",
                    "X-Content-Type-Options" to "nosniff",
                )
                WebResourceResponse(body.mime, body.charset, statusOf(body.status), reasonOf(body.status), headers, ByteArrayInputStream(body.data))
            } catch (e: CancellationException) {
                failed(request, "Your computer didn’t answer in time.")
            } catch (e: Exception) {
                failed(request, PreviewLoader.message(e, loopback))
            }
        }

        private fun failed(request: WebResourceRequest, message: String): WebResourceResponse {
            if (request.isForMainFrame) post(PreviewWebState.Failed(message))
            return WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
        }

        private fun refused(status: Int) =
            WebResourceResponse("text/plain", "utf-8", status, if (status == 405) "Method Not Allowed" else "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

        // WebResourceResponse refuses 3xx (the loader already turns them into errors) and odd codes.
        private fun statusOf(s: Int) = if (s in 100..299 || s in 400..599) s else 200
        private fun reasonOf(s: Int) = if (s in 200..299 || s !in 100..599) "OK" else "Status $s"

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (PreviewUrls.isAllowed(url)) return false
            // Off the app's hosts: only a link the user tapped leaves, and only to the browser or mail.
            if (interactive && request.hasGesture() && ChatLinks.classify(url) is ChatLinkTarget.Web) {
                try {
                    view.context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE))
                } catch (_: ActivityNotFoundException) {
                }
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = onState(PreviewWebState.Loading)

        override fun onPageFinished(view: WebView, url: String?) = onState(PreviewWebState.Loaded(view))

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail?): Boolean {
            // A gone renderer leaves the view unusable: take it out, so the app keeps running.
            (view.parent as? android.view.ViewGroup)?.removeView(view)
            view.destroy()
            onState(PreviewWebState.Failed("The preview stopped. Reload to try again."))
            return true
        }
    }
}
