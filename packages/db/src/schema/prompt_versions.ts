import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const promptVersions = sqliteTable("prompt_versions", {
	id: text("id").primaryKey(),
	agentId: text("agent_id").notNull(),
	gameType: text("game_type").notNull(),
	version: integer("version").notNull(),
	publicPersona: text("public_persona"),
	privateStrategyCiphertext: text("private_strategy_ciphertext").notNull(),
	privateStrategyIv: text("private_strategy_iv").notNull(),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});
