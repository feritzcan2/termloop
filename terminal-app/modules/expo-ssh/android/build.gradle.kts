plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "expo.modules.ssh"
  compileSdk = 34

  defaultConfig {
    minSdk = 24
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation("expo.modules:expo-modules-core:+")
  implementation("com.jcraft:jsch:0.1.55")
}
