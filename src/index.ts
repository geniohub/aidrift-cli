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

// ---------- sessions / turns / checkpoints (Phase 3+) ----------

const session = program.command("session").description("Manage drift sessions");
session
  .command("start")
  .requiredOption("--task <text>", "Task description")
  .requiredOption("--provider <name>", "Provider: claude-code | codex")
  .option("--model <name>")
  .action((opts) => console.log("[Phase 3 stub]", opts));
session.command("list").action(() => console.log("[Phase 3 stub] list"));

const turn = program.command("turn").description("Log and rate turns");
turn.command("add").action(() => console.log("[Phase 3 stub] add"));
turn.command("accept").action(() => console.log("[Phase 3 stub] accept"));
turn.command("reject").action(() => console.log("[Phase 3 stub] reject"));

program.command("status").action(() => console.log("[Phase 5 stub]"));
program.command("history").action(() => console.log("[Phase 5 stub]"));
program.command("report").action(() => console.log("[Phase 5 stub]"));
program.command("watch").action(() => console.log("[Phase 6 stub]"));

program.parseAsync(process.argv);
