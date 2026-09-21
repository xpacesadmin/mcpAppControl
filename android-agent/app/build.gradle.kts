plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.mcp.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.mcp.agent"
        minSdk = 26
        targetSdk = 34
        versionCode = 4
        versionName = "2.1.2-lab"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Firma del release con el keystore de depuración del equipo.
    //
    // Sin firma, `assembleRelease` produce un APK que Android no deja instalar, y
    // el agente se distribuye desde el propio escritorio, no por Play Store. Usar
    // el keystore que ya existe evita inventar una credencial nueva y guardarla en
    // el repositorio. Si algún día se publica fuera, hay que cambiarlo por una
    // clave propia: al hacerlo, los teléfonos con la versión anterior necesitarán
    // desinstalar antes de actualizar, porque la firma no coincidirá.
    signingConfigs {
        getByName("debug") {
            val taskKeystore = System.getenv("XSALPHA_AGENT_KEYSTORE")
            if (!taskKeystore.isNullOrBlank()) storeFile = file(taskKeystore)
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            // Lab builds deliberately reuse Gradle's standard debug signing
            // configuration. No keystore password or private key is committed.
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    // AndroidX Core
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")

    // WebSocket Client
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JSON Processing
    implementation("org.json:json:20231013")

    // Coroutines for async operations
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")

    // Logging
    implementation("com.jakewharton.timber:timber:5.0.1")

    // Testing
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
}
