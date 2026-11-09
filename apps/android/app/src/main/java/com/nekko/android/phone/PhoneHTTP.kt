package com.nekko.android.phone

import com.nekko.protocol.PhoneRequest
import com.nekko.protocol.PhoneProviders
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
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
        require(request.url.startsWith("https://")) { "Phone providers require HTTPS." }
        val builder = Request.Builder().url(request.url)
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
                            while (cont.isActive && !source.exhausted()) {
                                val text = source.readUtf8LineStrict(1_000_000)
                                if (!line(text)) break
                            }
                            line("")
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
