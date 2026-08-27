import { createPrivateKey, sign } from "node:crypto";

export type AccessCredential = {
  deviceId: string;
  privateKey: JsonWebKey;
  serverFingerprint: string;
};

export function signAccessChallenge(
  privateKey: JsonWebKey,
  serverFingerprint: string,
  channel: "control" | "terminal" | "forward",
  nonce: string,
): string {
  return sign(
    null,
    Buffer.from(`tl-access-v1|${serverFingerprint}|${channel}|${nonce}`),
    createPrivateKey({ key: privateKey, format: "jwk" }),
  ).toString("base64url");
}
