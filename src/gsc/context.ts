import type { McpServer } from "@modelcontextprotocol/server";
import { requireGscProperty, type WebsiteConfig } from "../shared/website";

export type GscToolContext = {
  server: McpServer;
  key: string;
  website: WebsiteConfig;
  name: (tool: string) => string;
  lock: string;
};

export function gscSite(context: GscToolContext): string {
  return requireGscProperty(context.website);
}
