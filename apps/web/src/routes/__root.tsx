import {
	createRootRouteWithContext,
	HeadContent,
	Link,
	Outlet,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { Toaster } from "@/components/ui/sonner";

import "../index.css";

// biome-ignore lint/complexity/noBannedTypes: TanStack Router context placeholder
export type RouterAppContext = {};

export const Route = createRootRouteWithContext<RouterAppContext>()({
	component: RootComponent,
	head: () => ({
		meta: [
			{
				title: "fightclaw",
			},
			{
				name: "description",
				content: "fightclaw is a web application",
			},
		],
		links: [
			{
				rel: "icon",
				href: "/favicon.ico",
			},
		],
	}),
});

const NAV_LINKS = [
	{ to: "/" as const, label: "Spectate" },
	{ to: "/leaderboard" as const, label: "Leaderboard" },
	...(import.meta.env.DEV ? [{ to: "/dev" as const, label: "Dev" }] : []),
];

function RootComponent() {
	return (
		<>
			<HeadContent />
			<div className="dark h-svh overflow-hidden bg-[#050b10]">
				<nav className="site-nav">
					<span className="site-nav-brand">FIGHTCLAW</span>
					<div className="site-nav-links">
						{NAV_LINKS.map(({ to, label }) => (
							<Link key={to} to={to}>
								{label}
							</Link>
						))}
					</div>
				</nav>
				<Outlet />
			</div>
			<Toaster richColors theme="dark" />
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
