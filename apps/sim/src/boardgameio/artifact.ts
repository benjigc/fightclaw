import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
	HarnessConfig,
	MatchArtifact,
	TurnArtifact,
	TurnMetricsV2,
	TurnPlanMeta,
} from "./types";

const DEFAULT_PROMPT_CAP_BYTES = 50 * 1024;
const DEFAULT_OUTPUT_CAP_BYTES = 50 * 1024;
const SOFT_ARTIFACT_CAP_BYTES = 5 * 1024 * 1024;

const SECRET_ENV_DENY_LIST = [
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"LLM_API_KEY",
	"API_KEY_PEPPER",
	"ANTHROPIC_API_KEY",
];

export class ArtifactBuilder {
	private artifact: MatchArtifact;
	private promptBytes = 0;
	private outputBytes = 0;
	private redactionApplied = false;

	constructor(config: HarnessConfig) {
		const simPackagePath = resolvePackagePath([
			"package.json",
			"apps/sim/package.json",
		]);
		const enginePackagePath = resolvePackagePath([
			"../../packages/engine/package.json",
			"packages/engine/package.json",
		]);
		const simPackage = JSON.parse(readFileSync(simPackagePath, "utf-8")) as {
			version?: string;
		};
		const enginePackage = JSON.parse(
			readFileSync(enginePackagePath, "utf-8"),
		) as { version?: string };

		this.artifact = {
			artifactVersion: 1,
			hashAlgo: "sha256",
			stateHashInput: "stable-json-sorted-keys-v1",
			engineRulesVersion: enginePackage.version ?? "0.0.0",
			simHarnessVersion: `sim-${simPackage.version ?? "0.0.0"}`,
			redactionApplied: false,
			seed: config.seed,
			scenario: config.scenario,
			engineConfig: config.engineConfig,
			boardColumns: config.engineConfig?.boardColumns ?? 21,
			participants: config.players,
			invalidPolicy: config.invalidPolicy,
			acceptedMoves: [],
			turns: [],
			result: {
				winner: null,
				reason: "maxTurns",
				turns: 0,
				illegalMoves: 0,
			},
			finalStateHash: "",
			bgioLog: null,
		};
	}

	startTurn(meta: TurnPlanMeta, playerID: string): number {
		const prompt = this.prepareText(meta.prompt, DEFAULT_PROMPT_CAP_BYTES);
		const rawOutput = this.prepareText(
			meta.rawOutput,
			DEFAULT_OUTPUT_CAP_BYTES,
		);
		this.promptBytes += Buffer.byteLength(prompt.value, "utf8");
		this.outputBytes += Buffer.byteLength(rawOutput.value, "utf8");

		const turn: TurnArtifact = {
			turnIndex: meta.turnIndex,
			playerID,
			promptHash: sha256(prompt.value),
			outputHash: sha256(rawOutput.value),
			commandAttempts: [],
			model: meta.model,
		};

		if (prompt.value.length > 0) {
			turn.prompt = prompt.value;
		}
		if (rawOutput.value.length > 0) {
			turn.rawOutput = rawOutput.value;
		}
		this.artifact.turns.push(turn);
		return this.artifact.turns.length - 1;
	}

	recordCommandAttempt(
		turnIdx: number,
		attempt: TurnArtifact["commandAttempts"][0],
	) {
		this.artifact.turns[turnIdx]?.commandAttempts.push(attempt);
	}

	getTurnCommandAttempts(turnIdx: number): TurnArtifact["commandAttempts"] {
		return this.artifact.turns[turnIdx]?.commandAttempts ?? [];
	}

	setTurnMetrics(turnIdx: number, metrics: TurnMetricsV2) {
		const turn = this.artifact.turns[turnIdx];
		if (!turn) return;
		turn.metricsV2 = metrics;
	}

