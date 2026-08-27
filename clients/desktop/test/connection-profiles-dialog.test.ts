import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ConnectionProfilesDialog,
  mergeConnectionProfileStatuses,
} from "../src/renderer/ui/ConnectionProfilesDialog.js";

describe("ConnectionProfilesDialog", () => {
  it("applies live source status without re-enabling a disabled profile", () => {
    const profile = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      name: "Remote computer",
      transport: "tailscale" as const,
      scope: "full" as const,
      endpoint: "wss://example.ts.net",
      enabled: true,
      persistence: "encrypted" as const,
      state: "connected" as const,
    };
    const offline = {
      ...profile,
      state: "offline" as const,
      message: "Connection lost; reconnecting",
    };

    expect(mergeConnectionProfileStatuses([profile], new Map([[profile.id, offline]])))
      .toEqual([offline]);
    expect(mergeConnectionProfileStatuses(
      [{ ...profile, enabled: false }],
      new Map([[profile.id, offline]]),
    )[0]).toMatchObject({ enabled: false });
  });

  it("presents an app-only host and client setup flow", () => {
    const markup = renderToStaticMarkup(createElement(ConnectionProfilesDialog, {
      setEnabled: vi.fn(),
      close: vi.fn(),
      connect: vi.fn(),
      disableHost: vi.fn(),
      discoverTailscaleServers: vi.fn(),
      enableHost: vi.fn(),
      hostStatus: vi.fn(),
      list: vi.fn(async () => []),
      remove: vi.fn(),
      subscribeStatus: vi.fn(() => () => undefined),
    }));

    expect(markup).toContain("Computers");
    expect(markup).toContain("Your computers");
    expect(markup).toContain("On your Tailscale network");
    expect(markup).toContain("Computers with TermLoop sharing enabled appear here automatically");
    expect(markup).toContain("Share this computer");
    expect(markup).toContain("Add by address instead");
    expect(markup).toContain("Connect with one click");
    expect(markup).toContain('role="group" aria-label="Connection settings"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain('role="tab"');
    expect(markup).not.toContain("Pairing code");
    expect(markup).not.toContain("termloopctl");
  });
});
