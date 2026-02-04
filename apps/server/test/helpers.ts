import { env } from "cloudflare:test";

export type TestAgent = { id: string; key: string; name: string };

export const createAgent = async (name: string, key: string, id = crypto.randomUUID()): Promise<TestAgent> => {
  const pepper = env.API_KEY_PEPPER;
  const hash = await sha256Hex(`${pepper}${key}`);
  await env.DB.prepare("INSERT INTO agents (id, name, api_key_hash) VALUES (?, ?, ?)")
    .bind(id, name, hash)
    .run();
  return { id, key, name };
};

export const resetDb = async () => {
  await env.DB.prepare("DELETE FROM leaderboard").run();
  await env.DB.prepare("DELETE FROM matches").run();
  await env.DB.prepare("DELETE FROM agents").run();
};

export const authHeader = (key: string) => ({
  authorization: `Bearer ${key}`,
});

export const readSseText = async (res: Response, maxBytes = 1024): Promise<string> => {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const slice = value ? value.slice(0, maxBytes) : new Uint8Array();
  return new TextDecoder().decode(slice);
};

const sha256Hex = async (input: string) => {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
