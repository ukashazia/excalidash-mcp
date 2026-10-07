import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startHttpServer } from './http.js';
import { sharedRenderer } from './renderer.js';
import { PNG } from 'pngjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); };

test('stable API compatibility: scene reads, inspection, versioned writes, and session isolation', async () => {
  let drawing = { id: 'drawing-1', name: 'Test', version: 3, elements: [
    { id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 80, boundElements: [{ id: 'label', type: 'text' }] },
    { id: 'label', type: 'text', text: 'Hello', containerId: 'box', x: 10, y: 20, width: 80, height: 30, fontSize: 20, fontFamily: 1, autoResize: true },
  ], appState: { viewBackgroundColor: '#fff' }, files: { preserved: {} } };
  const api = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-key');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url.startsWith('/api/drawings?')) return res.end(JSON.stringify({ drawings: [drawing] }));
    if (req.method === 'POST' && req.url === '/api/drawings') { res.statusCode = 201; return res.end(JSON.stringify({ ...drawing, id: 'new-drawing' })); }
    if (req.url !== '/api/drawings/drawing-1') { res.statusCode = 404; return res.end('{}'); }
    if (req.method === 'GET') return res.end(JSON.stringify(drawing));
    if (req.method === 'PUT') {
      let body = ''; for await (const chunk of req) body += chunk;
      const update = JSON.parse(body);
      if (update.version !== drawing.version) { res.statusCode = 409; return res.end(JSON.stringify({ code: 'VERSION_CONFLICT' })); }
      assert.equal(update.appState, undefined);
      assert.equal(update.files, undefined);
      drawing = { ...drawing, ...update, version: drawing.version + 1 };
      return res.end(JSON.stringify(drawing));
    }
    res.statusCode = 405; res.end('{}');
  });
  await listen(api);
  const http = await startHttpServer({ EXCALIDASH_URL: `http://127.0.0.1:${api.address().port}`, EXCALIDASH_API_KEY: 'test-key', MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: '0' });
  const endpoint = `http://127.0.0.1:${http.address().port}/mcp`;
  let counter = 0;
  const send = async (session, method, params) => {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++counter, method, params }) });
    const text = await r.text();
    const payload = JSON.parse(text.startsWith('event:') ? text.split('\n').find((line) => line.startsWith('data: ')).slice(6) : text);
    assert.equal(r.status, 200, text);
    return { session: r.headers.get('mcp-session-id'), ...payload };
  };
  const init = () => send(null, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const tool = async (session, name, args = {}) => (await send(session, 'tools/call', { name, arguments: args })).result;
  const value = (result) => { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  try {
    const { session } = await init();
    const tools = (await send(session, 'tools/list', {})).result.tools.map((t) => t.name);
    assert.equal(tools.length, 13); assert.ok(tools.includes('update_drawing')); assert.ok(!tools.includes('apply_drawing_ops'));
    assert.equal(value(await tool(session, 'list_drawings')).drawings.length, 1);
    assert.equal(value(await tool(session, 'select_drawing', { drawingId: 'drawing-1' })).selectedDrawingId, 'drawing-1');
    assert.equal(value(await tool(session, 'get_drawing')).version, 3);
    assert.equal(value(await tool(session, 'get_drawing_summary')).elements.length, 2);
    assert.equal(value(await tool(session, 'inspect_drawing_element', { elementId: 'box' })).children[0].id, 'label');
    const other = (await init()).session;
    assert.equal(value(await tool(other, 'get_selected_drawing')).selectedDrawingId, null);
    const elements = drawing.elements.map((e) => e.id === 'box' ? { ...e, x: 100 } : e);
    assert.equal(value(await tool(session, 'update_drawing', { version: 3, elements })).version, 4);
    assert.equal((await tool(session, 'update_drawing', { version: 3, elements })).isError, true);
    assert.equal(drawing.version, 4); assert.equal(drawing.appState.viewBackgroundColor, '#fff'); assert.ok(drawing.files.preserved);
    const viewport = value(await tool(session, 'set_viewport', { fit: 'board', expectedVersion: 4 }));
    assert.equal(viewport.source, 'saved');
    assert.equal(value(await tool(other, 'get_viewport')).viewport, null);
    const shot = await tool(session, 'snapshot_viewport');
    assert.equal(shot.content[1].type, 'image');
    const png = PNG.sync.read(Buffer.from(shot.content[1].data, 'base64'));
    assert.equal(png.width, 1280); assert.equal(png.height, 960);
    const meta = value(shot);
    assert.ok(meta.visibleElementIds.includes('box'));
    assert.ok(meta.timings.drawingReadMs >= 0);
    assert.ok(meta.timings.rendererMs >= meta.renderMs);
    assert.ok(meta.timings.totalMs >= meta.timings.rendererMs);
    assert.equal(value(await tool(session, 'create_drawing', { name: 'New' })).id, 'new-drawing');
    assert.equal(value(await tool(session, 'get_selected_drawing')).selectedDrawingId, 'new-drawing');
  } finally { await close(http); await close(api); await sharedRenderer.close(); }
});
