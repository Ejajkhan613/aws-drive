import { spawn } from "node:child_process";

const processes = [
  spawn("node", ["server/server.js"], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  }),
  spawn("npx", ["vite", "--host", "127.0.0.1"], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  }),
];

let shuttingDown = false;

for (const child of processes) {
  child.on("exit", (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const processToStop of processes) {
      if (processToStop !== child && !processToStop.killed) {
        processToStop.kill();
      }
    }
    process.exit(code ?? 0);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    for (const child of processes) {
      if (!child.killed) child.kill(signal);
    }
  });
}
