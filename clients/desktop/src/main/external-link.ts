function decodedSegment(value: string, maxScalars: number): string {
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) throw new Error("externalLinkDenied");
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).normalize("NFC");
  } catch {
    throw new Error("externalLinkDenied");
  }
  if (decoded === "." || decoded === ".." || [...decoded].length === 0 || [...decoded].length > maxScalars || /[\\/\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new Error("externalLinkDenied");
  }
  return decoded;
}

export function validatedGitHostPullRequestUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("externalLinkDenied");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("externalLinkDenied");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("externalLinkDenied");
  }
  if (url.hostname === "github.com") {
    if (!value.startsWith("https://github.com/") || /%2f|%5c/i.test(url.pathname) || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(url.pathname)) {
      throw new Error("externalLinkDenied");
    }
  } else if (url.hostname === "dev.azure.com") {
    if (!value.startsWith("https://dev.azure.com/")) throw new Error("externalLinkDenied");
    const match = /^\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/([1-9]\d*)$/.exec(url.pathname);
    const organization = match?.[1];
    const project = match?.[2];
    const repository = match?.[3];
    if (!organization || !project || !repository || !/^[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?$/.test(organization)) throw new Error("externalLinkDenied");
    decodedSegment(project, 64);
    decodedSegment(repository, 64);
  } else {
    throw new Error("externalLinkDenied");
  }
  return url.toString();
}

export function validatedJiraIssueUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("externalLinkDenied");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("externalLinkDenied");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.search !== ""
    || url.hash !== ""
    || !/^[A-Za-z0-9.-]+$/u.test(url.hostname)
    || !/^\/browse\/[A-Z][A-Z0-9]{0,63}-[1-9]\d{0,19}$/u.test(url.pathname)
  ) {
    throw new Error("externalLinkDenied");
  }
  return url.toString();
}

export function validatedExternalUrl(value: string): string {
  try {
    return validatedGitHostPullRequestUrl(value);
  } catch {
    return validatedJiraIssueUrl(value);
  }
}

export function validatedLoopbackRunUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("runUrlDenied");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("runUrlDenied");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
    || url.username !== ""
    || url.password !== ""
    || url.port === "0") {
    throw new Error("runUrlDenied");
  }
  return url.toString();
}
