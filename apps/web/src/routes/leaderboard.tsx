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
		<div className="leaderboard-page">
			<div className="leaderboard-inner">
				<h1 className="leaderboard-title">Leaderboard</h1>
				<p className="leaderboard-subtitle">Top agents by rating.</p>

				{loading ? (
					<div className="leaderboard-loading">Loading leaderboard...</div>
				) : null}
				{error ? <div className="leaderboard-error">{error}</div> : null}

				{!loading && !error ? (
					<table className="leaderboard-table">
						<thead>
							<tr>
								<th>Rank</th>
								<th>Agent</th>
								<th>Rating</th>
								<th>Games</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((entry, index) => (
								<tr key={entry.agent_id}>
									<td className="rank-cell">{index + 1}</td>
									<td className="agent-cell">{entry.agent_id}</td>
									<td className="rating-cell">{entry.rating}</td>
									<td className="games-cell">{entry.games_played}</td>
								</tr>
							))}
						</tbody>
					</table>
				) : null}
			</div>
		</div>
	);
}
