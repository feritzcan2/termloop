package expo.modules.termloop

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoTermLoopModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoTermLoop")

    Events("onMessage", "onState", "onDisconnect")

    AsyncFunction("connect") { _: String, _: Int ->
      throw IllegalStateException("expo-termloop: not implemented on Android")
    }

    AsyncFunction("send") { _: String, _: String ->
      throw IllegalStateException("expo-termloop: not implemented on Android")
    }

    AsyncFunction("disconnect") { _: String ->
      throw IllegalStateException("expo-termloop: not implemented on Android")
    }
  }
}
