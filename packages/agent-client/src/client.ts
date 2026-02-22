import { type SpectatorEvent, SpectatorEventSchema } from "@fightclaw/engine";
import { z } from "zod";
import { ArenaHttpError, asErrorEnvelope, isRecord } from "./errors";
import { createRouteResolver } from "./routes";
import type {
	ArenaClientOptions,
	ClientLogEvent,
	MatchStateResponse,
	MeResponse,
	MoveSubmitResponse,
	QueueJoinResponse,
	QueueStatusResponse,
	QueueWaitResponse,
	RegisterResponse,
	VerifyResponse,
} from "./types";

const registerSchema = z
	.object({
		agent: z.object({
			id: z.string(),
			name: z.string(),
			verified: z.boolean().optional(),
		}),
		apiKey: z.string(),
		claimCode: z.string(),
		apiKeyId: z.string().optional(),
		apiKeyPrefix: z.string().optional(),
	})
	.passthrough();

const meSchema = z
	.object({
		agent: z.object({
			id: z.string(),
			name: z.string(),
			verified: z.boolean(),
			verifiedAt: z.string().nullable().optional(),
			createdAt: z.string().optional(),
			apiKeyId: z.string().nullable().optional(),
		}),
	})
	.passthrough();

const queueJoinSchema = z
	.object({
		status: z.enum(["waiting", "ready"]),
		matchId: z.string(),
		opponentId: z.string().optional(),
	})
	.passthrough();

const queueStatusSchema = z
	.object({
		status: z.enum(["idle", "waiting", "ready"]),
		matchId: z.string().optional(),
		opponentId: z.string().optional(),
	})
	.passthrough();

const moveSubmitSchema = z.union([
	z.object({
		ok: z.literal(true),
		state: z.object({
			stateVersion: z.number().int(),
			status: z.enum(["active", "ended"]).optional(),
			winnerAgentId: z.string().nullable().optional(),
			endReason: z.string().optional(),
			game: z
				.object({
					activePlayer: z.string().optional(),
					players: z
						.record(
							z.string(),
							z.object({ id: z.string().optional() }).passthrough(),
						)
						.optional(),
				})
				.passthrough()
				.optional(),
		}),
	}),
	z.object({
		ok: z.literal(false),
		error: z.string(),
		stateVersion: z.number().int().optional(),
		forfeited: z.boolean().optional(),
		matchStatus: z.literal("ended").optional(),
		winnerAgentId: z.string().nullable().optional(),
		reason: z.string().optional(),
		reasonCode: z.string().optional(),
	}),
]);

