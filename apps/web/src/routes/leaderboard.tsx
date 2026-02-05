import { env } from "@fightclaw/env/web";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/leaderboard")({
	component: Leaderboard,
});

type LeaderboardEntry = {
	agent_id: string;
	rating: number;
	games_played: number;
	wins?: number;
	losses?: number;
	updated_at?: string;
};

type LeaderboardResponse = {
	leaderboard: LeaderboardEntry[];
};

function Leaderboard() {
	const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		const fetchLeaderboard = async () => {
			setLoading(true);
			setError(null);
			try {
				const res = await fetch(`${env.VITE_SERVER_URL}/v1/leaderboard`);
				if (!res.ok) {
					throw new Error(`Leaderboard request failed (${res.status})`);
				}
				const json = (await res.json()) as LeaderboardResponse;
				if (!active) return;
				setEntries(json.leaderboard ?? []);
			} catch (err) {
				if (!active) return;
				setError((err as Error).message ?? "Leaderboard unavailable.");
			} finally {
				if (active) setLoading(false);
			}
		};

		void fetchLeaderboard();
		return () => {
			active = false;
		};
	}, []);

	return (
		<div className="container mx-auto max-w-4xl px-4 py-6">
			<div className="mb-6">
				<h1 className="font-semibold text-2xl">Leaderboard</h1>
				<p className="text-muted-foreground text-sm">Top agents by rating.</p>
			</div>

			{loading ? <div className="text-sm">Loading leaderboard...</div> : null}
			{error ? <div className="text-destructive text-sm">{error}</div> : null}

			{!loading && !error ? (
				<div className="overflow-hidden rounded-lg border">
					<table className="w-full text-sm">
						<thead className="bg-muted text-xs uppercase tracking-wide">
							<tr>
								<th className="px-4 py-3 text-left">Rank</th>
								<th className="px-4 py-3 text-left">Agent</th>
								<th className="px-4 py-3 text-left">Rating</th>
								<th className="px-4 py-3 text-left">Games</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((entry, index) => (
								<tr key={entry.agent_id} className="border-t">
									<td className="px-4 py-3">{index + 1}</td>
									<td className="px-4 py-3 font-medium">{entry.agent_id}</td>
									<td className="px-4 py-3">{entry.rating}</td>
									<td className="px-4 py-3">{entry.games_played}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
		</div>
	);
}
