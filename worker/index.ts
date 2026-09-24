/// <reference types="@cloudflare/workers-types" />

import type { GameRoom as GameRoomType, WorkerEnv } from "./room";
export { GameRoom } from "./room";

const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 8;
const ROOM_CODE_PATTERN = /^[A-Z2-9]{8}$/;

function isAllowedOrigin(origin: string | null, env: WorkerEnv): boolean {
  if (origin === null) return true;
  if (origin === "http://localhost:3000") return true;
  return Boolean(env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN);
}

function json(status: number, value: unknown): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function withCors(response: Response, origin: string | null, env: WorkerEnv): Response {
  if (response.status === 101 || origin === null || !isAllowedOrigin(origin, env)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", headers.has("Vary") ? `${headers.get("Vary")}, Origin` : "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


function createRoomCode(): string {
  let code = "";
  const bytes = new Uint8Array(16);
  while (code.length < ROOM_CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 238) code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
      if (code.length === ROOM_CODE_LENGTH) break;
    }
  }
  return code;
}

function roomStub(env: WorkerEnv, code: string): DurableObjectStub<GameRoomType> {
  return env.MULTIPLAYER_ROOM.get(env.MULTIPLAYER_ROOM.idFromName(code));
}

async function createRoom(env: WorkerEnv): Promise<Response> {
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = createRoomCode();
      const room = roomStub(env, code);
      if (await room.createRoom(code)) return json(201, { code });
    }
  } catch {
    return json(503, { error: "ROOM_UNAVAILABLE" });
  }
  return json(503, { error: "ROOM_CREATION_FAILED" });
}

async function joinRoom(request: Request, env: WorkerEnv, code: string): Promise<Response> {
  if (!ROOM_CODE_PATTERN.test(code)) return json(400, { error: "INVALID_ROOM_CODE" });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json(426, { error: "WEBSOCKET_REQUIRED" });
  }

  const room = roomStub(env, code);
  try {
    if (!(await room.exists())) return json(404, { error: "ROOM_NOT_FOUND" });
    return await room.fetch(request);
  } catch {
    return json(503, { error: "ROOM_UNAVAILABLE" });
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const socketMatch = /^\/rooms\/([^/]+)\/socket$/.exec(url.pathname);
    const origin = request.headers.get("Origin");
    if (!isAllowedOrigin(origin, env)) {
      return json(403, { error: "ORIGIN_NOT_ALLOWED" });
    }
    if (socketMatch && origin === null) {
      return json(403, { error: "ORIGIN_REQUIRED" });
    }

    if (request.method === "OPTIONS") {
      if (origin === null) return json(403, { error: "ORIGIN_REQUIRED" });
      return withCors(
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
          },
        }),
        origin,
        env,
      );
    }

    if (request.method === "POST" && url.pathname === "/rooms") {
      return withCors(await createRoom(env), origin, env);
    }

    if (request.method === "GET" && socketMatch) {
      const code = socketMatch[1].toUpperCase();
      return withCors(await joinRoom(request, env, code), origin, env);
    }

    return withCors(json(404, { error: "NOT_FOUND" }), origin, env);
  },
};