	setTurnExplainability(
		turnIdx: number,
		explainability: Partial<
			Pick<
				TurnArtifact,
				"declaredPlan" | "powerSpikeTriggered" | "swingEvent" | "whyThisMove"
			>
		>,
	) {
		const turn = this.artifact.turns[turnIdx];
		if (!turn) return;
		if (explainability.declaredPlan !== undefined) {
			turn.declaredPlan = explainability.declaredPlan;
		}
		if (explainability.powerSpikeTriggered !== undefined) {
			turn.powerSpikeTriggered = explainability.powerSpikeTriggered;
		}
		if (explainability.swingEvent !== undefined) {
			turn.swingEvent = explainability.swingEvent;
		}
		if (explainability.whyThisMove !== undefined) {
			turn.whyThisMove = explainability.whyThisMove;
		}
	}

	recordAcceptedMove(entry: MatchArtifact["acceptedMoves"][0]) {
		this.artifact.acceptedMoves.push(entry);
	}

	setResult(result: MatchArtifact["result"], finalStateHash: string) {
		this.artifact.result = result;
		this.artifact.finalStateHash = finalStateHash;
	}

	setBoardgameLog(log: unknown[] | null) {
		this.artifact.bgioLog = log;
	}

	write(outputDir = "out/boardgameio"): string {
		this.artifact.redactionApplied = this.redactionApplied;
		if (this.promptBytes > 0 || this.outputBytes > 0) {
			this.artifact.truncated = {
				promptBytes: this.promptBytes,
				outputBytes: this.outputBytes,
			};
		}
		mkdirSync(outputDir, { recursive: true });
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const file = path.join(outputDir, `match-${this.artifact.seed}-${ts}.json`);
		const payload = stableStringify(this.artifact, 2);
		if (Buffer.byteLength(payload, "utf8") <= SOFT_ARTIFACT_CAP_BYTES) {
			writeFileSync(file, payload);
			return file;
		}
		// Soft cap: keep deterministic replay fields, drop full texts.
		for (const turn of this.artifact.turns) {
			delete turn.prompt;
			delete turn.rawOutput;
		}
		const truncatedPayload = stableStringify(this.artifact, 2);
		writeFileSync(file, truncatedPayload);
		return file;
	}

	private prepareText(
		value: string | undefined,
		capBytes: number,
	): {
		value: string;
	} {
		if (!value) {
			return { value: "" };
		}
		const text = redactSecrets(value);
		if (text !== value) {
			this.redactionApplied = true;
		}
		const byteLen = Buffer.byteLength(text, "utf8");
		if (byteLen <= capBytes) {
			return { value: text };
		}
		const chars: string[] = [];
		let usedBytes = 0;
		for (const char of text) {
			const charBytes = Buffer.byteLength(char, "utf8");
			if (usedBytes + charBytes > capBytes) break;
			chars.push(char);
			usedBytes += charBytes;
		}
		const truncated = chars.join("");
		return { value: `${truncated}\n[TRUNCATED]` };
	}
}

function resolvePackagePath(candidates: string[]): string {
	for (const candidate of candidates) {
		const absolute = path.resolve(candidate);
		if (existsSync(absolute)) {
			return absolute;
		}
	}
	throw new Error(
		`Unable to resolve package path from candidates: ${candidates.join(", ")}`,
	);
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown, spacing = 0): string {
	return JSON.stringify(sortKeys(value), null, spacing);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sortKeys(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	const input = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		out[key] = sortKeys(input[key]);
	}
	return out;
}

export function redactSecrets(input: string): string {
	let output = input;

	output = output.replace(
		/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+/gi,
		"Authorization: Bearer [REDACTED]",
	);
	output = output.replace(
		/\b(sk-[A-Za-z0-9_-]{12,}|arena_sk_[A-Za-z0-9_-]{8,})\b/g,
		"[REDACTED_KEY]",
	);

	for (const envName of SECRET_ENV_DENY_LIST) {
		const value = process.env[envName];
		if (value && value.length > 0) {
			output = output.split(value).join("[REDACTED_ENV]");
		}
	}

	return output;
}
