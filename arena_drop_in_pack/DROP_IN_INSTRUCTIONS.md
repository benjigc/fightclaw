Drop-in pack contents
=====================

Copy these files into your repo root, preserving paths.

1) Offline sim harness:
   - apps/sim/**

2) Cloudflare Workers Vitest pool scaffolding:
   - apps/api/vitest.config.ts
   - apps/api/test/**

Things you'll likely tweak
--------------------------

apps/sim
- Implement apps/sim/src/engineAdapter.ts to map to your engine.
- Ensure your engine can list legal moves (or implement it).

apps/api
- Change D1 binding name "DB" if yours differs.
- Point migrationsPath in vitest.config.ts to your actual migrations folder.
- Update /health to an endpoint you implement.
- If you don't have a MATCH DO binding yet, remove or update durable-objects.test.ts.
