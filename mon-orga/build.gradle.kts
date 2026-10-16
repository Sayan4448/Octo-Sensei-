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
        versionCode = 4
        versionName = "4.0"
    }

    // Committed key: every build, from any machine, can update the installed app without uninstalling it (which wipes the data).
    signingConfigs { getByName("debug") { storeFile = file("debug.keystore") } }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        // West of Greenwich, so a UTC/local mix-up in the date picker would land on the wrong day and fail the tests.
        unitTests.all { it.systemProperty("user.timezone", "America/Los_Angeles") }
    }

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
    implementation("com.google.android.material:material:1.13.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16")
}
