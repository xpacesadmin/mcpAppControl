package com.xsalpha.fleetconsole.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xsalpha.fleetconsole.data.FleetRepository
import com.xsalpha.fleetconsole.model.ConsoleState
import com.xsalpha.fleetconsole.model.PairingRequest
import com.xsalpha.fleetconsole.network.GatewayApi
import com.xsalpha.fleetconsole.network.GatewayException
import com.xsalpha.fleetconsole.network.VpnNetworkGate
import com.xsalpha.fleetconsole.network.VpnRequiredException
import com.xsalpha.fleetconsole.security.KeystoreIdentity
import com.xsalpha.fleetconsole.security.SecureSessionStore
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.net.SocketTimeoutException
import javax.net.ssl.SSLPeerUnverifiedException
import org.json.JSONObject

class FleetViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = FleetRepository(
        GatewayApi(
            identity = KeystoreIdentity(),
            sessionStore = SecureSessionStore(application),
            requirePrivateVpn = VpnNetworkGate(application)::requireActive,
        ),
    )
    private val refreshMutex = Mutex()
    private val _state = MutableStateFlow(ConsoleState(paired = repository.hasStoredSession()))
    val state: StateFlow<ConsoleState> = _state.asStateFlow()
    private var pollingJob: Job? = null

    fun pair(request: PairingRequest) {
        if (_state.value.loading) return
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true, errorMessage = null)
            try {
                repository.pair(request)
                _state.value = ConsoleState(paired = true, loading = true)
                refreshInternal(manual = true)
                startPolling()
            } catch (error: Exception) {
                _state.value = ConsoleState(paired = repository.hasStoredSession(), errorMessage = userMessage(error))
            }
        }
    }

    fun refresh() {
        if (!_state.value.paired) return
        viewModelScope.launch { refreshInternal(manual = true) }
    }

    fun startPolling() {
        if (!_state.value.paired || pollingJob?.isActive == true) return
        pollingJob = viewModelScope.launch {
            var delayMs = 30_000L
            while (isActive) {
                refreshInternal(manual = false)
                delayMs = if (_state.value.errorMessage == null) 30_000L else (delayMs * 2).coerceAtMost(300_000L)
                delay(delayMs)
            }
        }
    }

    fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
    }

    fun logout() {
        stopPolling()
        viewModelScope.launch {
            runCatching { repository.logout() }
            _state.value = ConsoleState(paired = false)
        }
    }

    fun executeDeviceAction(
        action: String,
        deviceId: Long,
        reason: String,
        packageName: String?,
        stepUpSigner: suspend (String) -> String,
    ) {
        if (_state.value.operationInProgress) return
        viewModelScope.launch {
            _state.value = _state.value.copy(operationInProgress = true, operationMessage = null)
            try {
                val parameters = JSONObject()
                if (action == "open_package") parameters.put("package_name", packageName)
                val operation = repository.submitCommand(
                    action = action,
                    targetDeviceIds = listOf(deviceId),
                    reason = reason,
                    parameters = parameters,
                    stepUpSigner = stepUpSigner,
                )
                refreshInternal(manual = false)
                _state.value = _state.value.copy(
                    operationInProgress = false,
                    operationMessage = "${operation.action.replace('_', ' ')}: ${operation.status}",
                )
            } catch (error: Exception) {
                _state.value = _state.value.copy(
                    operationInProgress = false,
                    operationMessage = userMessage(error),
                )
            }
        }
    }

    fun executeFleetAction(
        action: String,
        reason: String,
        stepUpSigner: suspend (String) -> String,
    ) {
        if (_state.value.operationInProgress) return
        viewModelScope.launch {
            _state.value = _state.value.copy(operationInProgress = true, operationMessage = null)
            try {
                val operation = when (action) {
                    "emergency_stop" -> repository.emergencyStop(reason, stepUpSigner)
                    "resume" -> repository.resume(reason, stepUpSigner)
                    else -> error("Unsupported fleet action")
                }
                refreshInternal(manual = false)
                _state.value = _state.value.copy(
                    operationInProgress = false,
                    operationMessage = "${operation.action.replace('_', ' ')}: ${operation.status}",
                )
            } catch (error: Exception) {
                _state.value = _state.value.copy(
                    operationInProgress = false,
                    operationMessage = userMessage(error),
                )
            }
        }
    }

    fun clearOperationMessage() {
        _state.value = _state.value.copy(operationMessage = null)
    }

    private suspend fun refreshInternal(manual: Boolean) = refreshMutex.withLock {
        if (!_state.value.paired) return@withLock
        _state.value = _state.value.copy(
            loading = _state.value.snapshot == null,
            refreshing = manual && _state.value.snapshot != null,
            errorMessage = if (manual) null else _state.value.errorMessage,
        )
        try {
            val snapshot = repository.snapshot()
            _state.value = ConsoleState(paired = true, snapshot = snapshot)
        } catch (error: Exception) {
            val noSession = error is GatewayException && error.code in setOf(
                "pairing_required", "session_revoked", "refresh_reuse_detected", "invalid_refresh",
            )
            if (noSession) repository.clearLocalSession()
            val previous = _state.value
            _state.value = previous.copy(
                paired = !noSession && repository.hasStoredSession(),
                loading = false,
                refreshing = false,
                errorMessage = userMessage(error),
                consecutiveFailures = previous.consecutiveFailures + 1,
            )
        }
    }

    private fun userMessage(error: Exception): String = when (error) {
        is SSLPeerUnverifiedException -> "Gateway certificate pin did not match. Stop and verify the pairing details."
        is SocketTimeoutException -> "Gateway did not respond on the private network. Showing the last snapshot."
        is VpnRequiredException -> "Connect the approved Tailscale or WireGuard VPN before using Fleet Console."
        is SecurityException -> "Step-up authentication could not be completed. No action was sent."
        is IllegalStateException -> "Secure local session handling failed. No action was sent."
        is GatewayException -> when (error.code) {
            "session_expired", "session_revoked", "pairing_required", "invalid_refresh", "refresh_reuse_detected" ->
                "Mobile session is no longer valid. Pair this phone again."
            "upstream_unavailable" -> "The lab desktop service is offline. Showing the last snapshot."
            "unsafe_upstream_state" -> "Mobile access is blocked because the lab reported an unsafe state."
            "rate_limited" -> "Refresh rate was limited. The console will wait before trying again."
            else -> error.message.take(180)
        }
        is IllegalArgumentException -> error.message?.take(180) ?: "Pairing details are invalid."
        else -> "Private gateway is unavailable. Showing the last snapshot."
    }
}
