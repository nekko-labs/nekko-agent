package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** The phone's half of step-up (SK-7): what it reads, what it sends, and what it decides. */
class StepUpTest {
    private fun json(s: String) = WireJson.parseToJsonElement(s)

    @Test fun `a typed code is six digits, grouped or not`() {
        assertEquals("123456", StepUp.normalizeCode("123456"))
        assertEquals("123456", StepUp.normalizeCode("123 456"))
        assertEquals("123456", StepUp.normalizeCode(" 123-456 "))
        assertNull(StepUp.normalizeCode("12345"))
        assertNull(StepUp.normalizeCode("1234567"))
        assertNull(StepUp.normalizeCode("12a456"))
        assertNull(StepUp.normalizeCode("１２３４５６"))
        assertNull(StepUp.normalizeCode(""))
    }

    @Test fun `the challenge reply says what the sheet may offer`() {
        val both = StepUpChallenge.from(json("""{"challenge":"BwcHBwcHBwcHBwcHBwcHBwcH","expiresAt":1790000120000,"required":true,"methods":["passkey","security-key","totp"],"rpId":"nekko-computer:abc"}"""))!!
        assertEquals(setOf(StepUpMethod.PASSKEY, StepUpMethod.SECURITY_KEY, StepUpMethod.TOTP), both.methods)
        assertTrue(both.offersKey)
        assertTrue(both.offersCode)
        assertFalse(both.noWayToAnswer)

        assertFalse("no computer offers phone registration yet", both.register)
        assertTrue(StepUpChallenge.from(json("""{"challenge":"BwcH","expiresAt":1,"methods":[],"register":true}"""))!!.register)
        assertTrue(StepUpChallenge.from(json("""{"challenge":"BwcH","expiresAt":1,"methods":[],"register":{"kinds":["passkey"]}}"""))!!.register)
        assertFalse(StepUpChallenge.from(json("""{"challenge":"BwcH","expiresAt":1,"methods":[],"register":"yes"}"""))!!.register)

        // A computer from before rpId was sent: without it no key can be asked, so only the code is offered.
        val noRp = StepUpChallenge.from(json("""{"challenge":"BwcHBwcHBwcHBwcHBwcHBwcH","expiresAt":1,"required":true,"methods":["security-key","totp"]}"""))!!
        assertFalse(noRp.offersKey)
        assertTrue(noRp.offersCode)

        // On with nothing that can answer (no method, or security.json unreadable: fail closed).
        val none = StepUpChallenge.from(json("""{"challenge":"BwcHBwcHBwcHBwcHBwcHBwcH","expiresAt":1,"required":true,"methods":[]}"""))!!
        assertTrue(none.noWayToAnswer)
        val keysOnly = StepUpChallenge.from(json("""{"challenge":"BwcHBwcHBwcHBwcHBwcHBwcH","expiresAt":1,"required":true,"methods":["security-key"]}"""))!!
        assertTrue("keys but no rpId and no code", keysOnly.noWayToAnswer)

        // Unknown kinds from a newer computer are ignored, not fatal.
        val newer = StepUpChallenge.from(json("""{"challenge":"BwcHBwcHBwcHBwcHBwcHBwcH","expiresAt":1,"required":false,"methods":["totp","smartcard"]}"""))!!
        assertEquals(setOf(StepUpMethod.TOTP), newer.methods)
        assertFalse(newer.required)

        assertNull(StepUpChallenge.from(json("""{"expiresAt":1}""")))
        assertNull(StepUpChallenge.from(json("""{"challenge":"not base64!"}""")))
        assertNull(StepUpChallenge.from(json("null")))
    }

    @Test fun `a challenge close to its two minutes is fetched again`() {
        val c = StepUpChallenge("BwcH", expiresAt = 1_000_000, required = true, methods = setOf(StepUpMethod.TOTP))
        assertFalse(c.isExpired(1_000_000 - 60_000))
        assertTrue(c.isExpired(1_000_000 - 5_000))
        assertTrue(c.isExpired(1_000_001))
    }

