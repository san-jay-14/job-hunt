import { PrismaClient } from "@prisma/client";

// Single shared PrismaClient for the whole process. This is a run-once CLI, so
// a module-level singleton is enough — no need for the global-caching dance
// that long-running dev servers use to survive hot reloads.
export const prisma = new PrismaClient();
