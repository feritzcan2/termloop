const UPDATE_GROUP_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export function mobileUpdatePage(requestUrl) {
  const request = new URL(requestUrl ?? "/mobile-update", "https://termloop.invalid");
  const candidate = request.searchParams.get("group") ?? "";
  const group = UPDATE_GROUP_PATTERN.test(candidate) ? candidate : undefined;
  const appUrl = group === undefined
    ? "termloop://force-update"
    : `termloop://force-update?group=${encodeURIComponent(group)}`;
  const release = group === undefined
    ? "Latest production release"
    : `Release ${group}`;

  return {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
    body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>TermLoop Mobile Update</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #1e2325; color: #dededf; }
    main { width: min(100%, 420px); padding: 28px 22px; border-radius: 18px; background: #2b3032; box-shadow: 0 18px 60px rgba(0,0,0,.28); }
    .prompt { color: #a48cff; font: 800 13px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 14px 0 8px; font-size: 28px; letter-spacing: -.03em; }
    p { margin: 0; color: #9aa0a1; font-size: 15px; line-height: 1.5; }
    .release { margin-top: 12px; color: #5b6062; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    a { display: grid; place-items: center; min-height: 52px; margin-top: 24px; border-radius: 11px; background: #7c5cff; color: #f7f5ff; font-weight: 800; text-decoration: none; }
    small { display: block; margin-top: 14px; color: #73797a; line-height: 1.4; text-align: center; }
  </style>
</head>
<body>
  <main>
    <div class="prompt">❯ update ready</div>
    <h1>TermLoop Mobile</h1>
    <p>Open the app, download the newest compatible OTA, and restart into it now.</p>
    <div class="release">${release}</div>
    <a href="${appUrl}">Force Update</a>
    <small>Keep Tailscale connected until TermLoop restarts.</small>
  </main>
</body>
</html>`,
  };
}
