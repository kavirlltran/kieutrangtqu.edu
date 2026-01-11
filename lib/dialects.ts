export const DIALECTS = ["en-us", "en-gb"] as const;
export type Dialect = (typeof DIALECTS)[number];

export function isDialect(v: unknown): v is Dialect {
  return typeof v === "string" && (DIALECTS as readonly string[]).includes(v);
}
