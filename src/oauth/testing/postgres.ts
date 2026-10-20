import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  chownSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { createServer } from "node:net";

/** Always starts an isolated temporary database; never connects to an application DB. */
export async function testPostgres() {
  const candidates = (process.env.PATH || "").split(delimiter);
  if (existsSync("/usr/lib/postgresql"))
    for (const v of readdirSync("/usr/lib/postgresql"))
      candidates.push(`/usr/lib/postgresql/${v}/bin`);
  const bin = candidates.find(
    (p) => existsSync(join(p, "initdb")) && existsSync(join(p, "pg_ctl")),
  );
  if (!bin)
    throw Error(
      "OAuth tests require PostgreSQL server binaries (initdb and pg_ctl)",
    );
  const dir = mkdtempSync(join(tmpdir(), "excalidash-oauth-test-"));
  let uid: number | undefined, gid: number | undefined;
  if (process.getuid?.() === 0) {
    uid = Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }));
    gid = Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }));
    chownSync(dir, uid, gid);
  }
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("No test port");
  const port = address.port;
  await new Promise<void>((r) => socket.close(() => r()));
  const run = (cmd: string, args: string[]) =>
    execFileSync(join(bin, cmd), args, {
      uid,
      gid,
      cwd: dir,
      stdio: "pipe",
      timeout: 30000,
    });
  try {
    run("initdb", [
      "-D",
      join(dir, "data"),
      "-U",
      "oauth_test",
      "-A",
      "trust",
      "--no-locale",
      "-E",
      "UTF8",
    ]);
    run("pg_ctl", [
      "-D",
      join(dir, "data"),
      "-l",
      join(dir, "server.log"),
      "-o",
      `-h 127.0.0.1 -k ${dir} -p ${port} -F`,
      "-w",
      "start",
    ]);
    return {
      url: `postgresql://oauth_test@127.0.0.1:${port}/postgres`,
      close: () => {
        try {
          run("pg_ctl", [
            "-D",
            join(dir, "data"),
            "-m",
            "immediate",
            "-w",
            "stop",
          ]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
