/**
 * Fullscreen /models hub, shown on the alternate screen like /settings.
 *
 * Layout: a sidebar of scopes (recently used, role management, all models,
 * one entry per provider — locked providers included, dimmed) beside a
 * {@link ModelBrowser} body. The Roles view manages assignments directly:
 * pick a role, pick a model, adjust thinking in an inline strip, or clear the
 * role back to auto-selection. Locked providers forward to the /login flow.
 * Fully mouse-navigable (hover, wheel, click). Session-only switching lives
 * in the compact alt+p picker ({@link ./model-picker}).
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getCatalogProviderEntry } from "@oh-my-pi/pi-catalog/provider-models";
import {
	type Component,
	extractPrintableText,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { type ModelRoleLookup, type ResolvedModelRoleValue, resolveModelRoleValue } from "../../config/model-resolver";
import { councilRoleLabel, getKnownRoleIds, getRoleInfo } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import {
	COUNCIL_LEAD_ROLES,
	COUNCIL_MAX_ACTIVE_REVIEWERS,
	COUNCIL_ROLE_ID,
	type CouncilMemberSetting,
	councilMemberRounds,
	countActiveCouncilMembers,
	isProjectScopedCouncilRoster,
	parseCouncilConfig,
	resolveCouncilMemberSelector,
} from "../../council/config";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../../thinking";
import { shortenPath } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	type RoleAssignments,
	resolveRoleAssignments,
	sortModelItems,
	thinkingLevelGlyph,
} from "./model-browser";
import { bottomBorder, dividerSplit, row, splitBodyWidth, splitRow, topBorderSplit } from "./overlay-box";
import { renderSegmentTrack } from "./segment-track";

/** Which reviewer group a `councilRole` row renders under. */
type CouncilRoundGroup = 1 | 2 | "every";
/** Per-role advisor toggles surfaced beside the Council roster. */
type CouncilAdvisorScope = "planner" | "reviewers" | "adjudicator";

/**
 * A row of the Roles view: a generic role, a model/wildcard chain-key
 * header, a fallback entry, or one of the council controls.
 * `sectionHeader` and `councilRoundHeader` rows are presentation-only and never receive focus.
 */
type RolesRow =
	| { kind: "role"; role: string }
	| { kind: "chainKey"; role: string }
	| { kind: "fallback"; role: string; chainIndex: number; selector: string }
	| { kind: "separator" }
	| { kind: "newFallback" }
	| { kind: "newRole" }
	| { kind: "sectionHeader"; section: "council"; label: string; segments: readonly HeaderSegment[] }
	| { kind: "councilNotice"; severity: "error" | "warning"; text: string; action?: "moveToGlobal" }
	| { kind: "councilLead"; role: string; label: string; fallbackText: string }
	| { kind: "councilAdvisor"; scope: CouncilAdvisorScope; label: string; enabled: boolean }
	| { kind: "councilRoundHeader"; group: CouncilRoundGroup; inactive: boolean; empty: boolean }
	| { kind: "councilRole"; member: CouncilMemberSetting; group: CouncilRoundGroup; roundFault: boolean }
	| { kind: "councilRounds"; rounds: 1 | 2; invalid: boolean }
	| { kind: "newCouncilMember" };

/** One status segment of a Roles section header, joined by dim separators. */
interface HeaderSegment {
	text: string;
	tone: "dim" | "warning";
}

/**
 * How an invalid council roster is presented. `salvaged` keeps the rows editable
 * because editing them is the repair; `projectScope` needs the roster relocated,
 * which no row edit can do (roster writes always target global settings);
 * `blocked` withholds the rows because `council.members` is not a list of
 * records at all.
 */
type CouncilFaultKind = "salvaged" | "projectScope" | "blocked";

/** What the footer name input is naming. */
type RoleNameMode = "newRole" | "newCouncilMember" | "councilDisplayName";

/**
 * What the model browser is currently picking for: a role's model, a slot in
 * a fallback chain (`role` may be a role name, model selector, or `provider/*`
 * key), or the primary model a brand-new fallback chain protects.
 */
type AssignTarget =
	| { kind: "role"; role: string }
	| { kind: "fallback"; role: string; index: number | null }
	| { kind: "fallbackKey" };

/** A `--models` scope entry (mirrors the session's scoped model list). */
export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export type ModelRoleSelectionScope = "global" | "project";

export interface ModelHubCallbacks {
	/** Persist a role assignment. */
	onAssign: (
		model: Model,
		role: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
		scope?: ModelRoleSelectionScope,
	) => void;
	/** Clear a configured role back to auto-selection. */
	onUnassign: (role: string, scope?: ModelRoleSelectionScope) => void;
	/** Persist a `retry.fallbackChains` entry — keyed by a role, `provider/model-id`, or `provider/*`; an empty chain clears the key. */
	onFallbackChainChange?: (role: string, chain: string[]) => void;
	/** Locked provider activation: forward to the /login flow. */
	onLoginRequest?: (providerId: string) => void;
	/** Persist a new quick-switch cycle order (the ctrl+p role cycle). */
	onCycleOrderChange?: (order: string[]) => void;
	/** Persist the ordered council roster. Model assignments continue through onAssign/onUnassign. */
	onCouncilRosterChange?: (members: CouncilMemberSetting[]) => void;
	/** Persist `council.rounds`. */
	onCouncilRoundsChange?: (rounds: 1 | 2) => void;
	/** Persist one `council.advisor.*` toggle. */
	onCouncilAdvisorChange?: (scope: CouncilAdvisorScope, enabled: boolean) => void;
	/** Persist a role's user-facing display name in `modelTags`; `undefined` clears it back to the role id. */
	onRoleDisplayNameChange?: (role: string, name: string | undefined) => void;
	/**
	 * Drop a project-scoped `council.members` key. The hub calls this only after
	 * it has observed the global roster write land, so a failed destination write
	 * leaves the project roster untouched.
	 */
	onCouncilRosterProjectClear?: () => Promise<void>;
	onCancel: () => void;
}

export interface ModelHubOptions {
	/** Preselect this provider's sidebar entry (e.g. when reopening after /login). */
	initialProviderId?: string;
	/** Open directly on the requested Roles subsection. */
	initialSection?: "council";
}

interface SidebarEntry {
	id: string;
	kind: "recent" | "roles" | "all" | "separator" | "provider";
	label: string;
	providerId?: string;
	locked?: boolean;
	/** Right-aligned annotation: model count, `assigned/total`, or `login`. */
	annotation?: string;
	oauth?: boolean;
	catalogCount?: number;
}

interface StripChip {
	label: string;
	/** Pre-styled label body (without selection decoration). */
	styled: string;
	role?: string;
	action:
		| "assign"
		| "unassign"
		| "fallback"
		| "fallbackModel"
		| "fallbackProvider"
		| "scope"
		| "thinking"
		| "councilRound";
	/** Round a `councilRound` chip commits; `"every"` leaves the member unpinned. */
	councilRound?: CouncilRoundGroup;
	thinkingLevel?: ConfiguredThinkingLevel;
	scope?: ModelRoleSelectionScope;
}

type StripState =
	| {
			kind: "role" | "scope" | "thinking";
			item: ModelBrowserItem;
			role?: string;
			scope?: ModelRoleSelectionScope;
			chips: StripChip[];
			index: number;
			/** Where to land when a scope or thinking strip closes. */
			returnToRoles: boolean;
	  }
	| {
			/** Footer text input naming a role or a council member's display name. */
			kind: "roleName";
			mode: RoleNameMode;
			/** Target council role when `mode` is `councilDisplayName`. */
			role?: string;
			input: Input;
	  }
	| {
			/**
			 * Round chooser shown before a new reviewer is named. Deliberately its own variant with no
			 * `item`: nothing is being assigned yet, so every model-item strip field would be a lie.
			 */
			kind: "councilRound";
			chips: StripChip[];
			index: number;
	  };

/** Recorded chip hit-range on the footer row (columns relative to frame col 0). */
interface ChipRange {
	start: number;
	end: number;
	index: number;
}

interface RoleRowPresentation {
	dot: string;
	label: string;
	value: string;
	effort: string;
	provenance: string;
}
const PROVIDER_REFRESH_DEBOUNCE_MS = 120;
const RECENT_LIMIT = 15;
const SIDEBAR_MIN_WIDTH = 18;
const COUNCIL_ERROR_MAX_LENGTH = 320;
/** New generic role ids: the historical `/models` role-name grammar. */
const ROLE_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;
/** Council display names: the role-name grammar plus interior spaces for multi-word labels. */
const COUNCIL_DISPLAY_NAME_PATTERN = /^[A-Za-z][\w-]*(?: [\w-]+)*$/;
const COUNCIL_DISPLAY_NAME_MAX_LENGTH = 48;
const SIDEBAR_MAX_WIDTH = 26;
const ROLE_LABEL_COLUMN_DIVISOR = 3;

