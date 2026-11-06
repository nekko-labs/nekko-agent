package com.nekko.android.mermaid

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.nekko.protocol.MermaidRules
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.ByteArrayInputStream
import java.io.File
import kotlin.coroutines.resume

/**
 * The diagram renderer (MM-4, the iPhone's `MermaidRenderer`): one shared,
 * off-screen WebView running the bundled Mermaid, made on first use. Its page
 * may load only the bundled script (every other request gets an empty 403,
 * and its address is under `.invalid`, which never resolves), its
 * Content-Security-Policy allows no connections, it refuses every navigation,
 * it has no JavaScript bridge, and Mermaid runs with `securityLevel: 'strict'`
 * and `htmlLabels: false`. Diagrams render one at a time; each result is
 * cached in memory and on disk as a picture (keyed by source, theme and
 * width) with its SVG, so scrolling and reopening a chat never draw again.
 * The one WebView it keeps is made from the application's context, never an
 * activity's, so holding it for the app's life leaks no screen.
 */
@SuppressLint("StaticFieldLeak")
object MermaidRenderer {
    class Drawing(val image: Bitmap, val svg: String)

    class Failure(message: String) : Exception(message) {
        companion object {
            val TOO_LARGE = Failure("Too large to draw on the phone")
        }
    }

    private const val ORIGIN = "https://mermaid.nekko.invalid/"
    private const val SCRIPT = "mermaid.min.js"

    private val mutex = Mutex()
    private var web: WebView? = null
    private var count = 0
    private val memory = object : LruCache<String, Drawing>(48 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Drawing) = value.image.allocationByteCount + value.svg.length * 2
    }

    /** Render times in milliseconds, newest last (for the perf log). */
    val timings = mutableListOf<Long>()

    /** The bundled Mermaid's version (vendor/mermaid/pin.json), part of every cache key. */
    fun version(context: Context): String = runCatching {
        val pin = context.assets.open("pin.json").bufferedReader().readText()
        (Json.parseToJsonElement(pin) as JsonObject)["version"].let { (it as JsonPrimitive).content }
    }.getOrDefault("unknown")

    private fun key(context: Context, source: String, dark: Boolean, width: Int, scale: Float) =
        MermaidRules.cacheKey(source, dark, width, version(context)) + "@${(scale * 100).toInt()}"

    private fun folder(context: Context) = File(context.cacheDir, "mermaid").apply { mkdirs() }

    /** A drawing already made, from memory or disk. */
    suspend fun cached(context: Context, source: String, dark: Boolean, width: Int, scale: Float): Drawing? {
        val k = key(context, source, dark, width, scale)
        memory.get(k)?.let { return it }
        return withContext(Dispatchers.IO) {
            val png = File(folder(context), "$k.png")
            val svg = File(folder(context), "$k.svg")
            if (!png.exists() || !svg.exists()) return@withContext null
            val image = BitmapFactory.decodeFile(png.path) ?: return@withContext null
            Drawing(image, svg.readText()).also { memory.put(k, it) }
        }
    }

    /** Draw a diagram, after any already in the queue. Fails with Mermaid's own words, or [Failure.TOO_LARGE]. */
    suspend fun draw(context: Context, source: String, dark: Boolean, width: Int, scale: Float): Drawing {
        if (MermaidRules.decide(source, closed = true) == MermaidRules.Decision.TOO_LARGE) throw Failure.TOO_LARGE
        cached(context, source, dark, width, scale)?.let { return it }
        return mutex.withLock {
            cached(context, source, dark, width, scale) ?: render(context.applicationContext, source, dark, width, scale)
        }
    }

    private suspend fun render(context: Context, source: String, dark: Boolean, width: Int, scale: Float): Drawing {
        val started = System.currentTimeMillis()
        val out = withContext(Dispatchers.Main) {
            val web = webView(context)
            val id = ++count
            web.evaluateJavascript(
                "window.nekkoStart($id, ${JsonPrimitive(source)}, $dark, $width, $scale)",
                null,
            )
            withTimeoutOrNull(MermaidRules.TIMEOUT_MS) {
                while (true) {
                    delay(40)
                    val r = eval(web, "window.nekkoTake($id)")
                    if (r != "null") return@withTimeoutOrNull r
                }
                @Suppress("UNREACHABLE_CODE") null
            }
        }
        if (out == null) {
            // A runaway render keeps the page busy: start a fresh one for the next diagram.
            withContext(Dispatchers.Main) { teardown() }
            throw Failure.TOO_LARGE
        }
        // evaluateJavascript hands back the JSON of the value: a string holding the result's JSON.
        val text = (Json.parseToJsonElement(out) as? JsonPrimitive)?.contentOrNull ?: throw Failure("The diagram couldn’t be drawn: no result")
        val o = Json.parseToJsonElement(text) as? JsonObject ?: throw Failure("The diagram couldn’t be drawn: no result")
        (o["error"] as? JsonPrimitive)?.contentOrNull?.let { throw Failure(it) }
        val png = (o["png"] as? JsonPrimitive)?.contentOrNull ?: throw Failure("The diagram couldn’t be drawn: no image")
        val svg = (o["svg"] as? JsonPrimitive)?.contentOrNull ?: throw Failure("The diagram couldn’t be drawn: no image")
        val bytes = Base64.decode(png.substringAfter(','), Base64.DEFAULT)
        val image = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw Failure("The diagram couldn’t be drawn: no image")
        val drawing = Drawing(image, svg)
        val k = key(context, source, dark, width, scale)
        memory.put(k, drawing)
        withContext(Dispatchers.IO) {
            runCatching {
                File(folder(context), "$k.png").writeBytes(bytes)
                File(folder(context), "$k.svg").writeText(svg)
            }
        }
        synchronized(timings) { timings += System.currentTimeMillis() - started }
        return drawing
    }

    /** For the device test: whether the renderer's page can reach the network (it must not). */
    suspend fun networkProbe(context: Context): String = withContext(Dispatchers.Main) {
        val web = webView(context.applicationContext)
        web.evaluateJavascript(
            "window.nekkoProbe = 'waiting'; fetch('https://example.com/', { cache: 'no-store' })" +
                ".then(() => { window.nekkoProbe = 'reached' }).catch(() => { window.nekkoProbe = 'blocked' })",
            null,
        )
        withTimeoutOrNull(5_000) {
            while (true) {
                delay(50)
                val r = eval(web, "window.nekkoProbe")
                if (r != "\"waiting\"") return@withTimeoutOrNull r.trim('"')
            }
            @Suppress("UNREACHABLE_CODE") ""
        } ?: "no answer"
    }

    private suspend fun eval(web: WebView, js: String): String = suspendCancellableCoroutine { c ->
        web.evaluateJavascript(js) { c.resume(it ?: "null") }
    }

    private fun teardown() {
        web?.destroy()
        web = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private suspend fun webView(context: Context): WebView {
        web?.let { return it }
        val loaded = CompletableDeferred<Unit>()
        val w = WebView(context)
        w.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            domStorageEnabled = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_NO_CACHE
            setGeolocationEnabled(false)
        }
        w.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        w.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                // The page and the bundled script, and nothing else: no fetch, image or font from anywhere.
                when (request.url.toString()) {
                    ORIGIN -> return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(PAGE.toByteArray(Charsets.UTF_8)))
                    ORIGIN + SCRIPT -> return WebResourceResponse("text/javascript", "utf-8", context.assets.open(SCRIPT))
                }
                return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

            override fun onPageFinished(view: WebView, url: String?) {
                loaded.complete(Unit)
            }
        }
        // Laid out off-screen at a desktop-ish size, so Mermaid can measure its text.
        w.measure(View.MeasureSpec.makeMeasureSpec(1024, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(768, View.MeasureSpec.EXACTLY))
        w.layout(0, 0, 1024, 768)
        w.loadUrl(ORIGIN)
        try {
            // "Page finished" can come before the bundled script has run: wait for Mermaid and the bridge themselves.
            withTimeoutOrNull(15_000) {
                loaded.await()
                while (eval(w, "typeof globalThis.mermaid === 'object' && typeof window.nekkoStart === 'function'") != "true") delay(50)
                Unit
            } ?: throw Failure("The diagram couldn’t be drawn: the renderer didn’t start")
        } catch (e: CancellationException) {
            w.destroy()
            throw e
        }
        web = w
        return w
    }

    private const val PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'">
