#!/usr/bin/env node
/**
 * Captures the MCP tool surface for the tool-surface benchmark.
 *
 *   node scripts/benchmark/capture-surface.mjs --org <org> [--package @azure-devops/mcp]
 *
 * Starts the MCP server over stdio, performs `initialize` + `tools/list`, and
 * stores the tool schemas (names, descriptions, JSON schemas) with the
 * organization name scrubbed. No Azure DevOps data is read.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = parseFlags(process.argv.slice(2));
const pkg = args.package ?? "@azure-devops/mcp";
const org = args.org;
const entry = args.entry;
const watchdogMs = Number(args.timeout ?? 90) * 1000;

if (!org) {
  console.error(
    "usage: node scripts/benchmark/capture-surface.mjs --org <org> [--entry <server.js>] [--package <pkg>] [--timeout <seconds>]",
  );
  process.exit(2);
}

const HELP_COMMANDS = ["work-item", "pr", "pipeline", "repo", "ref", "test", "project", "api"];

const child = entry
  ? spawn(process.execPath, [entry, org], { stdio: ["pipe", "pipe", "inherit"] })
  : spawn("npx", ["-y", pkg, org], {
      stdio: ["pipe", "pipe", "inherit"],
      shell: process.platform === "win32",
    });

/** Hard stop: an MCP server that waits for interactive auth must never hang the run. */
const watchdog = setTimeout(() => {
  console.error(`✗ timed out after ${watchdogMs / 1000}s — killing the MCP server`);
  shutdown();
  process.exit(1);
}, watchdogMs);
watchdog.unref?.();

function shutdown() {
  clearTimeout(watchdog);
  try {
    child.stdin.end();
  } catch {
    /* already closed */
  }
  if (child.pid && !child.killed) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  }
}

let buffer = "";
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

let nextId = 1;
const send = (method, params) =>
  new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++;
    pending.set(id, resolvePromise);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rejectPromise(new Error(`timeout waiting for ${method}`));
      }
    }, 60_000).unref?.();
  });

try {
  const initialized = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ado-axi-benchmark", version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const response = await send("tools/list", {});
  const tools = response.result?.tools ?? [];
  if (tools.length === 0) throw new Error("server returned no tools");

  const scrubbed = JSON.parse(JSON.stringify(tools).split(org).join("contoso"));
  const surface = {
    source: pkg,
    sourceVersion: initialized.result?.serverInfo?.version ?? null,
    capturedAt: new Date().toISOString().slice(0, 10),
    helpCommands: HELP_COMMANDS,
    mcpTools: scrubbed,
  };
  writeFileSync(join(root, "benchmark", "tool-surface.json"), `${JSON.stringify(surface, null, 2)}\n`, "utf8");
  console.log(`✓ captured ${tools.length} MCP tools from ${pkg}`);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  shutdown();
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}
