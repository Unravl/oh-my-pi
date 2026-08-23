import { afterAll, afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import * as modelResolver from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { COUNCIL_MAX_ACTIVE_REVIEWERS } from "@oh-my-pi/pi-coding-agent/council/config";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import * as instructions from "@oh-my-pi/pi-coding-agent/council/instructions";
import {
	assertCouncilResumeRosterWithinLimit,
	CouncilDispatchError,
	type CouncilPreflightHost,
	preflightCouncilDispatch,
} from "@oh-my-pi/pi-coding-agent/council/preflight";
import * as publication from "@oh-my-pi/pi-coding-agent/council/publication";
import { COUNCIL_TASK_CHAR_LIMIT } from "@oh-my-pi/pi-coding-agent/council/schema";
import type { EffectiveSubagentPolicy } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import * as subagents from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { prompt, TempDir } from "@oh-my-pi/pi-utils";
import reviewLens from "../src/prompts/council/lens.md" with { type: "text" };
import memberTaskTemplate from "../src/prompts/council/member-task.md" with { type: "text" };

const cwd = fs.realpathSync(process.cwd());
const plannerModel = {
	provider: "planner",
	id: "slow",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
} as unknown as Model<Api>;
const memberModel = {
	provider: "review",
	id: "one",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.High] },
} as unknown as Model<Api>;
const otherMemberModel = {
	provider: "review",
	id: "two",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.High] },
} as unknown as Model<Api>;
const mainModel = {
	provider: "main",
	id: "active",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.High] },
} as unknown as Model<Api>;
// A council run publishes into the session `local://` cache, never the working tree, so the plan root
// is the artifacts directory the ToolSession hands out. Canonicalized, because that is the form
// `councilPlanRoot` returns and every containment check downstream compares against.
const artifactsTemp = TempDir.createSync("@pi-council-preflight-");
const artifactsDirectory = artifactsTemp.join("artifacts");
const planRoot = path.join(fs.realpathSync(artifactsTemp.path()), "artifacts", "local");
const publicationTarget = {
	planRoot,
	slug: "change-auth",
	fileName: "council-change-auth-plan.md",
	relativePath: "council-change-auth-plan.md",
	absolutePath: path.join(planRoot, "council-change-auth-plan.md"),
};
const instructionSnapshot = {
	repoRoot: cwd,
	contextFiles: [{ path: path.join(cwd, "AGENTS.md"), content: "rules", depth: 0 }],
	files: [{ path: path.join(cwd, "AGENTS.md"), sha256: sha256CouncilContent("rules") }],
	totalBytes: 5,
};
// Preflight reaches no completion API: the published plan is named from the task, so the kickoff
// line always precedes council spend. Attached to every host below as a trap, not as a dependency —
// `CouncilPreflightHost` no longer declares it, and any resurrected title call fails loudly here.
const titleTrap = mock(async (_message: string, _signal?: AbortSignal): Promise<string | null> => {
	throw new Error("council preflight reached a completion API");
});

function settings(options?: {
	members?: Array<{ role: string; enabled: boolean; round?: 1 | 2 }>;
	roles?: Record<string, string | string[]>;
	rounds?: 1 | 2;
	advisor?: { planner?: boolean; reviewers?: boolean; adjudicator?: boolean };
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
}): Settings {
	return Settings.isolated({
		"council.members": options?.members ?? [{ role: "reviewer", enabled: true }],
		// Left unset unless a case asks for them, so the shipped defaults stay under test.
		...(options?.rounds === undefined ? {} : { "council.rounds": options.rounds }),
		...(options?.advisor?.planner === undefined ? {} : { "council.advisor.planner": options.advisor.planner }),
		...(options?.advisor?.reviewers === undefined ? {} : { "council.advisor.reviewers": options.advisor.reviewers }),
		...(options?.advisor?.adjudicator === undefined
			? {}
			: { "council.advisor.adjudicator": options.advisor.adjudicator }),
		defaultThinkingLevel: options?.defaultThinkingLevel ?? "high",
		modelRoles: { reviewer: "review/one:high", slow: "planner/slow:max", ...options?.roles },
	});
}

