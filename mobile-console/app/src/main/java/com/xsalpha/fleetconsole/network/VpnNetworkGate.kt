package com.xsalpha.fleetconsole.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

class VpnRequiredException : Exception("An active private VPN is required")

class VpnNetworkGate(context: Context) {
    private val connectivityManager = context.getSystemService(ConnectivityManager::class.java)

    fun requireActive() {
        val network = connectivityManager.activeNetwork
        val capabilities = network?.let(connectivityManager::getNetworkCapabilities)
        val approved = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        if (!approved) throw VpnRequiredException()
    }
}
