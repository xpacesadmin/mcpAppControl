package com.xsalpha.fleetconsole.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.ExperimentalMaterialApi
import androidx.compose.material.pullrefresh.PullRefreshIndicator
import androidx.compose.material.pullrefresh.pullRefresh
import androidx.compose.material.pullrefresh.rememberPullRefreshState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.xsalpha.fleetconsole.model.*

@Composable
fun FleetConsoleApp(viewModel: FleetViewModel, stepUpSigner: suspend (String) -> String) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    if (!state.paired) {
        PairingScreen(state, viewModel::pair)
    } else {
        DashboardScreen(
            state = state,
            onRefresh = viewModel::refresh,
            onLogout = viewModel::logout,
            onDeviceAction = { action, deviceId, reason, packageName ->
                viewModel.executeDeviceAction(action, deviceId, reason, packageName, stepUpSigner)
            },
            onFleetAction = { action, reason -> viewModel.executeFleetAction(action, reason, stepUpSigner) },
            onDismissMessage = viewModel::clearOperationMessage,
        )
    }
}

@Composable
private fun PairingScreen(state: ConsoleState, onPair: (PairingRequest) -> Unit) {
    var gatewayUrl by rememberSaveable { mutableStateOf("") }
    var certificatePin by rememberSaveable { mutableStateOf("") }
    var pairingCode by rememberSaveable { mutableStateOf("") }
    var deviceName by rememberSaveable { mutableStateOf("") }
    Surface(Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = PaddingValues(vertical = 36.dp),
        ) {
            item {
                Text("XSAlpha Fleet Console", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Text(
                    "Pair on the owner-approved Tailscale or WireGuard network. The QR/manual payload contains a one-time code and certificate pin—not the desktop API token.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            item {
                AssistChip(onClick = {}, enabled = false, label = { Text("Private network only • read-only canary") })
            }
            item {
                OutlinedTextField(
                    value = gatewayUrl,
                    onValueChange = { gatewayUrl = it },
                    label = { Text("Gateway HTTPS URL") },
                    placeholder = { Text("https://gateway.example.ts.net:8743") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                OutlinedTextField(
                    value = certificatePin,
                    onValueChange = { certificatePin = it },
                    label = { Text("TLS certificate pin") },
                    placeholder = { Text("sha256/…") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                OutlinedTextField(
                    value = pairingCode,
                    onValueChange = { pairingCode = it.uppercase() },
                    label = { Text("Single-use pairing code") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                OutlinedTextField(
                    value = deviceName,
                    onValueChange = { deviceName = it },
                    label = { Text("Phone name") },
                    placeholder = { Text("Owner phone") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            state.errorMessage?.let { message ->
                item { ErrorBanner(message) }
            }
            item {
                Button(
                    enabled = !state.loading && gatewayUrl.isNotBlank() && certificatePin.isNotBlank() && pairingCode.isNotBlank() && deviceName.isNotBlank(),
                    onClick = {
                        onPair(
                            PairingRequest(
                                endpoint = GatewayEndpoint(gatewayUrl, certificatePin),
                                pairingCode = pairingCode,
                                deviceName = deviceName,
                            ),
                        )
                    },
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) {
                    if (state.loading) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    else Text("Pair securely")
                }
            }
            item {
                Text(
                    "The app requests only Internet and network-state permissions. It has no USB debugging, accessibility, device-admin, contacts, SMS, or discovery permission.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterialApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun DashboardScreen(
    state: ConsoleState,
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
    onDeviceAction: (String, Long, String, String?) -> Unit,
    onFleetAction: (String, String) -> Unit,
    onDismissMessage: () -> Unit,
) {
    val pullState = rememberPullRefreshState(state.refreshing, onRefresh)
    var selectedDevice by remember { mutableStateOf<DeviceSummary?>(null) }
    var pendingFleetAction by remember { mutableStateOf<String?>(null) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Fleet Console", fontWeight = FontWeight.SemiBold)
                        Text("Private read-only view", style = MaterialTheme.typography.labelSmall)
                    }
                },
                actions = {
                    TextButton(onClick = onRefresh, enabled = !state.refreshing) { Text("Refresh") }
                    TextButton(onClick = onLogout) { Text("Log out") }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).pullRefresh(pullState)) {
            val snapshot = state.snapshot
            if (snapshot == null && state.loading) {
                CircularProgressIndicator(Modifier.align(Alignment.Center))
            } else if (snapshot == null) {
                Column(
                    Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    ErrorBanner(state.errorMessage ?: "No dashboard snapshot is available.")
                    Button(onClick = onRefresh) { Text("Try again") }
                }
            } else {
                DashboardList(
                    snapshot = snapshot,
                    offlineMessage = state.errorMessage,
                    operationMessage = state.operationMessage,
                    operationInProgress = state.operationInProgress,
                    onDismissMessage = onDismissMessage,
                    onControls = { selectedDevice = it },
                    onFleetAction = { pendingFleetAction = it },
                )
            }
            PullRefreshIndicator(state.refreshing, pullState, Modifier.align(Alignment.TopCenter))
        }
    }
    selectedDevice?.let { device ->
        DeviceCommandDialog(
            device = device,
            capabilities = state.snapshot?.identity?.capabilities ?: Capabilities(),
            busy = state.operationInProgress,
            onDismiss = { selectedDevice = null },
            onConfirm = { action, reason, packageName ->
                selectedDevice = null
                onDeviceAction(action, device.id, reason, packageName)
            },
        )
    }
    pendingFleetAction?.let { action ->
        FleetActionDialog(
            action = action,
            busy = state.operationInProgress,
            onDismiss = { pendingFleetAction = null },
            onConfirm = { reason ->
                pendingFleetAction = null
                onFleetAction(action, reason)
            },
        )
    }
}

@Composable
private fun DashboardList(
    snapshot: DashboardSnapshot,
    offlineMessage: String?,
    operationMessage: String?,
    operationInProgress: Boolean,
    onDismissMessage: () -> Unit,
    onControls: (DeviceSummary) -> Unit,
    onFleetAction: (String) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        offlineMessage?.let { item { ErrorBanner(it) } }
        operationMessage?.let {
            item { InfoBanner(it, onDismissMessage) }
        }
        if (operationInProgress) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        if (snapshot.summary.freshness.isStale) {
            item { WarningBanner("Data is ${snapshot.summary.freshness.state}; last source update: ${snapshot.summary.freshness.asOf ?: "unknown"}.") }
        }
        if (snapshot.summary.lab.halted) {
            item { ErrorBanner("Fleet halted${snapshot.summary.lab.haltReason?.let { ": $it" } ?: ""}. Reads remain available.") }
        }
        item {
            SectionTitle("Fleet")
            SummaryGrid(snapshot.summary)
        }
        item {
            Text(
                "Signed in as ${snapshot.identity.deviceName} • ${snapshot.identity.role}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        item { SectionTitle("Named devices") }
        items(snapshot.devices, key = { it.id }) { device ->
            DeviceCard(
                device = device,
                controlsEnabled = snapshot.identity.capabilities.writesEnabled && snapshot.identity.capabilities.actions.isNotEmpty(),
                busy = operationInProgress,
                onControls = { onControls(device) },
            )
        }
        item { SectionTitle("Routes") }
        items(snapshot.routes, key = { it.routeId }) { RouteCard(it) }
        item { SectionTitle("Automations") }
        items(snapshot.automations, key = { it.id }) { AutomationCard(it) }
        if (snapshot.alerts.isNotEmpty()) {
            item { SectionTitle("Alerts") }
            items(snapshot.alerts.take(10), key = { it.id }) { AlertCard(it) }
        }
        if (snapshot.audit.isNotEmpty()) {
            item { SectionTitle("Audit timeline") }
            items(snapshot.audit.take(15)) { AuditRow(it) }
        }
        if (snapshot.identity.capabilities.emergencyStop || (snapshot.identity.capabilities.resume && snapshot.summary.lab.halted)) {
            item {
                FleetSafetyControls(
                    halted = snapshot.summary.lab.halted,
                    emergencyStop = snapshot.identity.capabilities.emergencyStop,
                    resume = snapshot.identity.capabilities.resume,
                    busy = operationInProgress,
                    onAction = onFleetAction,
                )
            }
        }
        item {
            Text(
                if (snapshot.identity.capabilities.writesEnabled)
                    "Only server-approved declarative controls are available. Raw ADB, shell, coordinates, workflows, proxy/account changes, and public engagement are not exposed."
                else
                    "No command controls are shown in the read-only canary. Live view and scoped writes require separate owner approval and gateway capabilities.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 16.dp),
            )
        }
    }
}

@Composable
private fun SummaryGrid(summary: FleetSummary) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MetricCard("Online", summary.fleet.online, Color(0xFF10B981), Modifier.weight(1f))
            MetricCard("Busy", summary.fleet.busy, Color(0xFFF59E0B), Modifier.weight(1f))
            MetricCard("Offline", summary.fleet.offline, Color(0xFF64748B), Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MetricCard("Errors", summary.fleet.error, MaterialTheme.colorScheme.error, Modifier.weight(1f))
            MetricCard("Running", summary.tasks.running, Color(0xFF38BDF8), Modifier.weight(1f))
            MetricCard("Failed", summary.tasks.failed, Color(0xFFFB7185), Modifier.weight(1f))
        }
    }
}

@Composable
private fun MetricCard(label: String, value: Int, color: Color, modifier: Modifier = Modifier) {
    Card(modifier) {
        Column(Modifier.padding(12.dp)) {
            Text(value.toString(), style = MaterialTheme.typography.headlineSmall, color = color, fontWeight = FontWeight.Bold)
            Text(label, style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun DeviceCard(
    device: DeviceSummary,
    controlsEnabled: Boolean,
    busy: Boolean,
    onControls: () -> Unit,
) {
    Card {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(device.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                StatusPill(device.status)
            }
            Text(listOfNotNull(device.model, device.timezone, device.fleetVlan?.let { "VLAN $it" }).joinToString(" • "), style = MaterialTheme.typography.bodySmall)
            Text("Route: ${device.route?.routeId ?: "unassigned"} • ${device.route?.healthState ?: "unknown"}", style = MaterialTheme.typography.bodyMedium)
            Text("Observed IP: ${device.route?.observedPublicIp ?: "not verified"}", style = MaterialTheme.typography.bodySmall)
            Text("Account: ${device.accountHealth.state} • assigned ${device.accountHealth.assignedCount}", style = MaterialTheme.typography.bodySmall)
            val battery = device.battery.levelPercent?.let { "${it.toInt()}%" } ?: "unknown"
            Text("Battery: $battery • Last seen: ${device.lastSeenAt ?: "unknown"}", style = MaterialTheme.typography.bodySmall)
            if (controlsEnabled) {
                OutlinedButton(
                    onClick = onControls,
                    enabled = !busy,
                    modifier = Modifier.align(Alignment.End),
                ) { Text("Scoped controls") }
            }
        }
    }
}

private data class ActionPresentation(val label: String, val effect: String)

private val actionPresentation = mapOf(
    "refresh_status" to ActionPresentation("Refresh status", "Ask the named device for a bounded health refresh."),
    "screen_on" to ActionPresentation("Screen on", "Wake the selected device screen."),
    "screen_off" to ActionPresentation("Screen off", "Put the selected device screen to sleep."),
    "home" to ActionPresentation("Home", "Send the Android Home navigation action."),
    "back" to ActionPresentation("Back", "Send the Android Back navigation action."),
    "open_package" to ActionPresentation("Open approved app", "Open one package from the server-approved package list."),
    "media_play" to ActionPresentation("Play media", "Send the fixed Android media-play key."),
    "media_pause" to ActionPresentation("Pause media", "Send the fixed Android media-pause key."),
    "media_next" to ActionPresentation("Next media", "Send the fixed Android media-next key."),
    "stop_task" to ActionPresentation("Stop running task", "Request cancellation of work on this device. Requires biometric/PIN step-up."),
    "start_anti_idle" to ActionPresentation("Start configured guard", "Start the already-defined anti-idle guard without changing its targets. Requires step-up."),
    "stop_anti_idle" to ActionPresentation("Stop configured guard", "Stop the already-defined anti-idle guard. Requires step-up."),
)

@Composable
private fun DeviceCommandDialog(
    device: DeviceSummary,
    capabilities: Capabilities,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String, String, String?) -> Unit,
) {
    val actions = capabilities.actions.filter(actionPresentation::containsKey).filter {
        it != "open_package" || capabilities.approvedPackages.isNotEmpty()
    }.sorted()
    var selectedAction by remember(device.id, actions) { mutableStateOf(actions.firstOrNull().orEmpty()) }
    var reason by remember(device.id) { mutableStateOf("") }
    var confirmed by remember(device.id) { mutableStateOf(false) }
    var selectedPackage by remember(device.id, capabilities.approvedPackages) {
        mutableStateOf(capabilities.approvedPackages.firstOrNull())
    }
    val presentation = actionPresentation[selectedAction]
    val routeVerified = device.inCommandScope && device.route?.healthState == "verified"
    val ready = selectedAction.isNotBlank() && reason.trim().length in 4..240 && confirmed && routeVerified &&
        (selectedAction != "open_package" || selectedPackage != null)
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Confirm scoped command") },
        text = {
            Column(
                Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("Target: ${device.name}", fontWeight = FontWeight.Bold)
                Text("Device ID ${device.id} • Route ${device.route?.routeId ?: "unassigned"} • ${device.route?.healthState ?: "unknown"}")
                if (!routeVerified) ErrorBanner("Command blocked: target scope and a verified assigned route are required.")
                if (actions.isEmpty()) WarningBanner("The gateway enabled no controls supported by this APK build.")
                actions.forEach { action ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = selectedAction == action, onClick = { selectedAction = action })
                        Column {
                            Text(actionPresentation.getValue(action).label, fontWeight = FontWeight.Medium)
                            Text(actionPresentation.getValue(action).effect, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                if (selectedAction == "open_package") {
                    Text("Approved package", fontWeight = FontWeight.SemiBold)
                    capabilities.approvedPackages.forEach { packageName ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = selectedPackage == packageName, onClick = { selectedPackage = packageName })
                            Text(packageName)
                        }
                    }
                }
                presentation?.let { Text("Expected effect: ${it.effect}", style = MaterialTheme.typography.bodyMedium) }
                OutlinedTextField(
                    value = reason,
                    onValueChange = { if (it.length <= 240) reason = it },
                    label = { Text("Reason") },
                    supportingText = { Text("Required; recorded in the sanitized audit trail") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = confirmed, onCheckedChange = { confirmed = it })
                    Text("I confirm this exact action on ${device.name}.")
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(selectedAction, reason.trim(), selectedPackage) },
                enabled = ready && !busy,
            ) { Text(if (selectedAction in setOf("stop_task", "start_anti_idle", "stop_anti_idle")) "Authenticate & run" else "Run once") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FleetSafetyControls(
    halted: Boolean,
    emergencyStop: Boolean,
    resume: Boolean,
    busy: Boolean,
    onAction: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SectionTitle("Fleet safety")
        if (emergencyStop && !halted) {
            Surface(
                color = MaterialTheme.colorScheme.error,
                contentColor = MaterialTheme.colorScheme.onError,
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth().combinedClickable(
                    enabled = !busy,
                    onClick = {},
                    onLongClick = { onAction("emergency_stop") },
                ),
            ) {
                Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Hold to request emergency stop", fontWeight = FontWeight.Bold)
                    Text("Stops new work and requests cancellation; proxy state is not cleared.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        if (resume && halted) {
            Button(onClick = { onAction("resume") }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text("Review and resume fleet")
            }
        }
    }
}

@Composable
private fun FleetActionDialog(
    action: String,
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var reason by remember(action) { mutableStateOf("") }
    var confirmed by remember(action) { mutableStateOf(false) }
    val emergency = action == "emergency_stop"
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (emergency) "Emergency stop" else "Resume fleet") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    if (emergency)
                        "This requests cancellation and blocks new work. It does not remove route or proxy protection."
                    else
                        "Resume removes the halt only. Schedules remain disabled and are not restarted automatically.",
                )
                OutlinedTextField(
                    value = reason,
                    onValueChange = { if (it.length <= 240) reason = it },
                    label = { Text("Reason") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = confirmed, onCheckedChange = { confirmed = it })
                    Text("I understand the exact fleet-wide effect.")
                }
                Text("A fresh strong biometric or device PIN is required.", style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(reason.trim()) },
                enabled = confirmed && reason.trim().length in 4..240 && !busy,
                colors = if (emergency) ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error) else ButtonDefaults.buttonColors(),
            ) { Text("Authenticate & ${if (emergency) "stop" else "resume"}") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}

@Composable
private fun RouteCard(route: RouteSummary) {
    Card {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(route.routeId, fontWeight = FontWeight.SemiBold)
                Text("Device ${route.deviceId ?: "—"} • VLAN ${route.fleetVlan ?: "—"}", style = MaterialTheme.typography.bodySmall)
                Text("Observed IP ${route.observedPublicIp ?: "not verified"}", style = MaterialTheme.typography.bodySmall)
            }
            StatusPill(route.healthState)
        }
    }
}

@Composable
private fun AutomationCard(automation: AutomationStatus) {
    Card {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(automation.name, fontWeight = FontWeight.SemiBold)
                Text(if (!automation.available) "Unavailable at this approved base" else "Targets: ${automation.targetDeviceIds.joinToString().ifBlank { "none" }}", style = MaterialTheme.typography.bodySmall)
                automation.lastError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
            StatusPill(if (!automation.available) "unavailable" else if (automation.running) "running" else if (automation.enabled) "enabled" else "stopped")
        }
    }
}

@Composable
private fun AlertCard(alert: AlertItem) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Text("${alert.severity.uppercase()} • ${alert.type}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
            alert.message?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            alert.occurredAt?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun AuditRow(item: AuditItem) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row {
            Text(item.operation, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            Text(item.result, style = MaterialTheme.typography.labelMedium)
        }
        Text("${item.source} • ${item.actor}${item.role?.let { " • $it" } ?: ""}${item.deviceId?.let { " • device $it" } ?: ""}", style = MaterialTheme.typography.bodySmall)
        item.occurredAt?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        HorizontalDivider(Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun SectionTitle(value: String) {
    Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun StatusPill(value: String) {
    val color = when (value.lowercase()) {
        "online", "verified", "present", "running", "enabled" -> Color(0xFF10B981)
        "busy", "needs_reauth", "unverified", "stale" -> Color(0xFFF59E0B)
        "offline", "stopped", "unavailable", "unknown" -> Color(0xFF64748B)
        else -> MaterialTheme.colorScheme.error
    }
    Text(
        value.replace('_', ' '),
        color = Color.White,
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.background(color, MaterialTheme.shapes.extraLarge).padding(horizontal = 9.dp, vertical = 4.dp),
    )
}

@Composable
private fun ErrorBanner(message: String) {
    Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.medium) {
        Text(message, color = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.fillMaxWidth().padding(12.dp))
    }
}

@Composable
private fun InfoBanner(message: String, onDismiss: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(message, color = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.weight(1f))
            TextButton(onClick = onDismiss) { Text("Dismiss") }
        }
    }
}

@Composable
private fun WarningBanner(message: String) {
    Surface(color = Color(0xFF7C4A03), shape = MaterialTheme.shapes.medium) {
        Text(message, color = Color.White, modifier = Modifier.fillMaxWidth().padding(12.dp))
    }
}
