import * as fs from "node:fs";
import type { Anomaly, WinRateStats } from "../simulation/config";
import { escapeHtml, formatTurnWithPrefix } from "./htmlUtils.js";

export interface DashboardData {
	summary: {
		totalGames: number;
		completedGames: number;
		draws: number;
		avgTurns: number;
		totalAnomalies: number;
	};
	winRates: Record<string, WinRateStats>;
	strategyDistribution: Record<string, number>;
	anomalies: Anomaly[];
	matchLengths: {
		min: number;
		max: number;
		mean: number;
		median: number;
		p25: number;
		p75: number;
		p95: number;
	};
	timeline?: {
		matchesAnalyzed: number;
		openingChoice: Array<{
			label: string;
			count: number;
			rate: number;
		}>;
		firstCommitment: {
			meanTurn: number | null;
			medianTurn: number | null;
			samples: number;
		};
		powerSpikeTurns: Array<{
			turn: number;
			count: number;
			rate: number;
		}>;
		decisiveSwing: {
			meanTurn: number | null;
			medianTurn: number | null;
			samples: number;
		};
	};
	archetypeClassifier?: {
		matchesAnalyzed: number;
		primaryArchetype: string | null;
		averageConfidence: number;
		distribution: Array<{
			archetype: string;
			count: number;
			rate: number;
		}>;
		sampleMatches: Array<{
			seed: number | null;
			winner: string | null;
			archetype: string;
			confidence: number;
		}>;
	};
}

export class DashboardGenerator {
	generate(data: DashboardData, outputPath: string): void {
		const html = this.generateHTML(data);
		fs.writeFileSync(outputPath, html, "utf-8");
	}

	private generateHTML(data: DashboardData): string {
		const serializedData = stringifyForInlineScript(data);
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Simulation Dashboard</title>
	<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
	<style>
		:root {
			--bg-primary: #ffffff;
			--bg-secondary: #f5f5f5;
			--bg-card: #ffffff;
			--text-primary: #1a1a1a;
			--text-secondary: #666666;
			--border-color: #e0e0e0;
			--accent-primary: #3b82f6;
			--accent-secondary: #10b981;
			--accent-warning: #f59e0b;
			--accent-danger: #ef4444;
		}

		[data-theme="dark"] {
			--bg-primary: #0f0f0f;
			--bg-secondary: #1a1a1a;
			--bg-card: #242424;
			--text-primary: #ffffff;
			--text-secondary: #a0a0a0;
			--border-color: #333333;
			--accent-primary: #60a5fa;
			--accent-secondary: #34d399;
			--accent-warning: #fbbf24;
			--accent-danger: #f87171;
		}

		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			background: var(--bg-primary);
			color: var(--text-primary);
			line-height: 1.6;
			transition: background 0.3s, color 0.3s;
		}

		.container {
			max-width: 1400px;
			margin: 0 auto;
			padding: 2rem;
		}

