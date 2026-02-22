import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	ArenaClient,
	type MoveProvider,
	type MoveProviderContext,
	type RunMatchResult,
	runMatch,
} from "@fightclaw/agent-client";
import type { Move } from "@fightclaw/engine";

type ArgMap = Record<string, string | boolean>;

type MoveSubmitEnvelope =
	| {
			ok: true;
			state: {
				stateVersion: number;
				status?: "active" | "ended";
				winnerAgentId?: string | null;
				endReason?: string;
			};
	  }
	| {
			ok: false;
			error: string;
			stateVersion?: number;
			forfeited?: boolean;
			matchStatus?: "ended";
			winnerAgentId?: string | null;
			reason?: string;
			reasonCode?: string;
	  };

type GatewayMoveResult = {
	move: Move;
	publicThought?: string;
};

class InternalRunnerClient extends ArenaClient {
	private readonly internalBaseUrl: string;

	constructor(
		baseUrl: string,
		agentApiKey: string,
		private readonly runnerKey: string,
		private readonly runnerId: string,
		private readonly actingAgentId: string,
	) {
		super({
			baseUrl,
			agentApiKey,
			requestIdProvider: () => randomUUID(),
		});
		this.internalBaseUrl = baseUrl.replace(/\/+$/, "");
	}

	async submitMove(
		matchId: string,
		payload: { moveId: string; expectedVersion: number; move: unknown },
	): Promise<MoveSubmitEnvelope> {
		const moveRecord =
			payload.move && typeof payload.move === "object"
				? (payload.move as Record<string, unknown>)
				: null;
		const publicThought =
			typeof moveRecord?.reasoning === "string"
				? moveRecord.reasoning
				: undefined;
		const res = await fetch(
			`${this.internalBaseUrl}/v1/internal/matches/${encodeURIComponent(matchId)}/move`,
			{
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-runner-key": this.runnerKey,
					"x-runner-id": this.runnerId,
					"x-agent-id": this.actingAgentId,
					"x-request-id": randomUUID(),
				},
				body: JSON.stringify({
					...payload,
					...(publicThought ? { publicThought } : {}),
				}),
			},
		);
		const body = (await res.json().catch(() => null)) as unknown;
		if (!body || typeof body !== "object") {
			throw new Error(`Invalid internal move response (${res.status}).`);
		}
		const envelope = body as Record<string, unknown>;
		if (envelope.ok === true) {
			return envelope as MoveSubmitEnvelope;
		}
		if (envelope.ok === false && typeof envelope.error === "string") {
			return envelope as MoveSubmitEnvelope;
		}
		throw new Error(`Unexpected internal move payload (${res.status}).`);
	}
}

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
			"Fightclaw OpenClaw Runner",
			"",
			"Commands:",
			"  duel --baseUrl <url> --adminKey <key> --runnerKey <key> --runnerId <id> --strategyA <text> --strategyB <text> [--nameA a] [--nameB b] [--gatewayCmd '<cmd>'] [--moveTimeoutMs 4000]",
		].join("\n"),
	);
};

const waitForMatchId = async (client: ArenaClient, initialMatchId: string) => {
	let matchId = initialMatchId;
	for (let i = 0; i < 120; i += 1) {
		const waited = await client.waitForMatch(5);
		for (const event of waited.events) {
			if (event.event === "match_found") {
				matchId = event.matchId;
				return matchId;
			}
		}
	}
	throw new Error("Timed out waiting for match assignment.");
};

const bindRunnerAgent = async (
	baseUrl: string,
	runnerKey: string,
	runnerId: string,
	agentId: string,
) => {
	const res = await fetch(`${baseUrl}/v1/internal/runners/agents/bind`, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"x-runner-key": runnerKey,
			"x-runner-id": runnerId,
			"x-request-id": randomUUID(),
		},
		body: JSON.stringify({ agentId }),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed binding runner->agent (${res.status}): ${body}`);
	}
};

const setStrategyPrompt = async (
	baseUrl: string,
	apiKey: string,
	privateStrategy: string,
) => {
	const res = await fetch(`${baseUrl}/v1/agents/me/strategy/hex_conquest`, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
			"x-request-id": randomUUID(),
		},
		body: JSON.stringify({
			privateStrategy,
			activate: true,
		}),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed setting strategy prompt (${res.status}): ${body}`);
	}
	return (await res.json()) as unknown;
};

const invokeGateway = async (
	command: string,
	input: {
		agentId: string;
		matchId: string;
		stateVersion: number;
		state: unknown;
	},
): Promise<GatewayMoveResult | null> => {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, {
			shell: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`Gateway command failed (${code}). ${stderr.trim() || "No stderr."}`,
					),
				);
				return;
			}
			try {
				const parsed = JSON.parse(stdout.trim()) as unknown;
				if (!parsed || typeof parsed !== "object") {
					resolve(null);
					return;
				}
				const record = parsed as Record<string, unknown>;
				if (!record.move || typeof record.move !== "object") {
					resolve(null);
					return;
				}
				resolve({
					move: record.move as Move,
					publicThought:
						typeof record.publicThought === "string"
							? record.publicThought
							: undefined,
				});
			} catch (error) {
				reject(error);
			}
		});
		child.stdin.write(JSON.stringify(input));
		child.stdin.end();
	});
};

const fallbackMove: Move = {
	action: "pass",
	reasoning: "Public-safe fallback: pass turn.",
};

