import type { HexType, UnitType } from "@fightclaw/engine";

export const PLAYER_COLORS = {
	A: { fill: "#ffffff", stroke: "#ffffff", glow: "rgba(255,255,255,0.3)" },
	B: { fill: "#33ff66", stroke: "#33ff66", glow: "rgba(51,255,102,0.3)" },
} as const;

export type ElevationTier = "base" | "elevated" | "forest";

export const TERRAIN_ELEVATION: Record<HexType, ElevationTier> = {
	plains: "base",
	deploy_a: "base",
	deploy_b: "base",
	gold_mine: "base",
	lumber_camp: "base",
	crown: "base",
	forest: "forest",
	hills: "elevated",
	high_ground: "elevated",
	stronghold_a: "elevated",
	stronghold_b: "elevated",
};

export const ELEVATION_STYLE: Record<
	ElevationTier,
	{
		fill: string;
		stroke: string;
		stackFill: string;
		stackStroke: string;
		stackLayers: number;
	}
> = {
	base: {
		fill: "#0a0a0a",
		stroke: "#1a3a2a",
		stackFill: "#000000",
		stackStroke: "#0d1f15",
		stackLayers: 0,
	},
	elevated: {
		fill: "#142820",
		stroke: "#3a7a4a",
		stackFill: "#0a1810",
		stackStroke: "#1a3a2a",
		stackLayers: 1,
	},
	forest: {
		fill: "#0a1408",
		stroke: "#2a5a1a",
		stackFill: "#000000",
		stackStroke: "#1a3a1a",
		stackLayers: 0,
	},
};

// Subtle accent tints for special terrain types (applied as a semi-transparent overlay)
export const TERRAIN_ACCENT: Partial<Record<HexType, string>> = {
	gold_mine: "#2a2010",
	lumber_camp: "#1a1408",
	crown: "#2a2810",
	stronghold_a: "#1a2820",
	stronghold_b: "#1a2820",
};

export const TERRAIN_ASCII: Partial<Record<HexType, string[]>> = {
	forest: ["/\\|/\\", "||||||", "\\|/|\\"],
	gold_mine: [" $$ ", "/\\/\\", " \\/ "],
	lumber_camp: [" ## ", " || ", "_||_"],
	crown: ["_/\\_", "|  |", "\\__/"],
	stronghold_a: ["[==]", "|##|", "|__|"],
	stronghold_b: ["[==]", "|##|", "|__|"],
	deploy_a: [" ._ ", ". A.", " '. "],
	deploy_b: [" ._ ", ". B.", " '. "],
	hills: [" /\\ ", "/  \\", "----"],
	high_ground: ["/\\/\\", "|  |", "----"],
};

export const UNIT_ASCII: Record<UnitType, string[]> = {
	infantry: ["[o]", "/|\\", "/ \\"],
	cavalry: [" o/", "/=\\\\", '" "'],
	archer: [" o", "(|>-->", "/ \\"],
	swordsman: ["[o]", "/|>", "/ \\"],
	knight: [" o/", "/#\\\\", '" "'],
	crossbow: [" o", "(|}-=>", "/ \\"],
};

export const EFFECT_COLORS = {
	"move-from": "rgba(255,255,255,0.15)",
	"move-to": "rgba(255,255,255,0.25)",
	"attack-source": "rgba(255,255,255,0.30)",
	"attack-target": "rgba(255,255,255,0.40)",
	recruit: "rgba(255,255,255,0.20)",
	fortify: "rgba(255,255,255,0.20)",
	pass: "rgba(255,255,255,0.15)",
	"attack-tracer": "rgba(255,255,255,0.60)",
} as const;
