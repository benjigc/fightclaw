import type { HexType, UnitType } from "@fightclaw/engine";

export const PLAYER_COLORS = {
	A: { fill: "#ffffff", stroke: "#ffffff", glow: "rgba(255,255,255,0.3)" },
	B: { fill: "#33ff66", stroke: "#33ff66", glow: "rgba(51,255,102,0.3)" },
} as const;

export const TERRAIN_FILLS: Record<HexType, string> = {
	plains: "#000000",
	forest: "#000000",
	hills: "#000000",
	high_ground: "#000000",
	gold_mine: "#000000",
	lumber_camp: "#000000",
	crown: "#000000",
	stronghold_a: "#000000",
	stronghold_b: "#000000",
	deploy_a: "#000000",
	deploy_b: "#000000",
};

export const TERRAIN_ICONS: Partial<Record<HexType, string>> = {
	forest: "\u2663", // ♣
	hills: "\u2206", // ∆
	high_ground: "\u25b2", // ▲
	gold_mine: "\u2726", // ✦
	lumber_camp: "\u2692", // ⚒
	crown: "\u2655", // ♕
	stronghold_a: "\u2588", // █
	stronghold_b: "\u2588", // █
	deploy_a: "\u25cb", // ○
	deploy_b: "\u25cb", // ○
};

export const UNIT_ASCII: Record<UnitType, string[]> = {
	infantry: ["[o]", "/|\\", "/ \\"],
	cavalry: [" o/", "/=\\\\", '" "'],
	archer: [" o", "(|>-->", "/ \\"],
};

export const EFFECT_COLORS = {
	"move-from": "rgba(255,255,255,0.15)",
	"move-to": "rgba(255,255,255,0.25)",
	"attack-source": "rgba(255,255,255,0.30)",
	"attack-target": "rgba(255,255,255,0.40)",
	recruit: "rgba(255,255,255,0.20)",
	fortify: "rgba(255,255,255,0.20)",
	pass: "rgba(255,255,255,0.15)",
} as const;
