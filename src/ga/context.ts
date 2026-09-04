import type { McpServer } from "@modelcontextprotocol/server";
import { requireGaProperty, type WebsiteConfig } from "../shared/website";

export type GaToolContext = {
  server: McpServer;
  key: string;
  website: WebsiteConfig;
  /** Maps a base tool name to the registered name (adds a prefix on combined Workers). */
  name: (tool: string) => string;
  /** Text appended to every description so the model knows the lock. */
  lock: string;
};

export function gaProperty(context: GaToolContext): string {
  return requireGaProperty(context.website);
}
