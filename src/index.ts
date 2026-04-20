#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { input, password as passwordPrompt } from "@inquirer/prompts";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { VERSION } from "@aidrift/core";
import { api, ApiError, DEFAULT_API_URL, loginAndPersist, loginWithTokenAndPersist, logoutAndClear } from "./api-client.js";
import {
  addProfile,
  listProfiles,
  loadActiveProfile,
  removeProfile,
  updateProfile,
  useProfile,
} from "./auth/profiles.js";

const program = new Command();

program
  .name("drift")
  .description("AI Drift Detector — watch your AI coding sessions for drift")
  .version(VERSION);

// ---------- auth ----------

program
  .command("login")
  .description("Sign in to AI Drift (uses the active profile unless --profile is given)")
  .option("--token <token>", "Personal Access Token from the dashboard (required for Google users)")
  .option("--email <email>")
  .option("--password <password>", "(insecure: visible in shell history)")
  .option("--api <url>", "Override the profile's API base URL for this login")
  .option("--profile <name>", "Log into this profile instead of the active one (switches active)")
  .action(async (opts: {
    token?: string;
    email?: string;
    password?: string;
    api?: string;
    profile?: string;
  }) => {
    try {
      if (opts.profile) {
        const all = listProfiles();
        if (!all.profiles[opts.profile]) {
          const url = opts.api ?? DEFAULT_API_URL;
          addProfile(opts.profile, url);
          console.log(chalk.gray(`  created profile "${opts.profile}" at ${url}`));
        }
        useProfile(opts.profile);
      }
      const { name, profile } = loadActiveProfile();
      const apiBaseUrl = opts.api ?? profile.apiBaseUrl ?? DEFAULT_API_URL;
      // Persist the chosen URL on the profile so future requests use it.
      if (apiBaseUrl !== profile.apiBaseUrl) {
        updateProfile(name, { apiBaseUrl });
      }
      if (opts.token || (!opts.email && !opts.password)) {
        const token = opts.token ?? (await passwordPrompt({ message: "Token:", mask: "*" }));
        const stored = await loginWithTokenAndPersist(apiBaseUrl, token.trim());
        console.log(chalk.green(`✔ signed in as ${stored.email} (token) [profile: ${name}]`));
        return;
      }
      const email = opts.email ?? (await input({ message: "Email:" }));
      const pw = opts.password ?? (await passwordPrompt({ message: "Password:", mask: "*" }));
      const stored = await loginAndPersist(apiBaseUrl, email, pw);
      console.log(chalk.green(`✔ signed in as ${stored.email} [profile: ${name}]`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Clear stored credentials for the active profile")
  .action(() => {
    const { name } = loadActiveProfile();
    logoutAndClear();
    console.log(chalk.green(`✔ signed out [profile: ${name}]`));
  });

program
  .command("whoami")
  .description("Show the currently signed-in user and active profile")
  .action(async () => {
    const { name, profile } = loadActiveProfile();
    const hasCreds = Boolean(profile.accessToken || profile.pat);
    if (!hasCreds) {
      console.log(chalk.yellow(`not signed in [profile: ${name}] — run \`drift login\``));
      console.log(chalk.gray(`api: ${profile.apiBaseUrl}`));
      process.exit(1);
    }
    try {
      const me = await api<{ email: string; id: string }>("/auth/me");
      console.log(`${chalk.green("●")} ${me.email}  (${me.id})`);
      console.log(chalk.gray(`profile: ${name}`));
      console.log(chalk.gray(`api: ${profile.apiBaseUrl}`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        console.error(chalk.yellow(`session expired [profile: ${name}] — run \`drift login\``));
      } else {
        console.error(chalk.red(`✘ ${(err as Error).message}`));
      }
      process.exit(1);
    }
  });

// ---------- profiles ----------

const profile = program.command("profile").description("Manage API host + user profiles");

profile
  .command("list")
  .description("List all profiles and show the active one")
  .action(() => {
    const { active, effectiveActive, profiles } = listProfiles();
    const names = Object.keys(profiles);
    if (names.length === 0) {
      console.log(chalk.gray("no profiles"));
      return;
    }
    for (const n of names) {
      const p = profiles[n]!;
      const marker = n === effectiveActive ? chalk.green("● ") : "  ";
      const signed = p.pat ? "token" : p.accessToken ? "jwt" : chalk.gray("signed-out");
      const email = p.email ?? chalk.gray("—");
      console.log(`${marker}${chalk.bold(n.padEnd(12))}  ${chalk.dim(p.apiBaseUrl.padEnd(40))}  ${email}  ${signed}`);
    }
    if (effectiveActive !== active) {
      console.log(chalk.yellow(`\n(AIDRIFT_PROFILE=${effectiveActive} overrides stored active "${active}")`));
    }
  });

profile
  .command("add")
  .description("Add a new profile")
  .requiredOption("--name <name>", "Profile name (letters, digits, _, -)")
  .option("--url <url>", "API base URL", DEFAULT_API_URL)
  .action((opts: { name: string; url: string }) => {
    try {
      addProfile(opts.name, opts.url);
      console.log(chalk.green(`✔ added profile "${opts.name}" (${opts.url})`));
      console.log(chalk.gray(`  → switch with \`drift profile use ${opts.name}\` then run \`drift login\``));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

profile
  .command("use")
  .description("Switch the active profile")
  .argument("<name>")
  .action((name: string) => {
    try {
      useProfile(name);
      const { profile: p } = loadActiveProfile();
      console.log(chalk.green(`✔ active profile: ${name} (${p.apiBaseUrl})`));
      if (!p.accessToken && !p.pat) {
        console.log(chalk.yellow("  → not signed in; run `drift login`"));
      } else if (p.email) {
        console.log(chalk.gray(`  signed in as ${p.email}`));
      }
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

profile
  .command("remove")
  .description("Delete a profile (credentials included)")
  .argument("<name>")
  .action((name: string) => {
    try {
      removeProfile(name);
      console.log(chalk.green(`✔ removed profile "${name}"`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

profile
  .command("current")
  .description("Print the active profile name")
  .action(() => {
    const { name, profile: p } = loadActiveProfile();
    console.log(name);
    console.log(chalk.gray(`  api: ${p.apiBaseUrl}`));
    if (p.email) console.log(chalk.gray(`  email: ${p.email}`));
  });

profile
  .command("set-url")
  .description("Update the API base URL of a profile")
  .argument("<name>")
  .argument("<url>")
  .action((name: string, url: string) => {
    try {
      updateProfile(name, { apiBaseUrl: url });
      console.log(chalk.green(`✔ profile "${name}" → ${url}`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ---------- sessions / turns ----------

interface SessionDto {
  id: string;
  taskDescription: string;
  provider: string;
  model: string | null;
  workspacePath?: string | null;
  startedAt: string;
  endedAt: string | null;
  taskKeywords: string[];
}
interface ScoreDto {
  score: number;
  trend: "improving" | "stable" | "drifting";
  reasons: Array<{ code: string; delta: number; message: string }>;
}
interface TurnDto {
  id: string;
  turnIndex: number;
  outcome: string;
  userPrompt: string;
  modelResponse: string;
}
type ExecutionStage = "lint" | "build" | "test" | "runtime";
type ExecutionStatus = "pass" | "fail";

function requireAuth(): void {
  const { name, profile: p } = loadActiveProfile();
  if (!p.accessToken && !p.pat) {
    console.error(chalk.yellow(`not signed in [profile: ${name}] — run \`drift login\``));
    process.exit(1);
  }
}

function runGit(args: string[]): string | undefined {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const out = (r.stdout ?? "").trim();
  return out || undefined;
}

function currentWorkspacePath(): string {
  return runGit(["rev-parse", "--show-toplevel"]) ?? resolve(process.cwd());
}

function currentBranch(): string | undefined {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function defaultTaskDescription(workspacePath: string): string {
  const repo = basename(workspacePath);
  const branch = currentBranch();
  return branch ? `repo:${repo} branch:${branch}` : `repo:${repo}`;
}

async function ensureSession(input: {
  provider: string;
  taskDescription?: string;
  model?: string;
  workspacePath?: string;
}): Promise<SessionDto> {
  requireAuth();
  const workspacePath = input.workspacePath ?? currentWorkspacePath();
  const taskDescription = input.taskDescription ?? defaultTaskDescription(workspacePath);
  const list = await api<SessionDto[]>(`/sessions?limit=200&workspacePath=${encodeURIComponent(workspacePath)}`);
  const open = list.find((s) => !s.endedAt && s.provider === input.provider);
  if (open) return open;
  return api<SessionDto>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      taskDescription,
      provider: input.provider,
      model: input.model,
      workspacePath,
    }),
  });
}

async function resolveTurnIdForExecution(input: {
  turn?: string;
  session?: string;
  autoSession?: boolean;
  provider?: string;
  model?: string;
  task?: string;
  stage: ExecutionStage;
}): Promise<string> {
  if (input.turn) return input.turn;

  let sessionId = input.session;
  if (!sessionId && input.autoSession) {
    const s = await ensureSession({
      provider: input.provider ?? "codex",
      model: input.model,
      taskDescription: input.task,
    });
    sessionId = s.id;
  }
  if (!sessionId) {
    throw new Error("provide --turn, or --session, or use --auto-session");
  }
  const turns = await api<TurnDto[]>(`/sessions/${sessionId}/turns`);
  const last = turns.at(-1);
  if (last) return last.id;

  const created = await api<TurnDto>(`/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({
      userPrompt: `[exec:${input.stage}] auto telemetry turn`,
      modelResponse: "execution telemetry placeholder",
      metadata: {
        source: "drift-cli-auto-exec",
      },
    }),
  });
  return created.id;
}

const session = program.command("session").description("Manage drift sessions");
session
  .command("start")
  .description("Start a new drift session")
  .requiredOption("--task <text>", "Task description")
  .requiredOption("--provider <name>", "Provider: claude-code | codex")
  .option("--model <name>")
  .option("--workspace <path>", "Workspace path (defaults to current repo root)")
  .action(async (opts: { task: string; provider: string; model?: string; workspace?: string }) => {
    requireAuth();
    try {
      const s = await api<SessionDto>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          taskDescription: opts.task,
          provider: opts.provider,
          model: opts.model,
          workspacePath: opts.workspace ?? currentWorkspacePath(),
        }),
      });
      console.log(chalk.green(`✔ session ${s.id}`));
      console.log(chalk.gray(`  keywords: ${s.taskKeywords.join(", ")}`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

session
  .command("ensure")
  .description("Find or create an open session for the current repo/workspace")
  .option("--provider <name>", "Provider: claude-code | codex", "codex")
  .option("--task <text>", "Task description (defaults to repo+branch)")
  .option("--model <name>")
  .option("--workspace <path>", "Workspace path (defaults to current repo root)")
  .option("--json", "Print JSON output")
  .action(async (opts: { provider: string; task?: string; model?: string; workspace?: string; json?: boolean }) => {
    requireAuth();
    try {
      const s = await ensureSession({
        provider: opts.provider,
        taskDescription: opts.task,
        model: opts.model,
        workspacePath: opts.workspace ?? currentWorkspacePath(),
      });
      if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
      } else {
        console.log(chalk.green(`✔ session ${s.id}`));
        console.log(chalk.gray(`  provider: ${s.provider}`));
        console.log(chalk.gray(`  workspace: ${s.workspacePath ?? "n/a"}`));
        console.log(chalk.gray(`  task: ${s.taskDescription}`));
      }
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

function colorScore(score: number): string {
  if (score >= 80) return chalk.green(String(score).padStart(3, " "));
  if (score >= 65) return chalk.yellow(String(score).padStart(3, " "));
  return chalk.red(String(score).padStart(3, " "));
}

function trendArrow(trend: ScoreDto["trend"]): string {
  if (trend === "improving") return chalk.green("↗");
  if (trend === "drifting") return chalk.red("↘");
  return chalk.gray("→");
}

session
  .command("list")
  .description("List recent drift sessions with scores")
  .action(async () => {
    requireAuth();
    try {
      const list = await api<SessionDto[]>("/sessions");
      if (list.length === 0) {
        console.log(chalk.gray("no sessions yet — run `drift session start`"));
        return;
      }
      const scores = await Promise.all(
        list.map((s) => api<ScoreDto | null>(`/sessions/${s.id}/score`).catch(() => null)),
      );
      for (let i = 0; i < list.length; i++) {
        const s = list[i]!;
        const score = scores[i];
        const badge = s.endedAt ? chalk.gray("ended ") : chalk.green("open  ");
        const scoreStr = score ? `${colorScore(score.score)} ${trendArrow(score.trend)}` : chalk.gray(" — ·");
        console.log(
          `${badge}${chalk.bold(s.id.slice(-8))}  ${scoreStr}  ${s.provider.padEnd(12)}  ${chalk.dim(s.taskDescription.slice(0, 60))}`,
        );
      }
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

const turn = program.command("turn").description("Log and rate turns");
turn
  .command("add")
  .description("Append a turn to a session")
  .requiredOption("--session <id>")
  .requiredOption("--prompt <text>")
  .requiredOption("--response <text>")
  .option("--meta <json>")
  .action(async (opts: { session: string; prompt: string; response: string; meta?: string }) => {
    requireAuth();
    const metadata = opts.meta ? JSON.parse(opts.meta) as Record<string, unknown> : undefined;
    try {
      const t = await api<TurnDto>(`/sessions/${opts.session}/turns`, {
        method: "POST",
        body: JSON.stringify({
          userPrompt: opts.prompt,
          modelResponse: opts.response,
          metadata,
        }),
      });
      console.log(chalk.green(`✔ turn ${t.turnIndex} (${t.id.slice(-8)})`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

async function setOutcome(turnId: string, outcome: "accepted" | "rejected", note?: string): Promise<void> {
  requireAuth();
  try {
    const t = await api<TurnDto>(`/turns/${turnId}/outcome`, {
      method: "PATCH",
      body: JSON.stringify({ outcome, note }),
    });
    const colour = outcome === "accepted" ? chalk.green : chalk.yellow;
    console.log(colour(`✔ turn ${t.turnIndex} ${outcome}`));
  } catch (err) {
    console.error(chalk.red(`✘ ${(err as Error).message}`));
    process.exit(1);
  }
}

async function recordExecution(
  turnId: string,
  payload: {
    stage: ExecutionStage;
    status: ExecutionStatus;
    durationMs?: number;
    errorType?: string;
    errorMessage?: string;
    happenedAt?: string;
  },
): Promise<void> {
  await api<TurnDto>(`/turns/${turnId}/execution`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

turn
  .command("accept")
  .description("Mark a turn as accepted")
  .requiredOption("--turn <id>")
  .option("--note <text>")
  .action((opts: { turn: string; note?: string }) => setOutcome(opts.turn, "accepted", opts.note));

turn
  .command("reject")
  .description("Mark a turn as rejected")
  .requiredOption("--turn <id>")
  .option("--note <text>")
  .action((opts: { turn: string; note?: string }) => setOutcome(opts.turn, "rejected", opts.note));

turn
  .command("list")
  .description("List turns in a session")
  .requiredOption("--session <id>")
  .action(async (opts: { session: string }) => {
    requireAuth();
    try {
      const list = await api<TurnDto[]>(`/sessions/${opts.session}/turns`);
      for (const t of list) {
        const badge =
          t.outcome === "accepted" ? chalk.green("✓") :
          t.outcome === "rejected" ? chalk.red("✗") : chalk.gray("·");
        console.log(`${badge} ${t.turnIndex.toString().padStart(3, " ")}  ${t.id.slice(-8)}  ${chalk.dim(t.userPrompt.slice(0, 60))}`);
      }
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

turn
  .command("exec")
  .description("Record lint/build/test/runtime result for a turn")
  .option("--turn <id>")
  .option("--session <id>")
  .option("--auto-session", "Auto-find/create session for current repo")
  .option("--provider <name>", "Used with --auto-session", "codex")
  .option("--task <text>", "Used with --auto-session")
  .option("--model <name>", "Used with --auto-session")
  .requiredOption("--stage <stage>", "lint | build | test | runtime")
  .requiredOption("--status <status>", "pass | fail")
  .option("--duration <ms>")
  .option("--error-type <type>")
  .option("--error <message>")
  .option("--at <iso>", "ISO timestamp")
  .action(async (opts: {
    turn?: string;
    session?: string;
    autoSession?: boolean;
    provider?: string;
    task?: string;
    model?: string;
    stage: ExecutionStage;
    status: ExecutionStatus;
    duration?: string;
    errorType?: string;
    error?: string;
    at?: string;
  }) => {
    requireAuth();
    try {
      const turnId = await resolveTurnIdForExecution({
        turn: opts.turn,
        session: opts.session,
        autoSession: opts.autoSession,
        provider: opts.provider,
        model: opts.model,
        task: opts.task,
        stage: opts.stage,
      });
      await recordExecution(turnId, {
        stage: opts.stage,
        status: opts.status,
        durationMs: opts.duration ? Number(opts.duration) : undefined,
        errorType: opts.errorType,
        errorMessage: opts.error,
        happenedAt: opts.at,
      });
      console.log(chalk.green(`✔ recorded ${opts.stage}=${opts.status} for turn ${turnId.slice(-8)}`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

turn
  .command("exec-run")
  .description("Run a command and auto-record pass/fail for a turn")
  .option("--turn <id>")
  .option("--session <id>")
  .option("--auto-session", "Auto-find/create session for current repo")
  .option("--provider <name>", "Used with --auto-session", "codex")
  .option("--task <text>", "Used with --auto-session")
  .option("--model <name>", "Used with --auto-session")
  .requiredOption("--stage <stage>", "lint | build | test | runtime")
  .argument("<cmd...>", "Command and args")
  .action(async (
    opts: {
      turn?: string;
      session?: string;
      autoSession?: boolean;
      provider?: string;
      task?: string;
      model?: string;
      stage: ExecutionStage;
    },
    cmd: string[],
  ) => {
    requireAuth();
    if (!cmd || cmd.length === 0) {
      console.error(chalk.red("✘ command is required"));
      process.exit(1);
    }
    const started = Date.now();
    const proc = spawn(cmd[0]!, cmd.slice(1), {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      process.stderr.write(s);
    });
    const code = await new Promise<number>((resolve) => {
      proc.on("close", (c) => resolve(c ?? 1));
    });

    const durationMs = Date.now() - started;
    const status: ExecutionStatus = code === 0 ? "pass" : "fail";
    const msg = (err || out).trim().slice(-8000);
    try {
      const turnId = await resolveTurnIdForExecution({
        turn: opts.turn,
        session: opts.session,
        autoSession: opts.autoSession,
        provider: opts.provider,
        model: opts.model,
        task: opts.task,
        stage: opts.stage,
      });
      await recordExecution(turnId, {
        stage: opts.stage,
        status,
        durationMs,
        errorType: status === "fail" ? "command_exit_nonzero" : undefined,
        errorMessage: status === "fail" && msg ? msg : undefined,
      });
      const mark = status === "pass" ? chalk.green("✔") : chalk.red("✘");
      console.log(`${mark} recorded ${opts.stage}=${status} for turn ${turnId.slice(-8)} (${durationMs}ms)`);
    } catch (e) {
      console.error(chalk.red(`✘ failed to record execution: ${(e as Error).message}`));
    }
    if (code !== 0) process.exit(code);
  });

function parseLogOutcome(framework: string, text: string): { status: ExecutionStatus; errorType?: string; errorMessage?: string } {
  const f = framework.toLowerCase();
  if (f === "vitest") {
    const pass = /Test Files\s+\d+\s+passed/i.test(text) || /\bTest Files\b[\s\S]*\b0 failed\b/i.test(text);
    return pass
      ? { status: "pass" }
      : { status: "fail", errorType: "vitest_failure", errorMessage: text.trim().slice(-8000) };
  }
  if (f === "jest") {
    const pass = /\bTests:\s+.*0 failed/i.test(text) || /\bPASS\b/m.test(text);
    return pass
      ? { status: "pass" }
      : { status: "fail", errorType: "jest_failure", errorMessage: text.trim().slice(-8000) };
  }
  if (f === "pytest") {
    const pass = /=+[\s\S]*\b\d+\s+passed\b/i.test(text) && !/\bfailed\b/i.test(text);
    return pass
      ? { status: "pass" }
      : { status: "fail", errorType: "pytest_failure", errorMessage: text.trim().slice(-8000) };
  }
  if (f === "go") {
    const pass = /^ok\s/m.test(text) && !/^FAIL/m.test(text);
    return pass
      ? { status: "pass" }
      : { status: "fail", errorType: "go_test_failure", errorMessage: text.trim().slice(-8000) };
  }
  const genericPass = /\b(pass|passed|success)\b/i.test(text) && !/\b(fail|failed|error)\b/i.test(text);
  return genericPass
    ? { status: "pass" }
    : { status: "fail", errorType: "log_failure", errorMessage: text.trim().slice(-8000) };
}

turn
  .command("exec-log")
  .description("Parse a test/lint/build log file and record pass/fail")
  .option("--turn <id>")
  .option("--session <id>")
  .option("--auto-session", "Auto-find/create session for current repo")
  .option("--provider <name>", "Used with --auto-session", "codex")
  .option("--task <text>", "Used with --auto-session")
  .option("--model <name>", "Used with --auto-session")
  .requiredOption("--stage <stage>", "lint | build | test | runtime")
  .requiredOption("--framework <name>", "vitest | jest | pytest | go | generic")
  .requiredOption("--file <path>")
  .action(async (opts: {
    turn?: string;
    session?: string;
    autoSession?: boolean;
    provider?: string;
    task?: string;
    model?: string;
    stage: ExecutionStage;
    framework: string;
    file: string;
  }) => {
    requireAuth();
    try {
      const text = await readFile(opts.file, "utf8");
      const result = parseLogOutcome(opts.framework, text);
      const turnId = await resolveTurnIdForExecution({
        turn: opts.turn,
        session: opts.session,
        autoSession: opts.autoSession,
        provider: opts.provider,
        model: opts.model,
        task: opts.task,
        stage: opts.stage,
      });
      await recordExecution(turnId, {
        stage: opts.stage,
        status: result.status,
        errorType: result.errorType,
        errorMessage: result.errorMessage,
      });
      console.log(chalk.green(`✔ recorded ${opts.stage}=${result.status} from ${opts.framework} log for ${turnId.slice(-8)}`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

function parseJunit(xml: string): { status: ExecutionStatus; errorType?: string; errorMessage?: string } {
  const failures = [...xml.matchAll(/failures="(\d+)"/g)].reduce((a, m) => a + Number(m[1] ?? 0), 0);
  const errors = [...xml.matchAll(/errors="(\d+)"/g)].reduce((a, m) => a + Number(m[1] ?? 0), 0);
  if (failures + errors === 0) return { status: "pass" };
  const firstFailure =
    /<(failure|error)\b[^>]*message="([^"]*)"/i.exec(xml)?.[2] ??
    /<(failure|error)\b[^>]*>([\s\S]*?)<\/(failure|error)>/i.exec(xml)?.[2] ??
    "junit reported failures";
  return {
    status: "fail",
    errorType: errors > 0 ? "junit_error" : "junit_failure",
    errorMessage: firstFailure.trim().slice(0, 8000),
  };
}

turn
  .command("exec-junit")
  .description("Parse JUnit XML and record test pass/fail")
  .option("--turn <id>")
  .option("--session <id>")
  .option("--auto-session", "Auto-find/create session for current repo")
  .option("--provider <name>", "Used with --auto-session", "codex")
  .option("--task <text>", "Used with --auto-session")
  .option("--model <name>", "Used with --auto-session")
  .requiredOption("--file <path>")
  .option("--stage <stage>", "defaults to test", "test")
  .action(async (opts: {
    turn?: string;
    session?: string;
    autoSession?: boolean;
    provider?: string;
    task?: string;
    model?: string;
    file: string;
    stage: ExecutionStage;
  }) => {
    requireAuth();
    try {
      const xml = await readFile(opts.file, "utf8");
      const parsed = parseJunit(xml);
      const turnId = await resolveTurnIdForExecution({
        turn: opts.turn,
        session: opts.session,
        autoSession: opts.autoSession,
        provider: opts.provider,
        model: opts.model,
        task: opts.task,
        stage: opts.stage,
      });
      await recordExecution(turnId, {
        stage: opts.stage,
        status: parsed.status,
        errorType: parsed.errorType,
        errorMessage: parsed.errorMessage,
      });
      console.log(chalk.green(`✔ recorded ${opts.stage}=${parsed.status} from junit for ${turnId.slice(-8)}`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

interface StatusDto {
  session: { id: string; taskDescription: string; provider: string };
  currentScore: number | null;
  trend: "improving" | "stable" | "drifting";
  turnCount: number;
  alert: {
    active: boolean;
    reasons: string[];
    likelyDriftStartTurnId: string | null;
    type: "none" | "infra" | "stuck_loop" | "rejection_cascade" | "misalignment" | "gradual_decay";
    recommendation: string | null;
  };
  lastStableCheckpoint: { id: string; summary: string; scoreAtCheckpoint: number; createdAt: string } | null;
}
interface CheckpointDto {
  id: string;
  turnId: string;
  summary: string;
  scoreAtCheckpoint: number;
  createdAt: string;
}

async function pickSessionId(opt?: string): Promise<string> {
  if (opt) return opt;
  const list = await api<SessionDto[]>("/sessions");
  const open = list.find((s) => !s.endedAt) ?? list[0];
  if (!open) throw new Error("no sessions — run `drift session start`");
  return open.id;
}

program
  .command("status")
  .description("Show current drift status for a session (defaults to most recent)")
  .option("--session <id>")
  .action(async (opts: { session?: string }) => {
    requireAuth();
    try {
      const sid = await pickSessionId(opts.session);
      const s = await api<StatusDto>(`/sessions/${sid}/status`);
      const scoreStr = s.currentScore !== null ? colorScore(s.currentScore) : chalk.gray("  —");
      console.log(chalk.bold(s.session.taskDescription));
      console.log(`  provider: ${s.session.provider}   turns: ${s.turnCount}`);
      console.log(`  score:    ${scoreStr} ${trendArrow(s.trend)}  (${s.trend})`);
      if (s.alert.active) {
        console.log(chalk.red(`  ⚠ drift detected [${s.alert.type}]`));
        for (const r of s.alert.reasons) console.log(chalk.red(`    · ${r}`));
        if (s.alert.likelyDriftStartTurnId) {
          console.log(chalk.red(`    likely drift start: turn ${s.alert.likelyDriftStartTurnId.slice(-8)}`));
        }
        if (s.alert.recommendation) {
          console.log(chalk.yellow(`    → ${s.alert.recommendation}`));
        }
      } else {
        console.log(chalk.green("  ✓ no drift alert"));
      }
      if (s.lastStableCheckpoint) {
        console.log(
          chalk.gray(`  last stable checkpoint: "${s.lastStableCheckpoint.summary}" (score ${s.lastStableCheckpoint.scoreAtCheckpoint})`),
        );
      } else {
        console.log(chalk.gray("  last stable checkpoint: none yet"));
      }
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

const checkpoint = program.command("checkpoint").description("Manage session checkpoints");
checkpoint
  .command("create")
  .description("Create a manual checkpoint")
  .option("--session <id>")
  .option("--turn <id>", "Turn id (defaults to latest)")
  .requiredOption("--summary <text>")
  .action(async (opts: { session?: string; turn?: string; summary: string }) => {
    requireAuth();
    try {
      const sid = await pickSessionId(opts.session);
      let turnId = opts.turn;
      if (!turnId) {
        const turns = await api<TurnDto[]>(`/sessions/${sid}/turns?limit=1`);
        const last = turns[0];
        if (!last) throw new Error("no turns yet; add one before creating a checkpoint");
        turnId = last.id;
      }
      const c = await api<CheckpointDto>(`/sessions/${sid}/checkpoints`, {
        method: "POST",
        body: JSON.stringify({ turnId, summary: opts.summary, source: "manual" }),
      });
      console.log(chalk.green(`✔ checkpoint ${c.id.slice(-8)} at score ${c.scoreAtCheckpoint}`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

checkpoint
  .command("list")
  .description("List a session's checkpoints")
  .option("--session <id>")
  .action(async (opts: { session?: string }) => {
    requireAuth();
    try {
      const sid = await pickSessionId(opts.session);
      const list = await api<CheckpointDto[]>(`/sessions/${sid}/checkpoints`);
      if (list.length === 0) {
        console.log(chalk.gray("no checkpoints yet"));
        return;
      }
      for (const c of list) {
        const stable = c.scoreAtCheckpoint >= 75 ? chalk.green("stable  ") : chalk.yellow("unstable");
        console.log(`${stable} ${chalk.bold(c.id.slice(-8))}  score ${colorScore(c.scoreAtCheckpoint)}  ${chalk.dim(c.summary)}`);
      }
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.command("watch").description("[Phase 6] Watch Claude Code transcripts").action(() => console.log("[Phase 6 stub]"));
program.command("report").option("--json").action(() => console.log("[Phase 8 stub] report"));

program.parseAsync(process.argv);
