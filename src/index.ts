#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { input, password as passwordPrompt } from "@inquirer/prompts";
import { VERSION } from "@aidrift/core";
import { api, ApiError, DEFAULT_API_URL, loginAndPersist, logoutAndClear } from "./api-client.js";
import { load } from "./auth/store.js";

const program = new Command();

program
  .name("drift")
  .description("AI Drift Detector — watch your AI coding sessions for drift")
  .version(VERSION);

// ---------- auth ----------

program
  .command("login")
  .description("Sign in to the local AI Drift backend")
  .option("--email <email>")
  .option("--password <password>", "(insecure: visible in shell history)")
  .option("--api <url>", "API base URL", DEFAULT_API_URL)
  .action(async (opts: { email?: string; password?: string; api: string }) => {
    try {
      const email = opts.email ?? (await input({ message: "Email:" }));
      const pw = opts.password ?? (await passwordPrompt({ message: "Password:", mask: "*" }));
      const stored = await loginAndPersist(opts.api, email, pw);
      console.log(chalk.green(`✔ signed in as ${stored.email}`));
    } catch (err) {
      console.error(chalk.red(`✘ ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Clear stored credentials")
  .action(() => {
    logoutAndClear();
    console.log(chalk.green("✔ signed out"));
  });

program
  .command("whoami")
  .description("Show the currently signed-in user")
  .action(async () => {
    const stored = load();
    if (!stored) {
      console.log(chalk.yellow("not signed in — run `drift login`"));
      process.exit(1);
    }
    try {
      const me = await api<{ email: string; id: string }>("/auth/me");
      console.log(`${chalk.green("●")} ${me.email}  (${me.id})`);
      console.log(chalk.gray(`api: ${stored.apiBaseUrl}`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        console.error(chalk.yellow("session expired — run `drift login`"));
      } else {
        console.error(chalk.red(`✘ ${(err as Error).message}`));
      }
      process.exit(1);
    }
  });

// ---------- sessions / turns ----------

interface SessionDto {
  id: string;
  taskDescription: string;
  provider: string;
  model: string | null;
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

function requireAuth(): void {
  if (!load()) {
    console.error(chalk.yellow("not signed in — run `drift login`"));
    process.exit(1);
  }
}

const session = program.command("session").description("Manage drift sessions");
session
  .command("start")
  .description("Start a new drift session")
  .requiredOption("--task <text>", "Task description")
  .requiredOption("--provider <name>", "Provider: claude-code | codex")
  .option("--model <name>")
  .action(async (opts: { task: string; provider: string; model?: string }) => {
    requireAuth();
    try {
      const s = await api<SessionDto>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          taskDescription: opts.task,
          provider: opts.provider,
          model: opts.model,
        }),
      });
      console.log(chalk.green(`✔ session ${s.id}`));
      console.log(chalk.gray(`  keywords: ${s.taskKeywords.join(", ")}`));
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

interface StatusDto {
  session: { id: string; taskDescription: string; provider: string };
  currentScore: number | null;
  trend: "improving" | "stable" | "drifting";
  turnCount: number;
  alert: { active: boolean; reasons: string[]; likelyDriftStartTurnId: string | null };
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
        console.log(chalk.red("  ⚠ drift detected"));
        for (const r of s.alert.reasons) console.log(chalk.red(`    · ${r}`));
        if (s.alert.likelyDriftStartTurnId) {
          console.log(chalk.red(`    likely drift start: turn ${s.alert.likelyDriftStartTurnId.slice(-8)}`));
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
        const turns = await api<TurnDto[]>(`/sessions/${sid}/turns`);
        const last = turns.at(-1);
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