/** Strip terminal controls and collapse user-authored text to one display line. */
function sanitizeInline(text: string): string {
	return sanitizeText(text)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Providers already auto-refreshed this process. Selecting a provider fetches
 * its live model list at most once per application lifetime (surviving hub
 * close/reopen); F5 re-fetches on demand.
 */
const autoRefreshedProviders = new Set<string>();

/** Test hook: forget which providers were auto-refreshed this process. */
export function resetProviderAutoRefreshGuard(): void {
	autoRefreshedProviders.clear();
}

/**
 * The fullscreen model hub component. Hosted via `ui.showOverlay(..., { fullscreen: true })`;
 * the host must call {@link ModelHubComponent.dispose} when the overlay closes.
 */
export class ModelHubComponent implements Component {
	#tui: TUI;
	#settings: Settings;
	#registry: ModelRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#callbacks: ModelHubCallbacks;

	#browser: ModelBrowser;
	#roles: RoleAssignments = {};
	#availableItems: ModelBrowserItem[] = [];
	#recentItems: ModelBrowserItem[] = [];
	#configError: string | undefined;
	#councilMembers: CouncilMemberSetting[] = [];
	#councilRosterRoleIds = new Set<string>();
	#councilFault: { kind: CouncilFaultKind; message: string } | undefined;
	#councilRounds: 1 | 2 = 1;
	/** `council.rounds` holds a value outside 1|2; the rounds row says so. */
	#councilRoundsInvalid = false;
	/**
	 * Raw `round` values a salvaged row carried that are not `1 | 2`, keyed by role. Held apart from
	 * {@link #councilMembers} — which stays the validated view the grouping and rendering read — and
	 * re-attached on every roster write, so an unrelated edit cannot erase a pin the user still has
	 * to repair.
	 */
	#councilMalformedRounds = new Map<string, unknown>();
	/**
	 * The salvaged rows are not a faithful copy of `council.members`: at least one entry was dropped
	 * or could not be read at all. Relocating the roster in that state would write the reduced copy
	 * to global and then drop the project key, destroying the unreadable entries, so the move is
	 * refused while this is set.
	 */
	#councilRosterSalvageLossy = false;
	/**
	 * Enabled roster roles that would actually run and whose model role does not resolve to exactly
	 * one selector. An inert member — disabled, or pinned past `council.rounds` — never runs, so its
	 * missing assignment blocks nothing and is not counted.
	 */
	#councilUnassignedCount = 0;
	/** `council.advisor.*`, read with the same tolerance as `council.rounds`. */
	#councilAdvisor: Record<CouncilAdvisorScope, boolean> = { planner: false, reviewers: false, adjudicator: false };
	/** Round chosen in the add-reviewer chooser, consumed by the name strip that follows it. */
	#pendingCouncilRound: CouncilRoundGroup = "every";
	/** Transient council notice on the status row: a scope warning or a failed roster move. */
	#councilStatusNotice: { text: string; tone: "warning" | "error" } | undefined;

	#entries: SidebarEntry[] = [];
	// Sidebar sections from the last registry sync; #composeEntries assembles
	// #entries from these (reordered while searching).
	#fixedEntries: SidebarEntry[] = [];
	#unlockedProviderEntries: SidebarEntry[] = [];
	#lockedProviderEntries: SidebarEntry[] = [];
	/** Fuzzy match totals while searching: recent-scope hits and overall hits. */
	#recentSearchCount = 0;
	#searchTotal = 0;
	#activeEntryId = "all";
	#sidebarScroll = 0;
	/** Snap the sidebar viewport to the active entry on the next render; wheel panning leaves it free. */
	#sidebarFollowActive = true;
	#sidebarHover: number | null = null;
	/**
	 * Arrow-key ownership: `scope` (default) hops the sidebar; `list`
	 * navigates rows (browser models or role rows). Typing anywhere focuses
	 * the model list; Tab toggles; ←/→ switches between sidebar and list.
	 */
	#focus: "scope" | "list" = "scope";

	#rolesRows: RolesRow[] = [];
	#roleIndex = 0;
	#roleHover: number | null = null;
	#rolesScroll = 0;
	/** One-shot reveal request; wheel panning deliberately consumes it. */
	#rolesFollowActive = true;
	#rolesViewportRows = 1;
	/** Rendered body line → source row index, rebuilt for every viewport. */
	#rolesLineToRow = new Map<number, number>();

	#assigning: AssignTarget | null = null;
	#strip: StripState | null = null;
	/** Per-provider fuzzy match counts while a query is active; null when not searching. */
	#searchCounts: Map<string, number> | null = null;

	// Provider discovery refresh (debounced per sidebar selection, with spinner).
	#refreshingProviders = new Set<string>();
	#scheduledProviderRefreshes = new Map<string, Timer>();
	#refreshSpinnerFrame = 0;
	#refreshSpinnerInterval?: Timer;

	// Frame geometry from the last render, for mouse hit-testing (the
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1).
	#contentRowStart = 1;
	#contentRowCount = 0;
	#sidebarWidthLast = SIDEBAR_MIN_WIDTH;
	#footerRow = 0;
	#chipRanges: ChipRange[] = [];
	#lockedLoginLine: number | null = null;

	constructor(
		tui: TUI,
		settings: Settings,
		registry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelHubCallbacks,
		options: ModelHubOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#callbacks = callbacks;

		this.#browser = new ModelBrowser(settings, {
			emptyText: () => this.#emptyStateMessage(),
		});
		this.#browser.onActivate = item => this.#activateItem(item);
		this.#browser.onCancel = () => this.#callbacks.onCancel();
		this.#browser.onQueryChange = query => this.#onQueryChanged(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();

		const initialProvider = options.initialProviderId;
		if (options.initialSection === "council") {
			this.#setActiveEntry("roles");
			this.#focus = "list";
			// Prefer a repair action, then the first editable roster control.
			const councilIndex = this.#rolesRows.findIndex(
				row => row.kind === "councilNotice" && row.action !== undefined,
			);
			const fallbackIndex = this.#rolesRows.findIndex(
				row =>
					row.kind === "councilNotice" ||
					row.kind === "councilLead" ||
					row.kind === "councilRole" ||
					row.kind === "councilRounds" ||
					row.kind === "councilAdvisor" ||
					row.kind === "newCouncilMember",
			);
			this.#setCouncilInitialFocus(councilIndex >= 0 ? councilIndex : fallbackIndex);
		} else if (initialProvider && this.#entries.some(entry => entry.providerId === initialProvider)) {
			this.#setActiveEntry(`provider:${initialProvider}`);
		} else {
			this.#setActiveEntry("all");
		}

		// Reconcile with cached discovery state in the background. A --models
		// scope is registry-independent, so the offline reload would only repeat
		// the synchronous hydration above.
		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	/** Cancel pending provider refresh timers and the spinner. Host calls this on overlay close. */
	dispose(): void {
		for (const [, timer] of this.#scheduledProviderRefreshes) clearTimeout(timer);
		this.#scheduledProviderRefreshes.clear();
		this.#refreshingProviders.clear();
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
	}

	invalidate(): void {}

	// ═══════════════════════════════════════════════════════════════════════
	// Data pipeline
	// ═══════════════════════════════════════════════════════════════════════

	#visibleRoleIds(): string[] {
		return getKnownRoleIds(this.#settings).filter(role => !getRoleInfo(role, this.#settings).hidden);
	}

	#genericRoleIds(): string[] {
		// Council leads are rendered as their own rows in the Council section, so they must not also
		// appear in the generic list or in the model-item role strip.
		return this.#visibleRoleIds().filter(
			role => !this.#councilRosterRoleIds.has(role) && !COUNCIL_LEAD_ROLES.includes(role),
		);
	}

	/**
	 * Validate the roster strictly, then classify any failure so a broken config
	 * does not lock the editor. Invalid config never falls back to defaults; it
	 * falls back to the rows the user actually configured.
	 */
	#reloadCouncilConfig(): void {
		this.#councilRosterRoleIds.clear();
		this.#councilRoundsInvalid = false;
		this.#councilMalformedRounds.clear();
		this.#councilRosterSalvageLossy = false;
		try {
			const config = parseCouncilConfig(this.#settings);
			// `round` must survive: every roster mutation re-persists this whole array from these
			// records, so a field dropped here is durably erased on the next Space/[/]/Delete.
			this.#councilMembers = config.members.map(member => ({
				role: member.role,
				enabled: member.enabled,
				...(member.round === undefined ? {} : { round: member.round }),
			}));
			this.#councilRounds = config.rounds;
			this.#councilAdvisor = { ...config.advisor };
			for (const member of config.members) this.#councilRosterRoleIds.add(member.role);
			this.#councilFault = undefined;
		} catch (error) {
			const salvaged = this.#salvageCouncilMembers();
			const kind: CouncilFaultKind = isProjectScopedCouncilRoster(this.#settings)
				? "projectScope"
				: salvaged === null
					? "blocked"
					: "salvaged";
			this.#councilMembers = salvaged ?? [];
			for (const member of this.#councilMembers) this.#councilRosterRoleIds.add(member.role);
			let rawRounds: unknown;
			try {
				rawRounds = this.#settings.get("council.rounds");
			} catch {}
			this.#councilRounds = rawRounds === 2 ? 2 : 1;
			this.#councilRoundsInvalid = rawRounds !== 1 && rawRounds !== 2;
			this.#councilAdvisor = {
				planner: this.#rawCouncilAdvisorFlag("planner"),
				reviewers: this.#rawCouncilAdvisorFlag("reviewers"),
				adjudicator: this.#rawCouncilAdvisorFlag("adjudicator"),
			};
			const message = error instanceof Error ? error.message : String(error);
			this.#councilFault = { kind, message: sanitizeInline(message).slice(0, COUNCIL_ERROR_MAX_LENGTH) };
		}
		// An unassigned lead is not unassigned work: it falls back to a documented default. Only a
		// lead that resolves to several selectors — which preflight refuses — is worth warning about.
		const invalidLeads = COUNCIL_LEAD_ROLES.reduce(
			(count, role) => count + (resolveCouncilMemberSelector(this.#settings, role).kind === "invalid" ? 1 : 0),
			0,
		);
		this.#councilUnassignedCount =
			invalidLeads +
			this.#councilMembers.reduce(
				(count, member) =>
					count +
					(member.enabled &&
					councilMemberRounds(member, this.#councilRounds).length > 0 &&
					resolveCouncilMemberSelector(this.#settings, member.role).kind !== "resolved"
						? 1
						: 0),
				0,
			);
	}

	/** Read one advisor toggle tolerantly, so an unrelated config fault still renders the switches. */
	#rawCouncilAdvisorFlag(scope: CouncilAdvisorScope): boolean {
		try {
			return this.#settings.get(`council.advisor.${scope}`) === true;
		} catch {
			return false;
		}
	}

	/**
	 * Recover roster rows from a roster {@link parseCouncilConfig} rejected, so a
	 * per-member or rounds error stays repairable by editing the rows. Returns
	 * `null` only when `council.members` is not a list of records — the one fault
	 * no row edit can express. Recovered rows keep their configured `enabled`
	 * flag so a salvaged toggle round-trips instead of silently re-enabling.
	 *
	 * Every exit that loses an entry — an unreadable roster, an unreadable row, a
	 * row with no usable role — sets {@link #councilRosterSalvageLossy}, because the
	 * recovered rows are then a reduced copy the relocation must never treat as the
	 * whole roster.
	 */
	#salvageCouncilMembers(): CouncilMemberSetting[] | null {
		let raw: unknown;
		try {
			raw = this.#settings.get("council.members");
		} catch {
			return this.#lossySalvage();
		}
		if (!Array.isArray(raw)) return this.#lossySalvage();
		const members: CouncilMemberSetting[] = [];
		const seen = new Set<string>();
		for (const entry of raw) {
			// Mid-loop: earlier iterations may already have recorded malformed pins, and those must
			// not outlive the members array they were keyed against.
			if (!isRecord(entry)) return this.#lossySalvage();
			if (typeof entry.role !== "string" || entry.role.length === 0 || seen.has(entry.role)) {
				this.#councilRosterSalvageLossy = true;
				continue;
			}
			seen.add(entry.role);
			// A malformed `round` is recorded rather than dropped: the validated view below leaves it
			// off so grouping stays honest, while `#persistCouncilMembers` writes the raw value back so
			// an unrelated edit cannot silently widen this member to every round.
			const round = entry.round === 1 || entry.round === 2 ? entry.round : undefined;
			if (round === undefined && entry.round !== undefined) {
				this.#councilMalformedRounds.set(entry.role, entry.round);
			}
			members.push({
				role: entry.role,
				enabled: entry.enabled !== false,
				...(round === undefined ? {} : { round }),
			});
		}
		return members;
	}

	/**
	 * Abandon the salvage: no rows survive, so drop any malformed pins recorded so far to keep
	 * `keys(#councilMalformedRounds) ⊆ roles(#councilMembers)` true, and mark the result lossy.
	 */
	#lossySalvage(): null {
		this.#councilMalformedRounds.clear();
		this.#councilRosterSalvageLossy = true;
		return null;
	}

	/**
	 * True while the roster is project-scoped: roster rows render, but editing them would write the
	 * wrong file. Scoped to roster rows only — lead assignments write `modelRoles` and advisor
	 * toggles write `council.advisor.*`, neither of which the misplaced key affects.
	 */
	get #councilRowsLocked(): boolean {
		return this.#councilFault?.kind === "projectScope";
	}

	/**
	 * Where to fix the roster. `council.members` carries no `/settings` UI
	 * metadata, so the remedy names files rather than a settings screen.
	 */
	#councilRemedyLines(kind: CouncilFaultKind): { text: string; action?: "moveToGlobal" }[] {
		const globalPath = shortenPath(this.#settings.getGlobalConfigPath());
		if (kind === "salvaged") {
			return [{ text: `Fix it in the rows below, or edit council.members in ${globalPath}` }];
		}
		if (kind === "blocked") {
			return [{ text: `Council configuration is invalid; edit council.members in ${globalPath}` }];
		}
		const projectPath = shortenPath(
			this.#settings.getProjectSettingSource("council.members") ?? "the project configuration",
		);
		return [
			{ text: `Project roster: ${projectPath}` },
			{ text: `Move roster to global config: ${globalPath}`, action: "moveToGlobal" },
		];
	}

	/** Land the initial council focus on `index`, or scroll the section header into view when nothing is selectable. */
	#setCouncilInitialFocus(index: number): void {
		if (index >= 0) {
			this.#setRoleIndex(index);
			return;
		}
		const headerIndex = this.#rolesRows.findIndex(row => row.kind === "sectionHeader" && row.section === "council");
		if (headerIndex >= 0) {
			this.#rolesScroll = headerIndex;
			this.#rolesFollowActive = false;
		}
	}

	/** Resolve every known role: configured values first, auto-selection for the rest. */
	#reloadRoles(autoCandidates: ReadonlyArray<Model>): void {
		const allModels = this.#scopedModels.length > 0 ? autoCandidates : this.#registry.getAll();
		this.#roles = resolveRoleAssignments(this.#settings, allModels, autoCandidates);
	}

	/** Rebuild items, roles, and the sidebar from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		let allModels: ReadonlyArray<Model>;
		let availableModels: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			allModels = this.#scopedModels.map(scoped => scoped.model);
			availableModels = allModels;
			this.#configError = undefined;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			allModels = this.#registry.getAll();
			try {
				availableModels = this.#registry.getAvailable();
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				availableModels = [];
			}
		}

		this.#reloadCouncilConfig();
		this.#reloadRoles(availableModels);
		this.#buildRolesRows();

		const storage = this.#settings.getStorage();
		const mruOrder = storage?.getModelUsageOrder() ?? [];
		this.#availableItems = buildBrowserItems(availableModels);
		sortModelItems(this.#availableItems, { roles: this.#roles, mruOrder });
		this.#browser.setRoles(this.#roles);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(storage?.getModelPerf() ?? new Map());

		const bySelector = new Map(this.#availableItems.map(item => [item.selector, item]));
		this.#recentItems = [];
		for (const key of mruOrder) {
			const item = bySelector.get(key);
			if (item) this.#recentItems.push(item);
			if (this.#recentItems.length >= RECENT_LIMIT) break;
		}

		this.#buildSidebar(allModels, availableModels);
		this.#applyScope();
	}

	#buildSidebar(allModels: ReadonlyArray<Model>, availableModels: ReadonlyArray<Model>): void {
		const scoped = this.#scopedModels.length > 0;
		let disabledProviders: ReadonlySet<string>;
		try {
			disabledProviders = new Set(this.#settings.get("disabledProviders"));
		} catch {
			disabledProviders = new Set();
		}

		const availableCounts = new Map<string, number>();
		for (const model of availableModels) {
			availableCounts.set(model.provider, (availableCounts.get(model.provider) ?? 0) + 1);
		}
		const catalogCounts = new Map<string, number>();
		for (const model of allModels) {
			catalogCounts.set(model.provider, (catalogCounts.get(model.provider) ?? 0) + 1);
		}

		const unlocked = new Set<string>(availableCounts.keys());
		const locked = new Set<string>();
		if (!scoped) {
			const authStorage = this.#registry.authStorage;
			for (const provider of catalogCounts.keys()) {
				if (!unlocked.has(provider) && !disabledProviders.has(provider)) {
					locked.add(provider);
				}
			}
			for (const provider of this.#registry.getDiscoverableProviders()) {
				if (unlocked.has(provider) || disabledProviders.has(provider)) continue;
				// Discoverable without stored auth: catalog-backed providers stay
				// locked; keyless/custom endpoints (ollama, vllm, …) surface as
				// selectable so discovery can populate them.
				if (authStorage.hasAuth(provider) || !locked.has(provider)) {
					locked.delete(provider);
					unlocked.add(provider);
				}
			}
		}

		const oauthIds = new Set(getOAuthProviders().map(provider => provider.id));
		const providerEntry = (providerId: string, isLocked: boolean): SidebarEntry => ({
			id: `provider:${providerId}`,
			kind: "provider",
			label: providerId,
			providerId,
			locked: isLocked,
			annotation: isLocked ? undefined : String(availableCounts.get(providerId) ?? 0),
			oauth: oauthIds.has(providerId),
			catalogCount: catalogCounts.get(providerId) ?? 0,
		});

		const visibleRoles = this.#visibleRoleIds();
		let assignedCount = 0;
		for (const role of visibleRoles) {
			const assignment = this.#roles[role];
			if (assignment && !assignment.autoSelected) assignedCount++;
		}

		// Roles leads the fixed section so downward hops from Recent head into
		// model scopes instead of being captured by the roles view.
		const fixed: SidebarEntry[] = [
			{
				id: "roles",
				kind: "roles",
				label: "Roles & Council",
				annotation: `${assignedCount}/${visibleRoles.length}`,
			},
			{ id: "all", kind: "all", label: "All models", annotation: String(availableModels.length) },
		];

		this.#fixedEntries = fixed;
		this.#unlockedProviderEntries = [...unlocked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, false));
		this.#lockedProviderEntries = [...locked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, true));
		this.#composeEntries();
	}

	/**
	 * Assemble `#entries` from the stored sections. While a search is active,
	 * providers with matches float to the top of the provider section (each
	 * group stays alphabetical) so the hop order, mouse hit-testing, and the
	 * paint all agree.
	 */
	#composeEntries(): void {
		const counts = this.#searchCounts;
		let providers = this.#unlockedProviderEntries;
		if (counts) {
			providers = [...providers].sort((a, b) => {
				const aMatched = (counts.get(a.providerId ?? "") ?? 0) > 0;
				const bMatched = (counts.get(b.providerId ?? "") ?? 0) > 0;
				if (aMatched !== bMatched) return aMatched ? -1 : 1;
				return a.label.localeCompare(b.label);
			});
		}

		const entries: SidebarEntry[] = [...this.#fixedEntries];
		if (providers.length > 0) {
			entries.push({ id: "sep:providers", kind: "separator", label: "" }, ...providers);
		}
		if (this.#lockedProviderEntries.length > 0) {
			entries.push({ id: "sep:locked", kind: "separator", label: "" }, ...this.#lockedProviderEntries);
		}

		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) {
			this.#activeEntryId = "all";
			this.#sidebarFollowActive = true;
		}
	}

	#activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0];
	}

	#setActiveEntry(id: string): void {
		if (!this.#entries.some(entry => entry.id === id)) return;
		this.#activeEntryId = id;
		this.#sidebarFollowActive = true;
		if (id === "roles") this.#rolesFollowActive = true;
		this.#applyScope();
		const entry = this.#activeEntry();
		// Hops must never steal arrow focus: landing on a scope keeps provider
		// navigation active. Diving into the roles rows is explicit (Enter, →,
		// or a click on the Roles entry).
		this.#focus = "scope";
		if (entry.kind === "provider" && !entry.locked) {
			this.#scheduleProviderRefresh(entry.providerId ?? "");
		}
		this.#cancelScheduledRefreshesExcept(entry.kind === "provider" ? entry.providerId : undefined);
	}

	/** Push the active scope's items into the browser. */
	#applyScope(): void {
		const entry = this.#activeEntry();
		switch (entry.kind) {
			case "recent":
				this.#browser.setShowProvider(true);
				this.#browser.setItems([...this.#recentItems]);
				break;
			case "provider": {
				if (entry.locked) {
					// Assign-mode renders the browser regardless of scope; a locked
					// provider contributes nothing selectable.
					this.#browser.setItems([]);
					break;
				}
				const providerId = entry.providerId;
				this.#browser.setShowProvider(false);
				this.#browser.setItems(this.#availableItems.filter(item => item.provider === providerId));
				break;
			}
			case "roles": {
				let index = Math.min(this.#roleIndex, Math.max(0, this.#rolesRowCount - 1));
				if (!this.#isSelectableRolesRow(this.#rolesRows[index])) {
					const next = this.#stepRoleIndex(index, 1, { wrap: false });
					index = next === index ? this.#stepRoleIndex(index, -1, { wrap: false }) : next;
				}
				this.#roleIndex = index;
				break;
			}
			default:
				this.#browser.setShowProvider(true);
				this.#browser.setItems([...this.#availableItems]);
				break;
		}
	}

	/**
	 * The configured `retry.fallbackChains` record with malformed keys/entries
	 * dropped: non-array chains and non-string selectors never reach the rows
	 * or chain editors, so an edit through the hub replaces them wholesale.
	 */
	#fallbackChains(): Record<string, string[]> {
		try {
			const chains = this.#settings.get("retry.fallbackChains");
			if (!chains || typeof chains !== "object" || Array.isArray(chains)) return {};
			const sanitized: Record<string, string[]> = {};
			for (const key in chains) {
				const chain = (chains as Record<string, unknown>)[key];
				if (!Array.isArray(chain)) continue;
				sanitized[key] = chain.filter((entry): entry is string => typeof entry === "string");
			}
			return sanitized;
		} catch {
			return {};
		}
	}

	/** The reviewer group a member renders under; a pin outside `council.rounds` keeps its own group. */
	#councilMemberGroup(member: CouncilMemberSetting): CouncilRoundGroup {
		return member.round ?? "every";
	}

	/**
	 * Groups to render, in reading order. A round pinned beyond `council.rounds` still gets a muted
	 * group so the parked member stays visible and editable instead of vanishing from the hub.
	 */
	#councilRoundGroups(): CouncilRoundGroup[] {
		const groups: CouncilRoundGroup[] = ["every"];
		for (const round of [1, 2] as const) {
			if (round <= this.#councilRounds || this.#councilMembers.some(member => member.round === round)) {
				groups.push(round);
			}
		}
		return groups;
	}

	/**
	 * What an unassigned lead falls back to. Rendered in place of `unassigned` so a Planner or
	 * Adjudicator nobody pinned reads as configured — which it is — rather than broken.
	 */
	#leadFallbackText(role: string): string {
		if (role === "adjudicator") {
			const model = this.#roles.default?.model ?? this.#roles.slow?.model;
			return model ? `main session model (${model.provider}/${model.id})` : "main session model";
		}
		const slow = this.#roles.slow?.model;
		return slow ? `slow role (${slow.provider}/${slow.id})` : "slow role";
	}

	/** Rebuild generic roles, the council roster, then model-oriented fallback chains. */
	#buildRolesRows(): void {
		const rows: RolesRow[] = [];
		const chains = this.#fallbackChains();
		for (const role of this.#genericRoleIds()) {
			rows.push({ kind: "role", role });
			const chain = chains[role] ?? [];
			for (let i = 0; i < chain.length; i++) {
				rows.push({ kind: "fallback", role, chainIndex: i, selector: chain[i] });
			}
		}
		rows.push({ kind: "newRole" });
		rows.push({ kind: "separator" });

		const fault = this.#councilFault;
		const enabledCount = this.#councilMembers.reduce((count, member) => count + (member.enabled ? 1 : 0), 0);
		// The header reports assignment, not health: preflight still checks
		// availability, tool support, and credentials before a run spends.
		const segments: HeaderSegment[] =
			fault?.kind === "blocked"
				? [{ text: "config error", tone: "dim" }]
				: [
						{ text: `${enabledCount}/${this.#councilMembers.length} enabled`, tone: "dim" },
						...(this.#councilUnassignedCount > 0
							? [{ text: `${this.#councilUnassignedCount} unassigned`, tone: "warning" as const }]
							: []),
						...(fault?.kind === "projectScope" ? [{ text: "project scope", tone: "warning" as const }] : []),
						{ text: `rounds ${this.#councilRounds}`, tone: "dim" },
					];
		rows.push({ kind: "sectionHeader", section: "council", label: "Council", segments });
		if (fault) {
			rows.push({
				kind: "councilNotice",
				severity: fault.kind === "salvaged" ? "warning" : "error",
				text: fault.message,
			});
			for (const remedy of this.#councilRemedyLines(fault.kind)) {
				rows.push({ kind: "councilNotice", severity: "warning", text: remedy.text, action: remedy.action });
			}
		}
		if (fault?.kind !== "blocked") {
			rows.push(
				{
					kind: "councilLead",
					role: "planner",
					label: "Planner",
					fallbackText: this.#leadFallbackText("planner"),
				},
				{
					kind: "councilLead",
					role: "adjudicator",
					label: "Adjudicator",
					fallbackText: this.#leadFallbackText("adjudicator"),
				},
				{ kind: "councilRounds", rounds: this.#councilRounds, invalid: this.#councilRoundsInvalid },
				{
					kind: "councilAdvisor",
					scope: "planner",
					label: "Planner advisor",
					enabled: this.#councilAdvisor.planner,
				},
				{
					kind: "councilAdvisor",
					scope: "reviewers",
					label: "Reviewer advisor",
					enabled: this.#councilAdvisor.reviewers,
				},
				{
					kind: "councilAdvisor",
					scope: "adjudicator",
					label: "Adjudicator advisor",
					enabled: this.#councilAdvisor.adjudicator,
				},
			);
			for (const group of this.#councilRoundGroups()) {
				const members = this.#councilMembers.filter(member => this.#councilMemberGroup(member) === group);
				// `Every round` only earns a header when something is in it; a configured round always
				// gets one, empty or not, because an empty round is the `COUNCIL_ROUND_UNSTAFFED` refusal.
				if (group === "every" && members.length === 0) continue;
				const inactive = typeof group === "number" && group > this.#councilRounds;
				rows.push({ kind: "councilRoundHeader", group, inactive, empty: members.length === 0 });
				for (const member of members) {
					rows.push({
						kind: "councilRole",
						member,
						group,
						roundFault: this.#councilMalformedRounds.has(member.role),
					});
				}
			}
			if (!this.#councilRowsLocked) rows.push({ kind: "newCouncilMember" });
		}

		rows.push({ kind: "separator" });
		const modelKeys = Object.keys(chains)
			.filter(key => key.includes("/"))
			.sort();
		for (const key of modelKeys) {
			const chain = chains[key] ?? [];
			rows.push({ kind: "chainKey", role: key });
			for (let i = 0; i < chain.length; i++) {
				rows.push({ kind: "fallback", role: key, chainIndex: i, selector: chain[i] });
			}
		}
		rows.push({ kind: "newFallback" });
		this.#rolesRows = rows;
	}

	/** Refresh roles + dependent state after a settings mutation (assign/unassign). */
	#refreshAfterMutation(): void {
		this.#syncFromRegistryState();
		this.#tui.requestRender();
	}

	/** Re-sync after an asynchronous callback finishes mutating settings. */
	refreshAfterExternalMutation(): void {
		this.#refreshAfterMutation();
	}

	/**
	 * Recompute per-provider match counts for the active query. Providers
	 * without matches gray out and the scope hop skips them; a provider scope
	 * that just lost its last match falls back to All models so the results
	 * never silently vanish.
	 */
	#onQueryChanged(query: string): void {
		if (!query.trim()) {
			this.#searchCounts = null;
			this.#composeEntries();
			return;
		}
		const matches = fuzzyFilter(this.#availableItems, query, ({ provider, id }) => `${provider}/${id}`);
		const counts = new Map<string, number>();
		for (const item of matches) {
			counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
		}
		const recentSelectors = new Set(this.#recentItems.map(item => item.selector));
		this.#recentSearchCount = matches.reduce(
			(total, item) => total + (recentSelectors.has(item.selector) ? 1 : 0),
			0,
		);
		this.#searchTotal = matches.length;
		this.#searchCounts = counts;
		this.#composeEntries();
		const entry = this.#activeEntry();
		if (
			this.#assigning === null &&
			entry.kind === "provider" &&
			(entry.locked || (counts.get(entry.providerId ?? "") ?? 0) === 0)
		) {
			this.#setActiveEntry("all");
		}
	}

	/**
	 * Entries the scope hop skips: separators always; while searching, also
	 * the Roles view (not a model scope), an empty Recent, locked providers,
	 * and providers without matches.
	 */
	#isHopSkipped(entry: SidebarEntry): boolean {
		if (entry.kind === "separator") return true;
		if (!this.#searchCounts) return false;
		if (entry.kind === "roles") return true;
		if (entry.kind === "recent") return this.#recentSearchCount === 0;
		if (entry.kind === "provider") {
			if (entry.locked) return true;
			return (this.#searchCounts.get(entry.providerId ?? "") ?? 0) === 0;
		}
		return false;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Provider discovery refresh
	// ═══════════════════════════════════════════════════════════════════════

	#startRefreshSpinner(): void {
		if (this.#refreshSpinnerInterval) return;
		this.#refreshSpinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#refreshSpinnerFrame = (this.#refreshSpinnerFrame + 1) % frameCount;
			}
			this.#tui.requestRender();
		}, 80);
	}

	#stopRefreshSpinnerIfIdle(): void {
		if (this.#refreshingProviders.size > 0) return;
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
		this.#refreshSpinnerFrame = 0;
	}

	#setProviderRefreshing(providerId: string, refreshing: boolean): void {
		if (refreshing) {
			this.#refreshingProviders.add(providerId);
			this.#startRefreshSpinner();
		} else {
			this.#refreshingProviders.delete(providerId);
			this.#stopRefreshSpinnerIfIdle();
		}
	}

	#cancelScheduledRefreshesExcept(keepProviderId?: string): void {
		for (const [providerId, timer] of this.#scheduledProviderRefreshes) {
			if (providerId === keepProviderId) continue;
			clearTimeout(timer);
			this.#scheduledProviderRefreshes.delete(providerId);
			this.#setProviderRefreshing(providerId, false);
		}
	}

	#scheduleProviderRefresh(providerId: string, options?: { force?: boolean }): void {
		if (this.#scopedModels.length > 0 || !providerId) return;
		if (this.#scheduledProviderRefreshes.has(providerId) || this.#refreshingProviders.has(providerId)) return;
		// Hovering a provider must not re-fetch on every visit: auto-refresh runs
		// at most once per provider for the process lifetime. F5 forces a re-fetch.
		if (!options?.force && autoRefreshedProviders.has(providerId)) return;
		this.#setProviderRefreshing(providerId, true);
		const timer = setTimeout(() => {
			// Consume the once-guard only when the fetch actually starts: hopping
			// through a provider cancels the debounce and must not burn its slot.
			autoRefreshedProviders.add(providerId);
			this.#scheduledProviderRefreshes.delete(providerId);
			void this.#refreshProviderInBackground(providerId);
		}, PROVIDER_REFRESH_DEBOUNCE_MS);
		this.#scheduledProviderRefreshes.set(providerId, timer);
	}

	async #refreshProviderInBackground(providerId: string): Promise<void> {
		try {
			await this.#registry.refreshProvider(providerId, "online");
			// The provider refresh already updated the registry snapshot;
			// re-reading it here stays purely in-memory.
			this.#syncFromRegistryState();
		} catch (error) {
			this.#configError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#setProviderRefreshing(providerId, false);
			this.#tui.requestRender();
		}
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) return undefined;
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) return "less than a minute ago";
		return `${Math.round(ageMs / 60_000)}m ago`;
	}

	#emptyStateMessage(): string | undefined {
		if (this.#configError) return `  ${this.#configError}`;
		const entry = this.#activeEntry();
		if (entry.kind === "recent") return "  No recently used models yet";
		if (entry.kind !== "provider" || entry.locked) return undefined;
		if (this.#browser.query.trim()) {
			return `  No matching models in ${entry.label}. Switch to All models to search every provider.`;
		}
		const providerId = entry.providerId ?? "";
		const state = this.#registry.getProviderDiscoveryState(providerId);
		if (!state) return undefined;
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable": {
				const httpMatch = state.error?.match(/^HTTP (\d+) from (.+)$/);
				if (httpMatch?.[1] === "404") {
					return `  Discovery endpoint ${httpMatch[2]} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
				}
				if (state.error) return `  Discovery failed: ${state.error}`;
				return age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.";
			}
			case "unauthenticated":
				return "  Provider requires authentication before models can be discovered.";
			case "idle":
				return "  Provider has not been refreshed yet.";
			case "empty":
				return "  Discovery succeeded but returned 0 models. Check that /models returns { data: [{ id }] }.";
			case "ok":
				return undefined;
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Assignment flow
	// ═══════════════════════════════════════════════════════════════════════

	#activateItem(item: ModelBrowserItem): void {
		if (this.#assigning) {
			const target = this.#assigning;
			this.#assigning = null;
			if (target.kind === "role") {
				this.#assignRole(item, target.role, true);
			} else if (target.kind === "fallbackKey") {
				this.#openFallbackKeyStrip(item);
			} else {
				this.#commitFallback(item, target);
			}
			return;
		}
		this.#openRoleStrip(item);
	}

	#roleForScope(role: string, scope: ModelRoleSelectionScope): ResolvedModelRoleValue {
		const roleValue =
			scope === "project" ? this.#settings.getProjectModelRole(role) : this.#settings.getGlobalModelRole(role);
		const allModels =
			this.#scopedModels.length > 0 ? this.#scopedModels.map(scoped => scoped.model) : this.#registry.getAll();
		const roleLookup: ModelRoleLookup = {
			getModelRole: scopedRole =>
				scope === "project"
					? (this.#settings.getProjectModelRole(scopedRole) ?? this.#settings.getGlobalModelRole(scopedRole))
					: this.#settings.getGlobalModelRole(scopedRole),
		};
		return resolveModelRoleValue(roleValue, allModels, { settings: this.#settings, roleLookup });
	}

	#thinkingLevelForScope(role: string, scope: ModelRoleSelectionScope): ConfiguredThinkingLevel {
		const resolved = this.#roleForScope(role, scope);
		return resolved.explicitThinkingLevel ? (resolved.thinkingLevel ?? ThinkingLevel.Inherit) : ThinkingLevel.Inherit;
	}

	/** Persist `role → item`, preserving a still-supported thinking level, then open the thinking strip. */
	#assignRole(item: ModelBrowserItem, role: string, returnToRoles: boolean, scope?: ModelRoleSelectionScope): void {
		if (this.#settings.get("modelRoleStorage") === "project" && scope === undefined) {
			this.#openScopeStrip(item, role, returnToRoles);
			return;
		}

		const current = this.#roles[role];
		let level: ConfiguredThinkingLevel = ThinkingLevel.Inherit;
		if (this.#settings.get("modelRoleStorage") === "project" && scope !== undefined) {
			level = this.#thinkingLevelForScope(role, scope);
		} else if (current && !current.autoSelected) {
			level = current.thinkingLevel;
		}
		const supported = this.#thinkingOptionsFor(item.model);
		if (!supported.includes(level)) level = ThinkingLevel.Inherit;
		// The roster itself is global-only, so a project-scoped model for a council
		// role silently applies to this repository alone.
		this.#councilStatusNotice =
			scope === "project" &&
			(this.#councilRosterRoleIds.has(role) || COUNCIL_LEAD_ROLES.includes(role)) &&
			!isProjectScopedCouncilRoster(this.#settings)
				? {
						text: `${role} model saved to project scope — the council roster is global, so other repositories keep their own model for this role`,
						tone: "warning",
					}
				: undefined;
		this.#callbacks.onAssign(item.model, role, level, item.selector, scope);
		this.#refreshAfterMutation();
		this.#openThinkingStrip(item, role, returnToRoles, scope);
	}

	#unassignRole(role: string, force = false): void {
		const assignment = this.#roles[role];
		if (!force && (!assignment || assignment.autoSelected)) return;
		if (this.#settings.get("modelRoleStorage") === "project") {
			const source = this.#settings.getModelRoleSource(role);
			this.#callbacks.onUnassign(role, source === "default" ? undefined : source);
		} else {
			this.#callbacks.onUnassign(role);
		}
		this.#refreshAfterMutation();
	}

	#thinkingOptionsFor(model: Model): ConfiguredThinkingLevel[] {
		return [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)];
	}

	#openRoleStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [];
		const scopedStorage = this.#settings.get("modelRoleStorage") === "project";
		const scopes: readonly ModelRoleSelectionScope[] = scopedStorage ? ["project", "global"] : ["global"];
		for (const role of this.#genericRoleIds()) {
			const info = getRoleInfo(role, this.#settings);
			const assignment = this.#roles[role];
			for (const scope of scopes) {
				const scopedModel = scopedStorage
					? this.#roleForScope(role, scope).model
					: assignment && !assignment.autoSelected
						? assignment.model
						: undefined;
				const assignedHere =
					!!scopedModel && scopedModel.provider === item.model.provider && scopedModel.id === item.model.id;
				const roleLabel = (info.tag ?? info.name ?? role).toLowerCase();
				const label = scopedStorage ? `${scope} ${roleLabel}` : roleLabel;
				chips.push({
					label,
					styled: assignedHere
						? // Separator required: under the `nerd` preset this glyph is a
							// two-cell-wide PUA icon that `visibleWidth` counts as one, so
							// without it the icon overhangs and eats `label`'s first char.
							theme.fg(info.color ?? "muted", `${theme.status.enabled} ${label}`) +
							theme.fg("dim", ` ${theme.status.success}`)
						: theme.fg(info.color ?? "muted", label),
					role,
					scope,
					action: assignedHere ? "unassign" : "assign",
				});
			}
		}
		chips.push({
			label: `fallbacks:${item.model.id}`,
			styled: theme.fg("muted", `fallbacks:${item.model.id}`),
			action: "fallbackModel",
		});
		chips.push({
			label: `fallbacks:${item.model.provider}/*`,
			styled: theme.fg("muted", `fallbacks:${item.model.provider}/*`),
			action: "fallbackProvider",
		});
		chips.push({ label: "fallback", styled: theme.fg("muted", "retry-fallback"), action: "fallback" });
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	#openScopeStrip(item: ModelBrowserItem, role: string, returnToRoles: boolean): void {
		const chips: StripChip[] = [
			{ label: "project", styled: theme.fg("accent", "project"), action: "scope", scope: "project" },
			{ label: "global", styled: theme.fg("muted", "global"), action: "scope", scope: "global" },
		];
		this.#strip = { kind: "scope", item, role, chips, index: 0, returnToRoles };
	}

	#openThinkingStrip(
		item: ModelBrowserItem,
		role: string,
		returnToRoles: boolean,
		scope?: ModelRoleSelectionScope,
	): void {
		const options = this.#thinkingOptionsFor(item.model);
		const current =
			this.#settings.get("modelRoleStorage") === "project" && scope !== undefined
				? this.#thinkingLevelForScope(role, scope)
				: (this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit);
		const chips: StripChip[] = options.map(level => {
			const label = getConfiguredThinkingLevelMetadata(level).label;
			const glyph = thinkingLevelGlyph(level);
			return {
				label,
				styled: glyph ? `${theme.fg("accent", glyph)} ${label}` : label,
				action: "thinking",
				thinkingLevel: level,
			};
		});
		const preselect = options.indexOf(current);
		this.#strip = {
			kind: "thinking",
			item,
			role,
			scope,
			chips,
			index: preselect >= 0 ? preselect : 0,
			returnToRoles,
		};
	}

	#closeStrip(): void {
		const strip = this.#strip;
		this.#strip = null;
		this.#chipRanges = [];
		if ((strip?.kind === "scope" || strip?.kind === "thinking") && strip.returnToRoles) {
			this.#setActiveEntry("roles");
			this.#focus = "list";
		}
	}

	#activateStripChip(): void {
		const strip = this.#strip;
		if (!strip || strip.kind === "roleName") return;
		const chip = strip.chips[strip.index];
		if (!chip) return;
		if (strip.kind === "councilRound") {
			// The chooser has no `item`; it only stashes the round the name strip will apply.
			if (chip.action !== "councilRound" || chip.councilRound === undefined) return;
			this.#pendingCouncilRound = chip.councilRound;
			this.#strip = null;
			this.#chipRanges = [];
			this.#openRoleNameStrip("newCouncilMember");
			return;
		}
		switch (chip.action) {
			case "assign":
				if (chip.role) {
					this.#strip = null;
					this.#assignRole(strip.item, chip.role, false, chip.scope);
				}
				return;
			case "unassign":
				if (chip.role) {
					if (this.#settings.get("modelRoleStorage") === "project") {
						this.#callbacks.onUnassign(chip.role, chip.scope);
					} else {
						this.#callbacks.onUnassign(chip.role);
					}
					this.#refreshAfterMutation();
				}
				this.#closeStrip();
				return;
			case "fallback":
				this.#appendFallback(strip.item, "default");
				this.#closeStrip();
				return;
			case "fallbackModel":
				this.#closeStrip();
				this.#startAssignFallback(strip.item.selector, null);
				return;
			case "fallbackProvider":
				this.#closeStrip();
				this.#startAssignFallback(`${strip.item.model.provider}/*`, null);
				return;
			case "scope":
				if (strip.role && chip.scope) {
					this.#strip = null;
					this.#assignRole(strip.item, strip.role, strip.returnToRoles, chip.scope);
				}
				return;
			case "thinking":
				if (strip.role && chip.thinkingLevel !== undefined) {
					this.#callbacks.onAssign(
						strip.item.model,
						strip.role,
						chip.thinkingLevel,
						strip.item.selector,
						strip.scope,
					);
					this.#refreshAfterMutation();
				}
				this.#closeStrip();
				return;
			case "councilRound":
				// Only reachable from the chooser, which is handled above.
				return;
		}
	}

	/** Switch the body into assign mode for `role`: full catalog, cleared query, current model preselected. */
	#startAssign(role: string): void {
		this.#assigning = { kind: "role", role };
		this.#focus = "scope";
		this.#browser.setShowProvider(true);
		this.#browser.setItems([...this.#availableItems]);
		this.#browser.setQuery("");
		const current = this.#roles[role];
		if (current) {
			this.#browser.selectSelector(`${current.model.provider}/${current.model.id}`);
		}
	}

	/** Browse the catalog to fill a fallback-chain slot: `index` replaces an entry, `null` appends. */
	#startAssignFallback(role: string, index: number | null): void {
		this.#assigning = { kind: "fallback", role, index };
		this.#focus = "scope";
		this.#browser.setShowProvider(true);
		this.#browser.setItems([...this.#availableItems]);
		this.#browser.setQuery("");
		if (index !== null) {
			const selector = this.#fallbackChains()[role]?.[index];
			if (selector) this.#browser.selectSelector(selector);
		}
	}

	/** Browse the catalog for the primary model a brand-new fallback chain protects. */
	#startAssignFallbackKey(): void {
		this.#assigning = { kind: "fallbackKey" };
		this.#focus = "scope";
		this.#browser.setShowProvider(true);
		this.#browser.setItems([...this.#availableItems]);
		this.#browser.setQuery("");
	}

	/** Second step of "+ New fallback…": key the chain by the picked model or its whole provider. */
	#openFallbackKeyStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [
			{
				label: `for ${item.selector}`,
				styled: theme.fg("muted", `for ${item.selector}`),
				action: "fallbackModel",
			},
			{
				label: `for ${item.model.provider}/*`,
				styled: theme.fg("muted", `for ${item.model.provider}/*`),
				action: "fallbackProvider",
			},
		];
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	/** Write the picked model into the target chain slot, dedupe, and land back on its Roles row. */
	#commitFallback(item: ModelBrowserItem, target: { role: string; index: number | null }): void {
		const chain = [...(this.#fallbackChains()[target.role] ?? [])];
		const selector = item.selector;
		if (target.index !== null && target.index < chain.length) {
			chain[target.index] = selector;
			for (let i = chain.length - 1; i >= 0; i--) {
				if (i !== target.index && chain[i] === selector) chain.splice(i, 1);
			}
		} else if (!chain.includes(selector)) {
			chain.push(selector);
		}
		this.#setFallbackChain(target.role, chain);
		this.#browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
		const rowIndex = this.#rolesRows.findIndex(
			row => row.kind === "fallback" && row.role === target.role && row.selector === selector,
		);
		if (rowIndex >= 0) this.#setRoleIndex(rowIndex);
	}

	/** Persist `role`'s chain through the host callback and rebuild dependent state. */
	#setFallbackChain(role: string, chain: string[]): void {
		this.#callbacks.onFallbackChainChange?.(role, chain);
		this.#refreshAfterMutation();
	}

	/** Append `item` to `role`'s fallback chain (no-op when already present). */
	#appendFallback(item: ModelBrowserItem, role: string): void {
		const chain = [...(this.#fallbackChains()[role] ?? [])];
		if (chain.includes(item.selector)) return;
		chain.push(item.selector);
		this.#setFallbackChain(role, chain);
	}

	/** Remove one chain entry; the cursor stays on the nearest surviving row. */
	#removeFallback(row: { role: string; chainIndex: number }): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		if (row.chainIndex >= chain.length) return;
		chain.splice(row.chainIndex, 1);
		this.#setFallbackChain(row.role, chain);
		this.#setRoleIndex(Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1)));
	}

	/** Move a chain entry one slot earlier/later; the cursor follows the moved entry. */
	#moveFallback(row: { role: string; chainIndex: number }, delta: -1 | 1): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		const target = row.chainIndex + delta;
		if (row.chainIndex >= chain.length || target < 0 || target >= chain.length) return;
		[chain[row.chainIndex], chain[target]] = [chain[target], chain[row.chainIndex]];
		this.#setFallbackChain(row.role, chain);
		this.#setRoleIndex(this.#roleIndex + delta);
	}

	/**
	 * The roster exactly as it must be written back to `council.members`: the validated rows plus any
	 * malformed pin a salvaged row still carries.
	 *
	 * Every writer goes through this. A second, ad hoc projection of `#councilMembers` is precisely
	 * how the relocation path silently dropped a broken `round` the row editor was preserving. Rows
	 * are always cloned so a caller can never hand a live `#councilMembers` object to a callback.
	 */
	#councilRosterWrite(members: readonly CouncilMemberSetting[] = this.#councilMembers): CouncilMemberSetting[] {
		return members.map(member => {
			if (member.round !== undefined || !this.#councilMalformedRounds.has(member.role)) return { ...member };
			// The one place a `round` outside `1 | 2` is produced. It is the malformed value the config
			// still carries, written back verbatim so an unrelated edit cannot silently repair — and so
			// destroy — a pin the user has yet to fix. The setting itself is an unvalidated array, and
			// the next reload re-classifies this row as faulty, so nothing downstream trusts the type.
			return { ...member, round: this.#councilMalformedRounds.get(member.role) } as CouncilMemberSetting;
		});
	}

	/**
	 * Refuse, before anything is persisted, a roster mutation that would run more reviewers in a
	 * configured round than the adjudication grade schema can address. The notice lands on the
	 * status row, so the roster rows and the cursor stay exactly where the user left them.
	 *
	 * A roster loaded from disk can already be over the limit, and the salvage rows are the repair.
	 * Only a mutation that makes an over-limit roster *worse* is refused, so 66 -> 65 -> 64 walks
	 * back down while 64 -> 65 is still turned away.
	 */
	#refusesCouncilCap(members: readonly CouncilMemberSetting[], rounds: 1 | 2, mutation: string): boolean {
		const active = countActiveCouncilMembers(members, rounds);
		if (active <= COUNCIL_MAX_ACTIVE_REVIEWERS) return false;
		if (active <= countActiveCouncilMembers(this.#councilMembers, this.#councilRounds)) return false;
		this.#councilStatusNotice = {
			text: `${mutation} refused: ${active} reviewers would run, over the ${COUNCIL_MAX_ACTIVE_REVIEWERS} active-reviewer limit. Disable a reviewer, or pin one past round ${rounds}, first`,
			tone: "error",
		};
		this.#tui.requestRender();
		return true;
	}

	/**
	 * Persist a roster edit, then restore focus to the edited member in the rebuilt row list.
	 *
	 * A malformed pin recorded during salvage is written back verbatim unless this very edit
	 * supplied a real round for that role, so an unrelated toggle, reorder, or delete leaves a
	 * broken `round` exactly as the user left it instead of silently repairing it to every round.
	 */
	#persistCouncilMembers(members: CouncilMemberSetting[], focusRole?: string): void {
		this.#callbacks.onCouncilRosterChange?.(this.#councilRosterWrite(members));
		this.#refreshAfterMutation();
		if (focusRole) {
			const index = this.#rolesRows.findIndex(row => row.kind === "councilRole" && row.member.role === focusRole);
			if (index >= 0) this.#setRoleIndex(index);
		}
	}

	#toggleCouncilMember(role: string): void {
		const member = this.#councilMembers.find(candidate => candidate.role === role);
		if (!member) return;
		const members = this.#councilMembers.map(candidate =>
			candidate.role === role ? { ...candidate, enabled: !candidate.enabled } : { ...candidate },
		);
		if (this.#refusesCouncilCap(members, this.#councilRounds, `Enabling ${this.#roleDisplayLabel(role, true)}`)) {
			return;
		}
		this.#persistCouncilMembers(members, role);
	}

	#moveCouncilMember(role: string, delta: -1 | 1): void {
		const members = this.#councilMembers.map(member => ({ ...member }));
		const index = members.findIndex(member => member.role === role);
		const target = index + delta;
		if (index < 0 || target < 0 || target >= members.length) return;
		[members[index], members[target]] = [members[target], members[index]];
		this.#persistCouncilMembers(members, role);
	}

	#removeCouncilMember(role: string): void {
		const index = this.#councilMembers.findIndex(member => member.role === role);
		if (index < 0) return;
		const nextMembers = this.#councilMembers
			.filter(candidate => candidate.role !== role)
			.map(candidate => ({ ...candidate }));
		const nextFocus = nextMembers[Math.min(index, nextMembers.length - 1)]?.role;
		this.#unassignRole(role, true);
		this.#persistCouncilMembers(nextMembers, nextFocus);
		if (!nextFocus) {
			const addIndex = this.#rolesRows.findIndex(row => row.kind === "newCouncilMember");
			if (addIndex >= 0) this.#setRoleIndex(addIndex);
		}
	}

	/**
	 * Create a roster slot from the collected name, pinned to `group`. A name matching the durable
	 * role grammar becomes the role id; anything else is kept as a display name
	 * over the auto-generated id, because renaming a role id would orphan
	 * project-scoped `modelRoles` assignments in every other repository. Empty
	 * input takes the auto id with no display name. Returns the new role id, or
	 * `undefined` when the name is unusable.
	 */
	#createCouncilMember(name: string, group: CouncilRoundGroup): string | undefined {
		const used = new Set(this.#councilMembers.map(member => member.role));
		let suffix = 1;
		while (used.has(`council${suffix}`)) suffix++;
		let role = `council${suffix}`;
		let displayName: string | undefined;
		if (name.length > 0) {
			if (COUNCIL_ROLE_ID.test(name)) {
				// `planner`/`adjudicator` are the council leads, not roster ids.
				if (used.has(name) || this.#visibleRoleIds().includes(name) || COUNCIL_LEAD_ROLES.includes(name)) {
					return undefined;
				}
				role = name;
			} else {
				if (name.length > COUNCIL_DISPLAY_NAME_MAX_LENGTH || !COUNCIL_DISPLAY_NAME_PATTERN.test(name)) {
					return undefined;
				}
				displayName = name;
			}
		}
		const round = group === "every" ? undefined : group;
		this.#persistCouncilMembers(
			[
				...this.#councilMembers.map(member => ({ ...member })),
				{ role, enabled: true, ...(round === undefined ? {} : { round }) },
			],
			role,
		);
		if (displayName !== undefined) this.#setCouncilDisplayName(role, displayName);
		return role;
	}

	/** Cycle one member through `every → 1 → 2 → every`, bounded by the configured round count. */
	#cycleCouncilMemberRound(role: string): void {
		const current = this.#councilMembers.find(candidate => candidate.role === role);
		if (!current) return;
		const order: CouncilRoundGroup[] = [
			"every",
			...(Array.from({ length: this.#councilRounds }, (_v, i) => i + 1) as (1 | 2)[]),
		];
		const next = order[(order.indexOf(current.round ?? "every") + 1) % order.length] ?? "every";
		const round = next === "every" ? undefined : next;
		const members = this.#councilMembers.map(candidate =>
			candidate.role === role
				? { role: candidate.role, enabled: candidate.enabled, ...(round === undefined ? {} : { round }) }
				: { ...candidate },
		);
		// A pin beyond `council.rounds` is inert, so cycling it back into range is the one round edit
		// that can add an active reviewer.
		if (this.#refusesCouncilCap(members, this.#councilRounds, `Unparking ${this.#roleDisplayLabel(role, true)}`)) {
			return;
		}
		this.#persistCouncilMembers(members, role);
	}

	/**
	 * Persist a council member's user-facing name in `modelTags`. The durable role
	 * id is never touched, so project-scoped model assignments keep resolving.
	 */
	#setCouncilDisplayName(role: string, name: string | undefined): void {
		const index = this.#roleIndex;
		this.#callbacks.onRoleDisplayNameChange?.(role, name);
		this.#refreshAfterMutation();
		this.#setRoleIndex(index);
	}

	#setCouncilRounds(rounds: 1 | 2): void {
		if (rounds === this.#councilRounds && !this.#councilRoundsInvalid) return;
		// Raising the round count activates every member pinned to the round being opened.
		if (
			this.#refusesCouncilCap(
				this.#councilMembers,
				rounds,
				`Setting ${rounds} review round${rounds === 1 ? "" : "s"}`,
			)
		) {
			return;
		}
		const index = this.#roleIndex;
		this.#callbacks.onCouncilRoundsChange?.(rounds);
		this.#refreshAfterMutation();
		this.#setRoleIndex(index);
	}

	#toggleCouncilAdvisor(scope: CouncilAdvisorScope): void {
		const index = this.#roleIndex;
		this.#callbacks.onCouncilAdvisorChange?.(scope, !this.#councilAdvisor[scope]);
		this.#refreshAfterMutation();
		this.#setRoleIndex(index);
	}

	/**
	 * First step of "+ Add reviewer…" while two rounds are configured: choose the round before
	 * naming the member, so the new row lands in the group the user meant. Escape aborts the whole
	 * add rather than falling back to an unpinned member nobody asked for.
	 */
	#openCouncilRoundStrip(): void {
		const chips: StripChip[] = [
			{ label: "round 1", styled: theme.fg("accent", "round 1"), action: "councilRound", councilRound: 1 },
			{ label: "round 2", styled: theme.fg("muted", "round 2"), action: "councilRound", councilRound: 2 },
			{
				label: "every round",
				styled: theme.fg("muted", "every round"),
				action: "councilRound",
				councilRound: "every",
			},
		];
		this.#strip = { kind: "councilRound", chips, index: 0 };
	}

	/**
	 * Relocate a project-scoped roster: write the global destination, confirm it
	 * landed there, and only then drop the project key. A destination write that
	 * does not land leaves the project roster exactly as it was.
	 *
	 * Refused outright when the rows are a lossy salvage: relocation may only ever move a roster
	 * this editor can reproduce faithfully, otherwise the reduced copy would be written to global
	 * and the project key — still holding the entries that were dropped — deleted behind it.
	 */
	async #moveCouncilRosterToGlobal(): Promise<void> {
		const clearProjectRoster = this.#callbacks.onCouncilRosterProjectClear;
		if (!clearProjectRoster) return;
		if (this.#councilRosterSalvageLossy) {
			const projectPath = shortenPath(
				this.#settings.getProjectSettingSource("council.members") ?? "the project configuration",
			);
			this.#councilStatusNotice = {
				text: `Roster has entries this editor cannot read; move refused. Fix council.members in ${projectPath} first`,
				tone: "error",
			};
			this.#tui.requestRender();
			return;
		}
		// The same serializer the row editor uses: relocating a roster must not be the one write that
		// silently repairs (and so loses) a malformed pin the user still has to fix.
		const members = this.#councilRosterWrite();
		try {
			this.#callbacks.onCouncilRosterChange?.(members);
		} catch (error) {
			this.#councilStatusNotice = {
				text: `Global roster write failed: ${error instanceof Error ? error.message : String(error)}; project roster kept`,
				tone: "error",
			};
			this.#tui.requestRender();
			return;
		}
		const landed = this.#settings.getRawSetting("council.members", "global");
		const wroteRoster =
			landed.configured &&
			landed.blockedByParent !== true &&
			Array.isArray(landed.value) &&
			landed.value.length === members.length &&
			landed.value.every(
				(entry, index) =>
					isRecord(entry) && entry.role === members[index]?.role && entry.round === members[index]?.round,
			);
		if (!wroteRoster) {
			this.#councilStatusNotice = {
				text: "Global roster write did not land; project roster kept",
				tone: "error",
			};
			this.#tui.requestRender();
			return;
		}
		try {
			await clearProjectRoster();
			this.#councilStatusNotice = { text: "Council roster moved to global config", tone: "warning" };
		} catch (error) {
			this.#councilStatusNotice = {
				text: `Global roster written, but the project key remains: ${error instanceof Error ? error.message : String(error)}`,
				tone: "error",
			};
		}
		this.#refreshAfterMutation();
	}

	#cancelAssign(): void {
		this.#assigning = null;
		this.#browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Quick-switch cycle (ctrl+p) editing
	// ═══════════════════════════════════════════════════════════════════════

	#cycleOrder(): string[] {
		try {
			return [...this.#settings.get("cycleOrder")];
		} catch {
			return [];
		}
	}

	/** Toggle `role`'s membership in the quick-switch cycle (appended at the end). */
	#toggleCycleMembership(role: string): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		if (index >= 0) {
			order.splice(index, 1);
		} else {
			order.push(role);
		}
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/** Move `role` one slot earlier/later within the cycle order. */
	#moveCycleMembership(role: string, delta: -1 | 1): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		const target = index + delta;
		if (index < 0 || target < 0 || target >= order.length) return;
		[order[index], order[target]] = [order[target], order[index]];
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/**
	 * Open the footer name input. `councilDisplayName` prefills the current label
	 * so an edit reads as a rename rather than a blank prompt.
	 */
	#openRoleNameStrip(mode: RoleNameMode, role?: string): void {
		const input = new Input();
		if (mode === "councilDisplayName" && role !== undefined) input.setValue(this.#roleDisplayLabel(role, true));
		this.#strip = { kind: "roleName", mode, role, input };
	}

	/** Validate and commit the collected name. Invalid input keeps the strip open. */
	#submitRoleName(): void {
		const strip = this.#strip;
		if (strip?.kind !== "roleName") return;
		const name = strip.input.getValue().trim();
		switch (strip.mode) {
			case "newRole": {
				if (!ROLE_NAME_PATTERN.test(name)) return;
				if (this.#visibleRoleIds().includes(name) || this.#councilRosterRoleIds.has(name)) return;
				if (COUNCIL_LEAD_ROLES.includes(name)) return;
				this.#strip = null;
				this.#chipRanges = [];
				this.#startAssign(name);
				return;
			}
			case "newCouncilMember": {
				const role = this.#createCouncilMember(name, this.#pendingCouncilRound);
				if (role === undefined) return;
				this.#strip = null;
				this.#chipRanges = [];
				this.#startAssign(role);
				return;
			}
			case "councilDisplayName": {
				const role = strip.role;
				if (role === undefined) return;
				if (
					name.length > 0 &&
					(name.length > COUNCIL_DISPLAY_NAME_MAX_LENGTH || !COUNCIL_DISPLAY_NAME_PATTERN.test(name))
				) {
					return;
				}
				this.#strip = null;
				this.#chipRanges = [];
				this.#setCouncilDisplayName(role, name.length > 0 ? name : undefined);
				return;
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}

		if (this.#strip) {
			this.#handleStripInput(data);
			return;
		}

		if (matchesSelectCancel(data)) {
			if (this.#assigning !== null) {
				this.#cancelAssign();
				return;
			}
			const entry = this.#activeEntry();
			if (this.#isBrowserView(entry) && this.#browser.query.length > 0) {
				this.#browser.handleCancel();
				return;
			}
			this.#callbacks.onCancel();
			return;
		}

		const entry = this.#activeEntry();
		const rolesView = entry.kind === "roles" && this.#assigning === null;
		const lockedView = entry.kind === "provider" && entry.locked && this.#assigning === null;

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			return;
		}
		if (matchesKey(data, "f5")) {
			if (entry.kind === "provider" && !entry.locked) {
				this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
			}
			return;
		}

		// ←/→ are spatial pane switches: the sidebar sits left of the rows.
		// They never reach the search caret — fuzzy queries don't need one.
		if (matchesKey(data, "left")) {
			this.#focus = "scope";
			return;
		}
		if (matchesKey(data, "right")) {
			// Only views with rows can take list focus (not the locked pane).
			if (rolesView || this.#isBrowserView(entry)) {
				this.#focus = "list";
			}
			return;
		}

		// Arrow ownership: scope mode hops the sidebar; list mode navigates rows.
		if (this.#focus === "scope") {
			if (matchesSelectUp(data)) {
				this.#moveSidebar(-1);
				return;
			}
			if (matchesSelectDown(data)) {
				this.#moveSidebar(1);
				return;
			}
		}

		if (rolesView) {
			const printable = extractPrintableText(data);
			if (this.#focus === "scope" && printable !== undefined && printable.trim().length > 0) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.#browser.handleInput(data);
				return;
			}
			this.#handleRolesViewInput(data);
			return;
		}
		if (lockedView) {
			const printable = extractPrintableText(data);
			if (printable !== undefined && printable.trim().length > 0) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.#browser.handleInput(data);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#requestLogin(entry);
			}
			return;
		}

		const beforeQuery = this.#browser.query;
		const isPrintable = extractPrintableText(data) !== undefined;
		this.#browser.handleInput(data);
		if (isPrintable || this.#browser.query !== beforeQuery) {
			this.#focus = "list";
		}
	}

	#isBrowserView(entry: SidebarEntry): boolean {
		if (this.#assigning !== null) return true;
		return entry.kind === "recent" || entry.kind === "all" || (entry.kind === "provider" && !entry.locked);
	}

	#handleStripInput(data: string): void {
		const strip = this.#strip;
		if (!strip) return;
		if (matchesSelectCancel(data)) {
			this.#closeStrip();
			return;
		}
		if (strip.kind === "roleName") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#submitRoleName();
				return;
			}
			strip.input.handleInput(data);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			strip.index = (strip.index - 1 + strip.chips.length) % strip.chips.length;
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
			strip.index = (strip.index + 1) % strip.chips.length;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateStripChip();
			return;
		}
	}

	#moveSidebar(delta: number): void {
		const count = this.#entries.length;
		if (count === 0) return;
		let index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		if (index < 0) index = 0;
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = this.#entries[index];
			if (entry && !this.#isHopSkipped(entry)) {
				// Scope changes keep an active assignment (scoping helps find the
				// model); landing on the Roles view cancels it.
				if (entry.kind === "roles") this.#assigning = null;
				this.#setActiveEntry(entry.id);
				return;
			}
		}
	}

	/** Row count of the combined generic-role and council view. */
	get #rolesRowCount(): number {
		return this.#rolesRows.length;
	}

	#isSelectableRolesRow(row: RolesRow | undefined): boolean {
		return (
			row !== undefined &&
			row.kind !== "separator" &&
			row.kind !== "sectionHeader" &&
			row.kind !== "councilRoundHeader"
		);
	}

	#setRoleIndex(index: number): void {
		this.#roleIndex = Math.max(0, Math.min(index, Math.max(0, this.#rolesRows.length - 1)));
		this.#rolesFollowActive = true;
	}

	/** Enter/click activation for a Roles-view row. */
	#activateRolesRow(row: RolesRow): void {
		switch (row.kind) {
			case "role":
				this.#startAssign(row.role);
				return;
			case "councilRole":
				if (!this.#councilRowsLocked) this.#startAssign(row.member.role);
				return;
			case "councilLead":
				this.#startAssign(row.role);
				return;
			case "councilAdvisor":
				this.#toggleCouncilAdvisor(row.scope);
				return;
			case "councilRounds":
				if (!this.#councilRowsLocked) this.#setCouncilRounds(row.rounds === 1 ? 2 : 1);
				return;
			case "councilNotice":
				if (row.action === "moveToGlobal") void this.#moveCouncilRosterToGlobal();
				return;
			case "chainKey":
				this.#startAssignFallback(row.role, null);
				return;
			case "fallback":
				this.#startAssignFallback(row.role, row.chainIndex);
				return;
			case "newFallback":
				this.#startAssignFallbackKey();
				return;
			case "newRole":
				this.#openRoleNameStrip("newRole");
				return;
			case "newCouncilMember": {
				// Every round a new reviewer can be pinned to is a configured one, so it always joins the
				// active set. Refuse before the naming prompt rather than after the user has typed a name.
				const prospective = [...this.#councilMembers, { role: "", enabled: true }];
				if (this.#refusesCouncilCap(prospective, this.#councilRounds, "Adding a reviewer")) return;
				// With two rounds configured the group is ambiguous, so it is chosen before naming.
				if (this.#councilRounds === 2) this.#openCouncilRoundStrip();
				else {
					this.#pendingCouncilRound = "every";
					this.#openRoleNameStrip("newCouncilMember");
				}
				return;
			}
			case "separator":
			case "sectionHeader":
			case "councilRoundHeader":
				return;
		}
	}

	/** Step the roles cursor by one row, skipping separator rows. Wraps at the ends unless `wrap: false` (then the cursor stays put). */
	#stepRoleIndex(from: number, delta: -1 | 1, options: { wrap?: boolean } = {}): number {
		const wrap = options.wrap ?? true;
		const count = this.#rolesRows.length;
		if (count === 0) return 0;
		let index = from;
		for (let i = 0; i < count; i++) {
			const next = index + delta;
			if (next < 0 || next >= count) {
				if (!wrap) return from;
				index = (next + count) % count;
			} else {
				index = next;
			}
			if (this.#isSelectableRolesRow(this.#rolesRows[index])) return index;
		}
		return from;
	}

	#handleRolesViewInput(data: string): void {
		// Scope focus treats the roles view as a preview: Enter/Space dives
		// into the rows, everything else is inert (arrows already hop).
		if (this.#focus === "scope") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || matchesKey(data, "space")) {
				this.#focus = "list";
			}
			return;
		}
		if (matchesSelectUp(data)) {
			this.#councilStatusNotice = undefined;
			this.#setRoleIndex(this.#stepRoleIndex(this.#roleIndex, -1));
			return;
		}
		if (matchesSelectDown(data)) {
			this.#councilStatusNotice = undefined;
			this.#setRoleIndex(this.#stepRoleIndex(this.#roleIndex, 1));
			return;
		}
		const row = this.#rolesRows[this.#roleIndex];
		const role = row?.kind === "role" ? row.role : undefined;
		// A project-scoped roster renders read-only: every roster edit writes the global key, which is
		// not the file the refusal is about. Lead rows write `modelRoles` and advisor rows write
		// `council.advisor.*`, so neither is locked by a misplaced roster.
		const councilRole = row?.kind === "councilRole" && !this.#councilRowsLocked ? row.member.role : undefined;
		const roundsRow = row?.kind === "councilRounds" && !this.#councilRowsLocked ? row : undefined;
		const leadRole = row?.kind === "councilLead" ? row.role : undefined;
		const advisorScope = row?.kind === "councilAdvisor" ? row.scope : undefined;
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			if (row) this.#activateRolesRow(row);
			return;
		}
		if (advisorScope && matchesKey(data, "space")) {
			this.#toggleCouncilAdvisor(advisorScope);
			return;
		}
		if (roundsRow && matchesKey(data, "space")) {
			this.#setCouncilRounds(roundsRow.rounds === 1 ? 2 : 1);
			return;
		}
		if (councilRole && matchesKey(data, "space")) {
			this.#toggleCouncilMember(councilRole);
			return;
		}
		if (councilRole && matchesKey(data, "delete")) {
			this.#removeCouncilMember(councilRole);
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			if (role) this.#unassignRole(role);
			else if (row?.kind === "fallback") this.#removeFallback(row);
			else if (row?.kind === "chainKey") this.#setFallbackChain(row.role, []);
			return;
		}
		// Reordering: [ / shift+↑ moves the row earlier, ] / shift+↓ later —
		// cycle order on a role row, chain order on a fallback row.
		if (matchesKey(data, "shift+up")) {
			if (councilRole) this.#moveCouncilMember(councilRole, -1);
			else if (roundsRow) this.#setCouncilRounds(1);
			else if (role) this.#moveCycleMembership(role, -1);
			else if (row?.kind === "fallback") this.#moveFallback(row, -1);
			return;
		}
		if (matchesKey(data, "shift+down")) {
			if (councilRole) this.#moveCouncilMember(councilRole, 1);
			else if (roundsRow) this.#setCouncilRounds(2);
			else if (role) this.#moveCycleMembership(role, 1);
			else if (row?.kind === "fallback") this.#moveFallback(row, 1);
			return;
		}
		const printable = extractPrintableText(data);
		if (printable === " ") {
			if (councilRole) this.#toggleCouncilMember(councilRole);
			else if (advisorScope) this.#toggleCouncilAdvisor(advisorScope);
			return;
		}
		if (printable === "x") {
			if (leadRole) this.#unassignRole(leadRole, true);
			else if (councilRole) this.#unassignRole(councilRole, true);
			else if (role) this.#unassignRole(role);
			else if (row?.kind === "fallback") this.#removeFallback(row);
			else if (row?.kind === "chainKey") this.#setFallbackChain(row.role, []);
			return;
		}
		if (printable === "r" && councilRole) {
			this.#cycleCouncilMemberRound(councilRole);
			return;
		}
		if (printable === "f") {
			if (row?.kind === "newFallback") this.#startAssignFallbackKey();
			else if (row?.kind === "role" || row?.kind === "chainKey" || row?.kind === "fallback") {
				this.#startAssignFallback(row.role, null);
			}
			return;
		}
		if (printable === "c") {
			if (role) this.#toggleCycleMembership(role);
			return;
		}
		if (printable === "[") {
			if (councilRole) this.#moveCouncilMember(councilRole, -1);
			else if (roundsRow) this.#setCouncilRounds(1);
			else if (role) this.#moveCycleMembership(role, -1);
			else if (row?.kind === "fallback") this.#moveFallback(row, -1);
			return;
		}
		if (printable === "]") {
			if (councilRole) this.#moveCouncilMember(councilRole, 1);
			else if (roundsRow) this.#setCouncilRounds(2);
			else if (role) this.#moveCycleMembership(role, 1);
			else if (row?.kind === "fallback") this.#moveFallback(row, 1);
			return;
		}
		if (printable === "n") {
			// A lead rename writes `modelTags[role].name` only: `planner`/`adjudicator` are reserved as
			// roster ids, and the durable role id — which `modelRoles` and every refusal remedy name —
			// is never touched, exactly as for a reviewer row.
			if (leadRole) this.#openRoleNameStrip("councilDisplayName", leadRole);
			else if (councilRole) this.#openRoleNameStrip("councilDisplayName", councilRole);
			else if (row?.kind === "newCouncilMember") this.#activateRolesRow(row);
			else if (role || row?.kind === "newRole" || row?.kind === "fallback" || row?.kind === "chainKey") {
				this.#openRoleNameStrip("newRole");
			}
			return;
		}
		if (printable === "t") {
			const assignment = role ? this.#roles[role] : undefined;
			if (role && assignment) {
				const source =
					this.#settings.get("modelRoleStorage") === "project"
						? this.#settings.getModelRoleSource(role)
						: "default";
				const scope = source === "project" || source === "global" ? source : undefined;
				const scopedModel = scope ? this.#roleForScope(role, scope).model : assignment.model;
				if (!scopedModel) return;
				const item: ModelBrowserItem = {
					provider: scopedModel.provider,
					id: scopedModel.id,
					model: scopedModel,
					selector: `${scopedModel.provider}/${scopedModel.id}`,
				};
				this.#openThinkingStrip(item, role, true, scope);
			}
			return;
		}
	}

	#requestLogin(entry: SidebarEntry): void {
		if (!entry.providerId) return;
		if (entry.oauth) {
			this.#callbacks.onLoginRequest?.(entry.providerId);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mouse
	// ═══════════════════════════════════════════════════════════════════════

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const contentLine = event.row - this.#contentRowStart;
		const overContent = contentLine >= 0 && contentLine < this.#contentRowCount;
		const sidebarColStart = 2;
		const sidebarColEnd = sidebarColStart + this.#sidebarWidthLast;
		const bodyColStart = this.#sidebarWidthLast + 5;
		const overSidebar = overContent && event.col >= 0 && event.col < sidebarColEnd;
		const overBody = overContent && event.col >= bodyColStart;
		const bodyLine = contentLine - 1; // body row 0 is the status row
		const entry = this.#activeEntry();

		// Footer strip chips.
		if (event.row === this.#footerRow && this.#strip) {
			const strip = this.#strip;
			if (event.leftClick && strip.kind !== "roleName") {
				for (const range of this.#chipRanges) {
					if (event.col >= range.start && event.col < range.end) {
						strip.index = range.index;
						this.#activateStripChip();
						return true;
					}
				}
			}
			return true;
		}

		if (event.wheel !== null) {
			if (overSidebar) {
				// Wheel pans the sidebar viewport; picking a scope is click/keys only.
				const maxScroll = Math.max(0, this.#entries.length - this.#contentRowCount);
				this.#sidebarScroll = Math.max(0, Math.min(this.#sidebarScroll + event.wheel, maxScroll));
				this.#sidebarHover = this.#sidebarEntryIndexAt(contentLine);
			} else if (overBody) {
				if (entry.kind === "roles" && this.#assigning === null) {
					const maxScroll = Math.max(0, this.#rolesRows.length - this.#rolesViewportRows);
					this.#rolesScroll = Math.max(0, Math.min(this.#rolesScroll + event.wheel, maxScroll));
					this.#rolesFollowActive = false;
					this.#roleHover = null;
				} else if (this.#isBrowserView(entry)) {
					this.#browser.routeMouse(event, bodyLine);
				}
			}
			return true;
		}

		if (event.motion) {
			this.#sidebarHover = overSidebar ? this.#sidebarEntryIndexAt(contentLine) : null;
			if (overBody && entry.kind === "roles" && this.#assigning === null) {
				const hoveredRow = this.#rolesLineToRow.get(bodyLine);
				this.#roleHover = this.#isSelectableRolesRow(
					hoveredRow === undefined ? undefined : this.#rolesRows[hoveredRow],
				)
					? (hoveredRow ?? null)
					: null;
			} else {
				this.#roleHover = null;
				if (overBody && this.#isBrowserView(entry)) {
					this.#browser.routeMouse(event, bodyLine);
				} else {
					// Pointer left the browser pane: without this, the last
					// hovered row keeps its band while the sidebar hovers too.
					this.#browser.clearHover();
				}
			}
			return true;
		}

		if (!event.leftClick) return true;

		if (overSidebar) {
			const index = this.#sidebarEntryIndexAt(contentLine);
			const clicked = index !== null ? this.#entries[index] : undefined;
			if (clicked && clicked.kind !== "separator") {
				const already = clicked.id === this.#activeEntryId;
				if (clicked.kind === "roles") this.#assigning = null;
				this.#setActiveEntry(clicked.id);
				// A click on Roles is a deliberate dive into the rows.
				if (clicked.kind === "roles") this.#focus = "list";
				if (already && clicked.kind === "provider" && clicked.locked) {
					this.#requestLogin(clicked);
				}
			}
			return true;
		}

		if (overBody) {
			if (entry.kind === "roles" && this.#assigning === null) {
				const rowIndex = this.#rolesLineToRow.get(bodyLine);
				const rowDef = rowIndex === undefined ? undefined : this.#rolesRows[rowIndex];
				if (rowIndex !== undefined && this.#isSelectableRolesRow(rowDef)) {
					this.#focus = "list";
					if (rowIndex === this.#roleIndex && rowDef) {
						this.#activateRolesRow(rowDef);
					} else {
						this.#setRoleIndex(rowIndex);
					}
				}
			} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
				if (this.#lockedLoginLine !== null && bodyLine === this.#lockedLoginLine) {
					this.#requestLogin(entry);
				}
			} else if (this.#isBrowserView(entry)) {
				this.#browser.routeMouse(event, bodyLine);
			}
		}
		return true;
	}

	/** Map a content-line index to a sidebar entry index (accounting for scroll). */
	#sidebarEntryIndexAt(contentLine: number): number | null {
		const index = this.#sidebarScroll + contentLine;
		if (index < 0 || index >= this.#entries.length) return null;
		return index;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Sidebar width from its widest entry, clamped so a long fixed label never
	 * starves the body pane on a narrow terminal.
	 */
	#sidebarWidth(frameWidth: number): number {
		let longest = 0;
		for (const entry of this.#entries) {
			const annotation = entry.annotation ?? "";
			longest = Math.max(longest, visibleWidth(entry.label) + visibleWidth(annotation) + 5);
		}
		const frameShare = Math.floor(frameWidth / 3);
		return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, frameShare, longest));
	}

	#renderSidebar(width: number, rows: number): string[] {
		// The scroll offset is persistent: the wheel pans it freely. Only an
		// activation (keys, click, programmatic) snaps the viewport to the
		// active entry, and only far enough to reveal it.
		if (this.#sidebarFollowActive) {
			const activeIndex = Math.max(
				0,
				this.#entries.findIndex(entry => entry.id === this.#activeEntryId),
			);
			if (activeIndex < this.#sidebarScroll) {
				this.#sidebarScroll = activeIndex;
			} else if (activeIndex >= this.#sidebarScroll + rows) {
				this.#sidebarScroll = activeIndex - rows + 1;
			}
			this.#sidebarFollowActive = false;
		}
		this.#sidebarScroll = Math.max(0, Math.min(this.#sidebarScroll, Math.max(0, this.#entries.length - rows)));

		const lines: string[] = [];
		for (let i = this.#sidebarScroll; i < Math.min(this.#entries.length, this.#sidebarScroll + rows); i++) {
			const entry = this.#entries[i];
			if (!entry) continue;
			if (entry.kind === "separator") {
				lines.push(theme.fg("border", "─".repeat(width)));
				continue;
			}
			const active = entry.id === this.#activeEntryId;
			const hovered = i === this.#sidebarHover;
			const searching = this.#searchCounts !== null;
			let matchCount: number | undefined;
			if (searching) {
				if (entry.kind === "provider" && !entry.locked) {
					matchCount = this.#searchCounts?.get(entry.providerId ?? "") ?? 0;
				} else if (entry.kind === "recent") {
					matchCount = this.#recentSearchCount;
				} else if (entry.kind === "all") {
					matchCount = this.#searchTotal;
				}
			}
			// While searching, entries the hop skips gray out: locked and
			// zero-match providers, an empty Recent, and the Roles view.
			const muted = entry.locked || matchCount === 0 || (searching && entry.kind === "roles");
			// The sidebar's active entry is state, not a cursor: accent label
			// plus a cursor glyph while the sidebar owns the arrows. The band
			// stays in the body pane so the two never look alike.
			const cursor = active && this.#focus === "scope" ? theme.fg("accent", theme.nav.cursor) : " ";

			let icon: string;
			if (entry.kind === "recent") {
				icon = theme.icon.time;
			} else if (entry.kind === "roles") {
				icon = theme.icon.extensionSkill;
			} else if (entry.kind === "all") {
				icon = theme.icon.model;
			} else {
				icon = muted ? theme.status.shadowed : theme.status.enabled;
			}
			const labelStyled = muted
				? theme.fg("dim", entry.label)
				: active
					? theme.bold(theme.fg("accent", entry.label))
					: entry.label;

			const refreshing = entry.providerId ? this.#refreshingProviders.has(entry.providerId) : false;
			const annotationText = matchCount !== undefined ? String(matchCount) : (entry.annotation ?? "");
			const annotationStyled = refreshing
				? theme.fg("warning", theme.spinnerFrames[this.#refreshSpinnerFrame % theme.spinnerFrames.length] ?? "")
				: theme.fg("dim", annotationText);

			const left = `${cursor} ${muted ? theme.fg("dim", icon) : theme.fg(entry.kind === "provider" ? "success" : "accent", icon)} ${labelStyled}`;
			const leftWidth = visibleWidth(left);
			const annWidth = visibleWidth(annotationStyled);
			let line: string;
			if (leftWidth + annWidth + 1 <= width) {
				line = `${left}${" ".repeat(width - leftWidth - annWidth)}${annotationStyled}`;
			} else {
				line = truncateToWidth(left, width);
				const lineWidth = visibleWidth(line);
				if (lineWidth < width) line += " ".repeat(width - lineWidth);
			}
			if (hovered) {
				line = theme.bg("selectedBg", line);
			}
			lines.push(line);
		}
		return lines;
	}

	#statusRow(width: number): string {
		// A council notice reports a durable write the user cannot otherwise see,
		// so it outranks the transient assign/browse text until they navigate away.
		const notice = this.#councilStatusNotice;
		if (notice) {
			return truncateToWidth(theme.fg(notice.tone, ` ${sanitizeInline(notice.text)}`), width);
		}
		if (this.#assigning !== null) {
			if (this.#assigning.kind === "fallbackKey") {
				return truncateToWidth(
					theme.fg("accent", " New fallback chain — Enter picks the model it protects, Esc cancels"),
					width,
				);
			}
			const info = getRoleInfo(this.#assigning.role, this.#settings);
			const label =
				this.#assigning.kind === "role" && this.#councilRosterRoleIds.has(this.#assigning.role)
					? this.#roleDisplayLabel(this.#assigning.role, true)
					: sanitizeInline(info.tag ?? info.name ?? this.#assigning.role);
			if (this.#assigning.kind === "fallback") {
				const verb = this.#assigning.index === null ? "Adding fallback for" : "Replacing fallback of";
				return truncateToWidth(
					theme.fg("accent", ` ${verb} ${theme.bold(label)} — Enter picks the fallback model, Esc cancels`),
					width,
				);
			}
			return truncateToWidth(
				theme.fg("accent", ` Assigning ${theme.bold(label)} — Enter assigns, Esc cancels`),
				width,
			);
		}
		const entry = this.#activeEntry();
		const scopedSuffix = this.#scopedModels.length > 0 ? " · --models scope" : "";
		let text: string;
		switch (entry.kind) {
			case "recent":
				text = `Recently used models${scopedSuffix}`;
				break;
			case "roles": {
				const selectedRow = this.#rolesRows[this.#roleIndex];
				const councilSelected =
					selectedRow?.kind === "councilNotice" ||
					selectedRow?.kind === "councilRole" ||
					selectedRow?.kind === "councilRounds" ||
					selectedRow?.kind === "councilLead" ||
					selectedRow?.kind === "councilAdvisor" ||
					selectedRow?.kind === "councilRoundHeader" ||
					selectedRow?.kind === "newCouncilMember" ||
					selectedRow?.kind === "sectionHeader";
				if (!councilSelected) {
					text = "Model roles — f adds a retry fallback, cleared roles fall back to auto-selection";
				} else if (selectedRow?.kind === "councilNotice" && selectedRow.action === "moveToGlobal") {
					text = "Council roster — Enter rewrites the roster to global config, then drops the project key";
				} else if (selectedRow?.kind === "councilNotice") {
					text = "Council roster — this row explains what to fix; it changes nothing";
				} else if (selectedRow?.kind === "councilLead") {
					text =
						selectedRow.role === "adjudicator"
							? "Council adjudicator — assign a model to delegate judging, or clear it to adjudicate in this session"
							: "Council planner — assign a model, or clear it to fall back to the slow role";
				} else if (selectedRow?.kind === "councilAdvisor") {
					text = "Council advisors — an advisor watches that role's turns and is billed to it";
				} else if (this.#councilRowsLocked) {
					text = "Council roster — read-only until the roster moves to global config";
				} else if (selectedRow?.kind === "councilRounds") {
					text = "Council roster — Enter toggles review rounds";
				} else {
					text = "Council roster — Enter assigns models; r sets the round; disabled slots remain configured";
				}
				break;
			}
			case "provider":
				if (entry.locked) {
					text = `${entry.label} · not configured`;
				} else if (entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
					text = `${entry.label} · refreshing model list…`;
				} else {
					text = `${entry.label} · ${entry.annotation ?? "0"} models${scopedSuffix}`;
				}
				break;
			default:
				text = `All available models${scopedSuffix}`;
				break;
		}
		if (this.#configError && entry.kind !== "provider") {
			return truncateToWidth(theme.fg("error", ` ${sanitizeInline(this.#configError)}`), width);
		}
		return truncateToWidth(theme.fg("muted", ` ${sanitizeInline(text)}`), width);
	}

	/** Clamp a roles row to `width`; the bg band is reserved for mouse hover. */
	#finishRolesRow(line: string, width: number, hovered: boolean): string {
		let out = truncateToWidth(line, width);
		if (hovered) {
			const w = visibleWidth(out);
			if (w < width) out += " ".repeat(width - w);
			return theme.bg("selectedBg", out);
		}
		return out;
	}

	#roleDisplayLabel(role: string, council: boolean): string {
		const info = getRoleInfo(role, this.#settings);
		const modelTags = this.#settings.get("modelTags");
		// The Model Hub is the one Council surface that honours a configured `modelTags` name: it is
		// where that name is authored. With no name and no built-in tag the row falls back to the same
		// stable label every other Council surface shows — `Reviewer N`, `Planner`/`Adjudicator`, or a
		// custom (possibly salvaged) id humanized from its own words.
		if (council && !Object.hasOwn(modelTags, role) && !info.tag) return sanitizeInline(councilRoleLabel(role));
		return sanitizeInline(info.tag ?? info.name ?? role);
	}

	#roleRowPresentation(
		role: string,
		displayLabel: string,
		selected: boolean,
		labelWidth: number,
		requiresExplicitSelector: boolean,
		/** What an unassigned row shows instead of `unassigned`, when the role has a real fallback. */
		unassignedText?: string,
	): RoleRowPresentation {
		const info = getRoleInfo(role, this.#settings);
		const assignment = this.#roles[role];
		const shownLabel = truncateToWidth(sanitizeInline(displayLabel), labelWidth);
		const cleanLabel = `${shownLabel}${" ".repeat(Math.max(0, labelWidth - visibleWidth(shownLabel)))}`;
		let dot: string;
		let label: string;
		let value: string;
		let effort = "";
		let provenance = "";
		if (assignment && !assignment.autoSelected) {
			dot = theme.fg(info.color ?? "muted", theme.status.enabled);
			label = theme.fg(info.color ?? "muted", cleanLabel);
			const provider = sanitizeInline(assignment.model.provider);
			const modelId = sanitizeInline(assignment.model.id);
			value = `${theme.fg("dim", `${provider}/`)}${selected ? theme.fg("accent", modelId) : modelId}`;
			const glyph = thinkingLevelGlyph(assignment.thinkingLevel);
			const effortLabel = sanitizeInline(getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label);
			if (assignment.thinkingLevel !== ThinkingLevel.Inherit) {
				effort = theme.fg("dim", glyph ? `${glyph} ${effortLabel}` : effortLabel);
			}
			const source = this.#settings.getModelRoleProvenance(role);
			if (source !== "default") provenance = theme.fg("dim", sanitizeInline(source));
		} else if (assignment && !requiresExplicitSelector) {
			dot = theme.fg("dim", theme.status.shadowed);
			label = theme.fg("dim", cleanLabel);
			value = theme.fg(
				"dim",
				`auto → ${sanitizeInline(assignment.model.provider)}/${sanitizeInline(assignment.model.id)}`,
			);
		} else {
			dot = theme.fg("dim", theme.status.shadowed);
			label = theme.fg("dim", cleanLabel);
			// A lead with a documented fallback is configured, not broken, so it never reads `unassigned`.
			value = theme.fg("dim", unassignedText ?? (requiresExplicitSelector ? "unassigned" : "—"));
		}
		return { dot, label, value, effort, provenance };
	}

	#renderRoleRow(
		role: string,
		displayLabel: string,
		selected: boolean,
		hovered: boolean,
		width: number,
		labelWidth: number,
		cycleOrder: readonly string[],
		enabled?: boolean,
		unassignedText?: string,
		/** Inline per-row fault, rendered beside the value so the broken row explains itself. */
		fault?: string,
	): string {
		const cursor = selected && this.#focus === "list" ? theme.fg("accent", theme.nav.cursor) : " ";
		const presentation = this.#roleRowPresentation(
			role,
			displayLabel,
			selected,
			labelWidth,
			enabled !== undefined || unassignedText !== undefined,
			unassignedText,
		);
		const cycleIndex = cycleOrder.indexOf(role);
		const cycleBadge = cycleIndex >= 0 ? theme.fg("accent", `${theme.icon.loop}${cycleIndex + 1}`) : "";
		const rosterBadge =
			enabled === undefined ? "" : enabled ? `${theme.fg("success", "[on]")} ` : `${theme.fg("dim", "[off]")} `;
		const right = [presentation.effort, presentation.provenance, cycleBadge]
			.filter(part => part.length > 0)
			.join("  ");
		const faultSuffix = fault ? ` ${theme.fg("warning", fault)}` : "";
		let line = ` ${cursor} ${rosterBadge}${presentation.dot} ${presentation.label}  ${presentation.value}${faultSuffix}`;
		const rightWidth = visibleWidth(right);
		const lineWidth = visibleWidth(line);
		if (rightWidth > 0 && lineWidth + rightWidth + 2 <= width) {
			line = `${line}${" ".repeat(width - lineWidth - rightWidth - 1)}${right}`;
		}
		return this.#finishRolesRow(line, width, hovered);
	}

	#renderRolesView(width: number, rows: number): string[] {
		const lines: string[] = [];
		this.#rolesLineToRow.clear();
		const viewportRows = Math.max(1, rows - 3);
		this.#rolesViewportRows = viewportRows;
		const maxScroll = Math.max(0, this.#rolesRows.length - viewportRows);
		if (this.#rolesFollowActive) {
			if (this.#roleIndex < this.#rolesScroll) {
				this.#rolesScroll = this.#roleIndex;
			} else if (this.#roleIndex >= this.#rolesScroll + viewportRows) {
				this.#rolesScroll = this.#roleIndex - viewportRows + 1;
			}
			this.#rolesFollowActive = false;
		}
		this.#rolesScroll = Math.max(0, Math.min(this.#rolesScroll, maxScroll));

		const above = this.#rolesScroll;
		lines.push(above > 0 ? truncateToWidth(theme.fg("dim", `  ▲ ${above} more`), width) : "");

		let labelWidth = 0;
		const labelWidthLimit = Math.max(1, Math.floor(width / ROLE_LABEL_COLUMN_DIVISOR));
		for (const rowDef of this.#rolesRows) {
			if (rowDef.kind === "role") {
				labelWidth = Math.min(
					labelWidthLimit,
					Math.max(labelWidth, visibleWidth(this.#roleDisplayLabel(rowDef.role, false))),
				);
			} else if (rowDef.kind === "councilRole") {
				labelWidth = Math.min(
					labelWidthLimit,
					Math.max(labelWidth, visibleWidth(this.#roleDisplayLabel(rowDef.member.role, true))),
				);
			} else if (rowDef.kind === "councilLead" || rowDef.kind === "councilAdvisor") {
				labelWidth = Math.min(labelWidthLimit, Math.max(labelWidth, visibleWidth(rowDef.label)));
			}
		}

		const cycleOrder = this.#cycleOrder();
		const end = Math.min(this.#rolesRows.length, this.#rolesScroll + viewportRows);
		for (let index = this.#rolesScroll; index < end; index++) {
			const rowDef = this.#rolesRows[index];
			if (!rowDef) continue;
			this.#rolesLineToRow.set(lines.length, index);
			const selected = index === this.#roleIndex;
			const hovered = index === this.#roleHover;
			const cursor = selected && this.#focus === "list" ? theme.fg("accent", theme.nav.cursor) : " ";

			if (rowDef.kind === "separator") {
				lines.push(`   ${theme.fg("border", "─".repeat(Math.max(1, width - 6)))}`);
				continue;
			}
			if (rowDef.kind === "sectionHeader") {
				const label = theme.bold(theme.fg("accent", sanitizeInline(rowDef.label)));
				const meta = rowDef.segments
					.map(segment => theme.fg(segment.tone, sanitizeInline(segment.text)))
					.join(theme.fg("dim", " · "));
				lines.push(truncateToWidth(`   ${label}  ${meta}`, width));
				continue;
			}
			if (rowDef.kind === "councilRoundHeader") {
				const label = rowDef.group === "every" ? "Every round" : rowDef.group === 1 ? "Round 1" : "Round 2";
				const suffix = rowDef.inactive
					? theme.fg("dim", " · inactive")
					: rowDef.empty
						? theme.fg("warning", " · no reviewer assigned; a council run will refuse")
						: "";
				lines.push(truncateToWidth(`     ${theme.fg("dim", label)}${suffix}`, width));
				continue;
			}
			if (rowDef.kind === "councilAdvisor") {
				const shownLabel = truncateToWidth(rowDef.label, labelWidth);
				const padded = `${shownLabel}${" ".repeat(Math.max(0, labelWidth - visibleWidth(shownLabel)))}`;
				const choices = ([true, false] as const)
					.map(value =>
						value === rowDef.enabled
							? theme.fg("accent", `${theme.status.enabled}${value ? "on" : "off"}`)
							: theme.fg("dim", `${theme.status.shadowed}${value ? "on" : "off"}`),
					)
					.join(theme.fg("dim", " | "));
				lines.push(
					this.#finishRolesRow(
						` ${cursor} ${theme.fg("dim", theme.status.enabled)} ${theme.fg(selected ? "accent" : "muted", padded)}  ${choices}`,
						width,
						hovered,
					),
				);
				continue;
			}
			if (rowDef.kind === "councilNotice") {
				// A configuration fault stays coloured whether or not the cursor is on
				// it; only the action row brightens to read as activatable.
				const tone = rowDef.action !== undefined && selected ? "accent" : rowDef.severity;
				const prefix = rowDef.action !== undefined ? "Enter: " : "";
				lines.push(
					this.#finishRolesRow(
						` ${cursor} ${theme.fg(tone, `${prefix}${sanitizeInline(rowDef.text)}`)}`,
						width,
						hovered,
					),
				);
				continue;
			}
			if (rowDef.kind === "councilRounds") {
				const shownLabel = truncateToWidth("Rounds", labelWidth);
				const padded = `${shownLabel}${" ".repeat(Math.max(0, labelWidth - visibleWidth(shownLabel)))}`;
				const choices = ([1, 2] as const)
					.map(value =>
						value === rowDef.rounds
							? theme.fg("accent", `${theme.status.enabled}${value}`)
							: theme.fg("dim", `${theme.status.shadowed}${value}`),
					)
					.join(theme.fg("dim", " | "));
				const suffix = rowDef.invalid ? ` ${theme.fg("warning", "invalid council.rounds; using 1")}` : "";
				lines.push(
					this.#finishRolesRow(
						` ${cursor} ${theme.fg("dim", theme.status.enabled)} ${theme.fg(selected ? "accent" : "muted", padded)}  ${choices}${suffix}`,
						width,
						hovered,
					),
				);
				continue;
			}
			if (rowDef.kind === "newRole" || rowDef.kind === "newFallback" || rowDef.kind === "newCouncilMember") {
				const label =
					rowDef.kind === "newRole"
						? "+ New role…"
						: rowDef.kind === "newFallback"
							? "+ New fallback…"
							: "+ Add reviewer…";
				lines.push(
					this.#finishRolesRow(` ${cursor} ${theme.fg(selected ? "accent" : "dim", label)}`, width, hovered),
				);
				continue;
			}
			if (rowDef.kind === "chainKey") {
				const key = sanitizeInline(rowDef.role);
				const slash = key.lastIndexOf("/");
				const tail = key.slice(slash + 1);
				const keyStyled = theme.fg("dim", key.slice(0, slash + 1)) + (selected ? theme.fg("accent", tail) : tail);
				lines.push(
					this.#finishRolesRow(
						` ${cursor} ${theme.fg("dim", theme.status.shadowed)} ${keyStyled}`,
						width,
						hovered,
					),
				);
				continue;
			}
			if (rowDef.kind === "fallback") {
				const branch = theme.fg("dim", `${"".padEnd(labelWidth + 3)}↳`);
				const cleanSelector = sanitizeInline(rowDef.selector);
				const selector = selected ? theme.fg("accent", cleanSelector) : theme.fg("muted", cleanSelector);
				lines.push(this.#finishRolesRow(` ${cursor} ${branch} ${selector}`, width, hovered));
				continue;
			}
			if (rowDef.kind === "councilLead") {
				lines.push(
					this.#renderRoleRow(
						rowDef.role,
						this.#roleDisplayLabel(rowDef.role, true),
						selected,
						hovered,
						width,
						labelWidth,
						cycleOrder,
						undefined,
						rowDef.fallbackText,
					),
				);
				continue;
			}
			if (rowDef.kind === "councilRole") {
				lines.push(
					this.#renderRoleRow(
						rowDef.member.role,
						this.#roleDisplayLabel(rowDef.member.role, true),
						selected,
						hovered,
						width,
						labelWidth,
						cycleOrder,
						rowDef.member.enabled,
						undefined,
						rowDef.roundFault ? "invalid round; fix it or press r" : undefined,
					),
				);
				continue;
			}
			lines.push(
				this.#renderRoleRow(
					rowDef.role,
					this.#roleDisplayLabel(rowDef.role, false),
					selected,
					hovered,
					width,
					labelWidth,
					cycleOrder,
				),
			);
		}
		while (lines.length < viewportRows + 1) lines.push("");

		const below = Math.max(0, this.#rolesRows.length - (this.#rolesScroll + viewportRows));
		lines.push(below > 0 ? truncateToWidth(theme.fg("dim", `  ▼ ${below} more`), width) : "");

		const cycleKey = getKeybindings().getKeys("app.model.cycleForward")[0] ?? "ctrl+p";
		if (cycleOrder.length > 0) {
			const selectedRow = this.#rolesRows[this.#roleIndex];
			const selectedRole =
				selectedRow && (selectedRow.kind === "role" || selectedRow.kind === "fallback") ? selectedRow.role : "";
			const activeIndex = cycleOrder.indexOf(selectedRole);
			const track = renderSegmentTrack(
				cycleOrder.map(role => ({ label: sanitizeInline(role) })),
				activeIndex,
			);
			lines.push(truncateToWidth(`  ${theme.fg("dim", `${cycleKey} cycle:`)} ${track}`, width));
		} else {
			lines.push(
				truncateToWidth(theme.fg("dim", `  ${cycleKey} cycle is empty — press c on a role to add it`), width),
			);
		}
		return lines.slice(0, rows);
	}

	#renderLockedView(entry: SidebarEntry, width: number, rows: number): string[] {
		const lines: string[] = [];
		this.#lockedLoginLine = null;
		lines.push("");
		lines.push(truncateToWidth(theme.fg("warning", `  ${entry.label} has no credentials configured`), width));
		lines.push("");
		const envVars = entry.providerId ? (getCatalogProviderEntry(entry.providerId)?.envVars ?? []) : [];
		if (envVars.length > 0) {
			lines.push(
				truncateToWidth(
					theme.fg("muted", `  Set ${envVars.join(" or ")} in your environment, or add a key in config.`),
					width,
				),
			);
		} else {
			lines.push(truncateToWidth(theme.fg("muted", "  Add an API key for this provider in config."), width));
		}
		if (entry.oauth) {
			this.#lockedLoginLine = lines.length + 1; // +1 for the status row offset handled by caller
			lines.push(truncateToWidth(theme.fg("accent", `  ${theme.nav.cursor} Log in with OAuth (Enter)`), width));
		}
		lines.push("");
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `  ${catalogCount} models in catalog:`), width));
			const preview = this.#scopedModels.length > 0 ? [] : this.#registry.getAll();
			for (const model of preview) {
				if (model.provider !== entry.providerId) continue;
				if (lines.length >= rows) break;
				lines.push(truncateToWidth(theme.fg("dim", `    ${model.id}`), width));
			}
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(): string {
		const strip = this.#strip;
		if (strip) {
			if (strip.kind === "roleName") {
				return strip.mode === "councilDisplayName"
					? "Enter rename · empty restores the role id · Esc cancel"
					: "Enter create + pick model · Esc cancel";
			}
			if (strip.kind === "councilRound") return "←/→ choose round · Enter name the reviewer · Esc cancel";
			if (strip.kind === "role") return "←/→ choose · Enter assign/clear · Esc cancel";
			if (strip.kind === "scope") return "←/→ save scope · Enter choose · Esc cancel";
			return "←/→ thinking level · Enter apply · Esc keep";
		}
		if (this.#assigning !== null) {
			switch (this.#assigning.kind) {
				case "fallback":
					return "Enter pick fallback · ↑/↓ providers · type to search · Esc cancel";
				case "fallbackKey":
					return "Enter pick the protected model · ↑/↓ providers · type to search · Esc cancel";
				default:
					return "Enter assign · ↑/↓ providers · type to search · Esc cancel";
			}
		}
		const entry = this.#activeEntry();
		if (entry.kind === "roles") {
			if (this.#focus !== "list") {
				return "↑/↓ providers · → roles · Esc close";
			}
			const row = this.#rolesRows[this.#roleIndex];
			if (row?.kind === "councilNotice") {
				return row.action === "moveToGlobal"
					? "↑/↓ rows · Enter move roster to global config · ← providers"
					: "↑/↓ rows · Council configuration needs fixing · ← providers";
			}
			if (this.#councilRowsLocked && (row?.kind === "councilRole" || row?.kind === "councilRounds")) {
				return "↑/↓ rows · Read-only until the roster moves to global config · ← providers";
			}
			if (row?.kind === "councilLead") {
				return "↑/↓ rows · Enter model · n rename · x clear to the default · ← providers";
			}
			if (row?.kind === "councilAdvisor") {
				return "↑/↓ rows · Enter/Space toggle the advisor for this role · ← providers";
			}
			if (row?.kind === "councilRole") {
				return "↑/↓ rows · Enter model · Space toggle · r round · [/] reorder · n rename · x unassign · Del remove";
			}
			if (row?.kind === "councilRounds") {
				return "↑/↓ rows · Enter/Space toggle · [/] set 1 or 2 rounds · ← providers";
			}
			if (row?.kind === "newCouncilMember") {
				return "↑/↓ rows · Enter name + add reviewer · ← providers";
			}
			if (row?.kind === "fallback") {
				return "↑/↓ rows · Enter replace · f add another · x remove · [/] reorder · ← providers";
			}
			if (row?.kind === "chainKey") {
				return "↑/↓ rows · Enter/f add fallback · x clear chain · ← providers";
			}
			if (row?.kind === "newFallback") {
				return "↑/↓ rows · Enter new model/provider fallback chain · ← providers";
			}
			return "↑/↓ rows · Enter pick · f fallback · x clear · t thinking · c cycle · [/] reorder · n new";
		}
		if (entry.kind === "provider" && entry.locked) {
			return entry.oauth ? "Enter log in · ↑/↓ providers · Esc close" : "↑/↓ providers · Esc close";
		}
		const arrows = this.#focus === "scope" ? "↑/↓ providers · → models" : "↑/↓ models · ← providers";
		const refresh = entry.kind === "provider" ? " · F5 refresh" : "";
		return `Enter assign roles · ${arrows} · type to search${refresh} · Esc close`;
	}

	/** Footer row: active strip (chips) or the contextual hint line. */
	#renderFooter(width: number): string {
		this.#chipRanges = [];
		const strip = this.#strip;
		if (!strip) {
			return truncateToWidth(theme.fg("dim", this.#footerHint()), width);
		}

		if (strip.kind === "roleName") {
			const prompt =
				strip.mode === "councilDisplayName"
					? "Display name:"
					: strip.mode === "newCouncilMember"
						? "Reviewer:"
						: "New role name:";
			const hint =
				strip.mode === "newRole"
					? "(letters, digits, - and _)"
					: strip.mode === "newCouncilMember"
						? "(blank auto-names it; a lowercase word becomes the role id)"
						: "(display name only; the role id never changes)";
			const label = theme.fg("accent", prompt);
			const inputWidth = Math.max(8, Math.min(32, width - visibleWidth(prompt) - 24));
			const inputLine = strip.input.render(inputWidth)[0] ?? "";
			return truncateToWidth(`${label} ${inputLine} ${theme.fg("dim", hint)}`, width);
		}

		let prefix: string;
		if (strip.kind === "councilRound") {
			// No `item`: nothing is being assigned yet, so the prefix names the step, not a model.
			prefix = `${theme.fg("accent", "new reviewer")}${theme.fg("dim", " · round →")} `;
		} else if (strip.kind === "role") {
			prefix = `${theme.fg("accent", strip.item.id)}${theme.fg("dim", " →")} `;
		} else {
			const role = strip.role ?? "";
			const info = getRoleInfo(role, this.#settings);
			// `tag` is built-ins only, so a council slot falls through to its `Reviewer N` name.
			const label = (info.tag ?? info.name ?? role).toLowerCase();
			prefix = `${theme.fg(info.color ?? "muted", label)}${theme.fg("dim", ` · ${strip.item.id} →`)} `;
		}

		// Horizontal window: once the strip overflows, drop leading chips behind
		// a dim ellipsis so the selected chip (plus one chip of lookahead when it
		// fits) stays visible while cycling right.
		const prefixWidth = visibleWidth(prefix);
		const available = Math.max(1, width - prefixWidth);
		const chipWidths = strip.chips.map(
			(chip, i) => visibleWidth(` ${chip.styled} `) + (i === strip.index ? 2 : 0) + 1,
		);
		// Smallest start index whose window [start..target] (with its "… " lead-in
		// when start > 0) fits in the available width; `target` itself may still
		// overflow when a single chip is wider than the row.
		const startFor = (target: number): number => {
			let start = 0;
			while (start < target) {
				let sum = start > 0 ? 2 : 0;
				for (let i = start; i <= target; i++) sum += chipWidths[i] ?? 0;
				if (sum <= available) break;
				start++;
			}
			return start;
		};
		let start = startFor(Math.min(strip.index + 1, strip.chips.length - 1));
		if (start > strip.index) start = startFor(strip.index);

		let line = prefix;
		// Columns are relative to the frame: row() insets content by 2.
		let col = 2 + prefixWidth;
		if (start > 0) {
			line += theme.fg("dim", "… ");
			col += 2;
		}
		for (let i = start; i < strip.chips.length; i++) {
			const chip = strip.chips[i];
			if (!chip) continue;
			const selected = i === strip.index;
			const body = ` ${chip.styled} `;
			const rendered = selected
				? theme.bg("selectedBg", `${theme.fg("accent", "[")}${body}${theme.fg("accent", "]")}`)
				: body;
			const w = visibleWidth(body) + (selected ? 2 : 0);
			this.#chipRanges.push({ start: col, end: col + w, index: i });
			line += rendered;
			col += w;
			line += " ";
			col += 1;
		}
		return truncateToWidth(line, width);
	}

	render(width: number): string[] {
		const height = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const sidebarWidth = this.#sidebarWidth(width);
		this.#sidebarWidthLast = sidebarWidth;
		const bodyWidth = splitBodyWidth(width, sidebarWidth);
		const contentRows = Math.max(10, height - 4);
		this.#contentRowCount = contentRows;

		const entry = this.#activeEntry();
		const bodyLines: string[] = [this.#statusRow(bodyWidth)];
		if (entry.kind === "roles" && this.#assigning === null) {
			bodyLines.push(...this.#renderRolesView(bodyWidth, contentRows - 1));
		} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
			bodyLines.push(...this.#renderLockedView(entry, bodyWidth, contentRows - 1));
		} else {
			this.#browser.setMaxVisible(contentRows - 1 - 5);
			this.#browser.setFocused(this.#focus === "list");
			bodyLines.push(...this.#browser.render(bodyWidth));
		}

		const sidebarLines = this.#renderSidebar(sidebarWidth, contentRows);

		const out: string[] = [];
		out.push(topBorderSplit(width, "Models", sidebarWidth));
		this.#contentRowStart = out.length;
		for (let i = 0; i < contentRows; i++) {
			out.push(splitRow(sidebarLines[i] ?? "", bodyLines[i] ?? "", width, sidebarWidth));
		}
		out.push(dividerSplit(width, sidebarWidth));
		this.#footerRow = out.length;
		out.push(row(this.#renderFooter(width - 4), width));
		out.push(bottomBorder(width));
		return out;
	}
}
