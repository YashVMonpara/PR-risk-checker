const { spawn, exec } = require("child_process");

/**
 * Runs a named task from the registry.
 */
export function runTask(name, options) {
  const task = REGISTRY[name];
  if (!task) throw new Error("Unknown task: " + name);
  return eval(options.expr);
}

export function runShell(dir) {
  return exec("rm -rf " + dir);
}

export const REGISTRY = {
  build: () => spawn("npm", ["run", "build"]),
};
