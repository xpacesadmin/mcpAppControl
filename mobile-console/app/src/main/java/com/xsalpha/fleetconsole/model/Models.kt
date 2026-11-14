package com.xsalpha.fleetconsole.model

data class GatewayEndpoint(
    val baseUrl: String,
    val certificatePin: String,
)

data class StoredSession(
    val endpoint: GatewayEndpoint,
    val deviceId: String,
    val sessionId: String,
    val refreshToken: String,
    val refreshExpiresAt: String,
)

data class AccessSession(
    val accessToken: String,
    val accessExpiresAt: String,
)

data class PairingRequest(
    val endpoint: GatewayEndpoint,
    val pairingCode: String,
    val deviceName: String,
)

data class Capabilities(
    val writesEnabled: Boolean = false,
    val liveView: Boolean = false,
    val emergencyStop: Boolean = false,
    val resume: Boolean = false,
    val actions: Set<String> = emptySet(),
    val approvedPackages: List<String> = emptyList(),
)

data class StepUpChallenge(
    val id: String,
    val challenge: String,
    val action: String,
    val targetDeviceIds: List<Long>,
)

data class MobileOperation(
    val id: String,
    val action: String,
    val targetDeviceIds: List<Long>,
    val status: String,
    val updatedAt: String?,
)

data class Identity(
    val deviceId: String,
    val deviceName: String,
    val role: String,
    val capabilities: Capabilities,
)

data class DataFreshness(
    val asOf: String?,
    val ageSeconds: Long?,
    val maximumAgeSeconds: Long,
    val state: String,
) {
    val isStale: Boolean get() = state != "fresh"
}

data class FleetCounts(
    val total: Int,
    val online: Int,
    val busy: Int,
    val offline: Int,
    val error: Int,
)

data class TaskCounts(
    val running: Int,
    val scheduled: Int,
    val failed: Int,
    val completed: Int,
)

data class LabState(
    val halted: Boolean,
    val haltReason: String?,
    val scope: String,
)

data class FleetSummary(
    val fleet: FleetCounts,
    val tasks: TaskCounts,
    val lab: LabState,
    val freshness: DataFreshness,
)

data class RouteSummary(
    val routeId: String,
    val deviceId: Long?,
    val fleetVlan: Int?,
    val healthState: String,
    val observedPublicIp: String?,
    val lastVerifiedAt: String?,
)

data class AccountHealth(
    val state: String,
    val assignedCount: Int,
    val presentCount: Int,
    val missingCount: Int,
    val swappedCount: Int,
    val needsReauthCount: Int,
    val lastVerifiedAt: String?,
)

data class BatteryHealth(
    val levelPercent: Double?,
    val charging: Boolean?,
    val temperatureC: Double?,
    val storageFreeMb: Double?,
)

data class DeviceSummary(
    val id: Long,
    val name: String,
    val model: String?,
    val status: String,
    val fleetVlan: Int?,
    val route: RouteSummary?,
    val timezone: String?,
    val battery: BatteryHealth,
    val accountHealth: AccountHealth,
    val currentTaskId: Long?,
    val lastSeenAt: String?,
    val inCommandScope: Boolean,
)

data class AutomationStatus(
    val id: String,
    val name: String,
    val available: Boolean,
    val enabled: Boolean,
    val running: Boolean,
    val targetDeviceIds: List<Long>,
    val lastRunAt: String?,
    val nextRunAt: String?,
    val lastError: String?,
)

data class AlertItem(
    val id: Long,
    val type: String,
    val severity: String,
    val message: String?,
    val occurredAt: String?,
)

data class AuditItem(
    val source: String,
    val operation: String,
    val actor: String,
    val role: String?,
    val result: String,
    val deviceId: Long?,
    val occurredAt: String?,
)

data class DashboardSnapshot(
    val identity: Identity,
    val summary: FleetSummary,
    val devices: List<DeviceSummary>,
    val routes: List<RouteSummary>,
    val automations: List<AutomationStatus>,
    val alerts: List<AlertItem>,
    val audit: List<AuditItem>,
    val receivedAtEpochMs: Long,
)

data class ConsoleState(
    val paired: Boolean = false,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val snapshot: DashboardSnapshot? = null,
    val errorMessage: String? = null,
    val consecutiveFailures: Int = 0,
    val operationInProgress: Boolean = false,
    val operationMessage: String? = null,
)
