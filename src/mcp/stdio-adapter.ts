import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  createBrokerMcpServer,
  createIpcMcpControlClientV4,
  V4_MCP_INSTRUCTIONS,
  type McpAdapterDependenciesV4,
  type McpBrokerControlClientV4,
  type McpServerV4,
  type RepairControlV4,
} from './broker-server.js';
import type { BrokerIpcClientV4 } from '../runtime/broker-ipc.js';

export { createIpcMcpControlClientV4, V4_MCP_INSTRUCTIONS };
export type { McpAdapterDependenciesV4, McpBrokerControlClientV4, McpServerV4, RepairControlV4 };

export function createMcpStdioAdapter(deps: McpAdapterDependenciesV4): McpServerV4 {
  return createBrokerMcpServer(deps);
}

export async function runMcpStdioAdapter(deps: McpAdapterDependenciesV4): Promise<void> {
  const server = createMcpStdioAdapter(deps);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  transport.onclose = () => {
    void deps.client.close();
  };
  await server.connect(transport);
}

export function createIpcMcpStdioAdapter(client: BrokerIpcClientV4): McpAdapterDependenciesV4 {
  return Object.freeze({ client: createIpcMcpControlClientV4(client) });
}