<script src="mermaid.min.js"></script>
<script>
window.nekkoCount = 0;
window.nekkoResults = {};
// Renders with Mermaid, then draws the SVG onto a canvas at the bubble's width and returns both.
window.nekkoRender = async function (source, dark, width, scale) {
  const m = globalThis.mermaid;
  m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default',
    htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 50000, suppressErrorRendering: true,
    fontFamily: 'Roboto, sans-serif' });
  let svg;
  try {
    await m.parse(source);
    svg = (await m.render('nekko' + (++window.nekkoCount), source)).svg;
  } catch (e) {
    const text = String((e && (e.message || e.str)) || e);
    // Mermaid's first line says where ("Parse error on line 3:"), its last what it expected.
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length && !/^-*\^$/.test(l));
    const line = lines.length > 1 ? lines[0] + ' ' + lines[lines.length - 1] : (lines[0] || 'Mermaid couldn’t read this diagram.');
    return { error: line.slice(0, 240) };
  }
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  const vb = (el.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  let w = vb[2], h = vb[3];
  if (!(w > 0 && h > 0)) { w = 800; h = 600; }
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  el.removeAttribute('style');
  const fixed = new XMLSerializer().serializeToString(el);
  // Never wider than the bubble or than drawn, and a tall one no taller than maxHeight (full screen has the rest).
  const maxHeight = 560;
  const drawW = Math.max(1, Math.min(width, w, w * maxHeight / h));
  const drawH = h * drawW / w;
  let s = scale;
  while (drawW * s * drawH * s > 16000000 && s > 0.5) s -= 0.5;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fixed);
  await img.decode();
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(drawW * s));
  c.height = Math.max(1, Math.round(drawH * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { svg: fixed, png: c.toDataURL('image/png') };
};
// evaluateJavascript doesn't wait for a promise: start a render, then ask for its result.
window.nekkoStart = function (id, source, dark, width, scale) {
  window.nekkoRender(source, dark, width, scale)
    .then(r => { window.nekkoResults[id] = JSON.stringify(r); })
    .catch(e => { window.nekkoResults[id] = JSON.stringify({ error: String((e && e.message) || e) }); });
};
window.nekkoTake = function (id) {
  const r = window.nekkoResults[id];
  if (r === undefined) return null;
  delete window.nekkoResults[id];
  return r;
};
</script></head><body></body></html>"""
}