function host(options?: {
	settings?: Settings;
	model?: Model<Api>;
	activeTools?: string[];
	apiKey?: string | undefined;
	cwd?: string;
	/** Fires when the session cache root is resolved, so a test can cancel exactly at that stage. */
	onArtifactsDir?: () => void;
}): CouncilPreflightHost {
	const effectiveSettings = options?.settings ?? settings();
	const apiKey = Object.hasOwn(options ?? {}, "apiKey") ? options?.apiKey : "test-key";
	const sourceCwd = options?.cwd ?? cwd;
	const toolSession = {
		cwd: sourceCwd,
		hasUI: true,
		settings: effectiveSettings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		// Preflight resolves the publication target against the real session `local://` root, so the
		// storage identity surfaces have to be present even though every publication call is spied.
		localProtocolOptions: {
			getArtifactsDir: () => {
				options?.onArtifactsDir?.();
				return artifactsDirectory;
			},
			getSessionId: () => "session-1",
		},
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ToolSession;
	return {
		toolSession,
		session: Object.assign(
			{
				model: Object.hasOwn(options ?? {}, "model") ? options?.model : mainModel,
				thinkingLevel: undefined,
				getActiveToolNames: () => options?.activeTools ?? ["read", "write"],
			},
			{ generateTitle: titleTrap },
		),
		settings: effectiveSettings,
		modelRegistry: {
			getApiKey: mock(async () => apiKey),
			// An advisor toggle resolves the `advisor` model role against the registry; with nothing
			// available the toggle is a no-op preflight warns about, which is what the flag tests want.
			getAvailable: () => [],
		} as unknown as CouncilPreflightHost["modelRegistry"],
		sessionManager: { getCwd: () => sourceCwd, getSessionId: () => "session-1" },
	};
}
function isPlannerSelector(selector: string | undefined): boolean {
	return selector === "@slow" || selector?.startsWith("planner/") === true;
}

function resolved(selector: string): modelResolver.ResolveCliModelResult {
	const model = isPlannerSelector(selector) ? plannerModel : selector.includes("two") ? otherMemberModel : memberModel;
	return {
		model,
		selector: `${model.provider}/${model.id}`,
		thinkingLevel:
			selector === "@slow" || selector.endsWith(":max")
				? Effort.Max
				: selector.endsWith(":high")
					? Effort.High
					: selector.endsWith(":auto")
						? "auto"
						: undefined,
		warning: undefined,
		error: undefined,
	};
}
let modelResolverSpy: Mock<typeof modelResolver.resolveCliModel>;
let policySpy: Mock<typeof subagents.resolveEffectiveSubagentPolicy>;
let publicationSpy: Mock<typeof publication.resolveCouncilPublicationTarget>;
let instructionsSpy: Mock<typeof instructions.captureCouncilInstructionSnapshot>;

beforeEach(() => {
	titleTrap.mockClear();
	modelResolverSpy = spyOn(modelResolver, "resolveCliModel").mockImplementation(options =>
		resolved(options.cliModel ?? ""),
	);
	spyOn(git.repo, "root").mockResolvedValue(cwd);
	publicationSpy = spyOn(publication, "resolveCouncilPublicationTarget").mockResolvedValue(publicationTarget);
	instructionsSpy = spyOn(instructions, "captureCouncilInstructionSnapshot").mockResolvedValue(instructionSnapshot);
	policySpy = spyOn(subagents, "resolveEffectiveSubagentPolicy").mockImplementation(
		async request =>
			({
				agentName: request.agent,
			}) as EffectiveSubagentPolicy,
	);
	spyOn(subagents, "runStructuredSubagent").mockRejectedValue(new Error("must not run"));
});

afterEach(() => {
	mock.restore();
});

afterAll(async () => {
	await artifactsTemp.remove();
});

async function expectBlocked(preflightHost: CouncilPreflightHost, message: string): Promise<CouncilDispatchError> {
	try {
		await preflightCouncilDispatch(preflightHost, "Change auth");
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(CouncilDispatchError);
		expect((error as Error).message).toContain(message);
		expect((error as CouncilDispatchError).spending).toBeFalse();
		expect(subagents.runStructuredSubagent).toHaveBeenCalledTimes(0);
		return error as CouncilDispatchError;
	}
}

describe("council dispatch preflight", () => {
	it("blocks malformed configuration and an empty enabled roster without spending", async () => {
		await expectBlocked(host({ settings: Settings.isolated({ "council.members": "bad" }) }), "expected an array");

		await expectBlocked(
			host({ settings: settings({ members: [{ role: "reviewer", enabled: false }] }) }),
			"No enabled",
		);
	});
	it("blocks empty and whitespace-only tasks before resolving any model or publication surface", async () => {
		for (const task of ["", " \t\n "]) {
			await expect(preflightCouncilDispatch(host(), task)).rejects.toMatchObject({
				code: "COUNCIL_TASK_INVALID",
				spending: false,
			});
		}
		expect(modelResolver.resolveCliModel).not.toHaveBeenCalled();
		expect(publication.resolveCouncilPublicationTarget).not.toHaveBeenCalled();
		expect(subagents.resolveEffectiveSubagentPolicy).not.toHaveBeenCalled();
	});

	it("blocks an oversized task before resolving any model or publication surface", async () => {
		await expect(preflightCouncilDispatch(host(), "x".repeat(COUNCIL_TASK_CHAR_LIMIT + 1))).rejects.toMatchObject({
			code: "COUNCIL_TASK_INVALID",
			spending: false,
		});
		expect(modelResolver.resolveCliModel).not.toHaveBeenCalled();
		expect(publication.resolveCouncilPublicationTarget).not.toHaveBeenCalled();
		expect(subagents.resolveEffectiveSubagentPolicy).not.toHaveBeenCalled();
	});

	it("accepts a 64-character roster role and blocks a 65-character role before model resolution", async () => {
		const acceptedRole = `a${"1".repeat(63)}`;
		const rejectedRole = `a${"1".repeat(64)}`;
		const accepted = await preflightCouncilDispatch(
			host({
				settings: Settings.isolated({
					"council.members": [{ role: acceptedRole, enabled: true }],
					modelRoles: { [acceptedRole]: "review/one" },
				}),
			}),
			"Change auth",
		);
		expect(accepted.members[0]?.role).toBe(acceptedRole);

		modelResolverSpy.mockClear();
		await expectBlocked(
			host({
				settings: Settings.isolated({
					"council.members": [{ role: rejectedRole, enabled: true }],
					modelRoles: { [rejectedRole]: "review/one" },
				}),
			}),
			"must match /^[a-z][a-z0-9]{0,63}$/",
		);
		expect(modelResolverSpy).not.toHaveBeenCalled();
	});

	it("blocks missing, unavailable, and unauthenticated enabled member models", async () => {
		await expectBlocked(host({ settings: settings({ roles: { reviewer: "" } }) }), "reviewer");
		const absentBuiltIn = Settings.isolated({
			"council.members": [{ role: "slow", enabled: true }],
			modelRoles: {},
		});
		await expectBlocked(host({ settings: absentBuiltIn }), "no model selector is configured for Slow");
		expect(modelResolverSpy).not.toHaveBeenCalled();

		modelResolverSpy.mockImplementation(options =>
			options.cliModel?.startsWith("review/")
				? {
						model: undefined,
						selector: undefined,
						thinkingLevel: undefined,
						warning: undefined,
						error: "not found",
					}
				: resolved(options.cliModel ?? ""),
		);
		await expectBlocked(host(), "Reviewer model is unavailable");

		modelResolverSpy.mockImplementation(options => resolved(options.cliModel ?? ""));
		await expectBlocked(host({ apiKey: undefined }), "Reviewer model review/one has no usable credentials");
	});

	it("names the roster remedy on an unassigned member role", async () => {
		const unassignedMember = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { slow: "planner/slow:max" },
		});

		const error = await expectBlocked(
			host({ settings: unassignedMember }),
			"Council has 0 of 1 active reviewers assigned; no model selector is configured for Reviewer. Assign models with /council config (Model Hub -> Roles & Council).",
		);

		expect(error.code).toBe("COUNCIL_MEMBER_MODEL_INVALID");
	});

	it("names the slow role specifically when the planner cannot be resolved", async () => {
		modelResolverSpy.mockImplementation(options =>
			options.cliModel === "@slow"
				? {
						model: undefined,
						selector: undefined,
						thinkingLevel: undefined,
						warning: undefined,
						error: "no model matches @slow",
					}
				: resolved(options.cliModel ?? ""),
		);
		const noSlowRole = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: "review/one:high" },
		});

		const error = await expectBlocked(
			host({ settings: noSlowRole }),
			"Council Planner model is unavailable: no model matches @slow. Assign the Council Planner row with /council config (Model Hub -> Roles & Council); it falls back to the `slow` model role when unassigned.",
		);

		expect(error.code).toBe("COUNCIL_PLANNER_MODEL_INVALID");
	});

	it("uses normal built-in resolution for the planner when slow is not configured", async () => {
		const noSlowPlanner = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: "review/one:high" },
		});

		const plan = await preflightCouncilDispatch(host({ settings: noSlowPlanner }), "Change auth");

		expect(plan.planner).toMatchObject({
			requestedSelector: "@slow",
			model: plannerModel,
		});
	});

	it("ignores disabled members even when their selector is unavailable", async () => {
		const plan = await preflightCouncilDispatch(
			host({
				settings: settings({
					members: [
						{ role: "disabled", enabled: false },
						{ role: "reviewer", enabled: true },
					],
					roles: { disabled: "missing/model" },
				}),
			}),
			"Change auth",
		);

		expect(plan.members.map(member => member.role)).toEqual(["reviewer"]);
		expect(modelResolver.resolveCliModel).not.toHaveBeenCalledWith(
			expect.objectContaining({ cliModel: "missing/model" }),
		);
	});

	it("freezes child effort by selector, model default, global default, and concrete auto precedence", async () => {
		const effortModel = {
			...memberModel,
			id: "effort",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		} as unknown as Model<Api>;
		const withModelDefault = {
			...effortModel,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				defaultLevel: Effort.Medium,
			},
		} as unknown as Model<Api>;
		let selectedModel = withModelDefault;
		modelResolverSpy.mockImplementation(options => {
			const base = resolved(options.cliModel ?? "");
			return isPlannerSelector(options.cliModel) ? base : { ...base, model: selectedModel };
		});

		const explicit = await preflightCouncilDispatch(
			host({
				settings: settings({
					roles: { reviewer: "review/effort:max" },
					defaultThinkingLevel: "low",
				}),
			}),
			"Change auth",
		);
		expect(explicit.members[0]).toMatchObject({
			requestedSelector: "review/effort:max",
			resolvedSelector: "review/effort:high",
			effort: Effort.High,
		});

		const modelDefault = await preflightCouncilDispatch(
			host({
				settings: settings({
					roles: { reviewer: "review/effort" },
					defaultThinkingLevel: "low",
				}),
			}),
			"Change auth",
		);
		expect(modelDefault.members[0]).toMatchObject({
			resolvedSelector: "review/effort:medium",
			effort: Effort.Medium,
		});

		selectedModel = effortModel;
		const globalDefault = await preflightCouncilDispatch(
			host({
				settings: settings({
					roles: { reviewer: "review/effort" },
					defaultThinkingLevel: "low",
				}),
			}),
			"Change auth",
		);
		expect(globalDefault.members[0]).toMatchObject({
			resolvedSelector: "review/effort:low",
			effort: Effort.Low,
		});

		selectedModel = withModelDefault;
		const automatic = await preflightCouncilDispatch(
			host({ settings: settings({ roles: { reviewer: "review/effort:auto" } }) }),
			"Change auth",
		);
		expect(automatic.members[0]).toMatchObject({
			requestedSelector: "review/effort:auto",
			resolvedSelector: "review/effort:medium",
			effort: Effort.Medium,
		});
		expect(automatic.memberRequests[0]!.model).toBe("review/effort:medium");
	});

	it("blocks an unavailable or unauthenticated planner, absent Main model, and inactive write tool", async () => {
		modelResolverSpy.mockImplementation(options =>
			isPlannerSelector(options.cliModel)
				? {
						model: undefined,
						selector: undefined,
						thinkingLevel: undefined,
						warning: undefined,
						error: "not found",
					}
				: resolved(options.cliModel ?? ""),
		);
		await expectBlocked(host(), "Planner model is unavailable");

		modelResolverSpy.mockImplementation(options => resolved(options.cliModel ?? ""));
		const unauthenticatedPlanner = host();
		unauthenticatedPlanner.modelRegistry.getApiKey = mock(async model =>
			model.provider === "planner" ? undefined : "test-key",
		);
		await expectBlocked(unauthenticatedPlanner, "Planner model planner/slow has no usable credentials");
		await expectBlocked(host({ model: undefined }), "active Main model");
		const unauthenticatedMain = host();
		unauthenticatedMain.modelRegistry.getApiKey = mock(async model =>
			model.provider === "main" ? undefined : "test-key",
		);
		await expectBlocked(unauthenticatedMain, "Main model main/active has no usable credentials");
		await expectBlocked(host({ activeTools: ["read"] }), "write tool");
	});

	it("blocks tool-incapable members, planner, and Main before storage or child dispatch", async () => {
		const unsupportedMember = { ...memberModel, supportsTools: false } as Model<Api>;
		modelResolverSpy.mockImplementation(options => {
			const base = resolved(options.cliModel ?? "");
			return isPlannerSelector(options.cliModel) ? base : { ...base, model: unsupportedMember };
		});
		await expectBlocked(host(), "Reviewer model review/one does not support tools");

		const unsupportedPlanner = { ...plannerModel, supportsTools: false } as Model<Api>;
		modelResolverSpy.mockImplementation(options => {
			const base = resolved(options.cliModel ?? "");
			return isPlannerSelector(options.cliModel) ? { ...base, model: unsupportedPlanner } : base;
		});
		await expectBlocked(host(), "Planner model planner/slow does not support tools");

		modelResolverSpy.mockImplementation(options => resolved(options.cliModel ?? ""));
		await expectBlocked(
			host({ model: { ...mainModel, supportsTools: false } as Model<Api> }),
			"Main model main/active does not support tools",
		);
		expect(publication.resolveCouncilPublicationTarget).not.toHaveBeenCalled();
		expect(instructions.captureCouncilInstructionSnapshot).not.toHaveBeenCalled();
		expect(subagents.resolveEffectiveSubagentPolicy).not.toHaveBeenCalled();
	});

	it("blocks repository, publication, and instruction snapshot failures before model execution", async () => {
		const invalidRepository = host();
		invalidRepository.sessionManager = {
			getCwd: () => "/definitely/missing/council-repository",
			getSessionId: () => "session-1",
		};
		await expectBlocked(invalidRepository, "repository root is unusable");

		publicationSpy.mockRejectedValueOnce(new Error("target collision"));
		await expectBlocked(host(), "target collision");

		instructionsSpy.mockRejectedValueOnce(new Error("instruction escaped root"));
		await expectBlocked(host(), "instruction escaped root");
	});

	it("preflights planner and member final policies and propagates either blocker without spending", async () => {
		await preflightCouncilDispatch(host(), "Change auth");
		expect(subagents.resolveEffectiveSubagentPolicy).toHaveBeenCalledTimes(2);
		expect(subagents.resolveEffectiveSubagentPolicy).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ agent: "council-planner" }),
		);
		expect(subagents.resolveEffectiveSubagentPolicy).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ agent: "council-member" }),
		);

		policySpy.mockRejectedValueOnce(new Error("spawn denied"));
		await expectBlocked(host(), "spawn denied");
		policySpy.mockImplementation(async request => {
			if (request.agent === "council-member") throw new Error("member disabled");
			return { agentName: request.agent } as EffectiveSubagentPolicy;
		});
		await expectBlocked(host(), "member disabled");
	});

	it("revalidates a promised resume target without collision allocation or renaming", async () => {
		const promised = spyOn(publication, "resolvePromisedCouncilPublicationTarget").mockResolvedValue(
			publicationTarget,
		);

		const plan = await preflightCouncilDispatch(host(), "Change auth", {
			promisedOutputPath: publicationTarget.relativePath,
		});

		expect(promised).toHaveBeenCalledWith(planRoot, publicationTarget.relativePath);
		expect(publication.resolveCouncilPublicationTarget).not.toHaveBeenCalled();
		expect(plan.publicationTarget).toEqual(publicationTarget);
	});

	it("names a fresh publication target from the task itself", async () => {
		const task = "on the models page I want the ability to assign different models depending on the plan phase";

		const plan = await preflightCouncilDispatch(host(), task);

		// The word-aligned slugger owns the name; nothing summarizes the task first.
		expect(publicationSpy).toHaveBeenCalledWith(planRoot, task, "command");
		expect(plan.publicationTarget).toEqual(publicationTarget);
	});

	// Every refusal class *and* the success path: none of them may reach a completion API. This is
	// what makes `spending: false` literally true and puts the kickoff line ahead of all council spend.
	for (const scenario of [
		{ name: "a successful dispatch", install: () => undefined, signal: undefined },
		{
			name: "a publication refusal",
			install: () =>
				spyOn(publication, "ensureCouncilPlanRoot").mockRejectedValue(
					new Error("plan root is not a real directory"),
				),
			signal: undefined,
		},
		{
			name: "an instruction refusal",
			install: () => instructionsSpy.mockRejectedValue(new Error("nested AGENTS.md escapes the root")),
			signal: undefined,
		},
		{
			name: "a subagent policy refusal",
			install: () => policySpy.mockRejectedValue(new Error("agent is disabled")),
			signal: undefined,
		},
		{
			name: "a cancelled run",
			install: () => undefined,
			signal: (): AbortSignal => AbortSignal.abort(),
		},
	]) {
		it(`reaches no completion API on ${scenario.name}`, async () => {
			scenario.install();

			await preflightCouncilDispatch(host(), "Change auth", { signal: scenario.signal?.() }).catch(() => undefined);

			expect(titleTrap).not.toHaveBeenCalled();
		});
	}

	it("starts no stage at all when the run is cancelled before preflight", async () => {
		const preflightHost = host();

		await expect(
			preflightCouncilDispatch(preflightHost, "Change auth", { signal: AbortSignal.abort() }),
		).rejects.toThrow();

		// Cancellation is the caller's, never a dispatch refusal, and it lands before task validation.
		expect(modelResolverSpy).not.toHaveBeenCalled();
		expect(preflightHost.modelRegistry.getApiKey).not.toHaveBeenCalled();
		expect(instructionsSpy).not.toHaveBeenCalled();
		expect(policySpy).not.toHaveBeenCalled();
		expect(publicationSpy).not.toHaveBeenCalled();
	});

	it("starts no later stage after the signal aborts mid-flight", async () => {
		const controller = new AbortController();
		// Instruction capture takes no signal — the checkpoints are cooperative, not propagating — so
		// it runs to completion and everything ordered behind it is what must never start.
		instructionsSpy.mockImplementation(async () => {
			controller.abort();
			return instructionSnapshot;
		});

		const failure = await preflightCouncilDispatch(host(), "Change auth", { signal: controller.signal }).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(failure).not.toBeInstanceOf(CouncilDispatchError);
		expect(instructionsSpy).toHaveBeenCalledTimes(1);
		expect(policySpy).not.toHaveBeenCalled();
		expect(publicationSpy).not.toHaveBeenCalled();
	});

	it("stops repository discovery between its probes when the run aborts", async () => {
		const controller = new AbortController();
		const realpath = spyOn(fsPromises, "realpath");
		// `git rev-parse` spawns a subprocess, so it is the probe most likely to straddle a
		// cancellation: the second `realpath` and everything behind it must never start.
		spyOn(git.repo, "root").mockImplementation(async () => {
			controller.abort();
			return cwd;
		});

		const failure = await preflightCouncilDispatch(host(), "Change auth", { signal: controller.signal }).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(failure).not.toBeInstanceOf(CouncilDispatchError);
		// Exactly the first probe: the post-discovery canonicalization never ran.
		expect(realpath).toHaveBeenCalledTimes(1);
		expect(instructionsSpy).not.toHaveBeenCalled();
		expect(policySpy).not.toHaveBeenCalled();
		expect(publicationSpy).not.toHaveBeenCalled();
	});

	it("does not create the plan directory when the run aborts while resolving the cache root", async () => {
		const controller = new AbortController();
		const ensurePlanRoot = spyOn(publication, "ensureCouncilPlanRoot");
		// `councilPlanRoot` reads the session artifacts directory and takes no signal, so it runs to
		// completion; the checkpoint behind it is what must stop the directory from being created.
		// Nesting the two awaits in one expression would defeat that.
		const preflightHost = host({ onArtifactsDir: () => controller.abort() });

		const failure = await preflightCouncilDispatch(preflightHost, "Change auth", {
			signal: controller.signal,
		}).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(failure).not.toBeInstanceOf(CouncilDispatchError);
		expect(ensurePlanRoot).not.toHaveBeenCalled();
		expect(publicationSpy).not.toHaveBeenCalled();
	});

	it("stops resolving the rest of the roster once a credential lookup aborts the run", async () => {
		const controller = new AbortController();
		const preflightHost = host({
			settings: settings({
				members: [
					{ role: "council1", enabled: true },
					{ role: "council2", enabled: true },
				],
				roles: { council1: "review/one:high", council2: "review/two:high" },
			}),
		});
		preflightHost.modelRegistry.getApiKey = mock(async () => {
			controller.abort();
			return "test-key";
		});

		await expect(
			preflightCouncilDispatch(preflightHost, "Change auth", { signal: controller.signal }),
		).rejects.toThrow();

		// Sequential by construction, never `Promise.all`: reviewer 2 is not even resolved.
		expect(modelResolverSpy.mock.calls.map(([resolveOptions]) => resolveOptions.cliModel)).toEqual([
			"review/one:high",
		]);
		expect(preflightHost.modelRegistry.getApiKey).toHaveBeenCalledTimes(1);
	});

	it("pins every child cwd and instruction capture to the canonical root when the session starts nested", async () => {
		const repoRoot = fs.realpathSync(path.resolve(cwd, "../.."));
		const nestedHost = host({ cwd });
		spyOn(git.repo, "root").mockResolvedValueOnce(repoRoot);
		// The plan root is the session cache, so a nested checkout changes the discovered repository
		// root without moving the publication target off `local://`.
		publicationSpy.mockResolvedValueOnce(publicationTarget);
		instructionsSpy.mockResolvedValueOnce({ ...instructionSnapshot, repoRoot });

		const plan = await preflightCouncilDispatch(nestedHost, "Review sibling package behavior");

		expect(plan.cwd).toBe(cwd);
		expect(plan.repoRoot).toBe(repoRoot);
		expect([plan.plannerRequest, ...plan.memberRequests].every(request => request.cwd === repoRoot)).toBeTrue();
		expect(instructions.captureCouncilInstructionSnapshot).toHaveBeenCalledWith(nestedHost.toolSession, repoRoot);
		expect(plan.publicationTarget.planRoot).toBe(planRoot);
	});

	it("snapshots publication, instructions, roster, duplicate warnings, and strict pinned requests", async () => {
		const duplicateSettings = settings({
			members: [
				{ role: "first", enabled: true },
				{ role: "second", enabled: true },
			],
			roles: { first: "main/active:high", second: "main/active:high" },
		});
		modelResolverSpy.mockImplementation(options => {
			if (isPlannerSelector(options.cliModel)) return resolved(options.cliModel ?? "");
			return { ...resolved(options.cliModel ?? ""), model: mainModel, selector: "main/active" };
		});

		const plan = await preflightCouncilDispatch(host({ settings: duplicateSettings }), "Change auth");

		expect(plan.repoRoot).toBe(cwd);
		expect(plan.publicationTarget.relativePath).toBe("council-change-auth-plan.md");
		expect(plan.publicationTarget.planRoot).toBe(planRoot);
		expect(plan.instructions).toEqual(instructionSnapshot);
		expect(plan.instructions.files).toEqual([
			{ path: path.join(cwd, "AGENTS.md"), sha256: sha256CouncilContent("rules") },
		]);
		expect(plan.config.rounds).toBe(1);
		expect(plan.members.map(member => [member.role, member.order])).toEqual([
			["first", 0],
			["second", 1],
		]);
		expect(plan.members.map(member => [member.requestedSelector, member.resolvedSelector, member.effort])).toEqual([
			["main/active:high", "main/active:high", "high"],
			["main/active:high", "main/active:high", "high"],
		]);
		expect(plan.planner).toMatchObject({
			requestedSelector: "@slow",
			resolvedSelector: "planner/slow:max",
			effort: "max",
		});
		expect(plan.adjudicator).toMatchObject({ mode: "main", selector: "main/active", effort: undefined });
		expect(plan.warnings).toEqual(["Council reviewers First, Second resolve to the same model main/active."]);
		const requests = [plan.plannerRequest, ...plan.memberRequests];
		for (const request of requests) {
			expect(request).toMatchObject({
				cwd,
				model: expect.any(String),
				pinModel: true,
				tools: ["read", "grep", "glob", "lsp", "ast_grep"],
				restrictToolNames: true,
				inheritContextFiles: true,
				additionalContextFiles: instructionSnapshot.contextFiles,
				skills: [],
				rules: [],
				autoloadSkills: [],
				enableIrc: false,
				schemaMode: "strict",
			});
			expect(request).not.toHaveProperty("modelOverride");
		}
		expect(subagents.runStructuredSubagent).toHaveBeenCalledTimes(0);
	});

	it("pins the planner to an assigned planner role and falls back to slow only when it is unassigned", async () => {
		const assigned = await preflightCouncilDispatch(
			host({ settings: settings({ roles: { planner: "review/two" } }) }),
			"Change auth",
		);

		expect(assigned.planner).toMatchObject({
			role: "planner",
			requestedSelector: "review/two",
			resolvedSelector: "review/two:high",
			model: otherMemberModel,
		});
		expect(assigned.plannerRequest.model).toBe("review/two:high");
		// The assigned lead is an explicit pin, so the historical `@slow` alias is never consulted.
		expect(modelResolverSpy).not.toHaveBeenCalledWith(expect.objectContaining({ cliModel: "@slow" }));

		const unassigned = await preflightCouncilDispatch(host(), "Change auth");

		expect(unassigned.planner).toMatchObject({
			role: "slow",
			requestedSelector: "@slow",
			model: plannerModel,
		});
		// Control for the negative above: this is the run that does reach the `@slow` alias.
		expect(modelResolverSpy).toHaveBeenCalledWith(expect.objectContaining({ cliModel: "@slow" }));
	});

	it("refuses a planner role mapping to several models without falling back to a role default", async () => {
		const error = await expectBlocked(
			host({ settings: settings({ roles: { planner: ["review/one", "review/two"] } }) }),
			"Council Planner must configure exactly one model selector.",
		);

		expect(error.code).toBe("COUNCIL_PLANNER_MODEL_INVALID");
		// An ambiguous pin is a refusal, never a quiet demotion to the `slow` role behind it.
		expect(modelResolverSpy).not.toHaveBeenCalledWith(expect.objectContaining({ cliModel: "@slow" }));
	});

	it("keeps adjudication in the main session until an adjudicator role is assigned", async () => {
		const main = await preflightCouncilDispatch(host(), "Change auth");

		expect(main.adjudicator).toMatchObject({ mode: "main", selector: "main/active", model: mainModel });
		expect(main.adjudicatorRequest).toBeUndefined();
		expect(policySpy.mock.calls.map(([request]) => request.agent)).toEqual(["council-planner", "council-member"]);

		const delegated = await preflightCouncilDispatch(
			host({ settings: settings({ roles: { adjudicator: "review/two" } }) }),
			"Change auth",
		);

		expect(delegated.adjudicator).toMatchObject({
			mode: "delegated",
			requestedSelector: "review/two",
			resolvedSelector: "review/two:high",
			model: otherMemberModel,
		});
		expect(delegated.adjudicatorRequest).toMatchObject({
			agent: "council-adjudicator",
			model: "review/two:high",
			pinModel: true,
			restrictToolNames: true,
			schemaMode: "strict",
		});
		expect(policySpy).toHaveBeenCalledWith(expect.objectContaining({ agent: "council-adjudicator" }));
	});

	it("delegates adjudication to the planner's model for an agent-convened run with no adjudicator assigned", async () => {
		// Main-mode adjudication waits for the session to go idle; the `council` tool call that convened
		// the run is what would have to finish first, so main mode here deadlocks rather than degrading.
		const plan = await preflightCouncilDispatch(host(), "Change auth", { origin: "agent" });

		expect(plan.origin).toBe("agent");
		expect(plan.adjudicator).toMatchObject({
			mode: "delegated",
			requestedSelector: "@slow",
			resolvedSelector: "planner/slow:max",
			model: plannerModel,
		});
		expect(plan.adjudicatorRequest).toMatchObject({ agent: "council-adjudicator", model: "planner/slow:max" });
		// The substitution is announced, not silent: the operator is paying one model to both plan and judge.
		expect(plan.warnings).toContain(
			"No model is assigned to the `adjudicator` role, and an agent-convened run cannot adjudicate in your main session; planner/slow adjudicates as well as plans. Assign the Council Adjudicator row to separate them.",
		);
		// Advisory, not degrading: the run still produces a real adjudicated plan.
		expect(plan.degraded).toBeFalse();
	});

	it("keeps an assigned adjudicator and mints a brief stem for an agent-convened run", async () => {
		const plan = await preflightCouncilDispatch(
			host({ settings: settings({ roles: { adjudicator: "review/two" } }) }),
			"Change auth",
			{ origin: "agent" },
		);

		expect(plan.adjudicator).toMatchObject({ mode: "delegated", model: otherMemberModel });
		expect(plan.warnings).toEqual([]);
		// The stem is the whole mechanism keeping an agent brief out of `listPlanFiles`.
		expect(publicationSpy).toHaveBeenCalledWith(planRoot, "Change auth", "agent");
	});

	it("applies the operator's advisor toggles to a dispatch at either origin", async () => {
		// A dispatch reconciles into one adjudicated artifact, so the advisor is the operator's quality
		// knob on that pipeline and `origin` has no business overriding it. Only a consult forces
		// advisors off: its entire product is N independent reads, and the `advisor` role is a single
		// shared model that would correlate them (see council-consult.test.ts).
		const configured = settings({
			roles: { adjudicator: "review/two" },
			advisor: { planner: true, reviewers: true, adjudicator: true },
		});

		const agentRun = await preflightCouncilDispatch(host({ settings: configured }), "Change auth", {
			origin: "agent",
		});
		const commandRun = await preflightCouncilDispatch(host({ settings: configured }), "Change auth");

		for (const run of [agentRun, commandRun]) {
			expect(run.planner.advisor).toBeTrue();
			expect(run.members.map(member => member.advisor)).toEqual([true]);
			expect(run.adjudicator).toMatchObject({ mode: "delegated", advisor: true });
			for (const request of [run.plannerRequest, ...run.memberRequests, run.adjudicatorRequest!]) {
				expect(request.advisor).toBeTrue();
			}
		}
	});

	it("serves round 1 from a member with no round pin, at either round count", async () => {
		// An omitted `round` means EVERY configured round, so such a member is always in round 1. The
		// default roster in this suite is exactly that shape, which is why it must be asserted rather
		// than assumed.
		const single = await preflightCouncilDispatch(host(), "Change auth");
		expect(single.members.map(member => member.rounds)).toEqual([[1]]);

		const dual = await preflightCouncilDispatch(
			host({
				settings: settings({
					rounds: 2,
					members: [
						{ role: "reviewer", enabled: true },
						{ role: "second", enabled: true, round: 2 },
					],
					roles: { reviewer: "review/one:high", second: "review/two:high" },
				}),
			}),
			"Change auth",
		);
		expect(dual.members.map(member => [member.role, member.rounds])).toEqual([
			["reviewer", [1, 2]],
			["second", [2]],
		]);
		// Round 1 is staffed solely by the unpinned member, so it must not have been treated as inert.
		expect(dual.inert).toEqual([]);
	});

	it("refuses an adjudicator role mapping to several models", async () => {
		const error = await expectBlocked(
			host({ settings: settings({ roles: { adjudicator: ["review/one", "review/two"] } }) }),
			"Council Adjudicator must configure exactly one model selector.",
		);

		expect(error.code).toBe("COUNCIL_ADJUDICATOR_MODEL_INVALID");
	});

	it("threads each council.advisor toggle onto exactly the requests it names", async () => {
		const reviewers = await preflightCouncilDispatch(
			host({
				settings: settings({
					members: [
						{ role: "first", enabled: true },
						{ role: "second", enabled: true },
					],
					roles: { first: "review/one:high", second: "review/two:high" },
					advisor: { reviewers: true },
				}),
			}),
			"Change auth",
		);

		expect(reviewers.members.map(member => member.advisor)).toEqual([true, true]);
		expect(reviewers.memberRequests.map(request => request.advisor)).toEqual([true, true]);
		expect(reviewers.planner.advisor).toBeFalse();
		expect(reviewers.plannerRequest.advisor).toBeFalse();

		const planner = await preflightCouncilDispatch(
			host({ settings: settings({ advisor: { planner: true } }) }),
			"Change auth",
		);

		expect(planner.planner.advisor).toBeTrue();
		expect(planner.plannerRequest.advisor).toBeTrue();
		expect(planner.memberRequests.map(request => request.advisor)).toEqual([false]);
	});

	it("never depends on Main's write tool once adjudication is delegated", async () => {
		const delegated = await preflightCouncilDispatch(
			host({ activeTools: ["read"], settings: settings({ roles: { adjudicator: "review/two" } }) }),
			"Change auth",
		);

		expect(delegated.adjudicator.mode).toBe("delegated");
		expect(delegated.adjudicatorRequest?.agent).toBe("council-adjudicator");

		// Same session, same missing tool: only a main-mode adjudicator drives `xd://council`.
		const error = await expectBlocked(host({ activeTools: ["read"] }), "write tool");
		expect(error.code).toBe("COUNCIL_WRITE_TOOL_REQUIRED");
	});

	it("parks a member pinned above the configured rounds instead of resolving or refusing it", async () => {
		const plan = await preflightCouncilDispatch(
			host({
				settings: settings({
					members: [
						{ role: "reviewer", enabled: true },
						{ role: "parked", enabled: true, round: 2 },
					],
					rounds: 1,
				}),
			}),
			"Change auth",
		);

		expect(plan.members.map(member => member.role)).toEqual(["reviewer"]);
		expect(plan.memberRequests).toHaveLength(1);
		expect(plan.inert).toEqual([{ role: "parked", enabled: true, order: 1, round: 2 }]);
		// Parked configuration survives in the roster it was written to, and is reported…
		expect(plan.roster.map(member => member.role)).toEqual(["reviewer", "parked"]);
		expect(plan.warnings).toEqual([
			"Council Parked is pinned to round 2 but only 1 round(s) are configured; it will not run.",
		]);
		// …but the run that actually executes is not degraded by it.
		expect(plan.degraded).toBeFalse();
		// `parked` has no modelRoles assignment at all: resolving or credential-checking it would
		// have refused this dispatch, so only the active member and the planner are ever resolved.
		expect(modelResolverSpy.mock.calls.map(([options]) => options.cliModel)).toEqual(["review/one:high", "@slow"]);
	});

	it("refuses an unstaffed configured round while an empty roster still refuses as no enabled members", async () => {
		const unstaffed = await expectBlocked(
			host({ settings: settings({ members: [{ role: "reviewer", enabled: true, round: 1 }], rounds: 2 }) }),
			"Council round 2 has no enabled reviewer.",
		);
		expect(unstaffed.code).toBe("COUNCIL_ROUND_UNSTAFFED");
		// The round check sits ahead of every resolution, so an unstaffed round costs nothing.
		expect(modelResolverSpy).not.toHaveBeenCalled();

		// Every enabled member parked above the configured rounds leaves round 1 itself unstaffed.
		const allParked = await expectBlocked(
			host({ settings: settings({ members: [{ role: "reviewer", enabled: true, round: 2 }], rounds: 1 }) }),
			"Council round 1 has no enabled reviewer.",
		);
		expect(allParked.code).toBe("COUNCIL_ROUND_UNSTAFFED");

		const empty = await expectBlocked(host({ settings: settings({ members: [] }) }), "No enabled council members");
		expect(empty.code).toBe("COUNCIL_NO_ENABLED_MEMBERS");
	});

	// Reviewer differentiation now comes from the assigned models, so the brief itself is one
	// shared value at every arity, including past the four positions the old selector special-cased.
	it.each([2, 4, 5])("hands all %i enabled reviewers the identical shared review lens", async count => {
		const roles = Array.from({ length: count }, (_, index) => `council${index + 1}`);
		const plan = await preflightCouncilDispatch(
			host({
				settings: settings({
					members: roles.map(role => ({ role, enabled: true })),
					roles: Object.fromEntries(roles.map(role => [role, "review/one:high"])),
				}),
			}),
			"Change auth",
		);

		expect(plan.members).toHaveLength(count);
		expect(new Set(plan.members.map(member => member.lens)).size).toBe(1);
		expect(plan.members.every(member => member.lens === reviewLens)).toBeTrue();
	});

	const numberedRoster = (count: number): Array<{ role: string; enabled: boolean }> =>
		Array.from({ length: count }, (_unused, index) => ({ role: `council${index + 1}`, enabled: true }));
	const numberedRoles = (count: number): Record<string, string> =>
		Object.fromEntries(numberedRoster(count).map(member => [member.role, "review/one:high"]));

	it("dispatches the maximum active roster and refuses one above it before any credential or child work", async () => {
		const full = await preflightCouncilDispatch(
			host({
				settings: settings({
					members: numberedRoster(COUNCIL_MAX_ACTIVE_REVIEWERS),
					roles: numberedRoles(COUNCIL_MAX_ACTIVE_REVIEWERS),
				}),
			}),
			"Change auth",
		);
		expect(full.members).toHaveLength(COUNCIL_MAX_ACTIVE_REVIEWERS);
		expect(full.memberRequests).toHaveLength(COUNCIL_MAX_ACTIVE_REVIEWERS);

		const oversized = host({
			settings: settings({
				members: numberedRoster(COUNCIL_MAX_ACTIVE_REVIEWERS + 1),
				roles: numberedRoles(COUNCIL_MAX_ACTIVE_REVIEWERS + 1),
			}),
		});
		modelResolverSpy.mockClear();
		instructionsSpy.mockClear();
		policySpy.mockClear();
		publicationSpy.mockClear();

		const error = await expectBlocked(oversized, "65 reviewers would run in 1 configured round(s)");

		expect(error.code).toBe("COUNCIL_CONFIG_INVALID");
		expect(error.message).toContain(
			`above the ${COUNCIL_MAX_ACTIVE_REVIEWERS}-reviewer limit an adjudication can grade`,
		);
		// The grade schema cannot address slot 65, so nothing downstream of the roster is even touched.
		expect(modelResolverSpy).not.toHaveBeenCalled();
		expect(oversized.modelRegistry.getApiKey).not.toHaveBeenCalled();
		expect(instructionsSpy).not.toHaveBeenCalled();
		expect(policySpy).not.toHaveBeenCalled();
		expect(publicationSpy).not.toHaveBeenCalled();
	});

	it("reports every unassigned active reviewer in one refusal, in roster order with stable labels", async () => {
		const partial = host({
			settings: settings({
				members: [
					{ role: "council1", enabled: true },
					{ role: "council2", enabled: true },
					{ role: "council3", enabled: true },
					{ role: "judge2", enabled: true },
					{ role: "parked", enabled: true, round: 2 },
					{ role: "off", enabled: false },
				],
				rounds: 1,
				roles: { council2: "review/one:high" },
			}),
			// Broken credentials underneath: the aggregate has to win, or the operator fixes one
			// reviewer per dispatch attempt and never sees the list.
			apiKey: undefined,
		});

		const error = await expectBlocked(
			partial,
			"Council has 1 of 4 active reviewers assigned; no model selector is configured for Reviewer 1, Reviewer 3, Judge 2. Assign models with /council config (Model Hub -> Roles & Council).",
		);

		expect(error.code).toBe("COUNCIL_MEMBER_MODEL_INVALID");
		// A round-2 pin under one configured round and a disabled row are parked, not missing.
		expect(partial.modelRegistry.getApiKey).not.toHaveBeenCalled();
		expect(modelResolverSpy).not.toHaveBeenCalled();
	});

	it("orders task bounds and strict configuration ahead of staffing and assignment", async () => {
		await expect(
			preflightCouncilDispatch(host({ settings: Settings.isolated({ "council.members": "bad" }) }), "   "),
		).rejects.toMatchObject({ code: "COUNCIL_TASK_INVALID" });

		// The active cap is part of strict config, so it beats the unstaffed round it also creates.
		const capped = await expectBlocked(
			host({
				settings: settings({
					members: numberedRoster(COUNCIL_MAX_ACTIVE_REVIEWERS + 1).map(member => ({
						...member,
						round: 1 as const,
					})),
					roles: numberedRoles(COUNCIL_MAX_ACTIVE_REVIEWERS + 1),
					rounds: 2,
				}),
			}),
			"65 reviewers would run in 2 configured round(s)",
		);
		expect(capped.code).toBe("COUNCIL_CONFIG_INVALID");

		// Staffing beats the missing assignment on the very member that leaves round 2 empty.
		const unstaffed = await expectBlocked(
			host({ settings: settings({ members: [{ role: "council1", enabled: true, round: 1 }], rounds: 2 }) }),
			"Council round 2 has no enabled reviewer.",
		);
		expect(unstaffed.code).toBe("COUNCIL_ROUND_UNSTAFFED");
	});

	it("orders reviewers ahead of the planner and the planner ahead of the adjudicator", async () => {
		modelResolverSpy.mockImplementation(() => ({
			model: undefined,
			selector: undefined,
			thinkingLevel: undefined,
			warning: undefined,
			error: "not found",
		}));

		const reviewerFirst = await expectBlocked(host(), "Reviewer model is unavailable");
		expect(reviewerFirst.code).toBe("COUNCIL_MEMBER_MODEL_INVALID");

		modelResolverSpy.mockImplementation(options => resolved(options.cliModel ?? ""));
		const plannerFirst = await expectBlocked(
			host({
				settings: settings({
					roles: { planner: ["review/one", "review/two"], adjudicator: ["review/one", "review/two"] },
				}),
			}),
			"Council Planner must configure exactly one model selector.",
		);
		expect(plannerFirst.code).toBe("COUNCIL_PLANNER_MODEL_INVALID");
	});

	it("orders both leads ahead of repository, instruction, policy, and publication work", async () => {
		instructionsSpy.mockRejectedValue(new Error("nested AGENTS.md escapes the root"));
		policySpy.mockRejectedValue(new Error("agent is disabled"));
		publicationSpy.mockRejectedValue(new Error("target collision"));

		const adjudicatorFirst = await expectBlocked(
			host({
				cwd: "/definitely/missing/council-repository",
				settings: settings({ roles: { adjudicator: ["review/one", "review/two"] } }),
			}),
			"Council Adjudicator must configure exactly one model selector.",
		);
		expect(adjudicatorFirst.code).toBe("COUNCIL_ADJUDICATOR_MODEL_INVALID");

		const repositoryFirst = await expectBlocked(
			host({ cwd: "/definitely/missing/council-repository" }),
			"repository root is unusable",
		);
		expect(repositoryFirst.code).toBe("COUNCIL_REPOSITORY_INVALID");

		const instructionsFirst = await expectBlocked(host(), "nested AGENTS.md escapes the root");
		expect(instructionsFirst.code).toBe("COUNCIL_INSTRUCTIONS_INVALID");

		instructionsSpy.mockResolvedValue(instructionSnapshot);
		const policyFirst = await expectBlocked(host(), "agent is disabled");
		expect(policyFirst.code).toBe("COUNCIL_SUBAGENT_POLICY_INVALID");

		policySpy.mockImplementation(async request => ({ agentName: request.agent }) as EffectiveSubagentPolicy);
		const publicationLast = await expectBlocked(host(), "target collision");
		expect(publicationLast.code).toBe("COUNCIL_PUBLICATION_INVALID");
	});

	// The lens is the one prompt stored without a trailing newline: `member-task.md` supplies the
	// separator, and a second newline would make a 2+ blank run that the renderer deletes outright,
	// welding the brief onto the next heading.
	it("renders the whole shared lens as its own section before the next assignment heading", () => {
		const assignment = prompt.render(memberTaskTemplate, {
			repositoryRoot: cwd,
			round: 1,
			lens: reviewLens,
			idPrefix: "A",
			task: "Change auth",
			plan: "## Context\n\nDraft.",
		});

		const lensStart = assignment.indexOf(reviewLens);
		expect(lensStart).toBeGreaterThan(-1);
		expect(assignment.slice(lensStart + reviewLens.length)).toStartWith("\n\n#");
	});

	it("refuses to resume a persisted roster above the active reviewer limit", () => {
		const roster = Array.from({ length: COUNCIL_MAX_ACTIVE_REVIEWERS + 1 }, (_unused, index) => ({
			role: `council${index + 1}`,
			enabled: true,
			order: index,
			rounds: [1],
			advisor: false,
			requestedSelector: "review/one:high",
			resolvedModel: "review/one:high",
			effort: "high",
			lens: reviewLens,
		}));
		const oversized = { runId: "run-9", state: "interrupted", roster } as const;

		try {
			assertCouncilResumeRosterWithinLimit(oversized);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilDispatchError);
			expect((error as CouncilDispatchError).code).toBe("COUNCIL_CONFIG_INVALID");
			expect((error as CouncilDispatchError).spending).toBeFalse();
			expect((error as Error).message).toBe(
				"Council run run-9 has 65 active reviewers, above the 64-reviewer limit an adjudication can grade, so it cannot be resumed. Reduce the roster with /council config (Model Hub -> Roles & Council) and start a new run.",
			);
		}

		// At the limit it continues, and a terminal run keeps whatever refusal it already had.
		expect(() => assertCouncilResumeRosterWithinLimit({ ...oversized, roster: roster.slice(1) })).not.toThrow();
		expect(() => assertCouncilResumeRosterWithinLimit({ ...oversized, state: "completed" })).not.toThrow();
	});
});
