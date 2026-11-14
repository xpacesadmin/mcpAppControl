package com.xsalpha.fleetconsole.security

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.xsalpha.fleetconsole.model.GatewayEndpoint
import com.xsalpha.fleetconsole.model.StoredSession
import org.json.JSONObject
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences("xsalpha_console_secure", Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @SuppressLint("ApplySharedPref") // Credential rotation must be durable before the caller proceeds.
    fun save(session: StoredSession) {
        val payload = JSONObject()
            .put("base_url", session.endpoint.baseUrl)
            .put("certificate_pin", session.endpoint.certificatePin)
            .put("device_id", session.deviceId)
            .put("session_id", session.sessionId)
            .put("refresh_token", session.refreshToken)
            .put("refresh_expires_at", session.refreshExpiresAt)
            .toString()
            .toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        val persisted = preferences.edit()
            .putString("ciphertext", Base64.getEncoder().encodeToString(cipher.doFinal(payload)))
            .putString("iv", Base64.getEncoder().encodeToString(cipher.iv))
            .commit()
        check(persisted) { "Secure session storage was not persisted." }
    }

    fun load(): StoredSession? {
        val ciphertext = preferences.getString("ciphertext", null) ?: return null
        val iv = preferences.getString("iv", null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(128, Base64.getDecoder().decode(iv)))
            val value = JSONObject(String(cipher.doFinal(Base64.getDecoder().decode(ciphertext)), Charsets.UTF_8))
            StoredSession(
                endpoint = GatewayEndpoint(value.getString("base_url"), value.getString("certificate_pin")),
                deviceId = value.getString("device_id"),
                sessionId = value.getString("session_id"),
                refreshToken = value.getString("refresh_token"),
                refreshExpiresAt = value.getString("refresh_expires_at"),
            )
        } catch (_: Exception) {
            runCatching { clear() }
            runCatching { if (keyStore.containsAlias(STORAGE_ALIAS)) keyStore.deleteEntry(STORAGE_ALIAS) }
            null
        }
    }

    @SuppressLint("ApplySharedPref") // Revocation must be durable before the caller proceeds.
    fun clear() {
        check(preferences.edit().clear().commit()) { "Secure session storage was not cleared." }
    }

    private fun encryptionKey(): SecretKey {
        (keyStore.getKey(STORAGE_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    STORAGE_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    companion object {
        private const val STORAGE_ALIAS = "xsalpha.console.session-storage.v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