    @Test fun `the assertion request names the computer, its challenge and no credentials`() {
        val o = json(StepUp.assertionRequestJson("BwcHBwcHBwcHBwcHBwcHBwcH", "nekko-computer:abc")).jsonObject
        assertEquals("BwcHBwcHBwcHBwcHBwcHBwcH", o["challenge"]!!.jsonPrimitive.content)
        assertEquals("nekko-computer:abc", o["rpId"]!!.jsonPrimitive.content)
        assertEquals(JsonArray(emptyList()), o["allowCredentials"])
        assertEquals("preferred", o["userVerification"]!!.jsonPrimitive.content)
        assertEquals(StepUp.WEBAUTHN_TIMEOUT_MS, o["timeout"]!!.jsonPrimitive.long)
    }

    @Test fun `the registration request asks for a discoverable ES256 credential of the right kind`() {
        val key = json(
            StepUp.registrationRequestJson("Y2hhbGxlbmdl", "nekko-computer:abc", "Nekko Agent on Studio", byteArrayOf(1, 2, 3), "Philip’s Pixel", StepUpMethod.SECURITY_KEY),
        ).jsonObject
        assertEquals("nekko-computer:abc", key["rp"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals("AQID", key["user"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals(-7L, key["pubKeyCredParams"]!!.jsonArray.single().jsonObject["alg"]!!.jsonPrimitive.long)
        assertEquals("none", key["attestation"]!!.jsonPrimitive.content)
        val sel = key["authenticatorSelection"]!!.jsonObject
        assertEquals("cross-platform", sel["authenticatorAttachment"]!!.jsonPrimitive.content)
        assertEquals("required", sel["residentKey"]!!.jsonPrimitive.content)
        assertTrue(sel["requireResidentKey"]!!.jsonPrimitive.boolean)
        val passkey = json(
            StepUp.registrationRequestJson("Y2hhbGxlbmdl", "nekko-computer:abc", "x", byteArrayOf(1), "y", StepUpMethod.PASSKEY),
        ).jsonObject
        assertEquals("platform", passkey["authenticatorSelection"]!!.jsonObject["authenticatorAttachment"]!!.jsonPrimitive.content)
    }

    @Test fun `payloads encode as the computer reads them, and a code never prints`() {
        assertEquals("""{"totp":"012345"}""", StepUpProof.Totp("012345").toJson().toString())
        assertEquals("Totp(******)", StepUpProof.Totp("012345").toString())
        val a = StepUpProof.Assertion("aWQ", "YXV0aA", "Y2Rq", "c2ln")
        assertEquals("""{"credentialId":"aWQ","authenticatorData":"YXV0aA","clientDataJSON":"Y2Rq","signature":"c2ln"}""", a.toJson().toString())
        assertEquals(a, StepUpProof.from(a.toJson()))
        assertEquals(StepUpProof.Totp("012345"), StepUpProof.from(json("""{"totp":"012345"}""")))
        assertNull(StepUpProof.from(json("""{"credentialId":"aWQ"}""")))
        assertNull(StepUpProof.fromAuthenticationResponse("""{"type":"password"}"""))
        assertNull(StepUpProof.fromAuthenticationResponse("""{"id":"aWQ","response":{"clientDataJSON":"Y2Rq","authenticatorData":"%%","signature":"c2ln"}}"""))
        assertNull(StepUpProof.fromAuthenticationResponse("not json"))
    }

    @Test fun `base64url reads every form WebAuthn and security json use`() {
        val bytes = byteArrayOf(-5, -1, 0, 1)
        assertEquals("-_8AAQ", StepUp.b64url(bytes))
        assertTrue(bytes.contentEquals(StepUp.fromB64url("-_8AAQ")!!))
        assertTrue(bytes.contentEquals(StepUp.fromB64url("+/8AAQ==")!!))
        assertTrue(bytes.contentEquals(StepUp.fromB64url("+/8AAQ")!!))
        assertNull(StepUp.fromB64url("abcde"))
        assertNull(StepUp.fromB64url("ab cd"))
        assertEquals("+/8AAQ==", StepUp.b64(bytes))
    }

    @Test fun `the refusals read as plain sentences and say whether to ask again`() {
        val r = { code: String -> PhoneRefusal.parse("Not allowed from a paired phone ($code): settings:update")!! }
        assertEquals("Confirm with your security key or a code to do this.", r("step-up-required").message("Studio"))
        assertEquals("That key or code was not accepted. Try again.", r("step-up-invalid").message("Studio"))
        assertEquals("That confirmation took too long. Try again.", r("step-up-stale").message("Studio"))
        assertEquals("That confirmation was already used. Try again.", r("step-up-replayed").message("Studio"))
        for (code in listOf("step-up-required", "step-up-invalid", "step-up-stale", "step-up-replayed")) {
            assertTrue(code, r(code).asksForStepUp)
            assertFalse(code, r(code).isProof)
        }
        val quit = PhoneRefusal.parse("Not allowed from a paired phone (quit-disabled): app:quit")!!
        assertFalse(quit.asksForStepUp)
        assertEquals("Quitting from a phone is turned off on the computer (Settings → Remote access).", quit.message("Studio"))
        assertFalse(r("change-off").asksForStepUp)
        assertNull(r("change-off").stepUp)
    }

    @Test fun `app info says whether a phone may quit the computer`() {
        assertTrue(AppInfo.from(json("""{"version":"1.2.3","platform":"darwin","edition":"desktop","quitFromPhone":true}""")).quitFromPhone)
        assertFalse(AppInfo.from(json("""{"version":"1.2.3","platform":"darwin","quitFromPhone":false}""")).quitFromPhone)
        assertFalse("an older computer", AppInfo.from(json("""{"version":"1.0.0","platform":"win32"}""")).quitFromPhone)
        assertFalse(AppInfo.from(json("""{"quitFromPhone":"yes"}""")).quitFromPhone)
    }

    @Test fun `the safety exits and the challenge are phone channels`() {
        for (ch in listOf("security:challenge", "device:signOut", "remote:stop", "app:quit")) assertTrue(ch, ch in Channels.ALL)
    }

    // ---- registration: a response built here the way an authenticator builds one ----

    private fun cbor(v: Any?): ByteArray {
        val out = ByteArrayOutputStream()
        fun head(major: Int, n: Long) {
            when {
                n < 24 -> out.write((major shl 5) or n.toInt())
                n < 256 -> { out.write((major shl 5) or 24); out.write(n.toInt()) }
                else -> { out.write((major shl 5) or 25); out.write((n shr 8).toInt()); out.write(n.toInt() and 0xff) }
            }
        }
        fun w(x: Any?) {
            when (x) {
                is Int -> if (x >= 0) head(0, x.toLong()) else head(1, (-1 - x).toLong())
                is ByteArray -> { head(2, x.size.toLong()); out.write(x) }
                is String -> { val b = x.toByteArray(); head(3, b.size.toLong()); out.write(b) }
                is Map<*, *> -> { head(5, x.size.toLong()); x.forEach { (k, v2) -> w(k); w(v2) } }
                else -> error("unsupported $x")
            }
        }
        w(v)
        return out.toByteArray()
    }

    private class Made(val response: String, val id: ByteArray, val point: ByteArray)

    private fun registration(attachment: String?, coseAlg: Int = -7, idInJson: ByteArray? = null): Made {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val pub = kp.public as ECPublicKey
        fun fixed(b: java.math.BigInteger) = b.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else ByteArray(32 - it.size) + it }
        val x = fixed(pub.w.affineX)
        val y = fixed(pub.w.affineY)
        val id = ByteArray(16) { (it * 7).toByte() }
        val cose = cbor(linkedMapOf(1 to 2, 3 to coseAlg, -1 to 1, -2 to x, -3 to y))
        val rpHash = MessageDigest.getInstance("SHA-256").digest("nekko-computer:abc".toByteArray())
        val authData = rpHash + byteArrayOf(0x45) + byteArrayOf(0, 0, 0, 3) + ByteArray(16) + byteArrayOf(0, id.size.toByte()) + id + cose
        val att = cbor(linkedMapOf("fmt" to "none", "attStmt" to linkedMapOf<String, Any>(), "authData" to authData))
        val cdj = """{"type":"webauthn.create","challenge":"Y2hhbGxlbmdl","origin":"android:apk-key-hash:abc"}""".toByteArray()
        val attachmentField = attachment?.let { ""","authenticatorAttachment":"$it"""" } ?: ""
        val response = """{"id":"${StepUp.b64url(idInJson ?: id)}","rawId":"${StepUp.b64url(idInJson ?: id)}","type":"public-key"$attachmentField,
            "response":{"clientDataJSON":"${StepUp.b64url(cdj)}","attestationObject":"${StepUp.b64url(att)}","transports":["nfc","usb"]}}"""
        return Made(response, id, byteArrayOf(4) + x + y)
    }

    @Test fun `a registration yields the credential security json keeps`() {
        val m = registration("cross-platform")
        val r = StepUpRegistration.fromRegistrationResponse(m.response, StepUpMethod.PASSKEY)
        assertNotNull(r)
        r!!
        assertEquals(StepUp.b64url(m.id), r.credentialId)
        assertEquals(StepUp.b64(m.point), r.publicKey)
        assertEquals(65, StepUp.fromB64url(r.publicKey)!!.size)
        assertEquals(3L, r.counter)
        assertEquals("the platform said cross-platform", StepUpMethod.SECURITY_KEY, r.kind)
        val o = r.toJson("YubiKey 5C", 42)
        assertEquals("security-key", o["kind"]!!.jsonPrimitive.content)
        assertEquals("YubiKey 5C", o["name"]!!.jsonPrimitive.content)
        assertEquals(42L, o["addedAt"]!!.jsonPrimitive.long)

        assertEquals(StepUpMethod.PASSKEY, StepUpRegistration.fromRegistrationResponse(registration("platform").response, StepUpMethod.SECURITY_KEY)!!.kind)
        assertEquals("what was asked, when unsaid", StepUpMethod.PASSKEY, StepUpRegistration.fromRegistrationResponse(registration(null).response, StepUpMethod.PASSKEY)!!.kind)
    }

    @Test fun `a registration the computer could not verify is refused on the phone`() {
        assertNull("RS256 is not verified by the computer", StepUpRegistration.fromRegistrationResponse(registration("platform", coseAlg = -257).response, StepUpMethod.PASSKEY))
        assertNull("the JSON id must be the attested one", StepUpRegistration.fromRegistrationResponse(registration("platform", idInJson = ByteArray(16)).response, StepUpMethod.PASSKEY))
        assertNull(StepUpRegistration.fromRegistrationResponse("""{"response":{"clientDataJSON":"e30","attestationObject":"oA"}}""", StepUpMethod.PASSKEY))
        assertNull(StepUpRegistration.fromRegistrationResponse("[]", StepUpMethod.PASSKEY))
    }

    @Test fun `cbor that lies about its lengths is not read`() {
        assertNull(Cbor.decode(byteArrayOf(0x5a, 0x7f, 0, 0, 0)))
        assertNull(Cbor.decode(byteArrayOf(0xbf.toByte())))
        assertNull(Cbor.decode(ByteArray(0)))
        assertEquals(mapOf(1L to -7L), Cbor.decode(cbor(mapOf(1 to -7))))
        assertEquals(JsonPrimitive("x"), JsonPrimitive(Cbor.decode(cbor("x")) as String))
    }
}
