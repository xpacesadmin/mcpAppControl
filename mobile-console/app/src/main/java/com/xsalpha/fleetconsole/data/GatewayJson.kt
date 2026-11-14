package com.xsalpha.fleetconsole.data

import com.xsalpha.fleetconsole.model.*
import org.json.JSONArray
import org.json.JSONObject

internal object GatewayJson {
    fun identity(root: JSONObject): Identity {
        val data = root.getJSONObject("data")
        val device = data.getJSONObject("device")
        val capabilities = data.getJSONObject("capabilities")
        return Identity(
            deviceId = device.getString("id"),
            deviceName = device.getString("name"),
            role = data.getString("role"),
            capabilities = Capabilities(
                writesEnabled = capabilities.optBoolean("writes_enabled", false),
                liveView = capabilities.optBoolean("live_view", false),
                emergencyStop = capabilities.optBoolean("emergency_stop", false),
                resume = capabilities.optBoolean("resume", false),
                actions = capabilities.optJSONArray("actions").strings().toSet(),
                approvedPackages = capabilities.optJSONArray("approved_packages").strings(),
            ),
        )
    }

    fun stepUp(root: JSONObject): StepUpChallenge {
        val data = root.getJSONObject("data")
        return StepUpChallenge(
            id = data.getString("challenge_id"),
            challenge = data.getString("challenge"),
            action = data.getString("action"),
            targetDeviceIds = data.optJSONArray("target_device_ids").longs(),
        )
    }

    fun operation(root: JSONObject): MobileOperation {
        val data = root.getJSONObject("data")
        return MobileOperation(
            id = data.getString("operation_id"),
            action = data.getString("action"),
            targetDeviceIds = data.optJSONArray("target_device_ids").longs(),
            status = data.getString("status"),
            updatedAt = data.stringOrNull("updated_at"),
        )
    }

    fun summary(root: JSONObject): FleetSummary {
        val data = root.getJSONObject("data")
        val fleet = data.getJSONObject("fleet")
        val tasks = data.getJSONObject("tasks")
        val lab = data.getJSONObject("lab")
        return FleetSummary(
            fleet = FleetCounts(fleet.int("total"), fleet.int("online"), fleet.int("busy"), fleet.int("offline"), fleet.int("error")),
            tasks = TaskCounts(tasks.int("running"), tasks.int("scheduled"), tasks.int("failed"), tasks.int("completed")),
            lab = LabState(lab.optBoolean("halted"), lab.stringOrNull("halt_reason"), lab.optString("scope", "unknown")),
            freshness = freshness(root),
        )
    }

    fun devices(root: JSONObject): List<DeviceSummary> = root.getJSONObject("data").getJSONArray("items").objects().map { device ->
        val battery = device.optJSONObject("battery") ?: JSONObject()
        val account = device.optJSONObject("account_health") ?: JSONObject()
        val counts = account.optJSONObject("counts") ?: JSONObject()
        DeviceSummary(
            id = device.getLong("id"),
            name = device.getString("name"),
            model = device.stringOrNull("model"),
            status = device.optString("status", "error"),
            fleetVlan = device.intOrNull("fleet_vlan"),
            route = device.optJSONObject("route")?.let(::route),
            timezone = device.stringOrNull("timezone"),
            battery = BatteryHealth(
                levelPercent = battery.doubleOrNull("level_percent"),
                charging = battery.booleanOrNull("charging"),
                temperatureC = battery.doubleOrNull("temperature_c"),
                storageFreeMb = battery.doubleOrNull("storage_free_mb"),
            ),
            accountHealth = AccountHealth(
                state = account.optString("state", "unknown"),
                assignedCount = account.int("assigned_count"),
                presentCount = counts.int("present"),
                missingCount = counts.int("missing"),
                swappedCount = counts.int("swapped"),
                needsReauthCount = counts.int("needs_reauth"),
                lastVerifiedAt = account.stringOrNull("last_verified_at"),
            ),
            currentTaskId = device.optJSONObject("current_task")?.optLong("id")?.takeIf { it > 0 },
            lastSeenAt = device.stringOrNull("last_seen_at"),
            inCommandScope = device.optBoolean("in_command_scope", false),
        )
    }

    fun routes(root: JSONObject): List<RouteSummary> = root.getJSONObject("data").getJSONArray("items").objects().map(::route)

    fun automations(root: JSONObject): List<AutomationStatus> = root.getJSONObject("data").getJSONArray("automations").objects().map { automation ->
        AutomationStatus(
            id = automation.getString("id"),
            name = automation.getString("name"),
            available = automation.optBoolean("available", false),
            enabled = automation.optBoolean("enabled", false),
            running = automation.optBoolean("running", false),
            targetDeviceIds = automation.optJSONArray("target_device_ids").longs(),
            lastRunAt = automation.stringOrNull("last_run_at"),
            nextRunAt = automation.stringOrNull("next_run_at"),
            lastError = automation.stringOrNull("last_error"),
        )
    }

    fun alerts(root: JSONObject): List<AlertItem> = root.getJSONObject("data").getJSONArray("items").objects().map { alert ->
        AlertItem(
            id = alert.optLong("id"),
            type = alert.optString("type", "unknown"),
            severity = alert.optString("severity", "info"),
            message = alert.stringOrNull("message"),
            occurredAt = alert.stringOrNull("occurred_at"),
        )
    }

    fun audit(root: JSONObject): List<AuditItem> = root.getJSONObject("data").getJSONArray("items").objects().map { event ->
        AuditItem(
            source = event.optString("source", "unknown"),
            operation = event.optString("operation", "unknown"),
            actor = event.optString("actor", "unknown"),
            role = event.stringOrNull("role"),
            result = event.optString("result", "unknown"),
            deviceId = event.longOrNull("device_id"),
            occurredAt = event.stringOrNull("occurred_at"),
        )
    }

    private fun route(value: JSONObject) = RouteSummary(
        routeId = value.optString("route_id", "unknown"),
        deviceId = value.longOrNull("assigned_device_id"),
        fleetVlan = value.intOrNull("fleet_vlan"),
        healthState = value.optString("health_state", "unknown"),
        observedPublicIp = value.stringOrNull("observed_public_ip"),
        lastVerifiedAt = value.stringOrNull("last_verified_at"),
    )

    private fun freshness(root: JSONObject): DataFreshness {
        val value = root.optJSONObject("data_freshness") ?: JSONObject()
        return DataFreshness(
            asOf = value.stringOrNull("as_of"),
            ageSeconds = value.longOrNull("age_seconds"),
            maximumAgeSeconds = value.optLong("maximum_age_seconds", 60),
            state = value.optString("state", "unknown"),
        )
    }

    private fun JSONObject.int(name: String): Int = optInt(name, 0)
    private fun JSONObject.stringOrNull(name: String): String? = if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
    private fun JSONObject.intOrNull(name: String): Int? = if (isNull(name) || !has(name)) null else optInt(name)
    private fun JSONObject.longOrNull(name: String): Long? = if (isNull(name) || !has(name)) null else optLong(name)
    private fun JSONObject.doubleOrNull(name: String): Double? = if (isNull(name) || !has(name)) null else optDouble(name).takeIf { it.isFinite() }
    private fun JSONObject.booleanOrNull(name: String): Boolean? = if (isNull(name) || !has(name)) null else optBoolean(name)
    private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
    private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it).takeIf(String::isNotBlank) }
    private fun JSONArray?.longs(): List<Long> = if (this == null) emptyList() else (0 until length()).mapNotNull { optLong(it).takeIf { value -> value > 0 } }
}
