import * as Sentry from "@sentry/react-native";
import * as Application from "expo-application";
import * as Updates from "expo-updates";

import { subscribeMobileDiagnostics } from "./mobile-diagnostics";
import { mobileSentryDiagnostic } from "./sentry-diagnostics";

const SENTRY_DSN = "https://f947d94551545970dcb7e607aa06e13a@o4511248981164032.ingest.de.sentry.io/4512013745979472";
const enabled = !__DEV__;

Sentry.init({
  dsn: SENTRY_DSN,
  enabled,
  environment: "production",
  sendDefaultPii: false,
  enableLogs: enabled,
  logsOrigin: "js",
  enableAutoConsoleLogs: false,
  enableAutoPerformanceTracing: false,
  tracesSampleRate: 0,
  attachScreenshot: false,
  attachViewHierarchy: false,
  enableCaptureFailedRequests: false,
  maxBreadcrumbs: 200,
  beforeBreadcrumb(breadcrumb) {
    return breadcrumb.category?.startsWith("termloop.mobile") ? breadcrumb : null;
  },
  beforeSend(event) {
    delete event.request;
    delete event.user;
    return event;
  },
});

if (enabled) {
  Sentry.setTags({
    "app.version": Application.nativeApplicationVersion ?? "unknown",
    "app.build": Application.nativeBuildVersion ?? "unknown",
    "expo.channel": Updates.channel ?? "embedded",
    "expo.runtime": Updates.runtimeVersion ?? "unknown",
    "expo.update": Updates.updateId ?? "embedded",
  });
  Sentry.setContext("expo_update", {
    channel: Updates.channel,
    runtimeVersion: Updates.runtimeVersion,
    updateId: Updates.updateId,
    embedded: Updates.isEmbeddedLaunch,
  });

  subscribeMobileDiagnostics((event) => {
    const diagnostic = mobileSentryDiagnostic(event);
    if (diagnostic === undefined) return;
    Sentry.logger[diagnostic.level](diagnostic.message, diagnostic.attributes);
    Sentry.addBreadcrumb({
      category: "termloop.mobile.connection",
      level: diagnostic.level === "error" ? "error" : diagnostic.level === "warn" ? "warning" : diagnostic.level,
      message: diagnostic.message,
      data: diagnostic.attributes,
    });
    if (diagnostic.createsIssue) {
      Sentry.captureMessage(diagnostic.message, {
        level: "warning",
        fingerprint: ["termloop-mobile", event.area, event.event],
        tags: { area: event.area, diagnostic: event.event },
        extra: diagnostic.attributes,
      });
    }
  });
}
