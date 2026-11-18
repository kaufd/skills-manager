import { defineConfig } from "vitest/config";

// Anchored to the repo's tests/ dir so worktrees under .claude/ are not picked up.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
