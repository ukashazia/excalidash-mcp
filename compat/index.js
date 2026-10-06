import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { configFromEnv, ExcaliDashClient } from './excalidash.js';

// Compatibility with the stable ExcaliDash 0.6.5 drawing CRUD API.
// Keep upstream HTTP transport/session handling; do not advertise absent Agent API routes.
export const createServer = (client, initialDrawingId) => {
  const server = new McpServer({ name: 'excalidash-mcp', version: '0.3.1-compat.1' });
  let selectedDrawingId = initialDrawingId;
  const id = z.string().min(1);
  const resolve = (value) => {
    const resolved = value ?? selectedDrawingId;
    if (!resolved) throw new Error('Select a drawing first or supply drawingId.');
    return resolved;
  };
  const register = (name, description, inputSchema, action) => {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const result = await action(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
      }
    });
  };
  register('list_drawings', 'List or search drawings available to this account.', z.object({
    search: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().nonnegative().default(0),
  }), (args) => client.listDrawings(args));
  register('select_drawing', 'Select the default drawing for this MCP session.', z.object({ drawingId: id }), async ({ drawingId }) => {
    const drawing = await client.getDrawing(drawingId);
    selectedDrawingId = drawing.id;
    return { selectedDrawingId, name: drawing.name, version: drawing.version };
  });
  register('get_selected_drawing', 'Return this session’s selected drawing ID.', z.object({}), async () => ({ selectedDrawingId: selectedDrawingId ?? null }));
  register('create_drawing', 'Create an empty Excalidraw drawing.', z.object({ name: z.string().trim().min(1).max(200), select: z.boolean().default(true) }), async ({ name, select }) => {
    const drawing = await client.createDrawing(name);
    if (select) selectedDrawingId = drawing.id;
    return drawing;
  });
  register('get_drawing', 'Read complete drawing elements, appState, files, and current version before editing.', z.object({ drawingId: id.optional() }), ({ drawingId }) => client.getDrawing(resolve(drawingId)));
  register('get_drawing_summary', 'Read element IDs, types, labels, geometry, bindings, and current drawing version.', z.object({ drawingId: id.optional() }), async ({ drawingId }) => {
    const drawing = await client.getDrawing(resolve(drawingId));
    const elements = drawing.elements.filter((element) => !element.isDeleted);
    return { id: drawing.id, name: drawing.name, version: drawing.version, elements: elements.map(({ id, type, text, x, y, width, height, boundElements, containerId, startBinding, endBinding }) => ({ id, type, text, x, y, width, height, boundElements, containerId, startBinding, endBinding })) };
  });
  register('inspect_drawing_element', 'Read one element and its bound children.', z.object({ drawingId: id.optional(), elementId: id }), async ({ drawingId, elementId }) => {
    const drawing = await client.getDrawing(resolve(drawingId));
    const element = drawing.elements.find((e) => e.id === elementId && !e.isDeleted);
    if (!element) throw new Error('Element not found.');
    const boundIds = new Set((element.boundElements ?? []).map((e) => e.id));
    return { version: drawing.version, element, children: drawing.elements.filter((e) => !e.isDeleted && (boundIds.has(e.id) || e.containerId === elementId)) };
  });
  register('update_drawing', 'Replace the complete scene elements using the version from get_drawing. Preserve existing elements unless deleting intentionally. Supply valid Excalidraw elements with bindings and incremented element versions. Optional appState/files are preserved when omitted. A 409 means reread and reconcile; never retry with a guessed version.', z.object({
    drawingId: id.optional(), version: z.number().int().nonnegative(),
    elements: z.array(z.record(z.string(), z.unknown())).max(5000),
    appState: z.record(z.string(), z.unknown()).optional(), files: z.record(z.string(), z.unknown()).optional(),
  }), async ({ drawingId, ...payload }) => client.request(`drawings/${encodeURIComponent(resolve(drawingId))}`, { method: 'PUT', body: JSON.stringify(payload) }));
  return server;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv(process.env);
  await createServer(new ExcaliDashClient(config), config.drawingId).connect(new StdioServerTransport());
}
