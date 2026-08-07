import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readStdinIfPiped } from "../src/lib/stdin.js";

function streamOf(...chunks: Array<string | Buffer>): NodeJS.ReadableStream {
  return Readable.from(chunks);
}

describe("readStdinIfPiped", () => {
  it("preserves multiline content and trailing newlines", async () => {
    const result = await readStdinIfPiped(streamOf("first\n", "second\n\n"));
    expect(result?.toString("utf8")).toBe("first\nsecond\n\n");
  });

  it("preserves empty piped stdin as an empty body", async () => {
    const result = await readStdinIfPiped(streamOf());
    expect(result).toEqual(Buffer.alloc(0));
  });

  it("preserves binary content", async () => {
    const input = Buffer.from([0, 255, 13, 10]);
    const result = await readStdinIfPiped(streamOf(input));
    expect(result).toEqual(input);
  });

  it("does not read a TTY", async () => {
    const stream = streamOf("ignored");
    Object.defineProperty(stream, "isTTY", { value: true });
    expect(await readStdinIfPiped(stream)).toBeUndefined();
  });
});