const matchStateSchema = z
	.object({
		state: z
			.object({
				stateVersion: z.number().int(),
				status: z.enum(["active", "ended"]),
				winnerAgentId: z.string().nullable().optional(),
				loserAgentId: z.string().nullable().optional(),
				endReason: z.string().optional(),
				game: z
					.object({
						activePlayer: z.string().optional(),
						players: z
							.record(
								z.string(),
								z.object({ id: z.string().optional() }).passthrough(),
							)
							.optional(),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.nullable(),
	})
	.passthrough();

const queueWaitSchema = z
	.object({
		events: z.array(z.unknown()),
	})
	.passthrough();

type RequestOptions = {
	method?: "GET" | "POST" | "DELETE";
	body?: unknown;
	headers?: Record<string, string>;
	auth?: "agent" | "none";
};

const trimSlash = (value: string) => value.replace(/\/+$/, "");

export class ArenaClient {
	private readonly baseUrl: string;
	private agentApiKey: string | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly resolveRoutePath: ReturnType<typeof createRouteResolver>;
	private readonly requestIdProvider?: () => string;
	private readonly onLog?: (event: ClientLogEvent) => void;

	constructor(options: ArenaClientOptions) {
		this.baseUrl = trimSlash(options.baseUrl);
		this.agentApiKey = options.agentApiKey;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.resolveRoutePath = createRouteResolver(options.routeOverrides);
		this.requestIdProvider = options.requestIdProvider;
		this.onLog = options.onLog;
	}

	setAgentApiKey(apiKey: string) {
		this.agentApiKey = apiKey;
	}

	getBaseUrl() {
		return this.baseUrl;
	}

	getAgentApiKey() {
		return this.agentApiKey;
	}

	resolveRoute(
		key: Parameters<typeof this.resolveRoutePath>[0],
		params?: Parameters<typeof this.resolveRoutePath>[1],
	) {
		return this.resolveRoutePath(key, params);
	}

	buildAgentAuthHeaders(apiKeyOverride?: string): Record<string, string> {
		const token = apiKeyOverride ?? this.agentApiKey;
		if (!token) return {};
		return { authorization: `Bearer ${token}` };
	}

	private log(event: ClientLogEvent) {
		this.onLog?.(event);
	}

	private async requestJson<T>(
		path: string,
		options?: RequestOptions,
	): Promise<T> {
		const method = options?.method ?? "GET";
		const headers: Record<string, string> = {
			accept: "application/json",
			...(options?.headers ?? {}),
		};
		if (options?.auth !== "none") {
			Object.assign(headers, this.buildAgentAuthHeaders());
		}
		if (options?.body !== undefined) {
			headers["content-type"] = "application/json";
		}
		const requestId = this.requestIdProvider?.();
		if (requestId) headers["x-request-id"] = requestId;

		const url = `${this.baseUrl}${path}`;
		this.log({
			type: "request",
			message: "http_request",
			details: { method, path, requestId: requestId ?? null },
		});

		const response = await this.fetchImpl(url, {
			method,
			headers,
			body:
				options?.body === undefined ? undefined : JSON.stringify(options.body),
		});

		const isJson = (response.headers.get("content-type") ?? "")
			.toLowerCase()
			.includes("application/json");
		const body: unknown = isJson
			? await response.json().catch(() => null)
			: null;

		this.log({
			type: "response",
			message: "http_response",
			details: {
				method,
				path,
				status: response.status,
				ok: response.ok,
				requestId:
					(typeof body === "object" &&
					body !== null &&
					"requestId" in body &&
					typeof (body as { requestId?: unknown }).requestId === "string"
						? (body as { requestId: string }).requestId
						: requestId) ?? null,
			},
		});

		if (!response.ok) {
			const envelope = asErrorEnvelope(body);
			throw new ArenaHttpError(
				response.status,
				envelope?.error ?? `HTTP ${response.status}`,
				envelope,
			);
		}

		return body as T;
	}

	async register(name: string): Promise<RegisterResponse> {
		const payload = await this.requestJson<unknown>(
			this.resolveRoute("auth_register"),
			{
				method: "POST",
				body: { name },
				auth: "none",
			},
		);
		const parsed = registerSchema.parse(payload);
		return {
			agentId: parsed.agent.id,
			name: parsed.agent.name,
			verified: Boolean(parsed.agent.verified),
			apiKey: parsed.apiKey,
			claimCode: parsed.claimCode,
			apiKeyId: parsed.apiKeyId ?? null,
			apiKeyPrefix: parsed.apiKeyPrefix ?? null,
		};
	}

	async verifyClaim(
		claimCode: string,
		adminKey: string,
	): Promise<VerifyResponse> {
		const payload = await this.requestJson<unknown>(
			this.resolveRoute("auth_verify"),
			{
				method: "POST",
				body: { claimCode },
				headers: {
					"x-admin-key": adminKey,
				},
				auth: "none",
			},
		);
		if (!isRecord(payload)) {
			throw new Error("Invalid verify response.");
		}
		const agentId = payload.agentId;
		if (typeof agentId !== "string") {
			throw new Error("Verify response missing agentId.");
		}
		const verifiedAt =
			typeof payload.verifiedAt === "string" || payload.verifiedAt === null
				? payload.verifiedAt
				: null;
		return { agentId, verifiedAt };
	}

	async me(): Promise<MeResponse> {
		const payload = await this.requestJson<unknown>(
			this.resolveRoute("auth_me"),
			{
				auth: "agent",
			},
		);
		const parsed = meSchema.parse(payload);
		return {
			agentId: parsed.agent.id,
			name: parsed.agent.name,
			verified: parsed.agent.verified,
			verifiedAt: parsed.agent.verifiedAt ?? null,
			createdAt: parsed.agent.createdAt ?? null,
			apiKeyId: parsed.agent.apiKeyId ?? null,
		};
	}

	async queueJoin(): Promise<QueueJoinResponse> {
		const payload = await this.requestJson<unknown>(
			this.resolveRoute("queue_join"),
			{
				method: "POST",
				body: { mode: "ranked" },
				auth: "agent",
			},
		);
		const parsed = queueJoinSchema.parse(payload);
		return {
			status: parsed.status,
			matchId: parsed.matchId,
			opponentId: parsed.opponentId,
		};
	}

	async queueStatus(): Promise<QueueStatusResponse> {
		const payload = await this.requestJson<unknown>(
			this.resolveRoute("queue_status"),
			{
				auth: "agent",
			},
		);
		const parsed = queueStatusSchema.parse(payload);
		if (parsed.status === "idle") return { status: "idle" };
		if (parsed.status === "waiting") {
			if (!parsed.matchId) {
				throw new Error("Queue status response missing matchId.");
			}
			return { status: "waiting", matchId: parsed.matchId };
		}
		if (!parsed.matchId || !parsed.opponentId) {
			throw new Error("Queue ready response missing matchId/opponentId.");
		}
		return {
			status: "ready",
			matchId: parsed.matchId,
			opponentId: parsed.opponentId,
		};
	}

	async queueLeave(): Promise<void> {
		await this.requestJson<unknown>(this.resolveRoute("queue_leave"), {
			method: "DELETE",
			auth: "agent",
		});
	}

	async waitForMatch(timeoutSeconds = 30): Promise<QueueWaitResponse> {
		const path = `${this.resolveRoute("events_wait")}?timeout=${encodeURIComponent(String(timeoutSeconds))}`;
		const payload = await this.requestJson<unknown>(path, {
			auth: "agent",
		});
		const parsed = queueWaitSchema.parse(payload);
		const events: SpectatorEvent[] = [];
		for (const raw of parsed.events) {
			const event = SpectatorEventSchema.safeParse(raw);
			if (event.success) events.push(event.data);
		}
		return { events };
	}

	async submitMove(
		matchId: string,
		payload: {
			moveId: string;
			expectedVersion: number;
			move: unknown;
		},
	): Promise<MoveSubmitResponse> {
		try {
			const response = await this.requestJson<unknown>(
				this.resolveRoute("match_move", { matchId }),
				{
					method: "POST",
					body: payload,
					auth: "agent",
				},
			);
			return moveSubmitSchema.parse(response);
		} catch (error) {
			// Move submission intentionally uses structured non-2xx gameplay envelopes
			// (e.g., version mismatch, invalid move, forfeit). Preserve those as typed
			// MoveSubmitResponse values instead of raising transport exceptions.
			if (error instanceof ArenaHttpError && error.envelope) {
				const parsed = moveSubmitSchema.safeParse(error.envelope);
				if (parsed.success) {
					return parsed.data;
				}
			}
			throw error;
		}
	}

	async getMatchState(matchId: string): Promise<MatchStateResponse> {
		const response = await this.requestJson<unknown>(
			this.resolveRoute("match_state", { matchId }),
			{
				auth: "agent",
			},
		);
		const parsed = matchStateSchema.parse(response);
		return parsed as MatchStateResponse;
	}

	async subscribeMatchStream(
		matchId: string,
		handler: (event: SpectatorEvent) => Promise<void> | void,
	): Promise<() => void> {
		const path = this.resolveRoute("match_stream", { matchId });
		const headers: Record<string, string> = {
			accept: "text/event-stream",
			...this.buildAgentAuthHeaders(),
		};
		const requestId = this.requestIdProvider?.();
		if (requestId) headers["x-request-id"] = requestId;

		const abortController = new AbortController();
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method: "GET",
			headers,
			signal: abortController.signal,
		});
		if (!response.ok) {
			const body = await response
				.clone()
				.json()
				.catch(() => null);
			const envelope = asErrorEnvelope(body);
			throw new ArenaHttpError(
				response.status,
				envelope?.error ?? `HTTP ${response.status}`,
				envelope,
			);
		}
		if (!response.body) {
			throw new Error("Match stream response body is not readable.");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let closed = false;
		const closeStream = async () => {
			if (closed) return;
			closed = true;
			abortController.abort();
			try {
				await reader.cancel();
			} catch {
				// Reader can already be closed/cancelled.
			}
		};

		const pump = async () => {
			try {
				while (!closed) {
					const next = await reader.read();
					if (next.done) break;
					buffer += decoder.decode(next.value, { stream: true });
					while (true) {
						const boundary = buffer.indexOf("\n\n");
						if (boundary === -1) break;
						const frame = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						const parsed = this.parseSseFrame(frame);
						if (!parsed) continue;
						const event = SpectatorEventSchema.safeParse(parsed);
						if (event.success) await handler(event.data);
					}
				}
			} catch (error) {
				if (!closed) {
					const message =
						error instanceof Error ? error.message : String(error);
					this.log({
						type: "runner",
						message: "match_stream_pump_error",
						details: {
							matchId,
							error: message,
						},
					});
					console.error(
						`[ArenaClient] Match stream pump failed (${matchId}): ${message}`,
					);
				}
			} finally {
				await closeStream();
			}
		};

		void pump();

		return () => {
			void closeStream();
		};
	}

	private parseSseFrame(frame: string): unknown | null {
		const lines = frame.split("\n");
		const dataLines: string[] = [];
		for (const line of lines) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trimStart());
			}
		}
		if (dataLines.length === 0) return null;
		try {
			return JSON.parse(dataLines.join("\n"));
		} catch {
			return null;
		}
	}
}
