// Minimal MCP stdio server: newline-delimited JSON-RPC 2.0 on stdin/stdout.
// Never write to stdout outside this protocol (logs go to stderr).
export function createMcpServer({ name, version, tools }) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }
  function reply(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }
  function fail(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function handle(msg) {
    const { id, method, params } = msg;

    // Notifications carry no id and expect no response.
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;

    if (method === "initialize") {
      return reply(id, {
        // Echo the client's version when offered; both 2024-11-05 and
        // 2025-06-18 clients are satisfied by this handshake.
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
      });
    }

    if (method === "ping") return reply(id, {});

    if (method === "tools/list") {
      return reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (method === "tools/call") {
      const tool = toolMap.get(params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const out = await tool.run(params.arguments ?? {});
        const text = typeof out === "string" ? out : out.text;
        return reply(id, {
          content: [{ type: "text", text }],
          isError: !!(typeof out === "object" && out.isError),
        });
      } catch (e) {
        return reply(id, {
          content: [{ type: "text", text: `error: ${e?.message ?? e}` }],
          isError: true,
        });
      }
    }

    // Capability lists we do not implement: answer empty rather than erroring.
    if (method === "resources/list") return reply(id, { resources: [] });
    if (method === "prompts/list") return reply(id, { prompts: [] });

    fail(id, -32601, `method not found: ${method}`);
  }

  function run() {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // ignore malformed frames rather than killing the server
        }
        handle(msg).catch((e) => {
          if (msg?.id != null) fail(msg.id, -32603, String(e?.message ?? e));
        });
      }
    });
    process.stdin.on("end", () => process.exit(0));
  }

  return { run };
}
