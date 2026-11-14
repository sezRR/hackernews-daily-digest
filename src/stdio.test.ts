import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, assert, it } from "@effect/vitest";

/** Every request fails, which forces the logging path without touching the network. */
const NO_NETWORK = `data:text/javascript,${encodeURIComponent(
  'globalThis.fetch = async () => new Response("", { status: 404 });',
)}`;

/** Runs the built server as a real subprocess and speaks raw JSON-RPC to it. */
const startServer = () => {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--import", NO_NETWORK, "dist/index.js"],
    { stdio: "pipe" },
  );
  const stdoutLines: Array<string> = [];
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    stdoutLines.push(line);
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });

  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (id: number, method: string, params: object = {}) => {
    const response = new Promise<Record<string, any>>((resolve) => waiting.set(id, resolve));
    send({ id, method, params });
    return response;
  };

  return { child, stdoutLines, request, send, stderr: () => stderr };
};

let running: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  running?.kill("SIGKILL");
  running = undefined;
});

const initialize = async (server: ReturnType<typeof startServer>) => {
  running = server.child;
  const response = await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-test", version: "0" },
  });
  server.send({ method: "notifications/initialized" });
  return response;
};

it("negotiates the client's protocol version and lists tools", async () => {
  const server = startServer();
  const init = await initialize(server);

  assert.strictEqual(init.result.protocolVersion, "2025-06-18");
  assert.strictEqual(init.result.serverInfo.name, "hackernews");

  const tools = await server.request(2, "tools/list");
  assert.deepStrictEqual(
    tools.result.tools.map((tool: { name: string }) => tool.name).sort(),
    ["get_comments", "get_front_page"],
  );
}, 15_000);

it("negotiates down when a client offers a newer protocol version", async () => {
  const server = startServer();
  running = server.child;

  const init = await server.request(1, "initialize", {
    protocolVersion: "2099-01-01",
    capabilities: {},
    clientInfo: { name: "stdio-test", version: "0" },
  });

  assert.strictEqual(init.result.protocolVersion, "2025-11-25");
}, 15_000);

it("keeps stdout pure JSON-RPC and sends logs to stderr", async () => {
  const server = startServer();
  await initialize(server);

  const call = await server.request(2, "tools/call", { name: "get_front_page", arguments: {} });

  assert.strictEqual(call.result.isError, true);
  assert.include(server.stderr(), "Falling back to API ranking");
  for (const line of server.stdoutLines) {
    assert.strictEqual(JSON.parse(line).jsonrpc, "2.0");
  }
}, 15_000);

it("exits cleanly when the client closes stdin", async () => {
  const server = startServer();
  await initialize(server);

  const exited = once(server.child, "exit");
  server.child.stdin.end();
  const [code] = await exited;

  assert.strictEqual(code, 0);
}, 15_000);

it("exits on SIGTERM", async () => {
  const server = startServer();
  await initialize(server);

  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await exited;

  assert.isNotNull(server.child.exitCode ?? server.child.signalCode);
}, 15_000);
