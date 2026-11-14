package com.xsalpha.fleetconsole.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CanonicalRequestTest {
    @Test
    fun requestBindsMethodPathTimestampNonceAndBody() {
        val body = "{\"confirm\":true}".toByteArray()
        val canonical = CanonicalRequest.request(
            method = "post",
            encodedPathAndQuery = "/mobile/v1/commands?mode=one",
            timestamp = 1234,
            nonce = "nonce-value",
            body = body,
        )
        val lines = canonical.lines()
        assertEquals("XSALPHA_REQUEST_V1", lines[0])
        assertEquals("POST", lines[1])
        assertEquals("/mobile/v1/commands?mode=one", lines[2])
        assertEquals("1234", lines[3])
        assertEquals("nonce-value", lines[4])
        assertEquals(64, lines[5].length)
        assertNotEquals(canonical, CanonicalRequest.request("POST", "/mobile/v1/commands?mode=two", 1234, "nonce-value", body))
    }

    @Test
    fun noncesAreUrlSafeAndUnique() {
        val first = CanonicalRequest.nonce()
        val second = CanonicalRequest.nonce()
        assertNotEquals(first, second)
        assertTrue(first.matches(Regex("^[A-Za-z0-9_-]+$")))
    }

    @Test
    fun stepUpSortsAndDeduplicatesTargets() {
        val canonical = CanonicalRequest.stepUp("id", "challenge", "stop_task", listOf(3, 1, 3, 2))
        assertEquals("1,2,3", canonical.lines().last())
    }
}

