import { MoveSchema } from "@fightclaw/engine";
import { z } from "zod";

export const queueJoinSchema = z
	.object({
		type: z.literal("queue_join"),
		mode: z.literal("ranked"),
	})
	.strict();

export const queueLeaveSchema = z
	.object({
		type: z.literal("queue_leave"),
	})
	.strict();

export const pingSchema = z
	.object({
		type: z.literal("ping"),
		t: z.number().int().optional(),
	})
	.strict();

export const moveSubmitSchema = z
	.object({
		type: z.literal("move_submit"),
		matchId: z.string().uuid(),
		moveId: z.string().uuid(),
		expectedVersion: z.number().int(),
		move: MoveSchema,
	})
	.strict();

export const agentWsInboundSchema = z.discriminatedUnion("type", [
	queueJoinSchema,
	queueLeaveSchema,
	pingSchema,
	moveSubmitSchema,
]);

export const helloOkSchema = z
	.object({
		type: z.literal("hello_ok"),
		agentId: z.string().uuid(),
	})
	.strict();

export const queueStatusSchema = z
	.object({
		type: z.literal("queue_status"),
		status: z.enum(["queued", "matched", "idle"]),
		matchId: z.string().uuid().optional(),
		opponentAgentId: z.string().uuid().optional(),
	})
	.strict();

export const matchFoundSchema = z
	.object({
		type: z.literal("match_found"),
		matchId: z.string().uuid(),
		opponentAgentId: z.string().uuid(),
		wsPath: z.string(),
	})
	.strict();

export const yourTurnSchema = z
	.object({
		type: z.literal("your_turn"),
		matchId: z.string().uuid(),
		stateVersion: z.number().int(),
	})
	.strict();

export const stateSchema = z
	.object({
		type: z.literal("state"),
		matchId: z.string().uuid(),
		stateVersion: z.number().int(),
		stateSnapshot: z.unknown(),
	})
	.strict();

export const moveResultSchema = z
	.object({
		type: z.literal("move_result"),
		accepted: z.boolean(),
		reason: z.string().optional(),
		newStateVersion: z.number().int().optional(),
		stateSnapshot: z.unknown().optional(),
	})
	.strict();

export const matchEndedSchema = z
	.object({
		type: z.literal("match_ended"),
		matchId: z.string().uuid(),
		winnerAgentId: z.string().uuid().nullable().optional(),
		endReason: z.string().optional(),
		finalStateVersion: z.number().int(),
	})
	.strict();

export const wsErrorSchema = z
	.object({
		type: z.literal("error"),
		error: z.string(),
	})
	.strict();

export const agentWsOutboundSchema = z.discriminatedUnion("type", [
	helloOkSchema,
	queueStatusSchema,
	matchFoundSchema,
	yourTurnSchema,
	stateSchema,
	moveResultSchema,
	matchEndedSchema,
	wsErrorSchema,
]);

export type AgentWsInbound = z.infer<typeof agentWsInboundSchema>;
export type AgentWsOutbound = z.infer<typeof agentWsOutboundSchema>;
