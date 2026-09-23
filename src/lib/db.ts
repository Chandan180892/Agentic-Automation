import { PrismaClient } from "@/generated/prisma";
import { log } from "@/lib/log";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function create() {
  const client = new PrismaClient({
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });
  // Route Prisma's own messages through the structured logger. A unique-constraint violation is
  // how the job queue enforces "one at a time", so it is expected and handled — not an error.
  client.$on("error", (e) => {
    if (/Unique constraint failed/.test(e.message)) return;
    log.error("database error", undefined, { detail: e.message.slice(0, 500), target: e.target });
  });
  client.$on("warn", (e) => log.warn("database warning", { detail: e.message.slice(0, 500) }));
  return client;
}

export const db = globalForPrisma.prisma ?? create();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
