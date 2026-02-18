import {
	createRootRouteWithContext,
	HeadContent,
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

function RootComponent() {
	return (
		<>
			<HeadContent />
			<div className="dark h-svh overflow-hidden bg-[#050b10]">
				<Outlet />
			</div>
			<Toaster richColors theme="dark" />
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
