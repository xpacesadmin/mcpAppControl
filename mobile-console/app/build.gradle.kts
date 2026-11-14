plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xsalpha.fleetconsole"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xsalpha.fleetconsole"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-read-only-canary"
    }

    signingConfigs {
        create("ownerRelease") {
            val keystorePath = System.getenv("XSALPHA_CONSOLE_KEYSTORE")
            val storePasswordValue = System.getenv("XSALPHA_CONSOLE_KEYSTORE_PASSWORD")
            val keyAliasValue = System.getenv("XSALPHA_CONSOLE_KEY_ALIAS")
            val keyPasswordValue = System.getenv("XSALPHA_CONSOLE_KEY_PASSWORD")
            if (!keystorePath.isNullOrBlank() && !storePasswordValue.isNullOrBlank() &&
                !keyAliasValue.isNullOrBlank() && !keyPasswordValue.isNullOrBlank()
            ) {
                storeFile = file(keystorePath)
                storePassword = storePasswordValue
                keyAlias = keyAliasValue
                keyPassword = keyPasswordValue
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            val releaseConfig = signingConfigs.getByName("ownerRelease")
            if (releaseConfig.storeFile != null) signingConfig = releaseConfig
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.4" }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.02.02")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.fragment:fragment-ktx:1.6.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
