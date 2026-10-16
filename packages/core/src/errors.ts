import { AxiError, exitCodeForError as sdkExitCode } from "axi-sdk-js";
import { redactSecrets } from "./secrets.js";

export { AxiError };

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "READ_ONLY"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NETWORK"
  | "TIMEOUT"
  | "SQL_ERROR"
  | "UNKNOWN";

export function usageError(message: string, suggestions: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

export function axiError(message: string, code: ErrorCode, suggestions: string[] = []): AxiError {
  return new AxiError(message, code, suggestions);
}

/** A statement refused by the read-only guard is a usage error too: exit 2. */
export function exitCodeForError(error: unknown): number {
  return error instanceof AxiError && error.code === "READ_ONLY" ? 2 : sdkExitCode(error);
}

interface DriverError {
  code?: string;
  errno?: number;
  sqlMessage?: string;
  message?: string;
}

/** Map a mysql2 / socket error to an AxiError. Never echoes connection secrets. */
export function fromDriverError(error: unknown, where: string): AxiError {
  if (error instanceof AxiError) return error;
  const e = (error ?? {}) as DriverError;
  // Syntax errors quote the SQL near the problem, which can include a password.
  const sql = e.sqlMessage ? `${redactSecrets(e.sqlMessage)} (MySQL ${e.errno})` : undefined;
  switch (e.code) {
    case "ECONNREFUSED":
      return axiError(`cannot reach ${where} - connection refused`, "NETWORK", ["Is the server running? Check `docker ps` or the host/port of the profile"]);
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return axiError(`cannot resolve the host of ${where}`, "NETWORK");
    case "ETIMEDOUT":
    case "PROTOCOL_SEQUENCE_TIMEOUT":
      return axiError(`connection to ${where} timed out`, "NETWORK");
    case "PROTOCOL_CONNECTION_LOST":
      return axiError(`connection to ${where} was lost`, "NETWORK");
  }
  switch (e.errno) {
    case 1045:
      return axiError(sql ?? "access denied", "AUTH_REQUIRED", ["Check the user and password of the profile (`auth status`)"]);
    case 1044:
    case 1142:
    case 1143:
    case 1227:
    case 1370:
    case 1290:
      return axiError(sql ?? "permission denied", "FORBIDDEN");
    case 1049:
    case 1146:
      return axiError(sql ?? "not found", "NOT_FOUND");
    case 3024:
      return axiError("query exceeded the time limit", "TIMEOUT", ["Check the plan with `explain \"<select>\"` and narrow the query to an indexed WHERE", "Raise --timeout <seconds> only on a database you own - a long scan loads a shared server"]);
    case 1792:
      return axiError(sql ?? "refused by the read-only session", "READ_ONLY");
  }
  if (sql) return axiError(sql, "SQL_ERROR");
  return axiError(e.message || String(error), "UNKNOWN");
}
