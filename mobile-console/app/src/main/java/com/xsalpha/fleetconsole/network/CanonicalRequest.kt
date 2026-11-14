package com.xsalpha.fleetconsole.network

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

object CanonicalRequest {
    private val random = SecureRandom()

    fun nonce(): String {
        val bytes = ByteArray(18)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    fun bodyHash(body: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(body)
        .joinToString("") { "%02x".format(it) }

    fun request(method: String, encodedPathAndQuery: String, timestamp: Long, nonce: String, body: ByteArray): String = listOf(
        "XSALPHA_REQUEST_V1",
        method.uppercase(),
        encodedPathAndQuery,
        timestamp.toString(),
        nonce,
        bodyHash(body),
    ).joinToString("\n")

    fun pairing(code: String, deviceName: String, timestamp: Long): String = listOf(
        "XSALPHA_PAIR_V1",
        code,
        deviceName,
        timestamp.toString(),
    ).joinToString("\n")

    fun stepUp(challengeId: String, challenge: String, action: String, targetDeviceIds: List<Long>): String = listOf(
        "XSALPHA_STEP_UP_V1",
        challengeId,
        challenge,
        action,
        targetDeviceIds.distinct().sorted().joinToString(","),
    ).joinToString("\n")
}

