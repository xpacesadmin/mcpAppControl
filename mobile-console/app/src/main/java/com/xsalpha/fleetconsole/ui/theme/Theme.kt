package com.xsalpha.fleetconsole.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = Color(0xFF2DD4BF),
    onPrimary = Color(0xFF03201C),
    secondary = Color(0xFF7DD3FC),
    background = Color(0xFF07121C),
    surface = Color(0xFF0E1D29),
    surfaceVariant = Color(0xFF172A38),
    error = Color(0xFFFF8A80),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF00796B),
    secondary = Color(0xFF0369A1),
    background = Color(0xFFF3F7F9),
    surface = Color.White,
    surfaceVariant = Color(0xFFE2EDF2),
)

@Composable
fun FleetConsoleTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content,
    )
}

