import { createInsightsServer } from "./insights/server";
import { createMcpApiHandler } from "./shared/mcp";
import { createOAuthWorker } from "./shared/oauth";

const apiHandler = createMcpApiHandler(createInsightsServer);

export default createOAuthWorker("Google Insights MCP (Analytics + Search Console)", apiHandler);
