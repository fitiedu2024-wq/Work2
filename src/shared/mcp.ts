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

/**
 * MCP tool annotations. Clients such as Claude and Cursor use these to decide
 * whether a call needs the user's approval before it runs.
 */
export const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

/** Writes that create, change, or delete Google configuration. */
export const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
} as const;

/** Calls that spend quota or trigger work at Google without changing data. */
export const actionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
} as const;

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function jsonToolResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }]
  };
}

export function errorToolResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true
  };
}

/** Runs a tool body and converts thrown errors into MCP error results. */
export async function execute(operation: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return jsonToolResult(await operation());
  } catch (error) {
    return errorToolResult(error);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Builds tool names for a server. The standalone GA and GSC Workers use no
 * prefix; the combined per-brand Worker prefixes with "ga_" / "gsc_" so both
 * tool sets can live on one server without collisions.
 */
export function toolNamer(prefix: string): (name: string) => string {
  return (name) => (prefix && name.startsWith(prefix) ? name : `${prefix}${name}`);
}

/** Runs `operation` over `items` with at most `concurrency` in flight. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>
): Promise<Array<{ index: number; ok: true; value: R } | { index: number; ok: false; error: string }>> {
  const results: Array<
    { index: number; ok: true; value: R } | { index: number; ok: false; error: string }
  > = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = { index, ok: true, value: await operation(item, index) };
      } catch (error) {
        results[index] = {
          index,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
