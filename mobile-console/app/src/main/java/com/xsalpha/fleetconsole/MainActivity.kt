package com.xsalpha.fleetconsole

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.xsalpha.fleetconsole.ui.FleetConsoleApp
import com.xsalpha.fleetconsole.ui.FleetViewModel
import com.xsalpha.fleetconsole.ui.theme.FleetConsoleTheme
import com.xsalpha.fleetconsole.security.BiometricStepUp
import com.xsalpha.fleetconsole.security.KeystoreIdentity

class MainActivity : FragmentActivity() {
    private val viewModel: FleetViewModel by viewModels()
    private val biometricStepUp by lazy { BiometricStepUp(this, KeystoreIdentity()) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent {
            FleetConsoleTheme {
                LifecycleEventEffect(Lifecycle.Event.ON_START) { viewModel.startPolling() }
                LifecycleEventEffect(Lifecycle.Event.ON_STOP) { viewModel.stopPolling() }
                FleetConsoleApp(viewModel, biometricStepUp::sign)
            }
        }
    }
}
