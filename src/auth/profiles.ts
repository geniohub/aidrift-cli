// CLI profile storage: ~/.drift/profiles.json with mode 0600.
// Supports multiple named profiles (host + credentials) with one "active"
// pointer. Legacy ~/.drift/auth.json is auto-migrated to a "default" profile
// on first load.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DIR = join(homedir(), ".drift");
const FILE = join(DIR, "profiles.json");
const LEGACY_FILE = join(DIR, "auth.json");

export const DEFAULT_PROFILE_NAME = "default";
export const DEFAULT_API_URL =
  process.env.AIDRIFT_API_URL ?? "https://drift.geniohub.com/api";

export interface Profile {
  apiBaseUrl: string;
  email?: string;
  // Exactly one of { accessToken + refreshToken } or { pat } is populated
  // once the profile is signed in. Both are absent for a freshly-added
  // profile awaiting login.
  accessToken?: string;
  refreshToken?: string;
  pat?: string;
}

export interface ProfilesFile {
  active: string;
  profiles: Record<string, Profile>;
}

interface LegacyAuth {
  apiBaseUrl: string;
  email: string;
  accessToken?: string;
  refreshToken?: string;
  pat?: string;
}

function writeAtomic(data: ProfilesFile): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(data, null, 2));
  chmodSync(FILE, 0o600);
}

function emptyFile(): ProfilesFile {
  return {
    active: DEFAULT_PROFILE_NAME,
    profiles: {
      [DEFAULT_PROFILE_NAME]: { apiBaseUrl: DEFAULT_API_URL },
    },
  };
}

function migrateLegacy(): ProfilesFile | null {
  if (!existsSync(LEGACY_FILE)) return null;
  try {
    const raw = readFileSync(LEGACY_FILE, "utf8").trim();
    if (!raw) return null;
    const legacy = JSON.parse(raw) as LegacyAuth;
    const migrated: ProfilesFile = {
      active: DEFAULT_PROFILE_NAME,
      profiles: {
        [DEFAULT_PROFILE_NAME]: {
          apiBaseUrl: legacy.apiBaseUrl,
          email: legacy.email,
          accessToken: legacy.accessToken,
          refreshToken: legacy.refreshToken,
          pat: legacy.pat,
        },
      },
    };
    writeAtomic(migrated);
    // Move legacy file aside so we don't re-migrate on the next call.
    try {
      renameSync(LEGACY_FILE, `${LEGACY_FILE}.bak`);
    } catch { /* ignore */ }
    return migrated;
  } catch {
    return null;
  }
}

export function loadFile(): ProfilesFile {
  if (existsSync(FILE)) {
    try {
      const data = JSON.parse(readFileSync(FILE, "utf8")) as ProfilesFile;
      if (data && typeof data === "object" && data.profiles && data.active) {
        return data;
      }
    } catch { /* fall through to reset */ }
  }
  const migrated = migrateLegacy();
  if (migrated) return migrated;
  const fresh = emptyFile();
  writeAtomic(fresh);
  return fresh;
}

export function saveFile(data: ProfilesFile): void {
  writeAtomic(data);
}

/**
 * Resolve the name of the profile to use for this invocation. Honors
 * AIDRIFT_PROFILE as a per-invocation override, otherwise falls back to
 * the "active" pointer from profiles.json.
 */
export function resolveActiveName(file: ProfilesFile): string {
  const override = process.env.AIDRIFT_PROFILE;
  if (override && file.profiles[override]) return override;
  if (file.profiles[file.active]) return file.active;
  const first = Object.keys(file.profiles)[0];
  return first ?? DEFAULT_PROFILE_NAME;
}

export function loadActiveProfile(): { name: string; profile: Profile } {
  const file = loadFile();
  const name = resolveActiveName(file);
  const profile = file.profiles[name] ?? { apiBaseUrl: DEFAULT_API_URL };
  return { name, profile };
}

export function saveActiveProfile(profile: Profile): void {
  const file = loadFile();
  const name = resolveActiveName(file);
  file.profiles[name] = profile;
  saveFile(file);
}

export function clearActiveProfile(): void {
  const file = loadFile();
  const name = resolveActiveName(file);
  const existing = file.profiles[name];
  if (!existing) return;
  // Keep the apiBaseUrl but drop credentials so the profile is still usable
  // for a fresh `drift login`.
  file.profiles[name] = { apiBaseUrl: existing.apiBaseUrl };
  saveFile(file);
}

export function listProfiles(): {
  active: string;
  effectiveActive: string;
  profiles: Record<string, Profile>;
} {
  const file = loadFile();
  return {
    active: file.active,
    effectiveActive: resolveActiveName(file),
    profiles: file.profiles,
  };
}

export function addProfile(name: string, apiBaseUrl: string): void {
  if (!name || /[^a-zA-Z0-9_-]/.test(name)) {
    throw new Error(`invalid profile name "${name}" (use letters, digits, _ or -)`);
  }
  const file = loadFile();
  if (file.profiles[name]) {
    throw new Error(`profile "${name}" already exists`);
  }
  file.profiles[name] = { apiBaseUrl };
  saveFile(file);
}

export function useProfile(name: string): void {
  const file = loadFile();
  if (!file.profiles[name]) {
    throw new Error(`no profile named "${name}"`);
  }
  file.active = name;
  saveFile(file);
}

export function removeProfile(name: string): void {
  const file = loadFile();
  if (!file.profiles[name]) {
    throw new Error(`no profile named "${name}"`);
  }
  delete file.profiles[name];
  if (Object.keys(file.profiles).length === 0) {
    file.profiles[DEFAULT_PROFILE_NAME] = { apiBaseUrl: DEFAULT_API_URL };
    file.active = DEFAULT_PROFILE_NAME;
  } else if (file.active === name) {
    file.active = Object.keys(file.profiles)[0]!;
  }
  saveFile(file);
}

export function updateProfile(name: string, patch: Partial<Profile>): void {
  const file = loadFile();
  const existing = file.profiles[name];
  if (!existing) throw new Error(`no profile named "${name}"`);
  file.profiles[name] = { ...existing, ...patch };
  saveFile(file);
}
