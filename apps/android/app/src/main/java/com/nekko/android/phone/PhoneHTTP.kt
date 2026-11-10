package com.nekko.android.phone

import com.nekko.protocol.PhoneRequest
import com.nekko.protocol.PhoneProviders
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

interface PhoneHTTP {
    /** A null line callback reads a small JSON body; otherwise reads bounded SSE lines. */
    suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)? = null): String
}

/** No redirects: a provider must never forward a device key to a different origin. */
class DirectPhoneHTTP : PhoneHTTP {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.MINUTES).build()

    override suspend fun send(request: PhoneRequest, line: ((String) -> Boolean)?): String = suspendCancellableCoroutine { cont ->
        val url = request.url.toHttpUrl()
        require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.fragment == null) { "Phone providers require HTTPS without credentials or fragments." }
        val builder = Request.Builder().url(url)
        request.headers.forEach { (k, v) -> builder.header(k, v) }
        builder.method(request.method, request.body?.toString()?.toRequestBody("application/json".toMediaType()))
        val call = client.newCall(builder.build())
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(IOException("Could not reach the provider. Check your connection and address."))
            }
            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use { r ->
                        if (!r.isSuccessful) throw IOException(PhoneProviders.failure(r.code))
                        val source = r.body?.source() ?: throw IOException("The provider returned no body.")
                        if (line == null) {
                            source.request(2_000_001)
                            val bytes = source.buffer.readByteArray()
                            if (bytes.size > 2_000_000) throw IOException("The provider's model list is too large.")
                            if (cont.isActive) cont.resume(bytes.toString(Charsets.UTF_8))
                        } else {
                            val media = r.body?.contentType()
                            if (media?.type != "text" || media.subtype != "event-stream") throw IOException("The provider did not return an event stream.")
                            var remaining = 8_000_000L
                            while (cont.isActive && !source.exhausted()) {
                                // Bound the search by both the line limit and remaining stream budget.
                                val newline = source.indexOf('\n'.code.toByte(), 0, minOf(1_000_002L, remaining + 1))
                                if (newline < 0) throw IOException("The provider sent an incomplete or oversized stream line.")
                                val consumed = newline + 1
                                if (consumed > remaining || newline > 1_000_000L) throw IOException("The provider's stream is too large.")
                                val text = source.readUtf8LineStrict(1_000_000)
                                remaining -= consumed
                                if (!cont.isActive || !line(text)) break
                            }
                            // EOF is not an SSE frame delimiter. Do not fabricate completion.
                            if (cont.isActive) cont.resume("")
                        }
                    }
                } catch (e: Exception) {
                    if (cont.isActive) cont.resumeWithException(IOException(if (e is IOException && e.message?.startsWith("The provider") == true) e.message else "The provider connection ended unexpectedly."))
                }
            }
        })
    }
}
