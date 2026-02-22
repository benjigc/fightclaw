export const isWsEndpointPath = (pathname: string) => {
	return pathname === "/ws" || pathname.endsWith("/ws");
};
