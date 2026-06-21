#!/usr/bin/env bun

import { Command } from "commander";
import { authStatus, login, logout, ping } from "./auth";
import { syncCodex } from "./codex";
import { errorMessage } from "./errors";
import {
  defaultApiUrl,
  type AuthCommandOptions,
  type CodexSyncOptions,
} from "./types";

const program = new Command();
const authCommand = new Command("auth");
const codexCommand = new Command("codex");
const version = "0.1.0";

program
  .name("mainroom")
  .description("Use Mainroom from the command line.")
  .version(version, "-v, --version", "Show version")
  .showHelpAfterError()
  .addHelpText(
    "after",
    `
Examples:
  $ mainroom auth signup
  $ mainroom auth login
  $ mainroom codex sync
  $ mainroom auth status
  $ mainroom ping`,
  );

authCommand
  .description("Log in, sign up, and manage saved credentials.")
  .showHelpAfterError()
  .addHelpText(
    "after",
    `
New users should start with signup. Mainroom opens your browser, then saves your
login for future CLI commands.

Examples:
  $ mainroom auth signup
  $ mainroom auth login
  $ mainroom auth login --with-token < mainroom-api-key.txt
  $ mainroom auth logout`,
  );

authCommand
  .command("signup")
  .description("Create a Mainroom account or connect an existing one.")
  .option("--api-url <url>", "Mainroom API origin", defaultApiUrl)
  .action((options: AuthCommandOptions) =>
    runCommand(() => login(options, "signup")),
  );

authCommand
  .command("login")
  .description("Log in to Mainroom on this device.")
  .option("--api-url <url>", "Mainroom API origin", defaultApiUrl)
  .option(
    "--with-token",
    "Read an existing Mainroom API key from standard input",
  )
  .action((options: AuthCommandOptions) =>
    runCommand(() => login(options, "login")),
  );

authCommand
  .command("logout")
  .description("Log out of Mainroom on this device.")
  .action(() => runCommand(logout));

authCommand
  .command("status")
  .description("Show login status.")
  .action(() => runCommand(authStatus));

program.addCommand(authCommand);

codexCommand.description("Upload Codex auth files.").showHelpAfterError();

codexCommand
  .command("sync")
  .description("Upload unexpired local Codex auth JSON files.")
  .option("--yes", "Upload every eligible auth file without prompting")
  .action((options: CodexSyncOptions) => runCommand(() => syncCodex(options)));

program.addCommand(codexCommand);

program
  .command("ping")
  .description("Check the API connection.")
  .action(() => runCommand(ping));

async function runCommand(command: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await command();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}

try {
  await program.parseAsync(Bun.argv);
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
