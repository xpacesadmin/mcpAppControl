# XSAlpha Agent ProGuard Rules

# Keep WebSocket client classes
-keep class dev.mcp.agent.websocket.** { *; }

# Keep JSON model classes
-keep class org.json.** { *; }

# Keep OkHttp classes
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# Keep Coroutines classes
-dontwarn kotlinx.coroutines.**
-keep class kotlinx.coroutines.** { *; }

# Keep Timber logging
-dontwarn com.jakewharton.timber.**
-keep class com.jakewharton.timber.** { *; }

# Keep reflection-based JSON parsing
-keepattributes Signature,InnerClasses,EnclosingMethod

# Keep serialization
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
}

# Componentes propios: el sistema los referencia POR NOMBRE.
# El permiso de accesibilidad se guarda en Ajustes como la cadena
# "dev.mcp.agent.debug/dev.mcp.agent.MCPAccessibilityService"; si R8 renombrara
# esa clase, el permiso concedido dejaría de casar y el agente quedaría inerte
# sin ningún error visible.
-keep class dev.mcp.agent.MCPAccessibilityService { *; }
-keep class dev.mcp.agent.MCPForegroundService { *; }
-keep class dev.mcp.agent.MainActivity { *; }
-keep class dev.mcp.agent.HierarchyServer { *; }
