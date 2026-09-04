import { createMcpApiHandler } from "./shared/mcp";
import { createOAuthWorker } from "./shared/oauth";
import { createGaServer } from "./ga/server";

const apiHandler = createMcpApiHandler(createGaServer);

export default createOAuthWorker("Google Analytics MCP", apiHandler);
