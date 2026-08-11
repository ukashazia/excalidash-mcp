#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { configFromEnv, ExcaliDashClient } from "./excalidash.js";

const style = z.record(z.string(), z.unknown());
const id = z.string().min(1);

const op = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_shape"),
    ref: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),
    shape: z.enum(["rectangle", "ellipse", "diamond", "text", "frame"]),
    x: z.number(),
    y: z.number(),
    w: z.number().positive().optional(),
    h: z.number().positive().optional(),
    label: z.string().optional(),
    style: style.optional(),
  }),
  z.object({
    op: z.literal("connect"),
    fromId: id,
    toId: id,
    label: z.string().optional(),
    style: style.optional(),
    arrowType: z.enum(["arrow", "line"]).optional(),
  }),
  z.object({ op: z.literal("set_text"), id, text: z.string() }),
  z.object({ op: z.literal("set_style"), id, style }),
  z
    .object({
      op: z.literal("move"),
      id,
      dx: z.number().optional(),
      dy: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    })
    .refine((value) => {
      const relative = value.dx !== undefined || value.dy !== undefined;
      const absolute = value.x !== undefined || value.y !== undefined;
      return relative !== absolute;
    }, "move requires either (dx,dy) or (x,y), not both"),
  z.object({
    op: z.literal("resize"),
    id,
    w: z.number().positive(),
    h: z.number().positive(),
  }),
  z.object({
    op: z.literal("align"),
    ids: z.array(id).min(2).max(100),
    alignment: z.enum(["left", "center", "right", "top", "middle", "bottom"]),
  }),
  z.object({
    op: z.literal("distribute"),
    ids: z.array(id).min(2).max(100),
    direction: z.enum(["horizontal", "vertical"]),
    gap: z.number().nonnegative().optional(),
  }),
  z.object({
    op: z.literal("layout"),
    ids: z.array(id).min(1).max(100),
    direction: z.enum(["horizontal", "vertical", "grid"]),
    gap: z.number().nonnegative().max(2000).optional(),
    columns: z.number().int().positive().max(20).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({ op: z.literal("group"), ids: z.array(id).min(2).max(100) }),
  z.object({ op: z.literal("delete"), id }),
  z.object({
    op: z.literal("import_elements"),
    elements: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  }),
  z.object({
    op: z.literal("revert_to_snapshot"),
    version: z.number().int().nonnegative(),
  }),
]);

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

const errorResult = (error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: error instanceof Error ? error.message : String(error),
    },
  ],
  isError: true,
});

export const createServer = (
  client: ExcaliDashClient,
  initialDrawingId?: string,
): McpServer => {
  const server = new McpServer({ name: "excalidash-mcp", version: "0.3.1" });
  let selectedDrawingId = initialDrawingId;

  const resolveDrawingId = (drawingId?: string): string => {
    const resolved = drawingId ?? selectedDrawingId;
    if (!resolved) {
      throw new Error(
        "No drawing selected. Call list_drawings and select_drawing first, or pass drawingId.",
      );
    }
    return resolved;
  };

  server.registerTool(
    "list_drawings",
    {
      description:
        "List ExcaliDash drawings available to the account API key. Use this before selecting a drawing.",
      inputSchema: z.object({
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().nonnegative().default(0),
      }),
    },
    async ({ search, limit, offset }) => {
      try {
        const result = await client.listDrawings({ search, limit, offset });
        return textResult(
          JSON.stringify({ selectedDrawingId, ...result }, null, 2),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "select_drawing",
    {
      description:
        "Select an Excalidraw drawing as the default target for subsequent tools in this MCP process.",
      inputSchema: z.object({ drawingId: id }),
    },
    async ({ drawingId }) => {
      try {
        const drawing = await client.getDrawing(drawingId);
        if (drawing.engine !== "excalidraw") {
          throw new Error(
            `Drawing ${drawingId} uses ${drawing.engine}; Agent API operations support Excalidraw only.`,
          );
        }
        selectedDrawingId = drawing.id;
        return textResult(
          JSON.stringify(
            { selectedDrawingId, name: drawing.name, version: drawing.version },
            null,
            2,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_selected_drawing",
    {
      description: "Return the drawing currently selected by this MCP process.",
      inputSchema: z.object({}),
    },
    async () =>
      textResult(
        selectedDrawingId
          ? JSON.stringify({ selectedDrawingId })
          : "No drawing selected.",
      ),
  );

  server.registerTool(
    "create_drawing",
    {
      description:
        "Create a new empty Excalidraw drawing and optionally select it as the default target.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(200),
        select: z.boolean().default(true),
      }),
    },
    async ({ name, select }) => {
      try {
        const drawing = await client.createDrawing(name);
        if (select) selectedDrawingId = drawing.id;
        return textResult(
          JSON.stringify({ selected: select, drawing }, null, 2),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_drawing_summary",
    {
      description:
        "Read a compact structural summary of a drawing. Uses drawingId when provided, otherwise the selected drawing.",
      inputSchema: z.object({ drawingId: id.optional() }),
    },
    async ({ drawingId }) => {
      try {
        return textResult(await client.getSummary(resolveDrawingId(drawingId)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "inspect_drawing_element",
    {
      description:
        "Inspect one element and its bound children. Uses drawingId when provided, otherwise the selected drawing.",
      inputSchema: z.object({
        drawingId: id.optional(),
        elementId: id,
      }),
    },
    async ({ drawingId, elementId }) => {
      try {
        return textResult(
          JSON.stringify(
            await client.inspectElement(
              resolveDrawingId(drawingId),
              elementId,
            ),
            null,
            2,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "apply_drawing_ops",
    {
      description:
        "Atomically apply up to 50 semantic operations. Uses drawingId when provided, otherwise the selected drawing. Read the summary first.",
      inputSchema: z.object({
        drawingId: id.optional(),
        ops: z.array(op).min(1).max(50),
        clientBatchId: z.string().max(200).optional(),
      }),
    },
    async ({ drawingId, ops, clientBatchId }) => {
      try {
        return textResult(
          JSON.stringify(
            await client.applyOps(
              resolveDrawingId(drawingId),
              ops,
              clientBatchId,
            ),
            null,
            2,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
};

const main = async (): Promise<void> => {
  const config = configFromEnv();
  const server = createServer(
    new ExcaliDashClient(config),
    config.drawingId,
  );
  await server.connect(new StdioServerTransport());
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
