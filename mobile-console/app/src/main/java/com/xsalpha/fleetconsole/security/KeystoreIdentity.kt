package com.xsalpha.fleetconsole.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class KeystoreIdentity {
    private val keyStore: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun ensureKeys() {
        ensureKey(DEVICE_SIGNING_ALIAS, userAuthenticationRequired = false)
        ensureKey(STEP_UP_ALIAS, userAuthenticationRequired = true)
    }

    fun devicePublicKeyPem(): String = publicKeyPem(DEVICE_SIGNING_ALIAS)
    fun stepUpPublicKeyPem(): String = publicKeyPem(STEP_UP_ALIAS)

    fun signDevice(value: String): String {
        val entry = keyStore.getEntry(DEVICE_SIGNING_ALIAS, null) as? KeyStore.PrivateKeyEntry
            ?: error("Device signing key is unavailable")
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(entry.privateKey)
        signature.update(value.toByteArray(Charsets.UTF_8))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign())
    }

    fun initializedStepUpSignature(): Signature {
        val entry = keyStore.getEntry(STEP_UP_ALIAS, null) as? KeyStore.PrivateKeyEntry
            ?: error("Step-up key is unavailable")
        return Signature.getInstance("SHA256withECDSA").apply { initSign(entry.privateKey) }
    }

    fun signStepUp(value: String): String {
        val signature = initializedStepUpSignature()
        signature.update(value.toByteArray(Charsets.UTF_8))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign())
    }

    fun clear() {
        if (keyStore.containsAlias(DEVICE_SIGNING_ALIAS)) keyStore.deleteEntry(DEVICE_SIGNING_ALIAS)
        if (keyStore.containsAlias(STEP_UP_ALIAS)) keyStore.deleteEntry(STEP_UP_ALIAS)
    }

    private fun ensureKey(alias: String, userAuthenticationRequired: Boolean) {
        if (keyStore.containsAlias(alias)) return
        val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(userAuthenticationRequired)
        if (userAuthenticationRequired) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setUserAuthenticationParameters(
                    30,
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                )
            } else {
                @Suppress("DEPRECATION")
                builder.setUserAuthenticationValidityDurationSeconds(30)
            }
        }
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(builder.build())
            generateKeyPair()
        }
    }

    private fun publicKeyPem(alias: String): String {
        val certificate = keyStore.getCertificate(alias) ?: error("Keystore certificate is unavailable")
        val encoded = Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(certificate.publicKey.encoded)
        return "-----BEGIN PUBLIC KEY-----\n$encoded\n-----END PUBLIC KEY-----\n"
    }

    companion object {
        const val DEVICE_SIGNING_ALIAS = "xsalpha.console.device-signing.v1"
        const val STEP_UP_ALIAS = "xsalpha.console.step-up.v1"
    }
}
