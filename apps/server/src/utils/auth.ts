export const parseBearerToken = (authorization?: string): string | null => {
	if (!authorization) return null;
	const [scheme, token] = authorization.split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !token) return null;
	return token.trim();
};
