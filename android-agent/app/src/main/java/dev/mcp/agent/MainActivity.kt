package dev.mcp.agent

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.widget.*
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val ACCESSIBILITY_SETTINGS_REQUEST_CODE = 1001
        // 127.0.0.1 + adb reverse: el escritorio abre el túnel al detectar el teléfono,
        // así el router sigue atado a loopback y no queda expuesto en la red del local.
        // El valor anterior (10.0.2.2:6001) era la dirección del emulador y un puerto
        // antiguo: en un teléfono real no podía conectar nunca.
        private const val DEFAULT_SERVER_URL = "ws://127.0.0.1:6011"
    }

    // UI Elements
    private lateinit var tvStatus: TextView
    private lateinit var tvSerialNumber: TextView
    private lateinit var tvDeviceModel: TextView
    private lateinit var tvAndroidVersion: TextView
    private lateinit var tvLastCommand: TextView
    private lateinit var tvConnectionDetails: TextView
    private lateinit var btnConfigureServer: Button
    private lateinit var btnToggleAccessibility: Button
    private lateinit var btnToggleAgent: Button
    private lateinit var lvLogs: ListView

    private var isConnected = false
    private var accessibilityEnabled = false

    private val logEntries = mutableListOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        initializeViews()
        registerServiceListeners()
        checkAccessibilityStatus()

        aprovisionarSiEsPrimeraVez(intent)
        updateDeviceInformation()

        val prefs = getSharedPreferences("mcp_agent_prefs", MODE_PRIVATE)
        tvConnectionDetails.text = "Servidor: ${prefs.getString("server_url", DEFAULT_SERVER_URL)}"

        // Reconectar si estaba configurado para auto-conexión y el servicio no corre ya
        if (prefs.getBoolean("auto_connect", false) && !MCPForegroundService.isRunning) {
            startAgentService()
        }
    }

    private fun initializeViews() {
        tvStatus = findViewById(R.id.tvStatus)
        tvSerialNumber = findViewById(R.id.tvSerialNumber)
        tvDeviceModel = findViewById(R.id.tvDeviceModel)
        tvAndroidVersion = findViewById(R.id.tvAndroidVersion)
        tvLastCommand = findViewById(R.id.tvLastCommand)
        tvConnectionDetails = findViewById(R.id.tvConnectionDetails)
        btnConfigureServer = findViewById(R.id.btnConfigureServer)
        btnToggleAccessibility = findViewById(R.id.btnToggleAccessibility)
        btnToggleAgent = findViewById(R.id.btnToggleAgent)
        lvLogs = findViewById(R.id.lvLogs)

        btnConfigureServer.setOnClickListener { showServerConfigDialog() }
        btnToggleAccessibility.setOnClickListener { toggleAccessibilityService() }
        btnToggleAgent.setOnClickListener {
            when {
                !MCPForegroundService.isRunning -> startAgentService()
                MCPForegroundService.isConnected -> stopAgentService()
                else -> restartAgentService()
            }
        }

        val logAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, logEntries)
        lvLogs.adapter = logAdapter

        updateAgentButton()
        Log.i(TAG, "Activity created")
    }

    private fun registerServiceListeners() {
        MCPForegroundService.connectionListener = { connected, status ->
            runOnUiThread { updateConnectionStatus(connected, status) }
        }
        MCPForegroundService.commandListener = { command, success, _ ->
            runOnUiThread {
                tvLastCommand.text = "Último comando: $command (${if (success) "ok" else "fallo"})"
                addLogEntry("Comando: $command -> ${if (success) "ok" else "fallo"}")
            }
        }
    }

    /**
     * Aprovisionamiento inicial: el escritorio lanza la app justo tras instalarla
     * pasándole el servidor y el número de serie del dispositivo.
     *
     * Sin esto, una instalación nueva se autoasigna un serial propio (device-XXXX)
     * que no coincide con el serial ADB, y al conectar aparecería como un SEGUNDO
     * dispositivo en el panel, duplicando el que ya existe.
     *
     * Solo se acepta en la primera ejecución, cuando todavía no hay nada guardado.
     * MainActivity está exportada por ser la de arranque, así que sin ese límite
     * cualquier app instalada podría reapuntar el agente a otro servidor y hacerse
     * con el control del teléfono. Una vez configurado, se cambia desde la propia
     * pantalla de ajustes y no por intent.
     */
    private fun aprovisionarSiEsPrimeraVez(intent: Intent?) {
        if (intent == null) return
        val prefs = getSharedPreferences("mcp_agent_prefs", MODE_PRIVATE)
        if (prefs.contains("server_url") || prefs.contains("serial_number")) return

        val servidor = intent.getStringExtra("server_url")?.trim()
        val serial = intent.getStringExtra("serial_number")?.trim()
        if (servidor.isNullOrEmpty() && serial.isNullOrEmpty()) return

        prefs.edit().apply {
            if (!servidor.isNullOrEmpty()) putString("server_url", servidor)
            if (!serial.isNullOrEmpty()) putString("serial_number", serial)
            // Local ADB control is ready without enabling the WebSocket/Hermes connector.
            putBoolean("auto_connect", false)
            apply()
        }
        Log.i("MainActivity", "Aprovisionado desde el escritorio: servidor=$servidor serial=$serial")
        addLogEntry("Configurado por el escritorio")
    }

    private fun currentSerialNumber(): String {
        val prefs = getSharedPreferences("mcp_agent_prefs", MODE_PRIVATE)
        return prefs.getString("serial_number", null) ?: generateSerialNumber()
    }

    private fun generateSerialNumber(): String {
        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        return "device-${deviceId?.take(8)?.uppercase(Locale.ROOT)}"
    }

    private fun saveSettings(serverUrl: String, serialNumber: String, token: String, autoConnect: Boolean) {
        getSharedPreferences("mcp_agent_prefs", MODE_PRIVATE).edit().apply {
            putString("server_url", serverUrl)
            putString("serial_number", serialNumber)
            putString("auth_token", token)
            putBoolean("auto_connect", autoConnect)
            apply()
        }
    }

    private fun isValidWebSocketUrl(serverUrl: String): Boolean {
        val uri = Uri.parse(serverUrl)
        return uri.scheme in setOf("ws", "wss") && !uri.host.isNullOrBlank()
    }

    private fun updateDeviceInformation() {
        tvSerialNumber.text = "Dispositivo: ${currentSerialNumber()}"
        tvDeviceModel.text = "Modelo: ${Build.MODEL}"
        tvAndroidVersion.text = "Android: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
    }

    private fun checkAccessibilityStatus() {
        accessibilityEnabled = isAccessibilityServiceEnabled()

        if (accessibilityEnabled) {
            btnToggleAccessibility.text = "✓ Servicio de Accesibilidad Activo"
            btnToggleAccessibility.setBackgroundColor(0xFF4CAF50.toInt())
        } else {
            btnToggleAccessibility.text = "Activar Servicio de Accesibilidad"
            btnToggleAccessibility.setBackgroundColor(0xFFFF9800.toInt())
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val enabledServices = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false

        val serviceName = "$packageName/${MCPAccessibilityService::class.java.name}"
        return enabledServices.contains(serviceName)
    }

    private fun toggleAccessibilityService() {
        if (accessibilityEnabled) {
            Toast.makeText(this, "Servicio de accesibilidad activo", Toast.LENGTH_SHORT).show()
        } else {
            startActivityForResult(
                Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
                ACCESSIBILITY_SETTINGS_REQUEST_CODE
            )
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == ACCESSIBILITY_SETTINGS_REQUEST_CODE) {
            checkAccessibilityStatus()
            if (accessibilityEnabled) {
                addLogEntry("Accessibility active; local ADB control ready")
            }
        }
    }

    private fun startAgentService() {
        if (!accessibilityEnabled) {
            Toast.makeText(this, "Activa el servicio de accesibilidad primero", Toast.LENGTH_SHORT).show()
            return
        }

        val prefs = getSharedPreferences("mcp_agent_prefs", MODE_PRIVATE)
        val token = prefs.getString("auth_token", "").orEmpty().trim()
        if (token.isBlank()) {
            Toast.makeText(this, "Conector no configurado; control local ADB listo", Toast.LENGTH_LONG).show()
            addLogEntry("Conector bloqueado: falta configurar token")
            return
        }
        val intent = Intent(this, MCPForegroundService::class.java).apply {
            action = MCPForegroundService.ACTION_START_AGENT
            putExtra(MCPForegroundService.EXTRA_SERVER_URL, prefs.getString("server_url", DEFAULT_SERVER_URL))
            putExtra(MCPForegroundService.EXTRA_SERIAL, currentSerialNumber())
            putExtra(MCPForegroundService.EXTRA_TOKEN, token)
        }
        ContextCompat.startForegroundService(this, intent)
        updateAgentButton()
        addLogEntry("Iniciando agente...")
    }

    private fun restartAgentService() {
        stopAgentService()
        btnToggleAgent.isEnabled = false
        Handler(Looper.getMainLooper()).postDelayed({
            if (!isFinishing) {
                btnToggleAgent.isEnabled = true
                startAgentService()
            }
        }, 300)
    }

    private fun stopAgentService() {
        val intent = Intent(this, MCPForegroundService::class.java).apply {
            action = MCPForegroundService.ACTION_STOP_AGENT
        }
        startService(intent)
        updateAgentButton()
        addLogEntry("Deteniendo agente...")
    }

    private fun updateAgentButton() {
        btnToggleAgent.text = when {
            !MCPForegroundService.isRunning -> "Conectar al orquestador"
            MCPForegroundService.isConnected -> "Desconectar agente"
            else -> "Reintentar conexion"
        }
    }

    private fun updateConnectionStatus(connected: Boolean, status: String) {
        isConnected = connected
        updateAgentButton()
        tvStatus.text = if (connected) "✓ Conectado" else "✗ Desconectado"
        tvStatus.setTextColor(if (connected) 0xFF4CAF50.toInt() else 0xFFFF5252.toInt())
        addLogEntry("Estado conexión: $status")
    }

    private fun showServerConfigDialog() {
        val dialog = android.app.AlertDialog.Builder(this)
            .setTitle("Configurar Servidor")
            .setView(R.layout.dialog_server_config)
            .create()

        dialog.show()

        val etServerUrl = dialog.findViewById<EditText>(R.id.etServerUrl)
        val etSerialNumber = dialog.findViewById<EditText>(R.id.etSerialNumber)
        val etAuthToken = dialog.findViewById<EditText>(R.id.etAuthToken)
        val cbAutoConnect = dialog.findViewById<CheckBox>(R.id.cbAutoConnect)

        val prefs = getSharedPreferences("mcp_agent_prefs", MODE_PRIVATE)
        etServerUrl?.setText(prefs.getString("server_url", DEFAULT_SERVER_URL))
        etSerialNumber?.setText(currentSerialNumber())
        etAuthToken?.setText(prefs.getString("auth_token", ""))
        cbAutoConnect?.isChecked = prefs.getBoolean("auto_connect", false)

        val btnSave = dialog.findViewById<Button>(R.id.btnSaveServerConfig)
        val btnCancel = dialog.findViewById<Button>(R.id.btnCancelServerConfig)

        btnSave?.setOnClickListener {
            val serverUrl = etServerUrl?.text?.toString()?.trim().orEmpty()
            val serialNumber = etSerialNumber?.text?.toString()?.trim().orEmpty().ifEmpty { generateSerialNumber() }
            val token = etAuthToken?.text?.toString()?.trim().orEmpty()
            val autoConnect = cbAutoConnect?.isChecked ?: false

            if (serverUrl.isEmpty()) {
                Toast.makeText(this, "Ingresa la URL del servidor", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            if (!isValidWebSocketUrl(serverUrl)) {
                Toast.makeText(this, "Usa una URL ws:// o wss:// valida", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }

            saveSettings(serverUrl, serialNumber, token, autoConnect)
            tvConnectionDetails.text = "Servidor: $serverUrl"
            addLogEntry("Configuración guardada")

            // Reiniciar el agente con la nueva configuración
            if (MCPForegroundService.isRunning) {
                stopAgentService()
            }
            if (autoConnect && accessibilityEnabled) {
                startAgentService()
            }

            dialog.dismiss()
        }

        btnCancel?.setOnClickListener { dialog.dismiss() }
    }

    private fun addLogEntry(message: String) {
        val timestamp = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        logEntries.add("[$timestamp] $message")

        if (logEntries.size > 100) {
            logEntries.removeAt(0)
        }

        (lvLogs.adapter as ArrayAdapter<*>).notifyDataSetChanged()
        lvLogs.setSelection(logEntries.size - 1)
    }

    override fun onDestroy() {
        super.onDestroy()
        // No paramos el servicio: debe seguir en segundo plano.
        MCPForegroundService.connectionListener = null
        MCPForegroundService.commandListener = null
        Log.i(TAG, "Activity destroyed")
    }

    override fun onResume() {
        super.onResume()
        checkAccessibilityStatus()
        registerServiceListeners()
    }
}
