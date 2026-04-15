#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "@aidrift/core";

const program = new Command();

program
  .name("drift")
  .description("AI Drift Detector — watch your AI coding sessions for drift")
  .version(VERSION);

program
  .command("init")
  .description("Initialize a .drift/ folder in the current directory")
  .action(() => {
    console.log("[Phase 1 stub] would create .drift/drift.db and .drift/config.json");
  });

const session = program.command("session").description("Manage drift sessions");
session
  .command("start")
  .requiredOption("--task <text>", "Task description")
  .requiredOption("--provider <name>", "Provider: claude-code | codex | other")
  .option("--model <name>", "Model name")
  .action((opts) => {
    console.log("[Phase 2 stub] start session", opts);
  });
session.command("list").action(() => console.log("[Phase 2 stub] list sessions"));

const turn = program.command("turn").description("Log and rate turns");
turn
  .command("add")
  .requiredOption("--prompt <text>")
  .requiredOption("--response <text>")
  .option("--meta <json>")
  .action((opts) => console.log("[Phase 2 stub] add turn", opts));
turn.command("paste").action(() => console.log("[Phase 2 stub] paste turn from clipboard"));
turn
  .command("accept")
  .option("--turn <id>")
  .option("--note <text>")
  .action((opts) => console.log("[Phase 2 stub] accept turn", opts));
turn
  .command("reject")
  .option("--turn <id>")
  .option("--note <text>")
  .action((opts) => console.log("[Phase 2 stub] reject turn", opts));

program
  .command("checkpoint")
  .description("Create a checkpoint")
  .command("create")
  .option("--turn <id>")
  .requiredOption("--summary <text>")
  .action((opts) => console.log("[Phase 4 stub] create checkpoint", opts));

program.command("status").action(() => console.log("[Phase 4 stub] status"));
program.command("history").action(() => console.log("[Phase 5 stub] history"));
program
  .command("report")
  .option("--json")
  .option("--out <file>")
  .action((opts) => console.log("[Phase 5 stub] report", opts));
program
  .command("watch")
  .description("Watch Claude Code transcripts and auto-ingest turns")
  .action(() => console.log("[Phase 5 stub] watch"));

program.parseAsync(process.argv);
