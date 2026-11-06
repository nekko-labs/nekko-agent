package com.nekko.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.Base64

/**
 * The computer's end of one socket's handshake (`crates/nekko-remote/src/agent.rs`),
 * for the fakes that play the computer: it signs a challenge, takes the phone's
 * half of the exchange and seals everything after that under the connection's key.
 */
class HostEnd(private val room: String, private val roomKey: ByteArray, private val hostKey: HelloSigner) {
    private var nonce = ""
    private var eph = Ephemeral()
    /** Only this connection's two ends can derive it; null until the HELLO, and again on a new challenge. */
    @Volatile var session: ByteArray? = null
        private set
    /** The phone's half of the exchange. */
    @Volatile var clientEph: String? = null
        private set

    /** A fresh challenge signed by [signer], under the room key. It voids the connection's key, as the agent does. */
    fun challenge(nonce: String, signer: HelloSigner = hostKey): String {
        issued(nonce, Ephemeral())
        val sig = signer.sign(HostKey.text(room, nonce, eph.public).toByteArray(Charsets.UTF_8))
        return sealRoom(buildJsonObject {
            put("type", "challenge"); put("challenge", nonce); put("eph", eph.public)
            put("sig", Base64.getEncoder().encodeToString(sig))
        })
    }

    /** The challenge on the wire came from elsewhere (the golden file), with this nonce and ephemeral key. */
    fun issued(nonce: String, eph: Ephemeral) {
        this.nonce = nonce
        this.eph = eph
        session = null
    }

    /** What the phone sent: a HELLO beside its half of the exchange, or a frame under the connection's key. */
    fun open(text: String): JsonObject {
        val env = WireJson.parseToJsonElement(text).jsonObject
        env["eph"]?.jsonPrimitive?.content?.let { theirs ->
            clientEph = theirs
            session = eph.sessionKey(theirs, E2E.sessionInfo(room, nonce, eph.public, theirs))
        }
        return E2E.open(session!!, env["enc"]!!.jsonPrimitive.content).jsonObject
    }

    fun seal(frame: JsonObject) = sealWith(session!!, frame)

    fun sealRoom(frame: JsonObject) = sealWith(roomKey, frame)

    fun sealWith(key: ByteArray, frame: JsonObject) = buildJsonObject { put("enc", E2E.seal(key, frame)) }.toString()
}
