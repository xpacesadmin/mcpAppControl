package com.xsalpha.fleetconsole.network

import com.xsalpha.fleetconsole.model.GatewayEndpoint
import java.net.URI

object EndpointPolicy {
    private val certificatePin = Regex("^sha256/[A-Za-z0-9+/]{43}=$")

    fun validate(baseUrl: String, pin: String): GatewayEndpoint {
        val uri = try {
            URI(baseUrl.trim())
        } catch (_: Exception) {
            throw IllegalArgumentException("Gateway URL is invalid")
        }
        require(uri.scheme.equals("https", ignoreCase = true)) { "Gateway URL must use HTTPS" }
        require(uri.userInfo == null && uri.query == null && uri.fragment == null) { "Gateway URL must not contain credentials, query, or fragment" }
        require(uri.path.isNullOrEmpty() || uri.path == "/") { "Gateway URL must not contain an API path" }
        val host = uri.host?.lowercase()?.trimEnd('.') ?: throw IllegalArgumentException("Gateway host is required")
        require(isApprovedPrivateHost(host)) { "Gateway host must be a Tailscale or private WireGuard address" }
        require(certificatePin.matches(pin.trim())) { "Certificate pin must use sha256/<base64> format" }
        val normalizedPort = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
        val displayHost = if (host.contains(':')) "[$host]" else host
        return GatewayEndpoint("https://$displayHost$normalizedPort", pin.trim())
    }

    fun isApprovedPrivateHost(host: String): Boolean {
        if (host == "localhost" || host == "::1" || host.startsWith("127.")) return false
        if (host.endsWith(".ts.net") && host.length > ".ts.net".length) return true
        if (host.startsWith("fd7a:115c:a1e0:", ignoreCase = true)) return true
        if (host.contains(':') && (host.startsWith("fc", ignoreCase = true) || host.startsWith("fd", ignoreCase = true))) return true
        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { it.toIntOrNull() ?: return false }
        if (octets.any { it !in 0..255 }) return false
        return when {
            octets[0] == 100 && octets[1] in 64..127 -> true // Tailscale CGNAT
            octets[0] == 10 -> true // Explicitly configured WireGuard address
            octets[0] == 172 && octets[1] in 16..31 -> true
            octets[0] == 192 && octets[1] == 168 -> true
            else -> false
        }
    }
}
