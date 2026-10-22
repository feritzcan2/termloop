import { describe, expect, it } from "vitest";

import { networkRevivalReason } from "../src/platform/network-revival-state";

const wifi = { isConnected: true, type: "WIFI" };
const cellular = { isConnected: true, type: "CELLULAR" };
const offline = { isConnected: false, type: "NONE" };

describe("network revival", () => {
  it("revives when the network comes back", () => {
    expect(networkRevivalReason(offline, wifi)).toBe("networkRestored");
    expect(networkRevivalReason({ isConnected: undefined, type: undefined }, cellular)).toBe("networkRestored");
  });

  it("revives on a Wi-Fi to cellular handoff that never went offline", () => {
    expect(networkRevivalReason(wifi, cellular)).toBe("networkHandoff");
  });

  it("ignores losing the network, repeated states, and the first observation", () => {
    expect(networkRevivalReason(wifi, offline)).toBeUndefined();
    expect(networkRevivalReason(wifi, { ...wifi })).toBeUndefined();
    expect(networkRevivalReason(undefined, wifi)).toBeUndefined();
  });
});
