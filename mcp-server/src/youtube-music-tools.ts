export const YOUTUBE_MUSIC_TOOLS = [
    {
        name: "youtube_music_create_playlist",
        description: "Creates one YT Music playlist on explicitly named devices from ordered exact artist/title pairs; ambiguous or missing matches fail closed",
        inputSchema: {
            type: "object",
            properties: {
                device_ids: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 20 },
                playlist_name: { type: "string", minLength: 1, maxLength: 100 },
                privacy: { type: "string", enum: ["private", "unlisted", "public"], default: "private" },
                tracks: {
                    type: "array", minItems: 1, maxItems: 50,
                    items: {
                        type: "object",
                        properties: {
                            artist: { type: "string", minLength: 1, maxLength: 160 },
                            title: { type: "string", minLength: 1, maxLength: 200 },
                            url: { type: "string", description: "Optional HTTPS music.youtube.com URL for strongest identity" },
                        },
                        required: ["artist", "title"],
                    },
                },
                close_app_after: { type: "boolean", default: false },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string", minLength: 8 },
            },
            required: ["device_ids", "playlist_name", "tracks", "confirm", "idempotency_key"],
        },
    },
    {
        name: "youtube_music_guard_status",
        description: "Shows the opt-in YT Music inactivity guard state and its per-device sanitized results",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "configure_youtube_music_guard",
        description: "Configures exact allowlisted devices for bounded YT Music inactivity checks; verified proxy routes are required",
        inputSchema: {
            type: "object",
            properties: {
                device_ids: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 20 },
                poll_interval_seconds: { type: "number", minimum: 15, maximum: 300, default: 30 },
                cooldown_seconds: { type: "number", minimum: 30, maximum: 1800, default: 90 },
                batch_size: { type: "number", minimum: 1, maximum: 10, default: 5 },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string", minLength: 8 },
            },
            required: ["device_ids", "confirm", "idempotency_key"],
        },
    },
    {
        name: "start_youtube_music_guard",
        description: "Explicitly starts the configured restart-off YT Music inactivity guard",
        inputSchema: {
            type: "object",
            properties: {
                run_immediately: { type: "boolean", default: true },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string", minLength: 8 },
            },
            required: ["confirm", "idempotency_key"],
        },
    },
    {
        name: "stop_youtube_music_guard",
        description: "Stops future YT Music inactivity checks without closing the app or changing accounts",
        inputSchema: {
            type: "object",
            properties: {
                reason: { type: "string" },
                confirm: { type: "boolean" },
                idempotency_key: { type: "string", minLength: 8 },
            },
            required: ["reason", "confirm", "idempotency_key"],
        },
    },
    {
        name: "check_youtube_music_guard_now",
        description: "Requests one immediate bounded guard check while the YT Music guard is active",
        inputSchema: {
            type: "object",
            properties: {
                confirm: { type: "boolean" },
                idempotency_key: { type: "string", minLength: 8 },
            },
            required: ["confirm", "idempotency_key"],
        },
    },
] as const;
