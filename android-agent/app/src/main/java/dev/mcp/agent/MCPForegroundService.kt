package dev.mcp.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import dev.mcp.agent.websocket.WebSocketClientManager

/**
 * Servicio en primer plano que mantiene viva la conexión WebSocket con el
 * servidor MCP mientras la app no está en pantalla. Es el dueño del
 * WebSocketClientManager; la Activity solo lo arranca/para y observa el estado.
 */
class MCPForegroundService : Service() {

    companion object {
        private const val TAG = "MCPForegroundService"
        private const val CHANNEL_ID = "mcp_agent_channel"
        private const val NOTIFICATION_ID = 1001

        const val ACTION_START_AGENT = "ACTION_START_AGENT"
        const val ACTION_STOP_AGENT = "ACTION_STOP_AGENT"

        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_SERIAL = "serial_number"
        const val EXTRA_TOKEN = "auth_token"

        // Observador de estado y de comandos para la UI (la Activity lo asigna).
        @Volatile
        var connectionListener: ((Boolean, String) -> Unit)? = null
        @Volatile
        var commandListener: ((String, Boolean, String) -> Unit)? = null

        @Volatile
        var isRunning = false
            private set

        @Volatile
        var isConnected = false
            private set
    }

    private var wsClient: WebSocketClientManager? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Foreground Service created")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_AGENT -> {
                startForeground(NOTIFICATION_ID, createNotification("Conectando..."))
                startAgent(
                    intent.getStringExtra(EXTRA_SERVER_URL) ?: "ws://127.0.0.1:6011",
                    intent.getStringExtra(EXTRA_SERIAL) ?: "",
                    intent.getStringExtra(EXTRA_TOKEN) ?: ""
                )
            }
            ACTION_STOP_AGENT -> stopAgent()
        }

        return START_STICKY
    }

    private fun startAgent(serverUrl: String, serialNumber: String, token: String) {
        if (wsClient != null) {
            Log.w(TAG, "Agent is already running")
            return
        }

        wsClient = WebSocketClientManager(
            serverUrl = serverUrl,
            serialNumber = serialNumber,
            authToken = token,
            onCommandExecuted = { command, success, message ->
                updateNotification("Último: $command (${if (success) "ok" else "fallo"})")
                commandListener?.invoke(command, success, message)
            },
            onConnectionStateChanged = { connected, status ->
                isConnected = connected
                updateNotification(if (connected) "Conectado" else status)
                connectionListener?.invoke(connected, status)
            }
        )
        isRunning = true
        wsClient?.connect()
        Log.i(TAG, "Agent started with serial: $serialNumber")
    }

    private fun stopAgent() {
        wsClient?.disconnect()
        wsClient = null
        isConnected = false
        isRunning = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        Log.i(TAG, "Agent stopped")
    }

    override fun onDestroy() {
        wsClient?.disconnect()
        wsClient = null
        isConnected = false
        isRunning = false
        super.onDestroy()
    }

    private fun createNotification(text: String): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        return builder
            .setContentTitle("XSAlpha Agent Activo")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build()
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, createNotification(text))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "XSAlpha Agent Channel",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Canal para notificación del agente MCP"
            }

            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
