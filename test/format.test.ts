import { describe, expect, it } from "vitest";
import { countLine, htmlToText, personName, pickFields, shortDate, truncate } from "../src/lib/format.js";

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("hello", 10)).toEqual({ text: "hello", truncated: false, total: 5 });
  });

  it("adds a size hint when truncating", () => {
    const result = truncate("x".repeat(50), 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/truncated, 50 chars total/);
  });
});

describe("htmlToText", () => {
  it("flattens Azure DevOps HTML fields", () => {
    expect(htmlToText("<div>one</div><ul><li>two</li></ul>&amp; three<br/>four")).toBe(
      "one\n- two\n& three\nfour",
    );
  });
});

describe("shortDate", () => {
  it("returns a date for old timestamps", () => {
    expect(shortDate("2020-03-04T10:11:12.000Z")).toBe("2020-03-04");
  });

  it("passes through unparseable values", () => {
    expect(shortDate("not-a-date")).toBe("not-a-date");
    expect(shortDate(undefined)).toBe("");
  });
});

describe("personName", () => {
  it("prefers displayName", () => {
    expect(personName({ displayName: "Ada", uniqueName: "ada@example.com" })).toBe("Ada");
    expect(personName(undefined)).toBe("");
  });
});

describe("pickFields", () => {
  it("limits columns when --fields is passed", () => {
    const rows = [{ id: 1, title: "a", state: "open" }];
    expect(pickFields(rows, ["id", "state"])).toEqual([{ id: 1, state: "open" }]);
    expect(pickFields(rows, undefined)).toBe(rows);
  });
});

describe("countLine", () => {
  it("reports totals when the page is partial", () => {
    expect(countLine(5, 20, "work items")).toBe("5 of 20 work items");
    expect(countLine(5, 5, "work items")).toBe("5 work items");
  });
});
