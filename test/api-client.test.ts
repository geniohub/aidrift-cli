import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth/profiles.js", () => ({
  DEFAULT_API_URL: "http://localhost:3331/api",
  loadActiveProfile: vi.fn(),
  saveActiveProfile: vi.fn(),
  clearActiveProfile: vi.fn(),
  updateProfile: vi.fn(),
}));

import { api, ApiError, loginWithTokenAndPersist, logoutAndClear } from "../src/api-client.js";
import {
  clearActiveProfile,
  loadActiveProfile,
  saveActiveProfile,
  updateProfile,
} from "../src/auth/profiles.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cli api client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(loadActiveProfile).mockReset();
    vi.mocked(saveActiveProfile).mockReset();
    vi.mocked(clearActiveProfile).mockReset();
    vi.mocked(updateProfile).mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("uses PAT from active profile for authenticated requests", async () => {
    vi.mocked(loadActiveProfile).mockReturnValue({
      name: "default",
      profile: {
        apiBaseUrl: "http://localhost:3331/api",
        email: "u@example.com",
        pat: "aidrift_pat_abc",
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));

    const out = await api<{ ok: boolean }>("/auth/me");

    expect(out.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("http://localhost:3331/api/auth/me");
    const auth = new Headers((init as RequestInit).headers).get("Authorization");
    expect(auth).toBe("Bearer aidrift_pat_abc");
  });

  it("refreshes JWT on 401 and retries original request", async () => {
    vi.mocked(loadActiveProfile).mockReturnValue({
      name: "default",
      profile: {
        apiBaseUrl: "http://localhost:3331/api",
        email: "u@example.com",
        accessToken: "old-access",
        refreshToken: "old-refresh",
      },
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          user: { id: "u1", email: "u@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const out = await api<{ ok: boolean }>("/sessions");

    expect(out.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(updateProfile).toHaveBeenCalledWith("default", {
      apiBaseUrl: "http://localhost:3331/api",
      email: "u@example.com",
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
  });

  it("throws ApiError with parsed backend error message", async () => {
    vi.mocked(loadActiveProfile).mockReturnValue({
      name: "default",
      profile: { apiBaseUrl: "http://localhost:3331/api" },
    });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));

    try {
      await api("/secret");
      throw new Error("expected api to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 403, message: "forbidden" });
    }
  });

  it("persists PAT login after successful /auth/me probe", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: "u1", email: "u@example.com" }));

    const stored = await loginWithTokenAndPersist(
      "http://localhost:3331/api",
      "aidrift_pat_testtoken",
    );

    expect(stored).toEqual({
      apiBaseUrl: "http://localhost:3331/api",
      email: "u@example.com",
      pat: "aidrift_pat_testtoken",
    });
    expect(saveActiveProfile).toHaveBeenCalledWith(stored);
  });

  it("clears active profile credentials on logout", () => {
    logoutAndClear();
    expect(clearActiveProfile).toHaveBeenCalledTimes(1);
  });
});
