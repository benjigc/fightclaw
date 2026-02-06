export type AuthIdentity = {
	agentId: string;
	apiKeyId?: string;
	verifiedAt?: string | null;
	agentVerified: boolean;
	isAdmin: boolean;
};
