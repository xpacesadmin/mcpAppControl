package com.xsalpha.fleetconsole.security

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class BiometricStepUp(
    private val activity: FragmentActivity,
    private val identity: KeystoreIdentity,
) {
    suspend fun sign(canonicalValue: String): String = suspendCancellableCoroutine { continuation ->
        identity.ensureKeys()
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val availability = BiometricManager.from(activity).canAuthenticate(authenticators)
        if (availability != BiometricManager.BIOMETRIC_SUCCESS) {
            continuation.resumeWithException(IllegalStateException("Strong biometric or device credential is unavailable"))
            return@suspendCancellableCoroutine
        }
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (!continuation.isActive) return
                    runCatching { identity.signStepUp(canonicalValue) }
                        .onSuccess(continuation::resume)
                        .onFailure(continuation::resumeWithException)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (continuation.isActive) continuation.resumeWithException(SecurityException("Step-up authentication was cancelled"))
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Confirm fleet operation")
            .setSubtitle("Use a strong biometric or the device PIN")
            .setAllowedAuthenticators(authenticators)
            .setConfirmationRequired(true)
            .build()
        continuation.invokeOnCancellation { prompt.cancelAuthentication() }
        prompt.authenticate(info)
    }
}
