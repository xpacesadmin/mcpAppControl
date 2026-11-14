package com.xsalpha.fleetconsole.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointPolicyTest {
    private val pin = "sha256/" + "A".repeat(43) + "="

    @Test
    fun acceptsTailscaleAndPrivateWireGuardHosts() {
        assertTrue(EndpointPolicy.isApprovedPrivateHost("gateway.example.ts.net"))
        assertTrue(EndpointPolicy.isApprovedPrivateHost("100.100.10.20"))
        assertTrue(EndpointPolicy.isApprovedPrivateHost("10.44.0.2"))
        assertTrue(EndpointPolicy.isApprovedPrivateHost("fd7a:115c:a1e0::123"))
        assertTrue(EndpointPolicy.isApprovedPrivateHost("fd00::2"))
    }

    @Test
    fun rejectsPublicLoopbackAndLookalikeHosts() {
        assertFalse(EndpointPolicy.isApprovedPrivateHost("localhost"))
        assertFalse(EndpointPolicy.isApprovedPrivateHost("127.0.0.1"))
        assertFalse(EndpointPolicy.isApprovedPrivateHost("203.0.113.10"))
        assertFalse(EndpointPolicy.isApprovedPrivateHost("fcloud.example.com"))
        assertFalse(EndpointPolicy.isApprovedPrivateHost("example.com"))
    }

    @Test
    fun normalizesEndpointAndRequiresPinnedHttps() {
        val endpoint = EndpointPolicy.validate("https://Gateway.Example.ts.net:8743/", pin)
        assertEquals("https://gateway.example.ts.net:8743", endpoint.baseUrl)
        assertEquals(pin, endpoint.certificatePin)
        assertThrows(IllegalArgumentException::class.java) { EndpointPolicy.validate("http://100.100.1.2:8743", pin) }
        assertThrows(IllegalArgumentException::class.java) { EndpointPolicy.validate("https://example.com", pin) }
        assertThrows(IllegalArgumentException::class.java) { EndpointPolicy.validate("https://100.100.1.2", "not-a-pin") }
    }
}

