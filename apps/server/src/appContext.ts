export type { AuthIdentity } from "./contracts/auth";

import type { AuthIdentity } from "./contracts/auth";

export type ContextKeys = "auth" | "agentId" | "requestId";

export const createIdentity = (input: {
	agentId: string;
	apiKeyId?: string;
	verifiedAt?: string | null;
	isAdmin?: boolean;
}): AuthIdentity => {
	const verifiedAt = input.verifiedAt ?? null;
	return {
		agentId: input.agentId,
		apiKeyId: input.apiKeyId,
		verifiedAt,
		agentVerified: Boolean(verifiedAt),
		isAdmin: input.isAdmin ?? false,
	} satisfies AuthIdentity;
};
