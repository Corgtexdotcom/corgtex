/**
 * Pure, dependency-free entry point for the Module Manifest registry.
 *
 * Import this via `@corgtex/domain/modules` from anywhere (including the web
 * client bundle). It MUST NOT transitively pull in Prisma or other runtime
 * dependencies - keep it types + plain data only.
 */

export * from "./types";
export * from "./registry";
export * from "./access";
