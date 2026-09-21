# XSAlpha Agent Android - v2.0

Aplicación Android para automatización de dispositivos en la red MCP AppControl.

## Características

- **Conexión WebSocket** con servidor centralizado
- **Reconexión automática** con backoff exponencial (hasta 10 intentos)
- **Cola de comandos** para garantizar ejecución incluso con desconexiones temporales
- **Servicio de accesibilidad** completo para control de UI
- **Comandos soportados**:
  - `OPEN_APP` / `CLOSE_APP` - Gestión de aplicaciones
  - `CLICK_BY_TEXT` / `CLICK_BY_ID` - Interacción con elementos
  - `SET_TEXT` - Entrada de texto en campos editables
  - `SCROLL` / `SWIPE` - Navegación por scroll y gestos
  - `LONG_PRESS` - Pulsaciones largas
  - `PRESS_KEY` / `PRESS_BACK` / `PRESS_HOME` - Eventos de teclado y navegación
  - `WAIT` - Espera hasta que aparezca un elemento
  - `CAPTURE_SCREEN` - Captura de pantalla en base64

## Configuración del Servidor

1. Abre la aplicación XSAlpha Agent
2. Ve a "Configurar Servidor"
3. Ingresa la URL WebSocket (ej: `ws://10.0.2.2:6001`)
4. Configura el número de serie único para cada dispositivo
5. Activa el servicio de accesibilidad en Configuración > Accesibilidad

## Permisos Requeridos

- INTERNET - Conexión WebSocket
- ACCESS_NETWORK_STATE / ACCESS_WIFI_STATE - Monitoreo de red
- FOREGROUND_SERVICE - Servicio persistente en segundo plano
- SYSTEM_ALERT_WINDOW - Ventanas superpuestas
- WAKE_LOCK - Mantener dispositivo activo durante tareas

## Arquitectura

```
┌─────────────────┐     WebSocket      ┌──────────────────┐
│  XSAlpha Agent App  │ ◄──────────────► │  MCP Server      │
│                 │                    │  (Laravel/Node)  │
│ • MainActivity  │                    │                  │
│ • Foreground    │                    │ • Orquestador    │
│   Service       │                    │ • WebSocket Hub  │
│ • Accessibility │                    │ • Command Queue  │
│   Service       │                    │ • Task Scheduler │
└─────────────────┘                    └──────────────────┘
```

## Compilación

```bash
cd android-agent
./gradlew assembleRelease
```

El APK se generará en: `app/build/outputs/apk/release/app-release.apk`

## Instalación en Dispositivo

1. Habilita "Orígenes desconocidos" en Configuración > Seguridad
2. Transfiere el APK al dispositivo
3. Instala y abre la aplicación
4. Configura la conexión al servidor MCP
5. Activa el servicio de accesibilidad

## Notas para Demostración Académica

- Usa 2-3 dispositivos físicos + emuladores para simular los 40 dispositivos
- El VideoLab (app de prueba) se usa para demostrar engagement actions
- Las capturas de pantalla se envían como evidencia al servidor
- Los logs muestran el flujo completo de comandos y respuestas

## Licencia

Proyecto académico - MCP AppControl 2026