const createMoveProvider = (
	client: ArenaClient,
	agentId: string,
	gatewayCmd?: string,
): MoveProvider => ({
	nextMove: async ({ matchId, stateVersion }: MoveProviderContext) => {
		const state = await client.getMatchState(matchId);
		if (gatewayCmd) {
			const gateway = await invokeGateway(gatewayCmd, {
				agentId,
				matchId,
				stateVersion,
				state,
			});
			if (gateway?.move) {
				const thought =
					typeof gateway.publicThought === "string"
						? gateway.publicThought
						: "Public-safe summary unavailable.";
				return {
					...gateway.move,
					reasoning: thought,
				};
			}
		}
		return fallbackMove;
	},
});

const runDuel = async (args: ArgMap) => {
	const baseUrl = asString(args.baseUrl) ?? "http://127.0.0.1:3000";
	const adminKey =
		asString(args.adminKey) ??
		(typeof process.env.ADMIN_KEY === "string"
			? process.env.ADMIN_KEY
			: undefined);
	const runnerKey =
		asString(args.runnerKey) ??
		(typeof process.env.INTERNAL_RUNNER_KEY === "string"
			? process.env.INTERNAL_RUNNER_KEY
			: undefined);
	const runnerId =
		asString(args.runnerId) ??
		(typeof process.env.INTERNAL_RUNNER_ID === "string"
			? process.env.INTERNAL_RUNNER_ID
			: undefined);
	const nameA = asString(args.nameA) ?? `openclaw-a-${Date.now()}`;
	const nameB = asString(args.nameB) ?? `openclaw-b-${Date.now()}`;
	const strategyA = asString(args.strategyA);
	const strategyB = asString(args.strategyB);
	const gatewayCmd = asString(args.gatewayCmd);
	const moveTimeoutMs = asInt(args.moveTimeoutMs, 4_000);

	if (!adminKey) throw new Error("--adminKey or ADMIN_KEY is required.");
	if (!runnerKey)
		throw new Error("--runnerKey or INTERNAL_RUNNER_KEY is required.");
	if (!runnerId)
		throw new Error("--runnerId or INTERNAL_RUNNER_ID is required.");
	if (!strategyA || !strategyB) {
		throw new Error("--strategyA and --strategyB are required.");
	}

	const bootstrap = new ArenaClient({
		baseUrl,
		requestIdProvider: () => randomUUID(),
	});

	const registeredA = await bootstrap.register(nameA);
	const registeredB = await bootstrap.register(nameB);
	await bootstrap.verifyClaim(registeredA.claimCode, adminKey);
	await bootstrap.verifyClaim(registeredB.claimCode, adminKey);

	await bindRunnerAgent(baseUrl, runnerKey, runnerId, registeredA.agentId);
	await bindRunnerAgent(baseUrl, runnerKey, runnerId, registeredB.agentId);

	await setStrategyPrompt(baseUrl, registeredA.apiKey, strategyA);
	await setStrategyPrompt(baseUrl, registeredB.apiKey, strategyB);

	const queueClientA = new ArenaClient({
		baseUrl,
		agentApiKey: registeredA.apiKey,
		requestIdProvider: () => randomUUID(),
	});
	const queueClientB = new ArenaClient({
		baseUrl,
		agentApiKey: registeredB.apiKey,
		requestIdProvider: () => randomUUID(),
	});

	const joinedA = await queueClientA.queueJoin();
	const joinedB = await queueClientB.queueJoin();
	const matchA =
		joinedA.status === "ready"
			? joinedA.matchId
			: await waitForMatchId(queueClientA, joinedA.matchId);
	const matchB =
		joinedB.status === "ready"
			? joinedB.matchId
			: await waitForMatchId(queueClientB, joinedB.matchId);
	if (matchA !== matchB) {
		throw new Error(`Agent queues diverged: ${matchA} vs ${matchB}`);
	}

	const runnerClientA = new InternalRunnerClient(
		baseUrl,
		registeredA.apiKey,
		runnerKey,
		runnerId,
		registeredA.agentId,
	);
	const runnerClientB = new InternalRunnerClient(
		baseUrl,
		registeredB.apiKey,
		runnerKey,
		runnerId,
		registeredB.agentId,
	);

	const moveProviderA = createMoveProvider(
		runnerClientA,
		registeredA.agentId,
		gatewayCmd,
	);
	const moveProviderB = createMoveProvider(
		runnerClientB,
		registeredB.agentId,
		gatewayCmd,
	);

	const [resultA, resultB]: [RunMatchResult, RunMatchResult] =
		await Promise.all([
			runMatch(runnerClientA, {
				moveProvider: moveProviderA,
				preferredTransport: "ws",
				allowTransportFallback: true,
				moveProviderTimeoutMs: moveTimeoutMs,
			}),
			runMatch(runnerClientB, {
				moveProvider: moveProviderB,
				preferredTransport: "ws",
				allowTransportFallback: true,
				moveProviderTimeoutMs: moveTimeoutMs,
			}),
		]);

	console.log(
		JSON.stringify(
			{
				matchId: matchA,
				runnerId,
				agents: [
					{ id: registeredA.agentId, name: nameA },
					{ id: registeredB.agentId, name: nameB },
				],
				results: [resultA, resultB],
			},
			null,
			2,
		),
	);
};

const main = async () => {
	const { command, args } = parseArgs(process.argv.slice(2));
	if (!command) {
		usage();
		process.exit(1);
	}
	if (command === "duel") {
		await runDuel(args);
		return;
	}
	usage();
	throw new Error(`Unknown command: ${command}`);
};

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
