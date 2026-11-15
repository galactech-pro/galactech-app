/**
 * CSV helpers with spreadsheet formula-injection neutralisation (audit M-03, OWASP CSV Injection).
 * Escape on EXPORT only; stored data stays raw (a leading "+" is legitimate in E.164 phone numbers).
 * Quoting alone can be undone by Excel save/reopen, so risky cells are prefixed with an apostrophe.
 * No universal fix exists; test exports in the spreadsheet apps your customers use.
 */

/** Characters that make Excel/Sheets/LibreOffice treat a cell as a formula (also after leading whitespace). */
const RISKY = /^[\s ]*[=+\-@\t\r\n＝＋－＠]/;

/** Returns a single, correctly quoted CSV cell. Dates become ISO strings. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (RISKY.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/** Full CSV text (CRLF). Prefix with a BOM yourself if Excel Unicode support is needed: "﻿" + toCsv(...). */
export function toCsv(headers: string[], rows: unknown[][]): string {
  return [csvRow(headers), ...rows.map(csvRow)].join("\r\n");
}
