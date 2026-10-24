package com.nekko.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * `step-up.json`, the golden the TS and Rust verifiers decide alike (SK-1,
 * SK-2), read here twice: once for what the phone itself does with those
 * payloads (decode, encode, read the challenge back), and once through
 * [StepUpVerifierTwin], so a Kotlin verifier decides every case as they do.
 * A copy lives in test resources (the module has no repo access on CI's
 * Android runner); [theCopyMatchesTheGolden] keeps it equal when the repo is there.
 */
class StepUpGoldenTest {
    private val text = javaClass.getResource("/step-up.json")!!.readText()
    private val golden = WireJson.parseToJsonElement(text).jsonObject
    private val cases = golden["cases"]!!.jsonArray.map { it.jsonObject }

    @Test
    fun theCopyMatchesTheGolden() {
        val root = System.getenv("NEKKO_REPO_ROOT") ?: return
        val original = File(root, "crates/nekko-remote/tests/golden/step-up.json")
        if (!original.exists()) return
        assertEquals(original.readText(), text)
    }

    @Test
    fun everyCaseDecidesAsTheComputerDoes() {
        assertTrue(cases.size >= 24)
        for (c in cases) {
            val name = c["name"]!!.jsonPrimitive.content
            val expect = c["expect"]!!.jsonObject
            val out = StepUpVerifierTwin.check(
                c["state"]!!.jsonObject,
                c["issued"]!!.jsonArray,
                c["now"]!!.jsonPrimitive.long,
                c["stepUp"],
            )
            assertEquals(name, expect["result"]!!.jsonPrimitive.content, out.result)
            assertEquals("$name: state", expect["state"], out.state)
            assertEquals("$name: issued", expect["issued"], out.issued)
            assertEquals("$name: method", (expect["method"] as? JsonPrimitive)?.content, out.method)
            assertEquals("$name: uv", (expect["uv"] as? JsonPrimitive)?.boolean, out.uv)
            assertEquals("$name: cloned", (expect["cloned"] as? JsonPrimitive)?.content, out.cloned)
        }
        // Every refusal the phone has words for appears in the golden.
        val results = cases.map { it["expect"]!!.jsonObject["result"]!!.jsonPrimitive.content }.toSet()
        for (code in StepUpCode.entries - StepUpCode.QUIT_DISABLED) assertTrue(code.wire, code.wire in results)
    }

    @Test
    fun thePhonesPayloadsRoundTripEveryFixtureStepUp() {
        for (c in cases) {
            val stepUp = c["stepUp"] ?: continue
            if (stepUp is JsonNull) continue
            val name = c["name"]!!.jsonPrimitive.content
            val parsed = StepUpProof.from(stepUp)
            if (name == "malformed step-up") {
                assertEquals(null, parsed)
                continue
            }
            assertNotNull(name, parsed)
            // What the phone would send is byte for byte what the golden carries.
            assertEquals(name, stepUp, parsed!!.toJson())
        }
    }

    @Test
    fun anAssertionNamesTheChallengeItAnswers() {
        val valid = cases.first { it["name"]!!.jsonPrimitive.content == "valid security key, user verified" }
        val a = StepUpProof.from(valid["stepUp"]) as StepUpProof.Assertion
        val issued = valid["issued"]!!.jsonArray.first().jsonObject["challenge"]!!.jsonPrimitive.content
        assertEquals(issued, a.challenge())
        assertEquals("nekko-app://desktop", a.origin())
        val wrong = cases.first { it["name"]!!.jsonPrimitive.content == "wrong challenge" }
        assertTrue((StepUpProof.from(wrong["stepUp"]) as StepUpProof.Assertion).challenge() != issued)
    }

