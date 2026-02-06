import { it } from "vitest";

it.skip("flaky: vpw isolated storage + DO invalidation (broken.inputGateBroken)", // Unskip when vpw fixes isolated storage teardown for DO persistence tests. // - "Failed to pop isolated storage stack frame" / ".sqlite-shm" // - "broken.inputGateBroken" // - "index.ts changed, invalidating this Durable Object. Please retry the DurableObjectStub#fetch() call." // Failure signatures observed on 2026-02-05 with @cloudflare/vitest-pool-workers@0.9.14:
async () => {});
