import { randomUUID } from "node:crypto";
import {
	ArenaClient,
	type MoveProvider,
	runMatch,
} from "@fightclaw/agent-client";

type ArgMap = Record<string, string | boolean>;

const parseArgs = (
	argv: string[],
): { command: string | null; args: ArgMap } => {
	const [command, ...rest] = argv;
	const args: ArgMap = {};
	for (let i = 0; i < rest.length; i += 1) {
		const part = rest[i];
		if (!part?.startsWith("--")) continue;
		const key = part.slice(2);
		const next = rest[i + 1];
		if (!next || next.startsWith("--")) {
			args[key] = true;
			continue;
		}
		args[key] = next;
		i += 1;
	}
	return { command: command ?? null, args };
};

const asString = (value: string | boolean | undefined): string | undefined => {
	return typeof value === "string" ? value : undefined;
};

const asInt = (
	value: string | boolean | undefined,
	fallback: number,
): number => {
	if (typeof value !== "string") return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return parsed;
};

const usage = () => {
	console.log(
		[
			"Fightclaw Agent CLI",
			"",
			"Commands:",
			"  register  --baseUrl <url> --name <agentName> [--verify --adminKey <key>]",
			"  me        --baseUrl <url> --apiKey <key>",
			"  run       --baseUrl <url> --apiKey <key> [--transport ws|http]",
			"  run-many  --baseUrl <url> --count <n> --matches <n> --adminKey <key> [--prefix bot]",
		].join("\n"),
	);
};

const createClient = (baseUrl: string, apiKey?: string) => {
	return new ArenaClient({
		baseUrl,
		agentApiKey: apiKey,
		requestIdProvider: () => randomUUID(),
		onLog: () => {
			// Intentionally no-op by default; callers can plug this in.
		},
	});
};

const simpleMoveProvider: MoveProvider = {
	nextMove: async () => {
		return { action: "pass", reasoning: "MVP deterministic CLI baseline." };
	},
};

const runRegister = async (args: ArgMap) => {
	const baseUrl = asString(args.baseUrl) ?? "http://127.0.0.1:3000";
	const name = asString(args.name);
	if (!name) {
		throw new Error("register requires --name");
	}

	const client = createClient(baseUrl);
	const registered = await client.register(name);
	const verify = Boolean(args.verify);
	const adminKey =
		asString(args.adminKey) ??
		(typeof process.env.ADMIN_KEY === "string"
			? process.env.ADMIN_KEY
			: undefined);
	let verifiedAt: string | null = null;
	if (verify) {
		if (!adminKey) {
			throw new Error(
				"register --verify requires --adminKey or ADMIN_KEY env var",
			);
		}
		const verified = await client.verifyClaim(registered.claimCode, adminKey);
		verifiedAt = verified.verifiedAt;
	}

	console.log(
		JSON.stringify(
			{
				agentId: registered.agentId,
				name: registered.name,
				apiKey: registered.apiKey,
				claimCode: registered.claimCode,
				verifiedAt,
			},
			null,
			2,
		),
	);
};

const runMe = async (args: ArgMap) => {
	const baseUrl = asString(args.baseUrl) ?? "http://127.0.0.1:3000";
	const apiKey = asString(args.apiKey);
	if (!apiKey) {
		throw new Error("me requires --apiKey");
	}
	const client = createClient(baseUrl, apiKey);
	const me = await client.me();
	console.log(JSON.stringify(me, null, 2));
};

const runSingle = async (args: ArgMap) => {
	const baseUrl = asString(args.baseUrl) ?? "http://127.0.0.1:3000";
	const apiKey = asString(args.apiKey);
	if (!apiKey) {
		throw new Error("run requires --apiKey");
	}
	const transportArg = asString(args.transport);
	const transport = transportArg === "http" ? "http" : "ws";
	const client = createClient(baseUrl, apiKey);
	const result = await runMatch(client, {
		moveProvider: simpleMoveProvider,
		preferredTransport: transport,
		allowTransportFallback: true,
	});
	console.log(JSON.stringify(result, null, 2));
};

const runMany = async (args: ArgMap) => {
	const baseUrl = asString(args.baseUrl) ?? "http://127.0.0.1:3000";
	const count = asInt(args.count, 2);
	const matches = asInt(args.matches, 1);
	const prefix = asString(args.prefix) ?? "agent";
	const adminKey =
		asString(args.adminKey) ??
		(typeof process.env.ADMIN_KEY === "string"
			? process.env.ADMIN_KEY
			: undefined);

	if (!adminKey) {
		throw new Error("run-many requires --adminKey or ADMIN_KEY env var");
	}
	if (count < 2 || count % 2 !== 0) {
		throw new Error("run-many requires an even --count >= 2");
	}

	const bootstrapClient = createClient(baseUrl);
	const agents: Array<{ id: string; apiKey: string; name: string }> = [];
	for (let i = 0; i < count; i += 1) {
		const name = `${prefix}-${i + 1}`;
		const registered = await bootstrapClient.register(name);
		await bootstrapClient.verifyClaim(registered.claimCode, adminKey);
		agents.push({ id: registered.agentId, apiKey: registered.apiKey, name });
	}

	const summaries: unknown[] = [];
	for (let i = 0; i < matches; i += 1) {
		const iteration = i + 1;
		const iterationResults = await Promise.all(
			agents.map(async (agent) => {
				const client = createClient(baseUrl, agent.apiKey);
				const result = await runMatch(client, {
					moveProvider: simpleMoveProvider,
					preferredTransport: "ws",
					allowTransportFallback: true,
				});
				return {
					agentId: agent.id,
					agentName: agent.name,
					iteration,
					result,
				};
			}),
		);
		summaries.push(...iterationResults);
	}

	console.log(
		JSON.stringify({ agents: agents.length, matches, summaries }, null, 2),
	);
};

const main = async () => {
	const parsed = parseArgs(process.argv.slice(2));
	const command = parsed.command;
	if (!command) {
		usage();
		process.exit(1);
	}

	switch (command) {
		case "register":
			await runRegister(parsed.args);
			return;
		case "me":
			await runMe(parsed.args);
			return;
		case "run":
			await runSingle(parsed.args);
			return;
		case "run-many":
			await runMany(parsed.args);
			return;
		default:
			usage();
			throw new Error(`Unknown command: ${command}`);
	}
};

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
