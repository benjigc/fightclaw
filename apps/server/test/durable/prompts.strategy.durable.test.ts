import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

describe("prompt strategy", () => {
	beforeEach(async () => {
		await resetDb();
	});

	describe("encryption", () => {
		it("create prompt encrypts in DB (ciphertext != plaintext)", async () => {
			const agent = await createAgent("strategy-agent", "strategy-key");
			const privateStrategy = "You are a strategic AI player. Always win.";

			// POST /v1/agents/me/strategy/:gameType
			const res = await SELF.fetch(
				"https://example.com/v1/agents/me/strategy/hex_conquest",
				{
					method: "POST",
					headers: {
						...authHeader(agent.key),
						"content-type": "application/json",
					},
					body: JSON.stringify({ privateStrategy }),
				},
			);
			expect(res.status).toBe(201);
			const data = (await res.json()) as {
				ok: boolean;
				created?: { id: string };
			};
			expect(data.ok).toBe(true);
			expect(data.created?.id).toBeDefined();

			// Verify encryption: DB should not contain plaintext
			const row = await env.DB.prepare(
				"SELECT private_strategy_ciphertext FROM prompt_versions WHERE id = ?",
			)
				.bind(data.created?.id)
				.first<{ private_strategy_ciphertext: string }>();
			expect(row?.private_strategy_ciphertext).toBeDefined();
			expect(row?.private_strategy_ciphertext).not.toBe(privateStrategy);
			expect(row?.private_strategy_ciphertext).not.toContain(privateStrategy);
		});
	});

	describe("GET active", () => {
		it("returns decrypted prompt for authenticated agent", async () => {
			const agent = await createAgent("decrypt-agent", "decrypt-key");
			const privateStrategy = "Decrypted prompt content";

			// Create and auto-activate prompt
			const createRes = await SELF.fetch(
				"https://example.com/v1/agents/me/strategy/hex_conquest",
				{
					method: "POST",
					headers: {
						...authHeader(agent.key),
						"content-type": "application/json",
					},
					body: JSON.stringify({ privateStrategy, activate: true }),
				},
			);
			expect(createRes.status).toBe(201);

			// Get active prompt: GET /v1/agents/me/strategy/:gameType
			const getRes = await SELF.fetch(
				"https://example.com/v1/agents/me/strategy/hex_conquest",
				{
					headers: authHeader(agent.key),
				},
			);
			expect(getRes.status).toBe(200);
			const data = (await getRes.json()) as {
				ok: boolean;
				active?: { privateStrategy: string };
			};
			expect(data.ok).toBe(true);
			expect(data.active?.privateStrategy).toBe(privateStrategy);
		});
	});

	describe("versions list", () => {
		it("versions list shows correct isActive", async () => {
			const agent = await createAgent("versions-agent", "versions-key");

			// Create first prompt (auto-activates by default)
			const create1 = await SELF.fetch(
				"https://example.com/v1/agents/me/strategy/hex_conquest",
				{
					method: "POST",
					headers: {
						...authHeader(agent.key),
						"content-type": "application/json",
					},
					body: JSON.stringify({ privateStrategy: "First prompt" }),
				},
			);
			expect(create1.status).toBe(201);
			const { created: created1 } = (await create1.json()) as {
				created: { id: string; version: number };
			};

			// Create second prompt without activation
			const create2 = await SELF.fetch(
				"https://example.com/v1/agents/me/strategy/hex_conquest",
				{
					method: "POST",
					headers: {
						...authHeader(agent.key),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						privateStrategy: "Second prompt",
						activate: false,
					}),
				},
			);
			expect(create2.status).toBe(201);
			const { created: created2 } = (await create2.json()) as {
				created: { id: string; version: number };
			};

			// Activate second prompt by version number
			// POST /v1/agents/me/strategy/:gameType/versions/:version/activate
			await SELF.fetch(
				`https://example.com/v1/agents/me/strategy/hex_conquest/versions/${created2.version}/activate`,
				{
					method: "POST",
					headers: authHeader(agent.key),
				},
			);

			// List versions: GET /v1/agents/me/strategy/:gameType/versions
			const listRes = await SELF.fetch(
				"https://example.com/v1/agents/me/strategy/hex_conquest/versions",
				{
					headers: authHeader(agent.key),
				},
			);
			expect(listRes.status).toBe(200);
			const { versions } = (await listRes.json()) as {
				versions: { id: string; version: number; isActive: boolean }[];
			};

			const v1 = versions.find((v) => v.id === created1.id);
			const v2 = versions.find((v) => v.id === created2.id);
			expect(v1?.isActive).toBe(false);
			expect(v2?.isActive).toBe(true);
		});
	});

	describe("activate", () => {
		it("activate flips pointer", async () => {
			const agent = await createAgent("activate-agent", "activate-key");

			// Create and activate first prompt
			const create1 = await SELF.fetch(
				"https://example.com/v1/agents/me/strategy/hex_conquest",
				{
					method: "POST",
					headers: {
						...authHeader(agent.key),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						privateStrategy: "First prompt",
						activate: true,
					}),
				},
			);
			expect(create1.status).toBe(201);
			const { created: created1 } = (await create1.json()) as {
				created: { id: string; version: number };
			};

			// Verify first is active
			const activeRow1 = await env.DB.prepare(
				"SELECT prompt_version_id FROM agent_prompt_active WHERE agent_id = ? AND game_type = ?",
			)
				.bind(agent.id, "hex_conquest")
				.first<{ prompt_version_id: string }>();
			expect(activeRow1?.prompt_version_id).toBe(created1.id);

			// Create second prompt without activation
			const create2 = await SELF.fetch(
				"https://example.com/v1/agents/me/strategy/hex_conquest",
				{
					method: "POST",
					headers: {
						...authHeader(agent.key),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						privateStrategy: "Second prompt",
						activate: false,
					}),
				},
			);
			expect(create2.status).toBe(201);
			const { created: created2 } = (await create2.json()) as {
				created: { id: string; version: number };
			};

			// Activate second by version number
			const activateRes = await SELF.fetch(
				`https://example.com/v1/agents/me/strategy/hex_conquest/versions/${created2.version}/activate`,
				{
					method: "POST",
					headers: authHeader(agent.key),
				},
			);
			expect(activateRes.status).toBe(200);

			// Verify second is now active
			const activeRow2 = await env.DB.prepare(
				"SELECT prompt_version_id FROM agent_prompt_active WHERE agent_id = ? AND game_type = ?",
			)
				.bind(agent.id, "hex_conquest")
				.first<{ prompt_version_id: string }>();
			expect(activeRow2?.prompt_version_id).toBe(created2.id);
		});
	});
});
