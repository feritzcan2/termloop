// Vite/vitest `?raw` source imports used by source-scanning tests, so test
// code never needs privileged node:fs access (CLIENT_PRIVILEGE boundary).
declare module "*.mm?raw" {
  const source: string;
  export default source;
}

declare module "*.conf?raw" {
  const source: string;
  export default source;
}
