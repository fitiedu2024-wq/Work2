import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

type ServerFactory = (env: Env) => McpServer;

export type WorkerFetchHandler<Bindings> = {
  fetch(
    request: Request,
    env: Bindings,
    context: ExecutionContext
  ): Response | Promise<Response>;
};

export function createMcpApiHandler(
  createServer: ServerFactory
): WorkerFetchHandler<Env> {
  return {
    async fetch(request, env, context): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== "/mcp") {
        return Response.json({ error: 'The MCP endpoint is exactly "/mcp".' }, {
          status: 404
        });
      }
      const props =
        "props" in context &&
        context.props !== null &&
        typeof context.props === "object" &&
        !Array.isArray(context.props)
          ? context.props
          : undefined;
      const expectedResource = `${url.origin}/mcp`;
      if (
        !props ||
        !("resource" in props) ||
        props.resource !== expectedResource
      ) {
        return Response.json(
          { error: "This OAuth token is not authorized for this MCP route." },
          { status: 403 }
        );
      }

      const handler = createMcpHandler(() => createServer(env), {
        route: "/mcp"
      });
      return handler(request, env, context);
    }
  };
}

export function jsonToolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }]
  };
}

export function errorToolResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true
  };
}
