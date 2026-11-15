import { PrismaClient } from "@prisma/client";
import { pooledDatabaseUrl } from "@/lib/db-url";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient({ datasources: { db: { url: pooledDatabaseUrl() } }, log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";
