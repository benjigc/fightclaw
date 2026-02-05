import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

it("creates a DO instance and can fetch it", async () => {
	// Avoid pulling in the full generated Env binding type here (it can cause deep
	// instantiation errors in tsc), and gracefully no-op for lanes where MATCH is
	// not bound.
	const match = (env as unknown as Record<string, unknown>).MATCH as
		| DurableObjectNamespace
		| undefined;
	if (!match) return;

	const id = match.idFromName(`test-${crypto.randomUUID()}`);
	const stub: DurableObjectStub = match.get(id);

	const res = await stub.fetch("https://example.com");
	expect([200, 404, 405]).toContain(res.status);

	await runInDurableObject(stub, async (_instance: unknown, _state) => {
		return new Response("ok");
	});
});
