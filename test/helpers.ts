import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as roMain } from "../packages/mysql-axi/src/cli.js";
import { main as rwMain } from "../packages/mysql-rw-axi/src/cli.js";

export const RO_URL = "mysql://agent:s3cret@127.0.0.1:3306/shop";
export const RW_URL = "mysql://root@127.0.0.1:3306/shop";

/** Env-only config so tests never touch the real keychain or ~/.config. */
export function useTestEnv(): void {
  for (const prefix of ["MYSQL_AXI", "MYSQL_RW_AXI"]) {
    process.env[`${prefix}_CONFIG_DIR`] = mkdtempSync(join(tmpdir(), "mysql-axi-test-"));
    process.env[`${prefix}_NO_KEYCHAIN`] = "1";
    delete process.env[`${prefix}_PROFILE`];
  }
  process.env["MYSQL_AXI_URL"] = RO_URL;
  process.env["MYSQL_RW_AXI_URL"] = RW_URL;
}

async function capture(main: typeof roMain, argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  let stdout = "";
  process.exitCode = 0;
  await main({ argv, stdout: { write: (chunk: string) => (stdout += chunk) } });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout, exitCode };
}

export const ro = (...argv: string[]) => capture(roMain, argv);
export const rw = (...argv: string[]) => capture(rwMain, argv);
