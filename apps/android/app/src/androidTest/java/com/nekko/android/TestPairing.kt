package com.nekko.android

import com.nekko.protocol.PairingLink
import java.net.URLEncoder

/** A computer's host key, as a pairing link names it: every pairing needs one (decision 0042). */
const val TEST_HOST_KEY = "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="

private const val ROOM = "a1b2c3d4e5f60718"
private const val KEY = "00112233445566778899aabbccddeeff"

/** The pairing the fake computers in these tests answer to. */
fun testPairing(relayUrl: String = "wss://relay.example.dev", alts: List<String> = emptyList()) =
    PairingLink(relayUrl, ROOM, KEY, alts = alts, hostKey = TEST_HOST_KEY)

/** The same pairing as the link a person pastes. */
fun testPairingLink() = "nekko-agent-pair:?relay=${enc("wss://relay.example.dev")}&room=$ROOM&key=$KEY&host=${enc(TEST_HOST_KEY)}"

private fun enc(s: String) = URLEncoder.encode(s, Charsets.UTF_8)
