// CLI token storage: ~/.drift/auth.json with mode 0600.
// Not as secure as an OS keychain (the extension uses SecretStorage), but
// fine for a developer-machine CLI tool.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DIR = join(homedir(), ".drift");
const FILE = join(DIR, "auth.json");

export interface StoredAuth {
  apiBaseUrl: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

export function load(): StoredAuth | null {
  if (!existsSync(FILE)) return null;
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as StoredAuth;
  } catch {
    return null;
  }
}

export function save(auth: StoredAuth): void {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(auth, null, 2));
  chmodSync(FILE, 0o600);
}

export function clear(): void {
  if (existsSync(FILE)) writeFileSync(FILE, "");
}
