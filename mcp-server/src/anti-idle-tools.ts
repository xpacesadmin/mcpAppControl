export const ANTI_IDLE_TOOLS = [
    {
        name: "anti_idle_status",
        description: "Shows the bounded anti-idle mode state, exact device scope, timing, and last sanitized result",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "configure_anti_idle",
        description: "Configures neutral app switching and scrolling for explicitly named, allowlisted devices with verified proxy routes",
        inputSchema: {
            type: "object",
            properties: {
                device_ids: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 20 },
                package_names: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
                interval_seconds: { type: "number", minimum: 60, maximum: 3600, default: 480 },
                action_duration_seconds: { type: "number", minimum: 10, maximum: 300, default: 45 },
                gesture_interval_seconds: { type: "number", minimum: 2, maximum: 15, default: 4 },
                natural_scrolls_enabled: { type: "boolean", default: true },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["device_ids", "package_names", "confirm", "idempotency_key"],
        },
    },
    {
        name: "start_anti_idle",
        description: "Starts anti-idle for its configured exact devices; it does not like, follow, post, save, or rotate accounts",
        inputSchema: {
            type: "object",
            properties: {
                run_immediately: { type: "boolean", default: true },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["confirm", "idempotency_key"],
        },
    },
    {
        name: "stop_anti_idle",
        description: "Stops future anti-idle cycles and cancels an active cycle at its next bounded step",
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
        name: "run_anti_idle_now",
        description: "Requests one immediate bounded anti-idle cycle when the mode is already active",
        inputSchema: {
            type: "object",
            properties: {
                confirm: { type: "boolean" },
                idempotency_key: { type: "string" },
            },
            required: ["confirm", "idempotency_key"],
        },
    },
] as const;
