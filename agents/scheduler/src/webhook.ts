/**
 * Webhook server — node:http server exposing /trigger/{agent} and /health.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger, type WebhookTrigger } from "@agents/sdk";
import type { ExecutionManager } from "./execution-manager.js";

const DEFAULT_PORT = 3847;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function verifySignature(
  body: string,
  secret: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const sig = signature.replace(/^sha256=/, "");
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface WebhookRoute {
  agentName: string;
  path: string;
  trigger: WebhookTrigger;
}

export function createWebhookServer(
  manager: ExecutionManager,
  routes: WebhookRoute[],
  port = DEFAULT_PORT,
): Server {
  const routeMap = new Map<string, WebhookRoute>();
  for (const route of routes) {
    routeMap.set(`/trigger/${route.path}`, route);
    logger.info("Registered webhook route", {
      agent: route.agentName,
      path: `/trigger/${route.path}`,
    });
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";

    // Health check
    if (url === "/health" && req.method === "GET") {
      json(res, 200, { status: "ok" });
      return;
    }

    // Trigger routes
    if (req.method === "POST" && routeMap.has(url)) {
      const route = routeMap.get(url)!;
      const body = await readBody(req);

      // HMAC verification if secret is configured
      if (route.trigger.secret) {
        const sig = req.headers["x-signature-256"] as string | undefined;
        if (!verifySignature(body, route.trigger.secret, sig)) {
          json(res, 401, { error: "Invalid signature" });
          return;
        }
      }

      // Return 202 immediately, run agent async
      json(res, 202, { status: "accepted", agent: route.agentName });

      let webhookBody: unknown;
      if (route.trigger.passBody) {
        try {
          webhookBody = JSON.parse(body);
        } catch {
          webhookBody = body;
        }
      }

      manager
        .run(route.agentName, {
          triggerType: "webhook",
          triggeredAt: new Date().toISOString(),
          webhookBody,
        })
        .catch((err) =>
          logger.error("Webhook-triggered run failed", {
            agent: route.agentName,
            error: String(err),
          }),
        );
      return;
    }

    // 404
    json(res, 404, { error: "Not found" });
  });

  server.listen(port, () => {
    logger.info("Webhook server listening", { port });
  });

  return server;
}
