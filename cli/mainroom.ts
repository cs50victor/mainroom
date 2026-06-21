#!/usr/bin/env bun

import { Command } from "commander";
import { authStatus, login, logout, ping } from "./auth";
import { errorMessage } from "./errors";
import { defaultApiUrl, type AuthCommandOptions } from "./types";

const program = new Command();
const authCommand = new Command("auth");
const version = "0.1.0";

program
  .name("mainroom")
  .description("Use Mainroom from your terminal.")
  .version(version, "-v, --version", "Show version")
  .showHelpAfterError()
  .addHelpText(
    "after",
    `
Examples:
  $ mainroom auth signup
  $ mainroom auth login
  $ mainroom auth status
  $ mainroom ping`,
  );

authCommand
  .description("Create accounts, log in, and manage local credentials.")
  .showHelpAfterError()
  .addHelpText(
    "after",
    `
First-time users should run signup. The browser flow can create a Clerk account,
then Mainroom stores a local API key for future CLI commands.

Examples:
  $ mainroom auth signup
  $ mainroom auth login
  $ mainroom auth login --with-token < mainroom-api-key.txt
  $ mainroom auth logout`,
  );

authCommand
  .command("signup")
  .description("Create a Clerk account or sign in, then save a local API key.")
  .option("--api-url <url>", "Mainroom API origin", defaultApiUrl)
  .action((options: AuthCommandOptions) =>
    runCommand(() => login(options, "signup")),
  );

authCommand
  .command("login")
  .description(
    "Log in to an existing account, with account creation available.",
  )
  .option("--api-url <url>", "Mainroom API origin", defaultApiUrl)
  .option("--with-token", "Read an existing Mainroom API key from stdin")
  .action((options: AuthCommandOptions) =>
    runCommand(() => login(options, "login")),
  );

authCommand
  .command("logout")
  .description("Remove saved authentication.")
  .action(() => runCommand(logout));

authCommand
  .command("status")
  .description("Display saved authentication state.")
  .action(() => runCommand(authStatus));

program.addCommand(authCommand);

program
  .command("ping")
  .description("Call the authenticated ping endpoint.")
  .action(() => runCommand(ping));

program
  .command("hello")
  .description("Print hello.")
  .action(() => {
    console.log("hello");
  });

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