    /**
     * Credential Manager hands back WebAuthn's JSON form (`rawId`, `response`,
     * padded or not); the golden's valid assertion wrapped that way must come
     * out as the very payload the computer accepts.
     */
    @Test
    fun aCredentialManagerResponseBecomesTheGoldenPayload() {
        val valid = cases.first { it["name"]!!.jsonPrimitive.content == "valid security key, user verified" }
        val want = StepUpProof.from(valid["stepUp"]) as StepUpProof.Assertion
        val pad = { s: String -> s + "=".repeat((4 - s.length % 4) % 4) }
        val response = """{"id":"${want.credentialId}","rawId":"${pad(want.credentialId)}","type":"public-key",
            "authenticatorAttachment":"cross-platform","clientExtensionResults":{},
            "response":{"clientDataJSON":"${pad(want.clientDataJSON)}","authenticatorData":"${want.authenticatorData}",
            "signature":"${want.signature}","userHandle":null}}"""
        val got = StepUpProof.fromAuthenticationResponse(response)
        assertEquals(want, got)
        val out = StepUpVerifierTwin.check(valid["state"]!!.jsonObject, valid["issued"]!!.jsonArray, valid["now"]!!.jsonPrimitive.long, got!!.toJson())
        assertEquals("ok", out.result)
    }

    @Test
    fun totpVectorsAndRecoveryHashes() {
        for (v in golden["totpVectors"]!!.jsonArray.map { it.jsonObject }) {
            val secret = StepUpVerifierTwin.base32Decode(v["secret"]!!.jsonPrimitive.content)!!
            assertEquals(v["code"]!!.jsonPrimitive.content, StepUpVerifierTwin.totpAt(secret, v["step"]!!.jsonPrimitive.long))
        }
        val recovery = golden["recovery"]!!.jsonObject
        val codes = recovery["codes"]!!.jsonArray.map { it.jsonPrimitive.content }
        val hashes = recovery["hashes"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(hashes, codes.map(StepUpVerifierTwin::hashRecoveryCode))
        // Case, spaces and dashes don't matter.
        assertEquals(hashes[0], StepUpVerifierTwin.hashRecoveryCode(" ${codes[0].uppercase().replace("-", " - ")} "))
    }

    /** The constants the phone uses are the computer's (`stepUp` in phone-access.json, from `stepUpPolicy()`). */
    @Test
    fun theConstantsAreTheComputers() {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-remote/src/phone-access.json")
        if (!f.exists()) return
        val policy = WireJson.parseToJsonElement(f.readText()).jsonObject["stepUp"]!!.jsonObject
        val challenge = policy["challenge"]!!.jsonObject
        assertEquals(StepUp.CHALLENGE_CHANNEL, challenge["channel"]!!.jsonPrimitive.content)
        assertEquals(StepUp.CHALLENGE_BYTES.toLong(), challenge["bytes"]!!.jsonPrimitive.long)
        assertEquals(StepUp.CHALLENGE_TTL_MS, challenge["ttlMs"]!!.jsonPrimitive.long)
        assertEquals(StepUp.COVER_MS, policy["coverMs"]!!.jsonPrimitive.long)
        assertEquals(StepUp.CLIENT_TYPE, policy["clientType"]!!.jsonPrimitive.content)
        val totp = policy["totp"]!!.jsonObject
        assertEquals(StepUp.TOTP_DIGITS.toLong(), totp["digits"]!!.jsonPrimitive.long)
        assertEquals(StepUp.TOTP_PERIOD_S.toLong(), totp["periodS"]!!.jsonPrimitive.long)
        val guarded = policy["phoneGuarded"]!!.jsonObject["channels"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
        assertEquals(StepUp.GUARDED_CHANNELS, guarded)
        val never = (policy["neverGuarded"] as JsonArray).map { it.jsonPrimitive.content }.toSet()
        assertEquals(setOf(Channels.APP_QUIT, Channels.DEVICE_SIGN_OUT, Channels.REMOTE_STOP), never)
    }

    /** The refusal sentences are `STEP_UP_MESSAGES`, word for word. */
    @Test
    fun theMessagesAreTheSharedOnes() {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "packages/shared/src/step-up.ts")
        if (!f.exists()) return
        val ts = f.readText()
        for (code in StepUpCode.entries) {
            assertTrue("${code.wire} in step-up.ts", ts.contains("'${code.wire}': '${code.message}'"))
        }
    }

    @Test
    fun theRpIdIsTheComputers() {
        assertEquals("nekko-computer:golden-install", StepUp.rpId("golden-install"))
        assertEquals(StepUp.rpId("golden-install"), (cases.first()["state"] as JsonObject)["rpId"]!!.jsonPrimitive.content)
    }
}
