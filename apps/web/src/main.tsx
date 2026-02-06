import * as Sentry from "@sentry/react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";

// Initialize Sentry
const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
	const environment = import.meta.env.VITE_SENTRY_ENVIRONMENT ?? "development";
	const isProduction = environment === "production";
	Sentry.init({
		dsn,
		environment,
		release: import.meta.env.VITE_SENTRY_RELEASE,
		integrations: [Sentry.browserTracingIntegration()],
		tracesSampleRate: isProduction ? 0.05 : 1.0,
		tracePropagationTargets: ["localhost", "api.fightclaw.com"],
	});
}

const router = createRouter({
	routeTree,
	defaultPreload: "intent",
	defaultPendingComponent: () => <Loader />,
	context: {},
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

const rootElement = document.getElementById("app");

if (!rootElement) {
	throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(
		<Sentry.ErrorBoundary fallback={<div>Something went wrong</div>}>
			<RouterProvider router={router} />
		</Sentry.ErrorBoundary>,
	);
}
