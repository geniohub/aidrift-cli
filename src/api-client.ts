// Minimal HTTP client for the CLI. Resolves the API host and credentials
// from the active profile (~/.drift/profiles.json). Auto-refreshes JWT
// access tokens on 401.

import {
  DEFAULT_API_URL,
  loadActiveProfile,
  saveActiveProfile,
  clearActiveProfile,
  updateProfile,
  type Profile,
} from "./auth/profiles.js";

export { DEFAULT_API_URL };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface FetchInit extends RequestInit {
  apiBaseUrl?: string;
  accessToken?: string | null;
  skipAuth?: boolean;
}

async function rawFetch(path: string, init: FetchInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!init.skipAuth && init.accessToken) {
    headers.set("Authorization", `Bearer ${init.accessToken}`);
  }
  const url = `${init.apiBaseUrl}${path}`;
  return fetch(url, { ...init, headers });
}

function bearerFromProfile(p: Profile | null): string | null {
  if (!p) return null;
  return p.pat ?? p.accessToken ?? null;
}

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; createdAt: string };
}

async function tryRefresh(name: string, profile: Profile): Promise<Profile | null> {
  if (!profile.refreshToken) return null;
  const res = await rawFetch("/auth/refresh", {
    apiBaseUrl: profile.apiBaseUrl,
    method: "POST",
    body: JSON.stringify({ refreshToken: profile.refreshToken }),
    skipAuth: true,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as AuthResponse;
  const next: Profile = {
    apiBaseUrl: profile.apiBaseUrl,
    email: data.user.email,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  };
  updateProfile(name, next);
  return next;
}

export async function api<T = unknown>(
  path: string,
  init: Omit<FetchInit, "apiBaseUrl" | "accessToken"> = {},
): Promise<T> {
  let { name, profile } = loadActiveProfile();
  const apiBaseUrl = profile.apiBaseUrl ?? DEFAULT_API_URL;
  let res = await rawFetch(path, {
    ...init,
    apiBaseUrl,
    accessToken: bearerFromProfile(profile),
  });
  // PATs don't refresh. Only retry on 401 if we're using a JWT pair.
  if (res.status === 401 && !init.skipAuth && profile.accessToken && !profile.pat) {
    const refreshed = await tryRefresh(name, profile);
    if (refreshed) {
      profile = refreshed;
      res = await rawFetch(path, {
        ...init,
        apiBaseUrl,
        accessToken: bearerFromProfile(refreshed),
      });
    }
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* ignore */ }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function loginAndPersist(
  apiBaseUrl: string,
  email: string,
  password: string,
): Promise<Profile> {
  const res = await rawFetch("/auth/login", {
    apiBaseUrl,
    method: "POST",
    body: JSON.stringify({ email, password }),
    skipAuth: true,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  const data = (await res.json()) as AuthResponse;
  const next: Profile = {
    apiBaseUrl,
    email: data.user.email,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  };
  saveActiveProfile(next);
  return next;
}

export async function loginWithTokenAndPersist(
  apiBaseUrl: string,
  token: string,
): Promise<Profile> {
  // Probe /auth/me with the token to confirm it's valid and learn the email.
  const res = await rawFetch("/auth/me", {
    apiBaseUrl,
    accessToken: token,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  const user = (await res.json()) as { id: string; email: string };
  const next: Profile = {
    apiBaseUrl,
    email: user.email,
    pat: token,
  };
  saveActiveProfile(next);
  return next;
}

export function logoutAndClear(): void {
  clearActiveProfile();
}
