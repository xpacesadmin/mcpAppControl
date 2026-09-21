package dev.mcp.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class MCPAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "MCPAccessibilityService"

        // Instancia viva del servicio, para que el cliente WebSocket pueda ejecutar comandos
        @Volatile
        var instance: MCPAccessibilityService? = null
            private set

        data class CommandResult(
            val commandType: String,
            val success: Boolean,
            val message: String,
            val timestamp: Long = System.currentTimeMillis(),
            val extraData: Map<String, Any> = emptyMap()
        )
    }

    override fun onServiceConnected() {
        Log.i(TAG, "Accessibility Service connected")
        instance = this

        val info = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                         AccessibilityEvent.TYPE_VIEW_CLICKED or
                         AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED or
                         AccessibilityEvent.TYPE_WINDOWS_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
                    AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                    AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            notificationTimeout = 100
        }
        serviceInfo = info

        // Servidor de jerarquía: el escritorio lee la pantalla por aquí porque
        // `uiautomator dump`, lanzado desde el PC, muere en estos teléfonos.
        HierarchyServer.start()

        Log.i(TAG, "Accessibility Service configured successfully")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        HierarchyServer.stop()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        HierarchyServer.stop()
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        when (event?.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                Log.d(TAG, "Window changed: ${event.className}")
            }
            AccessibilityEvent.TYPE_VIEW_CLICKED -> {
                Log.d(TAG, "View clicked: ${event.text}")
            }
        }
    }

    override fun onInterrupt() {
        Log.w(TAG, "Accessibility Service interrupted")
    }

    /**
     * Execute a command received from the server
     */
    fun executeCommand(commandType: String, params: Map<String, Any>): CommandResult {
        return try {
            when (commandType) {
                "OPEN_APP" -> openApp(params["packageName"] as String)
                "CLOSE_APP" -> closeApp()
                "CLICK_BY_TEXT" -> clickByText(params["text"] as String)
                "CLICK_BY_ID" -> clickById(params["resourceId"] as String)
                "SET_TEXT" -> setText(
                    params["resourceId"] as String,
                    params["value"] as String
                )
                "SCROLL" -> scroll(params["direction"] as? String ?: "down")
                "SWIPE" -> swipe(
                    (params["startX"] as? Number)?.toInt() ?: 200,
                    (params["startY"] as? Number)?.toInt() ?: 1200,
                    (params["endX"] as? Number)?.toInt() ?: 200,
                    (params["endY"] as? Number)?.toInt() ?: 400
                )
                "LONG_PRESS" -> longPress(
                    (params["x"] as? Number)?.toInt() ?: 500,
                    (params["y"] as? Number)?.toInt() ?: 800
                )
                "PRESS_BACK" -> navigateBack()
                "PRESS_HOME" -> goHome()
                "WAIT", "WAIT_FOR_ELEMENT" -> waitForElement(
                    params["text"] as? String,
                    params["resourceId"] as? String,
                    (params["timeoutMs"] as? Number)?.toLong() ?: 10000L
                )
                "CAPTURE_SCREEN", "CAPTURE_SCREEN_FRAME" -> captureScreen()
                "PLAY_MEDIA" -> playMedia((params["durationSeconds"] as? Number)?.toLong() ?: 30L)
                "PAUSE_MEDIA" -> pauseMedia()
                "GOTO_URL" -> gotoUrl(params["url"] as String)
                // También por WebSocket, para los teléfonos que no van por ADB.
                "DUMP_HIERARCHY" -> {
                    val xml = dumpHierarchyXml()
                    CommandResult("DUMP_HIERARCHY", xml.length > 100, "Jerarquía leída (${xml.length} caracteres)",
                        extraData = mapOf("hierarchy" to xml))
                }
                else -> CommandResult(commandType, false, "Unknown command: $commandType")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing command: ${e.message}", e)
            CommandResult(commandType, false, "Error: ${e.message}")
        }
    }

    // ==================== APP MANAGEMENT ====================

    private fun openApp(packageName: String): CommandResult {
        return try {
            val intent = packageManager.getLaunchIntentForPackage(packageName)
                ?: return CommandResult("OPEN_APP", false, "App not found: $packageName")

            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            startActivity(intent)

            Thread.sleep(2000) // Wait for app to load

            Log.i(TAG, "Opened app: $packageName")
            CommandResult("OPEN_APP", true, "App opened successfully: $packageName")
        } catch (e: Exception) {
            Log.e(TAG, "Error opening app: ${e.message}", e)
            CommandResult("OPEN_APP", false, "Error: ${e.message}")
        }
    }

    private fun closeApp(): CommandResult {
        return try {
            goHome()
            Thread.sleep(1000)
            Log.i(TAG, "Closed current app")
            CommandResult("CLOSE_APP", true, "App closed successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Error closing app: ${e.message}", e)
            CommandResult("CLOSE_APP", false, "Error: ${e.message}")
        }
    }

    private fun gotoUrl(url: String): CommandResult {
        return try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            Thread.sleep(2000)
            CommandResult("GOTO_URL", true, "Opened URL: $url")
        } catch (e: Exception) {
            CommandResult("GOTO_URL", false, "Error: ${e.message}")
        }
    }

    // ==================== CLICK OPERATIONS ====================

    private fun clickByText(text: String): CommandResult {
        val root = rootInActiveWindow ?: return CommandResult("CLICK_BY_TEXT", false, "No active window")

        val nodes = findAllNodesByText(root, text)

        for (node in nodes) {
            if (clickNodeOrAncestor(node)) {
                Log.i(TAG, "Clicked by text: $text")
                return CommandResult("CLICK_BY_TEXT", true, "Clicked: $text")
            }
        }

        Log.w(TAG, "Text not found or not clickable: $text")
        return CommandResult("CLICK_BY_TEXT", false, "Not found or not clickable: $text")
    }

    private fun clickById(resourceId: String): CommandResult {
        val root = rootInActiveWindow ?: return CommandResult("CLICK_BY_ID", false, "No active window")

        val nodes = findAllNodesById(root, resourceId)

        for (node in nodes) {
            if (clickNodeOrAncestor(node)) {
                Log.i(TAG, "Clicked by ID: $resourceId")
                return CommandResult("CLICK_BY_ID", true, "Clicked ID: $resourceId")
            }
        }

        Log.w(TAG, "ID not found or not clickable: $resourceId")
        return CommandResult("CLICK_BY_ID", false, "Not found or not clickable: $resourceId")
    }

    /**
     * Click the node itself, walk up to the nearest clickable ancestor,
     * or fall back to a tap gesture at the node's center.
     */
    private fun clickNodeOrAncestor(node: AccessibilityNodeInfo): Boolean {
        var current: AccessibilityNodeInfo? = node
        while (current != null) {
            if (current.isClickable && current.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return true
            }
            current = current.parent
        }

        // Fallback: tap at the node's bounds center
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        if (!bounds.isEmpty) {
            return tap(bounds.centerX(), bounds.centerY())
        }
        return false
    }

    // ==================== TEXT INPUT ====================

    private fun setText(resourceId: String, value: String): CommandResult {
        val root = rootInActiveWindow ?: return CommandResult("SET_TEXT", false, "No active window")

        val nodes = findAllNodesById(root, resourceId)

        for (node in nodes) {
            if (node.isEditable) {
                val bundle = Bundle()
                bundle.putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                    value
                )
                if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)) {
                    Log.i(TAG, "Text set in: $resourceId")
                    return CommandResult("SET_TEXT", true, "Text set successfully in: $resourceId")
                }
            }
        }

        Log.w(TAG, "Editable field not found: $resourceId")
        return CommandResult("SET_TEXT", false, "Editable field not found: $resourceId")
    }

    // ==================== SCROLL & GESTURES ====================

    private fun scroll(direction: String): CommandResult {
        val root = rootInActiveWindow ?: return CommandResult("SCROLL", false, "No active window")

        val action = when (direction.lowercase()) {
            "up" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        }

        for (node in collectScrollable(root)) {
            if (node.performAction(action)) {
                Log.i(TAG, "Scrolled $direction")
                return CommandResult("SCROLL", true, "Scroll $direction successful")
            }
        }

        // Fallback: swipe gesture over the screen center
        val metrics = resources.displayMetrics
        val cx = metrics.widthPixels / 2
        val swiped = if (direction.lowercase() == "up") {
            performSwipeGesture(cx, metrics.heightPixels / 4, cx, metrics.heightPixels * 3 / 4, 300)
        } else {
            performSwipeGesture(cx, metrics.heightPixels * 3 / 4, cx, metrics.heightPixels / 4, 300)
        }

        return CommandResult("SCROLL", swiped, "Scroll $direction ${if (swiped) "successful (gesture)" else "failed"}")
    }

    private fun swipe(startX: Int, startY: Int, endX: Int, endY: Int): CommandResult {
        val success = performSwipeGesture(startX, startY, endX, endY, 300)
        Log.i(TAG, "Swiped from ($startX,$startY) to ($endX,$endY): $success")
        return CommandResult("SWIPE", success, if (success) "Swipe executed successfully" else "Swipe gesture failed")
    }

    private fun longPress(x: Int, y: Int): CommandResult {
        val duration = ViewConfiguration.getLongPressTimeout().toLong() + 200
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, duration))
            .build()

        val success = dispatchGestureBlocking(gesture)
        Log.i(TAG, "Long pressed at ($x,$y): $success")
        return CommandResult("LONG_PRESS", success, if (success) "Long press executed successfully" else "Long press failed")
    }

    private fun tap(x: Int, y: Int): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 100))
            .build()
        return dispatchGestureBlocking(gesture)
    }

    private fun performSwipeGesture(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Long): Boolean {
        val path = Path().apply {
            moveTo(startX.toFloat(), startY.toFloat())
            lineTo(endX.toFloat(), endY.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
        return dispatchGestureBlocking(gesture)
    }

    /**
     * dispatchGesture is async; block until it completes so commands are sequential.
     */
    private fun dispatchGestureBlocking(gesture: GestureDescription): Boolean {
        val latch = CountDownLatch(1)
        var completed = false

        val dispatched = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                completed = true
                latch.countDown()
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
                latch.countDown()
            }
        }, null)

        if (!dispatched) return false
        latch.await(5, TimeUnit.SECONDS)
        return completed
    }

    // ==================== NAVIGATION ====================

    private fun navigateBack(): CommandResult {
        val success = performGlobalAction(GLOBAL_ACTION_BACK)
        return CommandResult("PRESS_BACK", success, if (success) "Back navigation executed" else "Back navigation failed")
    }

    private fun goHome(): CommandResult {
        val success = performGlobalAction(GLOBAL_ACTION_HOME)
        return CommandResult("PRESS_HOME", success, if (success) "Home navigation executed" else "Home navigation failed")
    }

    // ==================== MEDIA ====================

    private fun playMedia(durationSeconds: Long): CommandResult {
        // El vídeo ya está reproduciéndose tras abrirlo; mantener la reproducción el tiempo pedido
        Thread.sleep(durationSeconds * 1000)
        return CommandResult("PLAY_MEDIA", true, "Played media for ${durationSeconds}s")
    }

    private fun pauseMedia(): CommandResult {
        // Tap en el centro de la pantalla para mostrar controles y pausar
        val metrics = resources.displayMetrics
        tap(metrics.widthPixels / 2, metrics.heightPixels / 2)
        Thread.sleep(300)
        val root = rootInActiveWindow
        if (root != null) {
            val pauseNodes = findAllNodesByText(root, "Pausa") + findAllNodesByText(root, "Pause")
            for (node in pauseNodes) {
                if (clickNodeOrAncestor(node)) {
                    return CommandResult("PAUSE_MEDIA", true, "Media paused")
                }
            }
        }
        return CommandResult("PAUSE_MEDIA", true, "Tapped screen to pause media")
    }

    // ==================== WAIT & SEARCH ====================

    private fun waitForElement(text: String?, resourceId: String?, timeoutMs: Long): CommandResult {
        val startTime = System.currentTimeMillis()

        while (System.currentTimeMillis() - startTime < timeoutMs) {
            val root = rootInActiveWindow
            if (root != null) {
                if (text != null && findAllNodesByText(root, text).isNotEmpty()) {
                    return CommandResult("WAIT_FOR_ELEMENT", true, "Element found: $text")
                }
                if (resourceId != null && findAllNodesById(root, resourceId).isNotEmpty()) {
                    return CommandResult("WAIT_FOR_ELEMENT", true, "Element found: $resourceId")
                }
            }
            Thread.sleep(500)
        }

        return CommandResult("WAIT_FOR_ELEMENT", false, "Timeout waiting for element (${timeoutMs}ms)")
    }

    // ==================== SCREENSHOT ====================

    private fun captureScreen(): CommandResult {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return CommandResult("CAPTURE_SCREEN", false, "Screenshot requires Android 11+")
        }

        // ScreenshotHelper está aislado para no cargar TakeScreenshotCallback en API < 30
        val (ok, result) = ScreenshotHelper.capture(this)
        return if (ok) {
            CommandResult("CAPTURE_SCREEN", true, "Screenshot captured", extraData = mapOf("screenshot" to result))
        } else {
            CommandResult("CAPTURE_SCREEN", false, result)
        }
    }

    // ==================== HELPER METHODS ====================

    private fun findAllNodesByText(root: AccessibilityNodeInfo, text: String): List<AccessibilityNodeInfo> {
        val result = mutableListOf<AccessibilityNodeInfo>()
        findNodesByText(root, text, result)
        return result
    }

    private fun findNodesByText(node: AccessibilityNodeInfo, text: String, result: MutableList<AccessibilityNodeInfo>) {
        if (node.text?.toString()?.contains(text, ignoreCase = true) == true ||
            node.contentDescription?.toString()?.contains(text, ignoreCase = true) == true
        ) {
            result.add(node)
        }

        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                findNodesByText(child, text, result)
            }
        }
    }

    private fun findAllNodesById(root: AccessibilityNodeInfo, resourceId: String): List<AccessibilityNodeInfo> {
        val result = mutableListOf<AccessibilityNodeInfo>()
        findNodesById(root, resourceId, result)
        return result
    }

    private fun findNodesById(node: AccessibilityNodeInfo, resourceId: String, result: MutableList<AccessibilityNodeInfo>) {
        if (node.viewIdResourceName?.contains(resourceId) == true) {
            result.add(node)
        }

        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                findNodesById(child, resourceId, result)
            }
        }
    }

    private fun collectScrollable(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val nodes = mutableListOf<AccessibilityNodeInfo>()
        collectScrollableNodes(root, nodes)
        return nodes
    }

    private fun collectScrollableNodes(node: AccessibilityNodeInfo, result: MutableList<AccessibilityNodeInfo>) {
        if (node.isScrollable) {
            result.add(node)
        }

        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                collectScrollableNodes(child, result)
            }
        }
    }

    /**
     * Vuelca la jerarquía de la pantalla en el mismo XML que produce
     * `uiautomator dump`.
     *
     * Se replica ese formato a propósito: el escritorio ya sabe interpretarlo, así
     * que puede leer de aquí sin cambiar una línea. Y hace falta leer de aquí
     * porque `uiautomator dump`, lanzado desde el PC, muere en estos teléfonos
     * ("Killed") y en apps con vídeo continuo nunca alcanza el estado idle.
     *
     * Se recorre el árbol de accesibilidad, que ya está activo para pulsar por
     * texto; esto solo lo expone entero en vez de nodo a nodo.
     */
    fun dumpHierarchyXml(): String {
        val raiz = rootInActiveWindow ?: return "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation=\"0\" />"
        val sb = StringBuilder(64 * 1024)
        sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n")
        sb.append("<hierarchy rotation=\"0\">\n")
        try {
            escribirNodo(raiz, sb, 0)
        } catch (e: Exception) {
            Log.w(TAG, "dumpHierarchy: ${e.message}")
        }
        sb.append("</hierarchy>")
        return sb.toString()
    }

    private fun escribirNodo(nodo: AccessibilityNodeInfo, sb: StringBuilder, indice: Int) {
        val r = android.graphics.Rect()
        nodo.getBoundsInScreen(r)
        val textoPropio = if (nodo.isPassword) "" else nodo.text?.toString().orEmpty()
        val descripcionPropia = if (nodo.isPassword) "" else nodo.contentDescription?.toString().orEmpty()
        val textoAccionable = if (nodo.isClickable && textoPropio.isBlank() && descripcionPropia.isBlank())
            primeraEtiquetaDescendiente(nodo) else ""

        sb.append("<node")
        sb.append(" index=\"").append(indice).append('"')
        sb.append(" text=\"").append(escapar(textoPropio.ifBlank { textoAccionable })).append('"')
        sb.append(" resource-id=\"").append(escapar(nodo.viewIdResourceName)).append('"')
        sb.append(" class=\"").append(escapar(nodo.className?.toString())).append('"')
        sb.append(" package=\"").append(escapar(nodo.packageName?.toString())).append('"')
        sb.append(" content-desc=\"").append(escapar(descripcionPropia)).append('"')
        sb.append(" checkable=\"").append(nodo.isCheckable).append('"')
        sb.append(" checked=\"").append(nodo.isChecked).append('"')
        sb.append(" clickable=\"").append(nodo.isClickable).append('"')
        sb.append(" enabled=\"").append(nodo.isEnabled).append('"')
        sb.append(" visible-to-user=\"").append(nodo.isVisibleToUser).append('"')
        sb.append(" focusable=\"").append(nodo.isFocusable).append('"')
        sb.append(" focused=\"").append(nodo.isFocused).append('"')
        sb.append(" scrollable=\"").append(nodo.isScrollable).append('"')
        sb.append(" long-clickable=\"").append(nodo.isLongClickable).append('"')
        sb.append(" password=\"").append(nodo.isPassword).append('"')
        sb.append(" selected=\"").append(nodo.isSelected).append('"')
        sb.append(" bounds=\"[").append(r.left).append(',').append(r.top)
          .append("][").append(r.right).append(',').append(r.bottom).append("]\"")

        val hijos = nodo.childCount
        if (hijos == 0) {
            sb.append(" />\n")
            return
        }
        sb.append(">\n")
        for (i in 0 until hijos) {
            nodo.getChild(i)?.let { escribirNodo(it, sb, i) }
        }
        sb.append("</node>\n")
    }

    private fun primeraEtiquetaDescendiente(nodo: AccessibilityNodeInfo, profundidad: Int = 0): String {
        if (profundidad >= 3) return ""
        for (i in 0 until nodo.childCount) {
            val hijo = nodo.getChild(i) ?: continue
            if (hijo.isPassword || !hijo.isVisibleToUser) continue
            val etiqueta = hijo.text?.toString()?.trim().orEmpty()
                .ifBlank { hijo.contentDescription?.toString()?.trim().orEmpty() }
            if (etiqueta.isNotBlank()) return etiqueta.take(160)
            val anidada = primeraEtiquetaDescendiente(hijo, profundidad + 1)
            if (anidada.isNotBlank()) return anidada
        }
        return ""
    }

    private fun escapar(valor: String?): String {
        if (valor.isNullOrEmpty()) return ""
        val sb = StringBuilder(valor.length + 16)
        for (c in valor) {
            when (c) {
                '&' -> sb.append("&amp;")
                '<' -> sb.append("&lt;")
                '>' -> sb.append("&gt;")
                '"' -> sb.append("&quot;")
                '\'' -> sb.append("&apos;")
                // Los caracteres de control rompen el XML y no aportan nada.
                else -> if (c.code < 0x20) sb.append(' ') else sb.append(c)
            }
        }
        return sb.toString()
    }

    /**
     * Get current screen content as text for debugging
     */
    fun getScreenContent(): String {
        val root = rootInActiveWindow ?: return "No active window"

        val builder = StringBuilder()
        collectText(root, builder, 0)
        return builder.toString()
    }

    private fun collectText(node: AccessibilityNodeInfo, builder: StringBuilder, depth: Int) {
        val indent = "  ".repeat(depth)

        if (!node.text.isNullOrEmpty()) {
            builder.append("$indent${node.text}\n")
        }

        if (!node.contentDescription.isNullOrEmpty()) {
            builder.append("$indent[DESC: ${node.contentDescription}]\n")
        }

        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                collectText(child, builder, depth + 1)
            }
        }
    }
}
