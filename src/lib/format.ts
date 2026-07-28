export const DEFAULT_TRUNCATE = 1200;

export interface Truncated {
  text: string;
  truncated: boolean;
  total: number;
}

export function truncate(value: string, limit = DEFAULT_TRUNCATE): Truncated {
  const total = value.length;
  if (total <= limit) return { text: value, truncated: false, total };
  return {
    text: `${value.slice(0, limit)}\n... (truncated, ${total} chars total)`,
    truncated: true,
    total,
  };
}

/** Azure DevOps stores work item descriptions and PR bodies as HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|BR)\s*\/?>/g, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li\s*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `2025-01-08T14:22:31.123Z` -> `2025-01-08` (or `2025-01-08 14:22` when recent). */
export function shortDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const iso = date.toISOString();
  const ageDays = (Date.now() - date.getTime()) / 86_400_000;
  return ageDays < 7 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** `Jane Doe <jane@example.com>` -> `Jane Doe` */
export function personName(identity: unknown): string {
  if (!identity || typeof identity !== "object") return "";
  const value = identity as { displayName?: string; uniqueName?: string; name?: string };
  return value.displayName ?? value.name ?? value.uniqueName ?? "";
}

export function emptyState(noun: string, context: string): string {
  return `0 ${noun} found ${context}`;
}

export function pickFields<T extends Record<string, unknown>>(
  rows: T[],
  fields: string[] | undefined,
): Array<Record<string, unknown>> {
  if (!fields || fields.length === 0) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const field of fields) out[field] = row[field] ?? "";
    return out;
  });
}

export function countLine(shown: number, total: number | undefined, noun: string): string {
  if (total === undefined || total === shown) return `${shown} ${noun}`;
  return `${shown} of ${total} ${noun}`;
}
