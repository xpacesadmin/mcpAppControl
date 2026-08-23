import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { readFileSync } from "node:fs";
import { ANTI_IDLE_TOOLS } from "./anti-idle-tools.js";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000/api/v1";
const BACKEND_TOKEN = (() => {
    if (process.env.BACKEND_TOKEN) return process.env.BACKEND_TOKEN.trim();
    if (!process.env.BACKEND_TOKEN_FILE) return "";
    try {
        return readFileSync(process.env.BACKEND_TOKEN_FILE, "utf8").trim();
    } catch (error) {
        console.error(`No se pudo leer BACKEND_TOKEN_FILE: ${(error as Error).message}`);
        return "";
    }
})();

const api = axios.create({
    baseURL: BACKEND_URL,
    headers: BACKEND_TOKEN ? { Authorization: `Bearer ${BACKEND_TOKEN}` } : {},
    timeout: 30000,
});

// ============================================================
// MCP Tool Definitions
// ============================================================

const TOOLS = [
    // Device tools
    {
        name: "devices_list",
        description: "Lista todos los dispositivos registrados en la flota",
        inputSchema: {
            type: "object",
            properties: {
                page: { type: "number", minimum: 1 },
                per_page: { type: "number", minimum: 1, maximum: 500, description: "Defaults to 200 so the fleet is not silently truncated" },
                status: { type: "string", enum: ["online", "busy", "error", "offline"] },
                search: { type: "string" },
            },
        },
    },
    {
        name: "devices_get_status",
        description: "Obtiene el estado actual de un dispositivo (por ID o número de serie), con sus últimos logs",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "string", description: "ID o número de serie del dispositivo" },
            },
            required: ["device_id"],
        },
    },
    {
        name: "devices_register",
        description: "Registra un nuevo dispositivo en la flota",
        inputSchema: {
            type: "object",
            properties: {
                serial_number: { type: "string" },
                name: { type: "string" },
                model: { type: "string" },
                android_version: { type: "string" },
            },
            required: ["serial_number"],
        },
    },
    {
        name: "devices_stats",
        description: "Estadísticas de salud de la flota (online/busy/offline)",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "devices_stabilize",
        description: "Estabiliza dispositivos ADB: despierta la pantalla, configura tiempo de espera, animaciones y opcionalmente hora/zona; verifica cada cambio",
        inputSchema: {
            type: "object",
            properties: {
                device_ids: { type: "array", items: { type: "number" }, minItems: 1 },
                keep_awake: { type: "boolean" },
                screen_timeout_minutes: { type: "number", minimum: 1, maximum: 120 },
                animation_scale: { type: "number", enum: [0, 0.5, 1] },
                sync_time: { type: "boolean", description: "Defaults to true; synchronize and verify the device clock" },
                clock_source: { type: "string", enum: ["host", "automatic"], description: "host copies the MCP host epoch; automatic uses Android network time" },
                timezone: { type: "string", description: "Zona IANA; defaults to MCP_DEFAULT_TIMEZONE or the MCP host timezone" },
                max_clock_drift_seconds: { type: "number", minimum: 1, maximum: 60 },
            },
            required: ["device_ids"],
        },
    },
    {
        name: "devices_network_status",
        description: "Diagnostica proxy, IP local, ruta, fecha, zona horaria y ajustes de estabilidad en varios dispositivos",
        inputSchema: {
            type: "object",
            properties: {
                device_ids: { type: "array", items: { type: "number" }, minItems: 1 },
            },
            required: ["device_ids"],
        },
    },
    {
        name: "devices_clear_proxy",
        description: "Libera la ruta nombrada activa y deja un único dispositivo canario sin proxy global",
        inputSchema: {
            type: "object",
            properties: {
                device_ids: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 1 },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["device_ids", "confirm", "idempotency_key"],
        },
    },
    {
        name: "device_command",
        description: "Runs one explicit canary-full ADB command on one named device; destructive commands require confirm=true",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "number" },
                command: {
                    type: "string",
                    enum: [
                        "OPEN_APP", "GOTO_URL", "CLICK_BY_TEXT", "CLICK_BY_ID", "SET_TEXT", "SCROLL", "SWIPE",
                        "PRESS_BACK", "PRESS_HOME", "PLAY_MEDIA", "PAUSE_MEDIA", "WAIT_FOR_ELEMENT", "CAPTURE_SCREEN",
                        "DEVICE_HEALTH", "DEVICE_NETWORK_STATUS", "CHECK_IP", "TAP_XY", "INPUT_KEYEVENT", "TYPE_TEXT",
                        "START_ACTIVITY", "FORCE_STOP", "GRANT_PERMISSION", "SETTINGS_GET", "SCREEN_ON", "SCREEN_OFF",
                        "UNLOCK", "KEEP_AWAKE", "SET_TIME_AUTO", "SET_TIMEZONE", "GET_TIME", "DEVICE_STABILIZE",
                        "READ_SCREEN_TEXT", "SCREEN_RECORD", "PULL_FILE", "CLEAR_APP", "UNINSTALL_APP", "INSTALL_APK",
                        "SETTINGS_PUT", "REBOOT", "MONKEY", "PUSH_FILE"
                    ]
                },
                params: { type: "object", additionalProperties: true },
                confirm: { type: "boolean" },
            },
            required: ["device_id", "command", "confirm"],
        },
    },

    // Proxy tools
    // Supervised lab controls
    {
        name: "lab_status",
        description: "Shows canary scope, halt state, and whether Hermes is disabled",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "configure_lab_canary",
        description: "Selects the single approved canary device; requires explicit confirmation",
        inputSchema: {
            type: "object",
            properties: {
                canary_device_id: { type: "number" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["canary_device_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "emergency_stop",
        description: "Stops new work, requests cancellation of running tasks, and disables schedules; it does not clear a device proxy",
        inputSchema: {
            type: "object",
            properties: {
                reason: { type: "string" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["reason", "confirm", "idempotency_key"],
        },
    },
    {
        name: "resume_lab",
        description: "Clears the application halt after operator review; schedules remain disabled",
        inputSchema: {
            type: "object",
            properties: {
                reason: { type: "string" },
                confirm_resume: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["reason", "confirm_resume", "idempotency_key"],
        },
    },

    ...ANTI_IDLE_TOOLS,

    // Credential-free stable proxy routes
    {
        name: "list_proxy_routes",
        description: "Lists stable Proxy Orch route IDs without provider credentials",
        inputSchema: {
            type: "object",
            properties: {
                health_state: { type: "string" },
                assigned_device_id: { type: "number" },
            },
        },
    },
    {
        name: "inspect_proxy_route",
        description: "Inspects one stable Proxy Orch route and its active assignment",
        inputSchema: {
            type: "object",
            properties: { route_id: { type: "string" } },
            required: ["route_id"],
        },
    },
    {
        name: "enroll_proxy_route",
        description: "Registers credential-free route metadata for an existing Proxy Orch listener",
        inputSchema: {
            type: "object",
            properties: {
                route_id: { type: "string" },
                provider: { type: "string" },
                internal_host: { type: "string" },
                internal_port: { type: "number" },
                protocol: { type: "string", enum: ["HTTP", "HTTPS", "SOCKS5"] },
                country: { type: "string" },
                region: { type: "string" },
                city: { type: "string" },
                classification: { type: "string", enum: ["dedicated_static"] },
                expected_public_ip: { type: "string" },
                assigned_fleet_vlan: { type: "number", enum: [60, 61] },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["route_id", "provider", "internal_host", "internal_port", "protocol", "classification", "confirm", "idempotency_key"],
        },
    },
    {
        name: "test_proxy_route",
        description: "Tests a Proxy Orch listener from the named canary when device_id is provided; otherwise tests desktop TCP reachability",
        inputSchema: {
            type: "object",
            properties: {
                route_id: { type: "string" },
                device_id: { type: "number" },
                timeout_ms: { type: "number", minimum: 250, maximum: 10000 },
                idempotency_key: { type: "string" },
                confirm: { type: "boolean" },
            },
            required: ["route_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "assign_proxy_route",
        description: "Applies one stable route to the named canary through guarded ADB, then records the active assignment",
        inputSchema: {
            type: "object",
            properties: {
                route_id: { type: "string" },
                device_id: { type: "number" },
                expected_previous_route_id: { anyOf: [{ type: "string" }, { type: "null" }] },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["route_id", "device_id", "expected_previous_route_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "release_proxy_route",
        description: "Releases the expected canary route and either restores the prior Android proxy or goes direct",
        inputSchema: {
            type: "object",
            properties: {
                route_id: { type: "string" },
                device_id: { type: "number" },
                restore_mode: { type: "string", enum: ["previous", "direct"] },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["route_id", "device_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "rotate_proxy_route",
        description: "Rotates one named device from its expected current stable route to a verified free route, verifies egress, and rolls back on mismatch",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "number" },
                expected_previous_route_id: { type: "string" },
                target_route_id: { type: "string", description: "Optional explicit free route; omitted selects the next route deterministically" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["device_id", "expected_previous_route_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "request_proxy_rotation",
        description: "Requests an IP refresh for one named device through its active Proxy Orch route. Provider URLs and credentials never enter MCP input or output.",
        inputSchema: {
            type: "object",
            properties: {
                route_id: { type: "string" },
                device_id: { type: "number" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
                timeout_ms: { type: "number", minimum: 1000, maximum: 30000 },
            },
            required: ["route_id", "device_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "set_device_proxy_direct",
        description: "Releases any active named route and clears Android's global proxy for one named canary",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "number" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["device_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "verify_device_egress",
        description: "Compares device-observed egress with the route expected IP and halts the lab on mismatch",
        inputSchema: {
            type: "object",
            properties: {
                route_id: { type: "string" },
                device_id: { type: "number" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["route_id", "device_id", "confirm", "idempotency_key"],
        },
    },

    // Credential-free account profiles
    {
        name: "list_account_profiles",
        description: "Lists account profile metadata without passwords, TOTP values, or secret references",
        inputSchema: {
            type: "object",
            properties: {
                platform: { type: "string" },
                status: { type: "string" },
                device_id: { type: "number" },
            },
        },
    },
    {
        name: "inspect_account_profile",
        description: "Inspects one credential-free account profile",
        inputSchema: {
            type: "object",
            properties: { account_id: { type: "number" } },
            required: ["account_id"],
        },
    },
    {
        name: "enroll_account_profile",
        description: "Creates account metadata linked to a restricted local secret reference; secret values are rejected",
        inputSchema: {
            type: "object",
            properties: {
                platform: { type: "string" },
                username: { type: "string" },
                email: { type: "string" },
                secret_ref: { type: "string" },
                notes: { type: "string" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["platform", "secret_ref", "confirm", "idempotency_key"],
        },
    },
    {
        name: "assign_account_profile",
        description: "Assigns one profile to the named canary after checking the previous active profile",
        inputSchema: {
            type: "object",
            properties: {
                account_id: { type: "number" },
                device_id: { type: "number" },
                expected_previous_account_id: { anyOf: [{ type: "number" }, { type: "null" }] },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["account_id", "device_id", "expected_previous_account_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "release_account_profile",
        description: "Releases the expected active profile from the named canary",
        inputSchema: {
            type: "object",
            properties: {
                account_id: { type: "number" },
                device_id: { type: "number" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["account_id", "device_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "inspect_google_accounts",
        description: "Returns only the Google account count and enrollment/rotation state for a named device; identifiers are not exposed",
        inputSchema: {
            type: "object",
            properties: { device_id: { type: "number" } },
            required: ["device_id"],
        },
    },
    {
        name: "start_google_account_enrollment",
        description: "Opens Android's native Google account enrollment UI; credentials remain on the device and owner interaction is required",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "number" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["device_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "verify_google_account_enrollment",
        description: "Checks whether the sanitized Google account count increased after supervised enrollment",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "number" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["device_id", "confirm", "idempotency_key"],
        },
    },
    {
        name: "set_google_account_rotation",
        description: "Enables or disables owner-supervised Google account rotation for one named device",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "number" },
                enabled: { type: "boolean" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["device_id", "enabled", "confirm", "idempotency_key"],
        },
    },
    {
        name: "open_google_account_rotation",
        description: "Opens Android's native Google account settings when rotation is allowed and at least two accounts exist; no automatic OS switch is claimed",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "number" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["device_id", "confirm", "idempotency_key"],
        },
    },

    {
        name: "proxies_list",
        description: "Lista el pool de proxies, capacidad y asignaciones sin revelar contraseñas",
        inputSchema: {
            type: "object",
            properties: {
                status: { type: "string", enum: ["active", "disabled", "error"] },
                country: { type: "string" },
            },
        },
    },
    {
        name: "proxies_create",
        description: "Agrega un proxy HTTP al pool cifrado",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string" },
                host: { type: "string" },
                port: { type: "number" },
                username: { type: "string" },
                password: { type: "string" },
                country: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                max_devices: { type: "number", minimum: 1 },
            },
            required: ["host", "port"],
        },
    },
    {
        name: "proxies_import",
        description: "Importa varios proxies HTTP al pool en una operación",
        inputSchema: {
            type: "object",
            properties: {
                proxies: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            host: { type: "string" },
                            port: { type: "number" },
                            username: { type: "string" },
                            password: { type: "string" },
                            country: { type: "string" },
                            tags: { type: "array", items: { type: "string" } },
                            max_devices: { type: "number", minimum: 1 },
                        },
                        required: ["host", "port"],
                    },
                },
            },
            required: ["proxies"],
        },
    },
    {
        name: "proxies_distribute",
        description: "Distribuye proxies disponibles entre dispositivos online, respetando capacidad y filtros",
        inputSchema: {
            type: "object",
            properties: {
                device_ids: { type: "array", items: { type: "number" } },
                group_id: { type: "number" },
                strategy: { type: "string", enum: ["round_robin", "random"] },
                country: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
            },
        },
    },
    {
        name: "device_proxy_assign",
        description: "Asigna un proxy específico o el siguiente disponible a un dispositivo",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "string" },
                proxy_id: { type: "number" },
                strategy: { type: "string", enum: ["round_robin", "random"] },
                country: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
            },
            required: ["device_id"],
        },
    },
    {
        name: "device_proxy_rotate",
        description: "Cambia un dispositivo al siguiente proxy disponible",
        inputSchema: {
            type: "object",
            properties: {
                device_id: { type: "string" },
                strategy: { type: "string", enum: ["round_robin", "random"] },
                country: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
            },
            required: ["device_id"],
        },
    },
    {
        name: "device_proxy_clear",
        description: "Quita el proxy del dispositivo y libera la asignación",
        inputSchema: {
            type: "object",
            properties: { device_id: { type: "string" } },
            required: ["device_id"],
        },
    },
    {
        name: "device_proxy_check_ip",
        description: "Comprueba la IP de salida actual de un dispositivo",
        inputSchema: {
            type: "object",
            properties: { device_id: { type: "string" } },
            required: ["device_id"],
        },
    },

    // Group tools
    {
        name: "groups_list",
        description: "Lista los grupos de dispositivos",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "groups_create",
        description: "Crea un nuevo grupo de dispositivos",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string" },
                description: { type: "string" },
                max_devices: { type: "number" },
            },
            required: ["name"],
        },
    },
    {
        name: "groups_assign_devices",
        description: "Asigna dispositivos a un grupo",
        inputSchema: {
            type: "object",
            properties: {
                group_id: { type: "string" },
                device_ids: { type: "array", items: { type: "number" } },
            },
            required: ["group_id", "device_ids"],
        },
    },
    {
        name: "groups_pause",
        description: "Pausa un grupo: sus dispositivos dejan de recibir tareas nuevas",
        inputSchema: {
            type: "object",
            properties: { group_id: { type: "string" } },
            required: ["group_id"],
        },
    },
    {
        name: "groups_resume",
        description: "Reanuda un grupo pausado",
        inputSchema: {
            type: "object",
            properties: { group_id: { type: "string" } },
            required: ["group_id"],
        },
    },

    // Workflow tools
    {
        name: "workflows_list",
        description: "Lista los workflows definidos",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "workflows_create",
        description: "Crea un nuevo workflow con pasos de automatización (OPEN_APP, CLICK_BY_TEXT, SET_TEXT, PLAY_MEDIA, ...)",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string" },
                description: { type: "string" },
                steps: { type: "array" },
                allowed_package: { type: "string" },
            },
            required: ["name", "steps"],
        },
    },
    {
        name: "workflows_validate",
        description: "Valida la estructura y pasos de un workflow existente",
        inputSchema: {
            type: "object",
            properties: { workflow_id: { type: "string" } },
            required: ["workflow_id"],
        },
    },
    {
        name: "workflows_execute",
        description: "Ejecuta un workflow ahora en dispositivos específicos, un grupo, o todos los online",
        inputSchema: {
            type: "object",
            properties: {
                workflow_id: { type: "string" },
                group_id: { type: "string" },
                device_ids: { type: "array", items: { type: "number" } },
                params: { type: "object" },
            },
            required: ["workflow_id"],
        },
    },

    // Task tools
    {
        name: "tasks_list",
        description: "Lista tareas (filtrable por status)",
        inputSchema: {
            type: "object",
            properties: { status: { type: "string" } },
        },
    },
    {
        name: "tasks_schedule",
        description: "Programa una tarea para ejecución futura",
        inputSchema: {
            type: "object",
            properties: {
                workflow_id: { type: "string" },
                scheduled_at: { type: "string", description: "Fecha/hora ISO 8601 futura" },
                group_id: { type: "string" },
                device_ids: { type: "array", items: { type: "number" } },
                params: { type: "object" },
            },
            required: ["workflow_id", "scheduled_at"],
        },
    },
    {
        name: "tasks_cancel",
        description: "Cancela una tarea programada o en ejecución",
        inputSchema: {
            type: "object",
            properties: { task_id: { type: "string" } },
            required: ["task_id"],
        },
    },
    {
        name: "tasks_retry",
        description: "Reintenta una tarea que falló",
        inputSchema: {
            type: "object",
            properties: { task_id: { type: "string" } },
            required: ["task_id"],
        },
    },

    // Report tools
    {
        name: "reports_execution_summary",
        description: "Resumen de ejecución de tareas para un período (días)",
        inputSchema: {
            type: "object",
            properties: { period: { type: "string", description: "Días hacia atrás, ej. '7'" } },
        },
    },
    {
        name: "reports_device_failures",
        description: "Reporte de dispositivos con fallos frecuentes",
        inputSchema: {
            type: "object",
            properties: { period: { type: "string", description: "Días hacia atrás, ej. '30'" } },
        },
    },
    {
        name: "reports_daily_activity",
        description: "Actividad diaria del sistema",
        inputSchema: {
            type: "object",
            properties: { days: { type: "string", description: "Días hacia atrás, ej. '30'" } },
        },
    },

    // Schedule tools (rutinas programadas)
    {
        name: "schedules_list",
        description: "Lista las rutinas programadas (schedules) con su próxima ejecución y estado",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "schedules_create",
        description: "Crea una rutina programada: ejecuta un workflow en un grupo, a horas fijas o en bucle dentro de una franja horaria",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string" },
                workflow_id: { type: "number", description: "ID del workflow (la rutina de pasos)" },
                group_id: { type: "number", description: "ID del grupo (omitir = todos los dispositivos online)" },
                mode: { type: "string", enum: ["fixed_times", "loop"], description: "'fixed_times' = a horas concretas; 'loop' = repetir dentro de una franja" },
                times: { type: "array", items: { type: "string" }, description: "Horas HH:MM para modo fixed_times, ej. ['09:00','14:30']" },
                window_start: { type: "string", description: "Inicio de franja HH:MM (modo loop)" },
                window_end: { type: "string", description: "Fin de franja HH:MM (modo loop)" },
                loop_gap_seconds: { type: "number", description: "Pausa en segundos entre repeticiones del bucle" },
                days_of_week: { type: "array", items: { type: "number" }, description: "Días 0-6 (0=domingo); omitir = todos" },
            },
            required: ["name", "workflow_id", "mode"],
        },
    },
    {
        name: "schedules_pause",
        description: "Pausa una rutina programada (deja de dispararse)",
        inputSchema: { type: "object", properties: { schedule_id: { type: "number" } }, required: ["schedule_id"] },
    },
    {
        name: "schedules_resume",
        description: "Reanuda una rutina programada pausada",
        inputSchema: { type: "object", properties: { schedule_id: { type: "number" } }, required: ["schedule_id"] },
    },
    {
        name: "schedules_run_now",
        description: "Dispara una vuelta inmediata de la rutina de un schedule",
        inputSchema: { type: "object", properties: { schedule_id: { type: "number" } }, required: ["schedule_id"] },
    },
    {
        name: "schedules_delete",
        description: "Elimina una rutina programada",
        inputSchema: { type: "object", properties: { schedule_id: { type: "number" } }, required: ["schedule_id"] },
    },

    // Dashboard tools
    {
        name: "dashboard_stats",
        description: "Estadísticas generales del sistema (dispositivos, tareas, workflows, grupos)",
        inputSchema: { type: "object", properties: {} },
    },
];

// ============================================================
// API helpers
// ============================================================

function ok(data: unknown) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: any) {
    const detail = error.response?.data ?? error.message;
    return {
        content: [{ type: "text", text: `Error: ${JSON.stringify(detail)}` }],
        isError: true,
    };
}

async function apiGet(endpoint: string, params?: object) {
    try {
        const response = await api.get(endpoint, { params });
        return ok(response.data);
    } catch (error: any) {
        return fail(error);
    }
}

async function apiPost(endpoint: string, body?: object) {
    try {
        const response = await api.post(endpoint, body);
        return ok(response.data);
    } catch (error: any) {
        return fail(error);
    }
}

async function apiPut(endpoint: string, body?: object) {
    try {
        const response = await api.put(endpoint, body);
        return ok(response.data);
    } catch (error: any) {
        return fail(error);
    }
}

async function apiDelete(endpoint: string) {
    try {
        const response = await api.delete(endpoint);
        return ok(response.data);
    } catch (error: any) {
        return fail(error);
    }
}

// ============================================================
// Tool dispatch
// ============================================================

async function callTool(name: string, params: any) {
    switch (name) {
        case "devices_list":
            return apiGet("/devices", {
                page: params.page || 1,
                per_page: params.per_page || 200,
                status: params.status,
                search: params.search,
            });
        case "devices_get_status":
            return apiGet(`/devices/${params.device_id}`);
        case "devices_register":
            return apiPost("/devices", params);
        case "devices_stats":
            return apiGet("/devices/stats");
        case "devices_stabilize":
            return apiPost("/devices/batch-command", {
                device_ids: params.device_ids,
                command: "DEVICE_STABILIZE",
                params: {
                    keep_awake: params.keep_awake,
                    screen_timeout_minutes: params.screen_timeout_minutes,
                    animation_scale: params.animation_scale,
                    sync_time: params.sync_time,
                    clock_source: params.clock_source,
                    timezone: params.timezone,
                    max_clock_drift_seconds: params.max_clock_drift_seconds,
                },
            });
        case "devices_network_status":
            return apiPost("/devices/batch-command", {

                device_ids: params.device_ids,
                command: "DEVICE_NETWORK_STATUS",
                params: {},
            });
        case "devices_clear_proxy":
            if (params.confirm !== true) throw new Error("confirm=true required");
            if (!Array.isArray(params.device_ids) || params.device_ids.length !== 1) throw new Error("Exactly one device_id is required");
            return apiPost(`/devices/${params.device_ids[0]}/proxy-control/direct`, params);
        case "device_command":
            if (params.confirm !== true) throw new Error("confirm=true required");
            return apiPost("/devices/batch-command", {
                device_ids: [params.device_id], command: params.command,
                params: { ...(params.params || {}), confirm: true },
            });
        case "lab_status":
            return apiGet("/lab/status");
        case "configure_lab_canary":
            return apiPut("/lab/config", { ...params, lab_mode_enabled: true, hermes_enabled: false });
        case "emergency_stop":
            return apiPost("/lab/emergency-stop", params);
        case "resume_lab":
            return apiPost("/lab/resume", params);
        case "anti_idle_status":
            return apiGet("/anti-idle");
        case "configure_anti_idle":
            return apiPut("/anti-idle/config", params);
        case "start_anti_idle":
            return apiPost("/anti-idle/start", params);
        case "stop_anti_idle":
            return apiPost("/anti-idle/stop", params);
        case "run_anti_idle_now":
            return apiPost("/anti-idle/run-now", params);
        case "list_proxy_routes":
            return apiGet("/proxy-routes", params);
        case "inspect_proxy_route":
            return apiGet(`/proxy-routes/${params.route_id}`);
        case "enroll_proxy_route":
            return apiPost("/proxy-routes", params);
        case "test_proxy_route":
            return apiPost(`/proxy-routes/${params.route_id}/test`, params);
        case "assign_proxy_route":
            return apiPost(`/proxy-routes/${params.route_id}/assign`, params);
        case "release_proxy_route":
            return apiPost(`/proxy-routes/${params.route_id}/release`, params);
        case "rotate_proxy_route":
            return apiPost(`/devices/${params.device_id}/proxy-route/rotate`, params);
        case "request_proxy_rotation":
            return apiPost(`/proxy-routes/${params.route_id}/request-provider-rotation`, params);
        case "set_device_proxy_direct":
            return apiPost(`/devices/${params.device_id}/proxy-control/direct`, params);
        case "verify_device_egress":
            return apiPost(`/proxy-routes/${params.route_id}/verify-device-egress`, params);
        case "list_account_profiles":
            return apiGet("/account-profiles", { platform: params.platform, status: params.status, device_id: params.device_id });
        case "inspect_account_profile":
            return apiGet(`/account-profiles/${params.account_id}`);
        case "enroll_account_profile":
            return apiPost("/account-profiles/enroll", params);
        case "assign_account_profile":
            return apiPost(`/account-profiles/${params.account_id}/assign`, params);
        case "release_account_profile":
            return apiPost(`/account-profiles/${params.account_id}/release`, params);
        case "inspect_google_accounts":
            return apiGet(`/devices/${params.device_id}/google-accounts`);
        case "start_google_account_enrollment":
            return apiPost(`/devices/${params.device_id}/google-accounts/enrollment/start`, params);
        case "verify_google_account_enrollment":
            return apiPost(`/devices/${params.device_id}/google-accounts/enrollment/verify`, params);
        case "set_google_account_rotation":
            return apiPut(`/devices/${params.device_id}/google-accounts/rotation`, params);
        case "open_google_account_rotation":
            return apiPost(`/devices/${params.device_id}/google-accounts/rotation/open`, params);

        case "proxies_list":
            return apiGet("/proxies", { status: params.status, country: params.country });
        case "proxies_create":
            return apiPost("/proxies", params);
        case "proxies_import":
            return apiPost("/proxies/import", { proxies: params.proxies });
        case "proxies_distribute":
            return apiPost("/proxies/distribute", params);
        case "device_proxy_assign":
            return apiPost(`/devices/${params.device_id}/proxy/assign`, {
                proxy_id: params.proxy_id,
                strategy: params.strategy,
                country: params.country,
                tags: params.tags,
            });
        case "device_proxy_rotate":
            return apiPost(`/devices/${params.device_id}/proxy/rotate`, {
                strategy: params.strategy,
                country: params.country,
                tags: params.tags,
            });
        case "device_proxy_clear":
            return apiPost(`/devices/${params.device_id}/proxy/clear`);
        case "device_proxy_check_ip":
            return apiPost(`/devices/${params.device_id}/check-ip`);

        case "groups_list":
            return apiGet("/groups");
        case "groups_create":
            return apiPost("/groups", {
                name: params.name,
                description: params.description,
                max_devices: params.max_devices,
            });
        case "groups_assign_devices":
            return apiPost(`/groups/${params.group_id}/assign-devices`, {
                device_ids: params.device_ids,
            });
        case "groups_pause":
            return apiPost(`/groups/${params.group_id}/pause`);
        case "groups_resume":
            return apiPost(`/groups/${params.group_id}/resume`);

        case "workflows_list":
            return apiGet("/workflows");
        case "workflows_create":
            return apiPost("/workflows", {
                name: params.name,
                description: params.description,
                steps: params.steps,
                allowed_package: params.allowed_package,
            });
        case "workflows_validate":
            return apiPost(`/workflows/${params.workflow_id}/validate`);
        case "workflows_execute":
            return apiPost(`/workflows/${params.workflow_id}/execute`, {
                group_id: params.group_id,
                device_ids: params.device_ids,
                params: params.params,
            });

        case "tasks_list":
            return apiGet("/tasks", params.status ? { status: params.status } : undefined);
        case "tasks_schedule":
            return apiPost("/tasks", {
                workflow_id: params.workflow_id,
                scheduled_at: params.scheduled_at,
                group_id: params.group_id,
                device_ids: params.device_ids,
                params: params.params,
            });
        case "tasks_cancel":
            return apiPost(`/tasks/${params.task_id}/cancel`);
        case "tasks_retry":
            return apiPost(`/tasks/${params.task_id}/retry`);

        case "reports_execution_summary":
            return apiGet("/reports/execution-summary", { period: params.period });
        case "reports_device_failures":
            return apiGet("/reports/device-failures", { period: params.period });
        case "reports_daily_activity":
            return apiGet("/reports/daily-activity", { days: params.days });

        case "schedules_list":
            return apiGet("/schedules");
        case "schedules_create":
            return apiPost("/schedules", {
                name: params.name,
                workflow_id: params.workflow_id,
                group_id: params.group_id,
                mode: params.mode,
                times: params.times,
                window_start: params.window_start,
                window_end: params.window_end,
                loop_gap_seconds: params.loop_gap_seconds,
                days_of_week: params.days_of_week,
            });
        case "schedules_pause":
            return apiPost(`/schedules/${params.schedule_id}/pause`);
        case "schedules_resume":
            return apiPost(`/schedules/${params.schedule_id}/resume`);
        case "schedules_run_now":
            return apiPost(`/schedules/${params.schedule_id}/run-now`);
        case "schedules_delete":
            return apiDelete(`/schedules/${params.schedule_id}`);

        case "dashboard_stats":
            return apiGet("/dashboard/stats");

        default:
            return {
                content: [{ type: "text", text: `Tool desconocida: ${name}` }],
                isError: true,
            };
    }
}

// ============================================================
// MCP Server Setup
// ============================================================

async function main() {
    const server = new Server(
        { name: "mcp-appcontrol", version: "1.1.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        return callTool(request.params.name, request.params.arguments ?? {});
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP AppControl Server running on stdio");
}

main().catch(console.error);
