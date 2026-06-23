/**
 * Product-data API barrel — PRD-022c.
 *
 * The single import surface for the product-data routes the CLI/SDK/MCP target. The
 * assembly (022d) imports {@link mountProductDataApi} from here to wire goals + kpis +
 * skills + rules + sources + secrets in one call; tests import the individual mounts +
 * fetchers + group constants.
 */

export {
	type KeyedAddBody,
	KeyedAddBodySchema,
	type KeyedApiOptions,
	type KeyedRow,
	keyedHealTarget,
	mountKeyedGroup,
	resolveScope,
} from "./keyed-engine.js";

export {
	buildHighestVersionSql,
	DOCUMENTS_GROUP,
	fetchRules,
	fetchSkills,
	GOALS_GROUP,
	KPIS_GROUP,
	mountProductDataApi,
	mountProductDocumentsApi,
	mountProductSecretsApi,
	mountProductSourcesApi,
	mountRulesReadApi,
	mountSkillsReadApi,
	type ProductDataApiOptions,
	RULES_GROUP,
	type RuleReadRow,
	SECRETS_GROUP,
	SKILLS_GROUP,
	type SkillReadRow,
	SOURCES_GROUP,
} from "./api.js";

export { GOALS_TABLE, mountGoalsApi } from "../goals/api.js";
export { KPIS_TABLE, mountKpisApi } from "../kpis/api.js";
