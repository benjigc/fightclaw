import {
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const matchPlayers = sqliteTable(
	"match_players",
	{
		matchId: text("match_id").notNull(),
		agentId: text("agent_id").notNull(),
		seat: integer("seat").notNull(),
		startingRating: integer("starting_rating").notNull(),
		promptVersionId: text("prompt_version_id"),
		modelProvider: text("model_provider"),
		modelId: text("model_id"),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.matchId, table.agentId] }),
	}),
);
