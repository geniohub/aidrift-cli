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

session
  .command("list")
  .description("List recent drift sessions")
  .action(async () => {
    requireAuth();
    try {
      const list = await api<SessionDto[]>("/sessions");
      if (list.length === 0) {
        console.log(chalk.gray("no sessions yet — run `drift session start`"));
        return;
      }
      for (const s of list) {
        const badge = s.endedAt ? chalk.gray("ended ") : chalk.green("open  ");
        console.log(`${badge}${chalk.bold(s.id.slice(-8))}  ${s.provider}  ${chalk.dim(s.taskDescription.slice(0, 60))}`);
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

program.command("status").action(() => console.log("[Phase 5 stub]"));
program.command("history").action(() => console.log("[Phase 5 stub]"));
program.command("report").action(() => console.log("[Phase 5 stub]"));
program.command("watch").action(() => console.log("[Phase 6 stub]"));

program.parseAsync(process.argv);
