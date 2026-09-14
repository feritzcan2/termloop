export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Invalid setup value.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export const inspectMachineScript = String.raw`set -eu
uname -s
uname -m
id -u
id -un
if test -d /run/systemd/system; then echo systemd; else echo unsupported; fi
if command -v apt-get >/dev/null 2>&1; then echo apt; else echo other; fi
if test "$(id -u)" = 0; then
  echo root
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  echo sudo
else
  echo user
fi
df -Pk "$HOME" | awk 'NR==2 { print $4 }'
`;

export function serverUserCommand(user: string, admin: "root" | "sudo" | "user", command: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(user)) throw new Error("Invalid server user.");
  const prefix = String.raw`set -eu
cd "$HOME"
export PATH="$HOME/.local/share/termloop-node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
`;
  return admin === "root"
    ? `runuser -u ${shellQuote(user)} -- sh -c ${shellQuote(prefix + command)}`
    : `sh -c ${shellQuote(prefix + command)}`;
}

export function inspectServerScript(user: string, admin: "root" | "sudo" | "user"): string {
  return (admin === "root" ? `id ${shellQuote(user)} >/dev/null 2>&1 || { echo missing; exit 0; }; ` : "") + serverUserCommand(user, admin, String.raw`set -eu
p="$HOME/.local/share/termloop-server/current"
if test -f "$p/termloop-server-manager.mjs"; then
  echo installed
else
  echo missing
fi
if systemctl --user is-active --quiet termloop-next.service 2>/dev/null; then echo running; else echo stopped; fi
if test "$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null)" = yes; then echo linger; else echo no-linger; fi
`);
}

export function prepareUserScript(user: string, admin: "root" | "sudo" | "user", publicKey: string): string {
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(publicKey)) throw new Error("Invalid generated SSH key.");
  const privileged = admin === "sudo" ? "sudo -n " : "";
  const rootSetup = admin === "user" ? "" : `
${admin === "root" ? `id ${shellQuote(user)} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${shellQuote(user)}` : ""}
${privileged}env DEBIAN_FRONTEND=noninteractive apt-get -q update >/dev/null
${privileged}env DEBIAN_FRONTEND=noninteractive apt-get -q install -y ca-certificates curl xz-utils libatomic1 >/dev/null
${privileged}loginctl enable-linger ${shellQuote(user)}
${privileged}systemctl start "user@$(id -u ${shellQuote(user)}).service"
`;
  return "set -eu\n" + rootSetup + serverUserCommand(user, admin, `set -eu
umask 077
mkdir -p "$HOME/.ssh" "$HOME/Projects"
test ! -L "$HOME/.ssh/authorized_keys"
touch "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
grep -qxF ${shellQuote(publicKey)} "$HOME/.ssh/authorized_keys" || printf '\\n%s\\n' ${shellQuote(publicKey)} >> "$HOME/.ssh/authorized_keys"
`);
}

export function installNodeScript(user: string, admin: "root" | "sudo" | "user"): string {
  return serverUserCommand(user, admin, String.raw`set -eu
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then exit 0; fi
command -v curl >/dev/null
command -v xz >/dev/null
umask 077
mkdir -p "$HOME/.local/share"
stage=$(mktemp -d "$HOME/.local/share/.termloop-node-XXXXXX")
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 120 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$stage/sums"
entry=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print }' "$stage/sums")
test "$(printf '%s\n' "$entry" | wc -l)" = 1
archive=$(printf '%s\n' "$entry" | awk '{print $2}')
test -n "$archive"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 240 "https://nodejs.org/dist/latest-v22.x/$archive" -o "$stage/$archive"
printf '%s\n' "$entry" > "$stage/checksum"
(cd "$stage" && sha256sum -c checksum >/dev/null)
mkdir "$stage/node"
tar -xJf "$stage/$archive" --strip-components=1 --no-same-owner -C "$stage/node"
"$stage/node/bin/node" -e 'if(Number(process.versions.node.split(".")[0]) !== 22) process.exit(1)'
test ! -e "$HOME/.local/share/termloop-node"
mv "$stage/node" "$HOME/.local/share/termloop-node"
`);
}

export function remoteCliCommand(user: string, admin: "root" | "sudo" | "user", action: "version" | "access-enable" | "access-status" | "ping"): string {
  return serverUserCommand(user, admin, `node "$HOME/.local/share/termloop-server/current/termloopctl" ${action} --json --runtime "$XDG_RUNTIME_DIR/termloop-next/runtime.json"`);
}
