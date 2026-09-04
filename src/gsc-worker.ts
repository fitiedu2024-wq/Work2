import { createGscServer } from "./gsc/server";
import { createMcpApiHandler } from "./shared/mcp";
import { createOAuthWorker } from "./shared/oauth";

const apiHandler = createMcpApiHandler(createGscServer);

export default createOAuthWorker("Google Search Console MCP", apiHandler);
