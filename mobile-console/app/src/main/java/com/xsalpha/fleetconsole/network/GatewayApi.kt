package com.xsalpha.fleetconsole.network

import com.xsalpha.fleetconsole.model.AccessSession
import com.xsalpha.fleetconsole.model.GatewayEndpoint
import com.xsalpha.fleetconsole.model.PairingRequest
import com.xsalpha.fleetconsole.model.StoredSession
import com.xsalpha.fleetconsole.security.KeystoreIdentity
import com.xsalpha.fleetconsole.security.SecureSessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.CertificatePinner
import okhttp3.ConnectionSpec
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.TlsVersion
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

class GatewayException(
    val status: Int,
    val code: String,
    override val message: String,
) : Exception(message)

class GatewayApi(
    private val identity: KeystoreIdentity,
    private val sessionStore: SecureSessionStore,
    private val requirePrivateVpn: () -> Unit,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    private val refreshMutex = Mutex()
    @Volatile private var accessSession: AccessSession? = null
    @Volatile private var cachedClientKey: String? = null
    @Volatile private var cachedClient: OkHttpClient? = null

    fun hasStoredSession(): Boolean = sessionStore.load() != null

    suspend fun pair(input: PairingRequest) {
        val endpoint = EndpointPolicy.validate(input.endpoint.baseUrl, input.endpoint.certificatePin)
        val code = input.pairingCode.trim().uppercase()
        val deviceName = input.deviceName.trim()
        require(deviceName.length in 2..80) { "Device name must be between 2 and 80 characters" }
        identity.ensureKeys()
        val timestamp = clock()
        val body = JSONObject()
            .put("code", code)
            .put("device_name", deviceName)
            .put("public_key_pem", identity.devicePublicKeyPem())
            .put("step_up_public_key_pem", identity.stepUpPublicKeyPem())
            .put("timestamp", timestamp)
            .put("proof_signature", identity.signDevice(CanonicalRequest.pairing(code, deviceName, timestamp)))
        val response = execute(endpoint, "POST", "/mobile/v1/pair/complete", body, authenticated = false)
        val data = response.getJSONObject("data")
        val device = data.getJSONObject("device")
        val session = data.getJSONObject("session")
        val access = AccessSession(
            accessToken = session.getString("access_token"),
            accessExpiresAt = session.getString("access_expires_at"),
        )
        sessionStore.save(
            StoredSession(
                endpoint = endpoint,
                deviceId = device.getString("id"),
                sessionId = session.getString("id"),
                refreshToken = session.getString("refresh_token"),
                refreshExpiresAt = session.getString("refresh_expires_at"),
            ),
        )
        accessSession = access
    }

    suspend fun get(path: String): JSONObject = authenticatedRequest("GET", path, null)

    suspend fun post(path: String, body: JSONObject, confirmed: Boolean = false, stepUpToken: String? = null): JSONObject =
        authenticatedRequest("POST", path, body, confirmed, stepUpToken)

    suspend fun logout() {
        try {
            if (hasStoredSession()) post("/mobile/v1/session/logout", JSONObject())
        } finally {
            accessSession = null
            sessionStore.clear()
        }
    }

    fun clearLocalSession() {
        accessSession = null
        sessionStore.clear()
    }

    private suspend fun authenticatedRequest(
        method: String,
        path: String,
        body: JSONObject?,
        confirmed: Boolean = false,
        stepUpToken: String? = null,
    ): JSONObject {
        val stored = sessionStore.load() ?: throw GatewayException(401, "pairing_required", "Pair this phone with the gateway")
        ensureAccess(stored)
        return try {
            execute(stored.endpoint, method, path, body, authenticated = true, confirmed = confirmed, stepUpToken = stepUpToken)
        } catch (error: GatewayException) {
            if (error.status != 401 || error.code !in setOf("session_expired", "session_revoked")) throw error
            if (error.code == "session_revoked") {
                clearLocalSession()
                throw error
            }
            refresh(stored, force = true)
            execute(stored.endpoint, method, path, body, authenticated = true, confirmed = confirmed, stepUpToken = stepUpToken)
        }
    }

    private suspend fun ensureAccess(stored: StoredSession) {
        val current = accessSession
        val expiresAt = current?.accessExpiresAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L
        if (current != null && expiresAt > clock() + 15_000) return
        refresh(stored, force = false)
    }

    private suspend fun refresh(initial: StoredSession, force: Boolean) = refreshMutex.withLock {
        val stored = sessionStore.load() ?: throw GatewayException(401, "pairing_required", "Pair this phone with the gateway")
        if (!force) {
            val current = accessSession
            val expiresAt = current?.accessExpiresAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L
            if (current != null && expiresAt > clock() + 15_000) return@withLock
        }
        val body = JSONObject()
            .put("device_id", stored.deviceId)
            .put("refresh_token", stored.refreshToken)
        val response = try {
            execute(stored.endpoint, "POST", "/mobile/v1/session/refresh", body, authenticated = false, signWithoutAccess = true)
        } catch (error: GatewayException) {
            if (error.status == 401) clearLocalSession()
            throw error
        }
        val session = response.getJSONObject("data").getJSONObject("session")
        accessSession = AccessSession(session.getString("access_token"), session.getString("access_expires_at"))
        sessionStore.save(
            initial.copy(
                endpoint = stored.endpoint,
                sessionId = session.getString("id"),
                refreshToken = session.getString("refresh_token"),
                refreshExpiresAt = session.getString("refresh_expires_at"),
            ),
        )
    }

    private suspend fun execute(
        endpoint: GatewayEndpoint,
        method: String,
        path: String,
        body: JSONObject?,
        authenticated: Boolean,
        signWithoutAccess: Boolean = false,
        confirmed: Boolean = false,
        stepUpToken: String? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        requirePrivateVpn()
        require(path.startsWith("/mobile/v1/") && !path.contains("..")) { "Unsafe gateway path" }
        val url = endpointUrl(endpoint, path)
        val bodyBytes = body?.toString()?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
        val requestBuilder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
        if (method == "GET") requestBuilder.get()
        else requestBuilder.method(method, bodyBytes.toRequestBody(JSON_MEDIA_TYPE))

        if (authenticated || signWithoutAccess) {
            val timestamp = clock()
            val nonce = CanonicalRequest.nonce()
            val encodedPath = buildString {
                append(url.encodedPath)
                if (url.encodedQuery != null) append('?').append(url.encodedQuery)
            }
            val signature = identity.signDevice(CanonicalRequest.request(method, encodedPath, timestamp, nonce, bodyBytes))
            requestBuilder
                .header("X-XSAlpha-Timestamp", timestamp.toString())
                .header("X-XSAlpha-Nonce", nonce)
                .header("X-XSAlpha-Signature", signature)
            if (authenticated) {
                val token = accessSession?.accessToken ?: throw GatewayException(401, "session_expired", "Mobile access session expired")
                requestBuilder.header("Authorization", "Bearer $token")
            }
        }
        if (confirmed) requestBuilder.header("X-XSAlpha-Confirmation", "true")
        if (!stepUpToken.isNullOrBlank()) requestBuilder.header("X-XSAlpha-Step-Up-Token", stepUpToken)

        client(endpoint).newCall(requestBuilder.build()).execute().use { response ->
            val contentLength = response.body?.contentLength() ?: 0L
            if (contentLength > MAX_RESPONSE_BYTES) throw GatewayException(502, "response_too_large", "Gateway response exceeded the app limit")
            val bytes = response.body?.bytes() ?: ByteArray(0)
            if (bytes.size > MAX_RESPONSE_BYTES) throw GatewayException(502, "response_too_large", "Gateway response exceeded the app limit")
            val payload = try { JSONObject(String(bytes, Charsets.UTF_8)) }
            catch (_: Exception) { throw GatewayException(502, "invalid_response", "Gateway returned an invalid response") }
            if (!response.isSuccessful) {
                val error = payload.optJSONObject("error")
                throw GatewayException(
                    response.code,
                    error?.optString("code")?.takeIf { it.isNotBlank() } ?: "gateway_error",
                    error?.optString("message")?.takeIf { it.isNotBlank() } ?: "Gateway rejected the request",
                )
            }
            payload
        }
    }

    private fun endpointUrl(endpoint: GatewayEndpoint, path: String): HttpUrl =
        (endpoint.baseUrl + path).toHttpUrl()

    private fun client(endpoint: GatewayEndpoint): OkHttpClient {
        val key = "${endpoint.baseUrl}|${endpoint.certificatePin}"
        cachedClient?.takeIf { cachedClientKey == key }?.let { return it }
        return synchronized(this) {
            cachedClient?.takeIf { cachedClientKey == key } ?: run {
                val host = endpoint.baseUrl.toHttpUrl().host
                val tls13 = ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS)
                    .tlsVersions(TlsVersion.TLS_1_3)
                    .build()
                OkHttpClient.Builder()
                    .certificatePinner(CertificatePinner.Builder().add(host, endpoint.certificatePin).build())
                    .connectionSpecs(listOf(tls13))
                    .connectTimeout(8, TimeUnit.SECONDS)
                    .readTimeout(10, TimeUnit.SECONDS)
                    .writeTimeout(10, TimeUnit.SECONDS)
                    .callTimeout(12, TimeUnit.SECONDS)
                    .retryOnConnectionFailure(false)
                    .followRedirects(false)
                    .followSslRedirects(false)
                    .build()
                    .also {
                        cachedClientKey = key
                        cachedClient = it
                    }
            }
        }
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private const val MAX_RESPONSE_BYTES = 1_048_576
    }
}
