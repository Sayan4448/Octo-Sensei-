plugins {
    id("com.android.application") version "8.13.2"
    id("org.jetbrains.kotlin.android") version "2.2.21"
}

android {
    namespace = "com.sayan.todo"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.sayan.todo"
        minSdk = 26 // java.time without desugaring
        targetSdk = 36
        versionCode = 5
        versionName = "5.0.0"
    }

    // Committed key: every build, from any machine, can update the installed app without uninstalling it (which wipes the data).
    signingConfigs { getByName("debug") { storeFile = file("debug.keystore") } }
    // The published APK: same key (so it installs over earlier versions), but not debuggable.
    buildTypes { getByName("release") { signingConfig = signingConfigs.getByName("debug"); isMinifyEnabled = false } }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        // West of Greenwich, so a UTC/local mix-up lands on the wrong day and fails the tests.
        unitTests.all { it.systemProperty("user.timezone", "America/Los_Angeles") }
    }

    // The interface is shared with the PC app: web/src is bundled as the app's assets.
    sourceSets { getByName("main") { assets.srcDirs("../web/src") } }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.biometric:biometric:1.1.0") // optional lock: fingerprint, face or PIN
    implementation("org.nanohttpd:nanohttpd:2.3.1") // the PC version's web server
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16")
}
