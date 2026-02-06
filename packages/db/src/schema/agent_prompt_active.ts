import { sql } from "drizzle-orm";
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agentPromptActive = sqliteTable(
	"agent_prompt_active",
	{
		agentId: text("agent_id").notNull(),
		gameType: text("game_type").notNull(),
		promptVersionId: text("prompt_version_id").notNull(),
		activatedAt: text("activated_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.agentId, table.gameType] }),
	}),
);
