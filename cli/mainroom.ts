#!/usr/bin/env bun

const version = "0.1.0";

const usage = `mainroom ${version}

Usage:
  mainroom hello
  mainroom --help
  mainroom --version

Commands:
  hello        Print hello

Options:
  -h, --help     Show help
  -v, --version  Show version`;

function main(args: string[]): number {
  const [command] = args;

  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    console.log(version);
    return 0;
  }

  if (command === "hello") {
    console.log("hello");
    return 0;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Run `mainroom --help` for usage.");
  return 1;
}

process.exitCode = main(Bun.argv.slice(2));
