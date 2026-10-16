import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import spawn from "cross-spawn";
import { clearCredentialCache, resolveCredential } from "../src/lib/auth.js";
import { pipelineCommand } from "../src/commands/pipeline.js";
import * as contextModule from "../src/lib/context.js";
import type { ResolvedProfile } from "../src/lib/config.js";

vi.mock("cross-spawn", () => ({ default: vi.fn() }));

const mockSpawn = vi.mocked(spawn);
const profile: ResolvedProfile = {
  name: "watch-auth",
  org: "test-org",
  project: "Project",
  auth: "az",
  tenant: "tenant & value",
  source: "flags",
};

function azProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
  mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

beforeEach(() => {
  mockSpawn.mockReset();
  clearCredentialCache();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearCredentialCache();
  process.exitCode = undefined;
});

describe("credential cancellation", () => {
  it("does not spawn az for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(resolveCredential(profile, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("removes cancellation listeners after success and caches only completed credentials", async () => {
    const child = azProcess();
    const controller = new AbortController();
    const pending = resolveCredential(profile, controller.signal);
    child.stdout.emit("data", Buffer.from('{"accessToken":"token"}'));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ header: "Bearer token", mode: "az" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await expect(resolveCredential(profile)).resolves.toEqual({ header: "Bearer token", mode: "az" });
    controller.abort();
    await expect(resolveCredential(profile, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(child.kill).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith("az", [
      "account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798",
      "--output", "json", "--tenant", "tenant & value",
    ], { windowsHide: true });
  });

  it.each(["error", "close"])("preserves authentication failures and removes listeners after %s", async (event) => {
    const child = azProcess();
    const controller = new AbortController();
    const pending = resolveCredential(profile, controller.signal);
    if (event === "error") {
      child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    } else {
      child.stderr.emit("data", Buffer.from("Please run az login"));
      child.emit("close", 1);
    }

    await expect(pending).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining(event === "error" ? "not installed" : "not signed in"),
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("cancels pending az authentication at the watch deadline without caching a late token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.spyOn(contextModule, "profileFromArgs").mockReturnValue(profile);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const child = azProcess();

    const pending = pipelineCommand(["watch", "9", "--timeout", "1"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const output = await pending;

    expect(child.kill).toHaveBeenCalledOnce();
    expect(output.run).toMatchObject({ outcome: "timeout", status: "unknown", polls: 0, "elapsed-seconds": 1 });
    expect(process.exitCode).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();

    child.stdout.emit("data", Buffer.from('{"accessToken":"late-token"}'));
    child.emit("close", 0);
    const nextChild = azProcess();
    const nextCredential = resolveCredential(profile);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    nextChild.stdout.emit("data", Buffer.from('{"accessToken":"fresh-token"}'));
    nextChild.emit("close", 0);
    await expect(nextCredential).resolves.toEqual({ header: "Bearer fresh-token", mode: "az" });
  });
});
