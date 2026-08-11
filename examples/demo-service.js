const { exec } = require("child_process");

// CHANGED: added a second parameter — breaking for existing callers.
export function runTask(name, options) {
  // RISKY: executes arbitrary code from the caller.
  return eval(options.expr);
}

// RISKY: shell command built by string concatenation.
export function cleanup(dir) {
  return exec("rm -rf " + dir);
}
