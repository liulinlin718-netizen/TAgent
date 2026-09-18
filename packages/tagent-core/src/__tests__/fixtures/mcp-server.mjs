import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'local-test', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Isolated fixture', inputSchema: { type: 'object' } }] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.arguments?.oversized) { process.stdout.write('x'.repeat(300000)); return { content: [] }; }
  if (request.params.arguments?.wait) await new Promise(resolve => setTimeout(resolve, 60000));
  return { content: [{ type: 'text', text: JSON.stringify({ value: request.params.arguments?.text, own: process.env.OWN_KEY, leaked: process.env.TAGENT_TEST_PRIVATE_KEY || null, args: process.argv.slice(2) }) }] };
});
await server.connect(new StdioServerTransport());