		header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 2rem;
			padding-bottom: 1rem;
			border-bottom: 1px solid var(--border-color);
		}

		h1 {
			font-size: 2rem;
			font-weight: 700;
		}

		.controls {
			display: flex;
			gap: 1rem;
			align-items: center;
		}

		button {
			padding: 0.5rem 1rem;
			border: 1px solid var(--border-color);
			background: var(--bg-card);
			color: var(--text-primary);
			border-radius: 0.375rem;
			cursor: pointer;
			font-size: 0.875rem;
			transition: all 0.2s;
		}

		button:hover {
			background: var(--bg-secondary);
		}

		.stats-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
			gap: 1.5rem;
			margin-bottom: 2rem;
		}

		.stat-card {
			background: var(--bg-card);
			border: 1px solid var(--border-color);
			border-radius: 0.5rem;
			padding: 1.5rem;
			transition: transform 0.2s, box-shadow 0.2s;
		}

		.stat-card:hover {
			transform: translateY(-2px);
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
		}

		.stat-label {
			font-size: 0.875rem;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-bottom: 0.5rem;
		}

		.stat-value {
			font-size: 2.5rem;
			font-weight: 700;
			color: var(--accent-primary);
		}

		.stat-subtitle {
			font-size: 0.875rem;
			color: var(--text-secondary);
			margin-top: 0.25rem;
		}

		.charts-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
			gap: 1.5rem;
			margin-bottom: 2rem;
		}

		.chart-card {
			background: var(--bg-card);
			border: 1px solid var(--border-color);
			border-radius: 0.5rem;
			padding: 1.5rem;
		}

		.chart-title {
			font-size: 1.125rem;
			font-weight: 600;
			margin-bottom: 1rem;
		}

		.chart-container {
			position: relative;
			height: 300px;
		}

		.anomaly-list {
			background: var(--bg-card);
			border: 1px solid var(--border-color);
			border-radius: 0.5rem;
			padding: 1.5rem;
			max-height: 400px;
			overflow-y: auto;
		}

		.anomaly-item {
			padding: 1rem;
			border-bottom: 1px solid var(--border-color);
			display: flex;
			align-items: flex-start;
			gap: 1rem;
		}

		.anomaly-item:last-child {
			border-bottom: none;
		}

		.anomaly-severity {
			padding: 0.25rem 0.5rem;
			border-radius: 0.25rem;
			font-size: 0.75rem;
			font-weight: 600;
			text-transform: uppercase;
		}

		.severity-info {
			background: var(--accent-primary);
			color: white;
		}

		.severity-warn {
			background: var(--accent-warning);
			color: white;
		}

		.severity-critical {
			background: var(--accent-danger);
			color: white;
		}

		.anomaly-content {
			flex: 1;
		}

		.anomaly-type {
			font-weight: 600;
			margin-bottom: 0.25rem;
		}

		.anomaly-desc {
			font-size: 0.875rem;
			color: var(--text-secondary);
		}

		.empty-state {
			text-align: center;
			padding: 3rem;
			color: var(--text-secondary);
		}

		.insight-list {
			display: grid;
			gap: 0.75rem;
		}

		.insight-row {
			padding: 0.75rem;
			border: 1px solid var(--border-color);
			border-radius: 0.375rem;
			font-size: 0.9rem;
		}

		.insight-key {
			font-weight: 600;
			margin-right: 0.35rem;
		}

		@media (max-width: 768px) {
			.container {
				padding: 1rem;
			}

			.charts-grid {
				grid-template-columns: 1fr;
			}

			header {
				flex-direction: column;
				gap: 1rem;
				align-items: flex-start;
			}
		}
	</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>Simulation Dashboard</h1>
			<div class="controls">
				<button onclick="toggleTheme()">Toggle Theme</button>
				<button onclick="exportCSV()">Export CSV</button>
				<button onclick="exportJSON()">Export JSON</button>
			</div>
		</header>

		<div class="stats-grid">
			<div class="stat-card">
				<div class="stat-label">Total Games</div>
				<div class="stat-value">${data.summary.totalGames.toLocaleString()}</div>
				<div class="stat-subtitle">${data.summary.completedGames} completed</div>
			</div>
			<div class="stat-card">
				<div class="stat-label">Draws</div>
				<div class="stat-value" style="color: var(--accent-warning)">${data.summary.draws}</div>
				<div class="stat-subtitle">${((data.summary.draws / Math.max(1, data.summary.totalGames)) * 100).toFixed(1)}% of games</div>
			</div>
			<div class="stat-card">
				<div class="stat-label">Avg Turns</div>
				<div class="stat-value" style="color: var(--accent-secondary)">${data.summary.avgTurns.toFixed(1)}</div>
				<div class="stat-subtitle">per game</div>
			</div>
			<div class="stat-card">
				<div class="stat-label">Anomalies</div>
				<div class="stat-value" style="color: var(--accent-danger)">${data.summary.totalAnomalies}</div>
				<div class="stat-subtitle">detected</div>
			</div>
		</div>

		<div class="charts-grid">
			<div class="chart-card">
				<div class="chart-title">Win Rates</div>
				<div class="chart-container">
					<canvas id="winRateChart"></canvas>
				</div>
			</div>
			<div class="chart-card">
				<div class="chart-title">Match Length Distribution</div>
				<div class="chart-container">
					<canvas id="lengthChart"></canvas>
				</div>
			</div>
		</div>

		<div class="charts-grid">
			<div class="chart-card">
				<div class="chart-title">Match Timeline Signals</div>
				<div class="insight-list">
					${this.generateTimelinePanel(data.timeline)}
				</div>
			</div>
			<div class="chart-card">
				<div class="chart-title">Post-Match Archetype Classifier</div>
				<div class="insight-list">
					${this.generateArchetypePanel(data.archetypeClassifier)}
				</div>
			</div>
		</div>

		<div class="chart-card" style="margin-bottom: 2rem;">
			<div class="chart-title">Detected Anomalies</div>
			<div class="anomaly-list" id="anomalyList">
				${this.generateAnomalyList(data.anomalies)}
			</div>
		</div>
	</div>

		<script>
			const dashboardData = ${serializedData};

		function toggleTheme() {
			const current = document.documentElement.getAttribute('data-theme');
			const next = current === 'dark' ? 'light' : 'dark';
			document.documentElement.setAttribute('data-theme', next);
			localStorage.setItem('theme', next);
		}

		const savedTheme = localStorage.getItem('theme');
		if (savedTheme) {
			document.documentElement.setAttribute('data-theme', savedTheme);
		}

		function exportCSV() {
			const rows = [
				['Metric', 'Value'],
				['Total Games', dashboardData.summary.totalGames],
				['Completed Games', dashboardData.summary.completedGames],
				['Draws', dashboardData.summary.draws],
				['Avg Turns', dashboardData.summary.avgTurns],
				['Total Anomalies', dashboardData.summary.totalAnomalies],
			];

			const csv = rows.map(row => row.join(',')).join('\\n');
			const blob = new Blob([csv], { type: 'text/csv' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'simulation-summary.csv';
			a.click();
		}

		function exportJSON() {
			const json = JSON.stringify(dashboardData, null, 2);
			const blob = new Blob([json], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'simulation-data.json';
			a.click();
		}

		Chart.defaults.color = getComputedStyle(document.body).color;
		Chart.defaults.borderColor = getComputedStyle(document.body).getPropertyValue('--border-color');

		const winRateCtx = document.getElementById('winRateChart').getContext('2d');
		const winRateData = Object.entries(dashboardData.winRates);
		new Chart(winRateCtx, {
			type: 'bar',
			data: {
				labels: winRateData.map(([name]) => name),
				datasets: [{
					label: 'Win Rate',
					data: winRateData.map(([, stats]) => stats.rate * 100),
					backgroundColor: 'rgba(59, 130, 246, 0.5)',
					borderColor: 'rgba(59, 130, 246, 1)',
					borderWidth: 1
				}]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				scales: {
					y: {
						beginAtZero: true,
						max: 100,
						ticks: {
							callback: function(value) {
								return value + '%';
							}
						}
					}
				}
			}
		});

		const lengthCtx = document.getElementById('lengthChart').getContext('2d');
		new Chart(lengthCtx, {
			type: 'line',
			data: {
				labels: ['Min', 'P25', 'Median', 'P75', 'Max', 'Mean'],
				datasets: [{
					label: 'Turns',
					data: [
						dashboardData.matchLengths.min,
						dashboardData.matchLengths.p25,
						dashboardData.matchLengths.median,
						dashboardData.matchLengths.p75,
						dashboardData.matchLengths.max,
						dashboardData.matchLengths.mean
					],
					borderColor: 'rgba(16, 185, 129, 1)',
					backgroundColor: 'rgba(16, 185, 129, 0.1)',
					fill: true,
					tension: 0.4
				}]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				scales: {
					y: {
						beginAtZero: true
					}
				}
			}
		});
	</script>
</body>
</html>`;
	}

	private generateTimelinePanel(data: DashboardData["timeline"]): string {
		if (!data || data.matchesAnalyzed === 0) {
			return `<div class="empty-state"><p>No timeline explainability data found.</p></div>`;
		}

		const opening = data.openingChoice[0];
		const openingText = opening
			? `${escapeHtml(opening.label)} (${(opening.rate * 100).toFixed(1)}%)`
			: "n/a";
		const spikes =
			data.powerSpikeTurns.length > 0
				? data.powerSpikeTurns
						.map((item) => `T${item.turn} (${(item.rate * 100).toFixed(1)}%)`)
						.join(", ")
				: "none observed";
		const firstCommitmentMean = formatTurnWithPrefix(
			data.firstCommitment.meanTurn,
		);
		const firstCommitmentMedian = formatTurnWithPrefix(
			data.firstCommitment.medianTurn,
		);
		const decisiveSwingMean = formatTurnWithPrefix(data.decisiveSwing.meanTurn);
		const decisiveSwingMedian = formatTurnWithPrefix(
			data.decisiveSwing.medianTurn,
		);

		return [
			`<div class="insight-row"><span class="insight-key">Opening choice:</span>${openingText}</div>`,
			`<div class="insight-row"><span class="insight-key">First commitment:</span>mean ${firstCommitmentMean}, median ${firstCommitmentMedian} (n=${data.firstCommitment.samples})</div>`,
			`<div class="insight-row"><span class="insight-key">Power spike turns:</span>${spikes}</div>`,
			`<div class="insight-row"><span class="insight-key">Decisive swing:</span>mean ${decisiveSwingMean}, median ${decisiveSwingMedian} (n=${data.decisiveSwing.samples})</div>`,
		].join("");
	}

	private generateArchetypePanel(
		data: DashboardData["archetypeClassifier"],
	): string {
		if (!data || data.matchesAnalyzed === 0) {
			return `<div class="empty-state"><p>No archetype classifier data found.</p></div>`;
		}

		const top = data.distribution[0];
		const topText = top
			? `${escapeHtml(top.archetype)} (${(top.rate * 100).toFixed(1)}%)`
			: "n/a";
		const mix = data.distribution
			.slice(0, 4)
			.map(
				(item) =>
					`${escapeHtml(item.archetype)}: ${(item.rate * 100).toFixed(1)}%`,
			)
			.join(", ");

		return [
			`<div class="insight-row"><span class="insight-key">Primary profile:</span>${topText}</div>`,
			`<div class="insight-row"><span class="insight-key">Average confidence:</span>${(data.averageConfidence * 100).toFixed(1)}%</div>`,
			`<div class="insight-row"><span class="insight-key">Distribution:</span>${mix || "n/a"}</div>`,
			`<div class="insight-row"><span class="insight-key">Matches analyzed:</span>${data.matchesAnalyzed}</div>`,
		].join("");
	}

	private generateAnomalyList(anomalies: Anomaly[]): string {
		if (anomalies.length === 0) {
			return `<div class="empty-state">
				<p>No anomalies detected.</p>
			</div>`;
		}

		return anomalies
			.slice(0, 50)
			.map((anomaly) => {
				const severity = escapeHtml(String(anomaly.severity));
				const type = escapeHtml(String(anomaly.type));
				const description = escapeHtml(String(anomaly.description));
				const seed = escapeHtml(String(anomaly.seed));
				return `
				<div class="anomaly-item">
					<span class="anomaly-severity severity-${severity}">${severity}</span>
					<div class="anomaly-content">
						<div class="anomaly-type">${type}</div>
						<div class="anomaly-desc">${description} (Seed: ${seed})</div>
					</div>
				</div>
			`;
			})
			.join("");
	}
}

function stringifyForInlineScript(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

export function generateDashboard(
	data: DashboardData,
	outputPath: string,
): void {
	const generator = new DashboardGenerator();
	generator.generate(data, outputPath);
}
