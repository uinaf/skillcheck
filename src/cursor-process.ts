// This process owns the group until cleanup. The harness may exit first;
// only the still-running group leader signals its own group, never a saved PID.
import { spawn, type ChildProcess } from "node:child_process";

let child: ChildProcess | undefined;
let terminal = false;
let cleaning = false;
let watchdog = setTimeout(cleanup, 5_000);

function cleanup(): void {
  if (cleaning) return;
  cleaning = true;
  clearTimeout(watchdog);
  if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
  // Windows has no POSIX group signaling. Retain direct-child cleanup there.
  child?.kill("SIGKILL");
  process.exit(1);
}

function fail(error: string): void {
  if (terminal) return;
  terminal = true;
  process.send?.({ type: "failure", error }, cleanup);
  clearTimeout(watchdog);
  watchdog = setTimeout(cleanup, 1_000);
}

if (!process.send) process.exit(1);
process.on("disconnect", cleanup);
process.on("message", (message: unknown) => {
  if (message === "stop") return cleanup();
  if (message === "cleanup" && terminal) {
    // Parent has acknowledged terminal facts. Flush cleanup confirmation before
    // killing this process and every helper that remains in its group.
    process.send?.({ type: "cleanup" }, cleanup);
    return;
  }
  if (child !== undefined || terminal) return;
  if (
    typeof message !== "object" ||
    message === null ||
    !("command" in message) ||
    typeof message.command !== "string" ||
    !("cwd" in message) ||
    typeof message.cwd !== "string" ||
    !("args" in message) ||
    !Array.isArray(message.args) ||
    !message.args.every((arg: unknown) => typeof arg === "string") ||
    !("timeoutMs" in message) ||
    typeof message.timeoutMs !== "number" ||
    !Number.isFinite(message.timeoutMs) ||
    message.timeoutMs <= 0
  ) {
    return fail("cursor-agent supervisor received invalid configuration");
  }
  clearTimeout(watchdog);
  watchdog = setTimeout(
    () => fail("cursor-agent supervisor watchdog timed out"),
    message.timeoutMs + 1_000,
  );
  const command = message.command;
  try {
    child = spawn(command, message.args, {
      cwd: message.cwd,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (error) {
    return fail(
      `failed to spawn ${command}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  child.on("error", (error) => fail(`failed to spawn ${command}: ${error.message}`));
  child.stdin?.on("error", (error) => fail(`cursor-agent stdin failed: ${error.message}`));
  process.stdin.on("error", (error) => fail(`cursor-agent prompt stream failed: ${error.message}`));
  if (child.stdin) process.stdin.pipe(child.stdin);
  child.on("exit", (code, signal) => {
    if (terminal) return;
    if (!child?.stdin?.writableFinished)
      return fail("cursor-agent stdin closed before prompt delivery");
    terminal = true;
    process.stdin.unpipe();
    clearTimeout(watchdog);
    watchdog = setTimeout(cleanup, 1_000);
    process.send?.({ type: "terminal", code, signal }, (error) => {
      if (error) cleanup();
    });
  });
});
