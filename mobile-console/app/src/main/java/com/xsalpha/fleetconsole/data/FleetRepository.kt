package com.xsalpha.fleetconsole.data

import com.xsalpha.fleetconsole.model.DashboardSnapshot
import com.xsalpha.fleetconsole.model.MobileOperation
import com.xsalpha.fleetconsole.model.PairingRequest
import com.xsalpha.fleetconsole.network.CanonicalRequest
import com.xsalpha.fleetconsole.network.GatewayApi
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class FleetRepository(private val api: GatewayApi) {
    fun hasStoredSession(): Boolean = api.hasStoredSession()

    suspend fun pair(request: PairingRequest) {
        api.pair(request)
    }

    suspend fun snapshot(): DashboardSnapshot = coroutineScope {
        val identity = async { GatewayJson.identity(api.get("/mobile/v1/me")) }
        val summary = async { GatewayJson.summary(api.get("/mobile/v1/fleet/summary")) }
        val devices = async { GatewayJson.devices(api.get("/mobile/v1/devices?page=1&per_page=100")) }
        val routes = async { GatewayJson.routes(api.get("/mobile/v1/routes?page=1&per_page=100")) }
        val automations = async { GatewayJson.automations(api.get("/mobile/v1/automations")) }
        val alerts = async { GatewayJson.alerts(api.get("/mobile/v1/alerts?limit=25")) }
        val audit = async { GatewayJson.audit(api.get("/mobile/v1/audit?limit=30")) }
        DashboardSnapshot(
            identity = identity.await(),
            summary = summary.await(),
            devices = devices.await(),
            routes = routes.await(),
            automations = automations.await(),
            alerts = alerts.await(),
            audit = audit.await(),
            receivedAtEpochMs = System.currentTimeMillis(),
        )
    }

    suspend fun logout() = api.logout()
    fun clearLocalSession() = api.clearLocalSession()

    suspend fun submitCommand(
        action: String,
        targetDeviceIds: List<Long>,
        reason: String,
        parameters: JSONObject = JSONObject(),
        stepUpSigner: (suspend (String) -> String)? = null,
    ): MobileOperation {
        val stepUpToken = if (requiresStepUp(action, targetDeviceIds)) {
            requireNotNull(stepUpSigner) { "Step-up authentication is required" }
            stepUp(action, targetDeviceIds, stepUpSigner)
        } else null
        val body = JSONObject()
            .put("action", action)
            .put("target_device_ids", JSONArray(targetDeviceIds))
            .put("parameters", parameters)
            .put("reason", reason)
            .put("confirm", true)
            .put("idempotency_key", UUID.randomUUID().toString())
        val accepted = GatewayJson.operation(api.post("/mobile/v1/commands", body, confirmed = true, stepUpToken = stepUpToken))
        return awaitOperation(accepted)
    }

    suspend fun emergencyStop(reason: String, stepUpSigner: suspend (String) -> String): MobileOperation =
        fleetAction("emergency_stop", "/mobile/v1/emergency-stop", reason, stepUpSigner)

    suspend fun resume(reason: String, stepUpSigner: suspend (String) -> String): MobileOperation =
        fleetAction("resume", "/mobile/v1/resume", reason, stepUpSigner)

    private suspend fun fleetAction(
        action: String,
        path: String,
        reason: String,
        stepUpSigner: suspend (String) -> String,
    ): MobileOperation {
        val token = stepUp(action, emptyList(), stepUpSigner)
        val body = JSONObject()
            .put("target_device_ids", JSONArray())
            .put("reason", reason)
            .put("confirm", true)
            .put("idempotency_key", UUID.randomUUID().toString())
        return awaitOperation(GatewayJson.operation(api.post(path, body, confirmed = true, stepUpToken = token)))
    }

    private suspend fun stepUp(
        action: String,
        targets: List<Long>,
        signer: suspend (String) -> String,
    ): String {
        val challengeBody = JSONObject()
            .put("action", action)
            .put("target_device_ids", JSONArray(targets))
        val challenge = GatewayJson.stepUp(api.post("/mobile/v1/session/step-up/challenge", challengeBody))
        val signature = signer(CanonicalRequest.stepUp(challenge.id, challenge.challenge, challenge.action, challenge.targetDeviceIds))
        val completeBody = JSONObject()
            .put("challenge_id", challenge.id)
            .put("challenge", challenge.challenge)
            .put("action", challenge.action)
            .put("target_device_ids", JSONArray(challenge.targetDeviceIds))
            .put("step_up_signature", signature)
        return api.post("/mobile/v1/session/step-up/complete", completeBody)
            .getJSONObject("data")
            .getString("step_up_token")
    }

    private suspend fun awaitOperation(initial: MobileOperation): MobileOperation {
        var operation = initial
        repeat(15) {
            if (operation.status in setOf("succeeded", "failed", "cancelled")) return operation
            delay(1_000)
            operation = GatewayJson.operation(api.get("/mobile/v1/operations/${operation.id}"))
        }
        return operation
    }

    private fun requiresStepUp(action: String, targets: List<Long>): Boolean =
        targets.size > 1 || action in setOf("stop_task", "start_anti_idle", "stop_anti_idle")
}
