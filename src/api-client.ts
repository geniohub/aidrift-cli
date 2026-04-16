// Minimal HTTP client for the CLI. Mirrors the frontend client's behavior
// (auto-refresh on 401) but persists tokens to ~/.drift/auth.json.

import { load, save, clear, type StoredAuth } from "./auth/store.js";

// Single public origin for all clients. In local dev this is the frontend
// container at :3331 which proxies /api/* to the api container. In SaaS
// deployment, override with AIDRIFT_API_URL=https://aidrift.example.com/api.
export const DEFAULT_API_URL = process.env.AIDRIFT_API_URL ?? "http://localhost:3331/api";

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

function bearerFromStore(stored: StoredAuth | null): string | null {
  if (!stored) return null;
  return stored.pat ?? stored.accessToken ?? null;
}

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; createdAt: string };
}

async function tryRefresh(stored: StoredAuth): Promise<StoredAuth | null> {
  const res = await rawFetch("/auth/refresh", {
    apiBaseUrl: stored.apiBaseUrl,
    method: "POST",
    body: JSON.stringify({ refreshToken: stored.refreshToken }),
    skipAuth: true,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as AuthResponse;
  const next: StoredAuth = {
    apiBaseUrl: stored.apiBaseUrl,
    email: data.user.email,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  };
  save(next);
  return next;
}

export async function api<T = unknown>(
  path: string,
  init: Omit<FetchInit, "apiBaseUrl" | "accessToken"> = {},
): Promise<T> {
  let stored = load();
  const apiBaseUrl = stored?.apiBaseUrl ?? DEFAULT_API_URL;
  let res = await rawFetch(path, {
    ...init,
    apiBaseUrl,
    accessToken: bearerFromStore(stored),
  });
  // PATs don't refresh. Only retry on 401 if we're using a JWT pair.
  if (res.status === 401 && stored && !init.skipAuth && stored.accessToken && !stored.pat) {
    const refreshed = await tryRefresh(stored);
    if (refreshed) {
      stored = refreshed;
      res = await rawFetch(path, {
        ...init,
        apiBaseUrl,
        accessToken: bearerFromStore(refreshed),
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
): Promise<StoredAuth> {
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
  const stored: StoredAuth = {
    apiBaseUrl,
    email: data.user.email,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  };
  save(stored);
  return stored;
}

export async function loginWithTokenAndPersist(
  apiBaseUrl: string,
  token: string,
): Promise<StoredAuth> {
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
  const stored: StoredAuth = {
    apiBaseUrl,
    email: user.email,
    pat: token,
  };
  save(stored);
  return stored;
}

export function logoutAndClear(): void {
  clear();
}
