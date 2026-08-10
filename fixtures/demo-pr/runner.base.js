const { spawn } = require("child_process");

/**
 * Runs a named task from the registry.
 */
export function runTask(name) {
  const task = REGISTRY[name];
  if (!task) throw new Error("Unknown task: " + name);
  return task();
}

export const REGISTRY = {
  build: () => spawn("npm", ["run", "build"]),
};
