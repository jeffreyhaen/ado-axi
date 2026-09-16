/**
 * Preload hook: records or replays Azure DevOps HTTP traffic for the benchmark.
 *
 *   node --import ./scripts/benchmark/fetch-hook.mjs dist/bin/ado-axi.js <args>
 *
 * ADO_AXI_BENCH_MODE=record  → real network, appends to $ADO_AXI_BENCH_FILE
 * ADO_AXI_BENCH_MODE=replay  → no network, serves $ADO_AXI_BENCH_FILE
 */
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.env.ADO_AXI_BENCH_MODE;
const file = process.env.ADO_AXI_BENCH_FILE;

if (mode && file) {
  const realFetch = globalThis.fetch.bind(globalThis);

  if (mode === "record") {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init.method ?? "GET").toUpperCase();
      const response = await realFetch(input, init);
      const body = await response.clone().text();
      calls.push({
        method,
        url,
        requestBody: typeof init.body === "string" ? init.body : undefined,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body,
      });
      return response;
    };
    process.on("exit", () => {
      writeFileSync(file, JSON.stringify({ calls }, null, 2), "utf8");
    });
  } else if (mode === "replay") {
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    const remaining = new Map();
    for (const call of fixture.calls) {
      const key = `${call.method} ${call.url}`;
      if (!remaining.has(key)) remaining.set(key, []);
      remaining.get(key).push(call);
    }
    const used = new Set();
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init.method ?? "GET").toUpperCase();
      const key = `${method} ${url}`;
      const queue = remaining.get(key);
      const call = queue && queue.length > 0 ? queue.shift() : undefined;
      if (!call) {
        throw new Error(
          `benchmark replay miss: ${key}\nrecorded keys:\n  ${[...remaining.keys()].join("\n  ")}`,
        );
      }
      used.add(key);
      return new Response(call.body, {
        status: call.status,
        headers: { "content-type": call.contentType || "application/json" },
      });
    };
    globalThis.__adoAxiBenchReplay = { fixture, used };
  }
}
