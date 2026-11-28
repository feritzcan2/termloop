export type MobileSentryEnvironment = "production" | "local";

/**
 * App Store and TestFlight binaries are re-signed by Apple without an embedded
 * provisioning profile; locally archived development or ad hoc builds keep it.
 * The check reads the installed binary, so it stays correct after OTA updates.
 */
export function mobileSentryEnvironment(hasEmbeddedProvisioningProfile: () => boolean): MobileSentryEnvironment {
  try {
    return hasEmbeddedProvisioningProfile() ? "local" : "production";
  } catch {
    return "production";
  }
}
