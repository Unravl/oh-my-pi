import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import {
	COUNCIL_SLUG_MAX_LENGTH,
	type CouncilPublicationDurabilityOperation,
	CouncilPublicationError,
	type CouncilPublicationFileSystem,
	commitStagedCouncilPublication,
	councilPublicationSlug,
	ensureCouncilPlanRoot,
	publishCouncilPlan,
	publishedCouncilPlanMatches,
	resolveCouncilPublicationTarget,
	resolvePromisedCouncilPublicationTarget,
	stageCouncilPublication,
} from "@oh-my-pi/pi-coding-agent/council/publication";
import { TempDir } from "@oh-my-pi/pi-utils";
import { directorySymlinkType, durableOps, symlinksSupported } from "./helpers/platform";

describe("council publication targets", () => {
	it("creates bounded lowercase kebab slugs that never end in a published stem", () => {
		expect(councilPublicationSlug("  Fix OAuth_2 / Redirect PLAN  ")).toBe("fix-oauth-2-redirect");
		expect(councilPublicationSlug("plan")).toBe("council");
		expect(councilPublicationSlug("...")).toBe("council");
		expect(councilPublicationSlug(`${"Long task ".repeat(20)}plan`)).not.toEndWith("-plan");
		// Both stems are reserved, and stripping repeats until nothing is left to strip: either name
		// would otherwise produce `council-x-brief-brief.md`, which the output-path grammar rejects.
		expect(councilPublicationSlug("brief")).toBe("council");
		expect(councilPublicationSlug("Rework the auth brief")).toBe("rework-the-auth");
		expect(councilPublicationSlug("Rework the auth plan brief")).toBe("rework-the-auth");
		// Only whole trailing words are stems; a word that merely ends in one survives.
		expect(councilPublicationSlug("Write the debrief")).toBe("write-the-debrief");
	});

	it("truncates a sentence-length task on a word boundary inside the length budget", () => {
		const task = "on the models page I want the ability to assign different models depending on the plan phase";
		const slug = councilPublicationSlug(task);

		expect(slug.length).toBeLessThanOrEqual(COUNCIL_SLUG_MAX_LENGTH);
		// Every retained segment is a whole word of the task; the old character slice ended in `th`.
		for (const segment of slug.split("-")) expect(task.toLowerCase().split(/[^a-z0-9]+/)).toContain(segment);
		expect(councilPublicationSlug(task, 12)).toBe("on-the");
		// A single word wider than the whole budget is the only case that still cuts mid-word.
		expect(councilPublicationSlug("supercalifragilistic", 8)).toBe("supercal");
	});

	it("rejects promised output paths outside the shared durable slug contract", async () => {
		using temp = TempDir.createSync("@omp-council-invalid-target-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		for (const outputPath of [
			"council-plan.md",
			"council-review-plan-plan.md",
			"council-Review-plan.md",
			"review-auth-plan.md",
			"council-review-auth.md",
			`council-${"a".repeat(81)}-plan.md`,
			"nested/council-review-plan.md",
			"plans/plan.md",
			"plans/review-plan.md",
			"plans/Review.md",
			"plans/nested/review.md",
			`plans/${"a".repeat(81)}.md`,
		]) {
			await expect(
				publishedCouncilPlanMatches(planRoot, outputPath, { sha256: "a".repeat(64), bytes: 0 }),
			).rejects.toMatchObject({ code: "INVALID_TARGET" });
		}
	});

	it("creates and syncs the plan root itself, never a plans segment below it", async () => {
		using temp = TempDir.createSync("@omp-council-plan-root-");
		const planRoot = temp.join("root");
		const operations: CouncilPublicationDurabilityOperation[] = [];
		const canonicalPlanRoot = await ensureCouncilPlanRoot(planRoot, {
			onDurabilityOperation: (operation: CouncilPublicationDurabilityOperation) => operations.push(operation),
		});
		expect(operations).toEqual(durableOps("directory-sync"));
		expect(canonicalPlanRoot).toBe(fs.realpathSync(planRoot));
		expect(fs.readdirSync(canonicalPlanRoot)).toEqual([]);
	});

	it("mints a bare council-<slug>-plan.md target directly in the canonical plan root", async () => {
		using temp = TempDir.createSync("@omp-council-target-shape-");
		const planRoot = temp.join("root");
		const target = await resolveCouncilPublicationTarget(planRoot, "Review auth", "command");

		expect(target.relativePath).toBe("council-review-auth-plan.md");
		expect(target.fileName).toBe(target.relativePath);
		expect(target.slug).toBe("review-auth");
		expect(target.planRoot).toBe(fs.realpathSync(planRoot));
		expect(target.absolutePath).toBe(path.join(target.planRoot, target.relativePath));
		expect(path.dirname(target.absolutePath)).toBe(target.planRoot);
	});

	it("mints an agent brief that the plan listing cannot see, in the same root and namespace", async () => {
		using temp = TempDir.createSync("@omp-council-brief-target-");
		const planRoot = temp.join("root");
		const brief = await resolveCouncilPublicationTarget(planRoot, "Review auth", "agent");

		expect(brief.relativePath).toBe("council-review-auth-brief.md");
		expect(brief.slug).toBe("review-auth");
		// The consumer contract: `listPlanFiles` selects on this exact pattern, so an agent-convened run
		// is excluded from plan review by its name alone. If this ever matches, the operator gets an
		// approval screen for a plan they never asked for.
		expect(/plan\.md$/i.test(brief.fileName)).toBeFalse();
		expect(
			/plan\.md$/i.test((await resolveCouncilPublicationTarget(planRoot, "Review auth", "command")).fileName),
		).toBeTrue();

		// Both stems share one collision namespace, so a brief cannot silently overwrite a plan.
		fs.writeFileSync(brief.absolutePath, "existing");
		expect((await resolveCouncilPublicationTarget(planRoot, "Review auth", "agent")).relativePath).toBe(
			"council-review-auth-2-brief.md",
		);
		// A promised brief round-trips its slug through the same stem-stripping the plan form uses.
		expect((await resolvePromisedCouncilPublicationTarget(planRoot, brief.relativePath)).slug).toBe("review-auth");
	});

	it("resolves a collision suffix once", async () => {
		using temp = TempDir.createSync("@omp-council-target-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		fs.writeFileSync(path.join(planRoot, "council-review-auth-plan.md"), "existing");

		const target = await resolveCouncilPublicationTarget(planRoot, "Review auth plan", "command");
		expect(target.relativePath).toBe("council-review-auth-2-plan.md");
		expect(target.slug).toBe("review-auth-2");
		expect(target.absolutePath).toBe(path.join(target.planRoot, "council-review-auth-2-plan.md"));

		const promised = await resolvePromisedCouncilPublicationTarget(planRoot, "council-review-auth-plan.md");
		expect(promised.relativePath).toBe("council-review-auth-plan.md");
		expect(promised.slug).toBe("review-auth");
	});

	it.skipIf(!symlinksSupported())("refuses a plan root whose final component is a symlink", async () => {
		using temp = TempDir.createSync("@omp-council-plan-root-symlink-");
		const real = temp.join("real");
		fs.mkdirSync(real);
		const linkedRoot = temp.join("linked-root");
		fs.symlinkSync(real, linkedRoot, directorySymlinkType);

		try {
			await ensureCouncilPlanRoot(linkedRoot);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilPublicationError);
			expect(error).toMatchObject({ code: "INVALID_TARGET" });
		}
	});

	it("refuses a plan root whose final component is a regular file", async () => {
		using temp = TempDir.createSync("@omp-council-plan-root-file-");
		const fileRoot = temp.join("root");
		fs.writeFileSync(fileRoot, "not a directory");

		try {
			await resolveCouncilPublicationTarget(fileRoot, "Review auth", "command");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilPublicationError);
			expect(error).toMatchObject({ code: "INVALID_TARGET" });
		}
	});

	it.skipIf(!symlinksSupported())("refuses a legacy plans subdirectory that is a symlink", async () => {
		using temp = TempDir.createSync("@omp-council-plans-symlink-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const outside = temp.join("outside");
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(planRoot, "plans"), directorySymlinkType);

		await expect(
			publishCouncilPlan({ planRoot, outputPath: "plans/review-auth.md", content: "# Plan\n" }),
		).rejects.toThrow("not a real directory");
		expect(fs.readdirSync(outside)).toEqual([]);
	});
});

describe("atomic council publication", () => {
	it("does not expose a final file when interrupted after durable temp staging", async () => {
		using temp = TempDir.createSync("@omp-council-stage-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const finalPath = path.join(planRoot, "council-task-plan.md");
		const staged = await stageCouncilPublication(planRoot, "complete plan");

		expect(fs.existsSync(staged.tempPath)).toBeTrue();
		expect(fs.existsSync(finalPath)).toBeFalse();
		fs.unlinkSync(staged.tempPath);
		expect(fs.existsSync(finalPath)).toBeFalse();
	});

	it("removes the staged file without linking when cancellation lands before commit", async () => {
		using temp = TempDir.createSync("@omp-council-stage-abort-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const finalPath = path.join(planRoot, "council-task-plan.md");
		const staged = await stageCouncilPublication(planRoot, "complete plan");
		const controller = new AbortController();
		controller.abort();

		await expect(
			commitStagedCouncilPublication(staged, finalPath, { signal: controller.signal }),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fs.existsSync(staged.tempPath)).toBeFalse();
		expect(fs.existsSync(finalPath)).toBeFalse();
	});

	it("orders file sync, hard link, directory sync, then durable temp cleanup", async () => {
		using temp = TempDir.createSync("@omp-council-publication-order-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const finalPath = path.join(planRoot, "council-task-plan.md");
		const operations: CouncilPublicationDurabilityOperation[] = [];
		const durability = {
			onDurabilityOperation: (operation: CouncilPublicationDurabilityOperation) => operations.push(operation),
		};
		const staged = await stageCouncilPublication(planRoot, "complete plan", durability);
		await commitStagedCouncilPublication(staged, finalPath, durability);

		expect(operations).toEqual(durableOps("file-sync", "link", "directory-sync", "unlink", "directory-sync"));
		expect(fs.readFileSync(finalPath, "utf8")).toBe("complete plan");
		expect(fs.existsSync(staged.tempPath)).toBeFalse();
	});

	it("publishes a complete no-clobber file", async () => {
		using temp = TempDir.createSync("@omp-council-publish-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const target = await resolveCouncilPublicationTarget(planRoot, "Review auth", "command");
		const first = await publishCouncilPlan({
			planRoot,
			outputPath: target.relativePath,
			content: "# Complete plan\n",
			now: "2026-08-05T12:00:00.000Z",
		});
		expect(first.idempotent).toBeFalse();
		expect(first.path).toBe(target.relativePath);
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("# Complete plan\n");
		expect(await publishedCouncilPlanMatches(planRoot, target.relativePath, first)).toBeTrue();
	});

	it("publishes inside the plan root and creates nothing above it", async () => {
		using temp = TempDir.createSync("@omp-council-containment-");
		const parent = temp.join("session");
		fs.mkdirSync(parent);
		const planRoot = path.join(parent, "root");
		const content = "# Contained plan\n";
		const target = await resolveCouncilPublicationTarget(planRoot, "Contained plan", "command");
		const parentBefore = fs.readdirSync(parent).sort();

		const published = await publishCouncilPlan({ planRoot, outputPath: target.relativePath, content });

		expect(fs.readdirSync(parent).sort()).toEqual(parentBefore);
		expect(fs.readdirSync(target.planRoot)).toEqual([target.fileName]);
		expect(fs.existsSync(path.join(target.planRoot, "plans"))).toBeFalse();
		expect(published.path).toBe(target.relativePath);
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe(content);
	});

	it.skipIf(!symlinksSupported())("publishes through a plan root reached by a symlinked ancestor", async () => {
		using temp = TempDir.createSync("@omp-council-symlinked-ancestor-");
		const realRoot = temp.join("real", "root");
		fs.mkdirSync(realRoot, { recursive: true });
		fs.symlinkSync(temp.join("real"), temp.join("link"), directorySymlinkType);
		const planRoot = temp.join("link", "root");
		const content = "# Plan behind a symlinked ancestor\n";

		const target = await resolveCouncilPublicationTarget(planRoot, "Symlinked ancestor", "command");
		expect(target.planRoot).toBe(fs.realpathSync(realRoot));

		const published = await publishCouncilPlan({ planRoot, outputPath: target.relativePath, content });
		expect(published.sha256).toBe(sha256CouncilContent(content));
		expect(fs.readdirSync(fs.realpathSync(realRoot))).toEqual([target.fileName]);
		expect(fs.readFileSync(path.join(fs.realpathSync(realRoot), target.fileName), "utf8")).toBe(content);
	});

	it("publishes a legacy plans/<slug>.md output into a plan-root subdirectory", async () => {
		using temp = TempDir.createSync("@omp-council-legacy-output-");
		const parent = temp.join("session");
		fs.mkdirSync(parent);
		const planRoot = path.join(parent, "root");
		const canonicalPlanRoot = await ensureCouncilPlanRoot(planRoot);
		const parentBefore = fs.readdirSync(parent).sort();
		const content = "# Legacy plan\n";

		const published = await publishCouncilPlan({ planRoot, outputPath: "plans/legacy-review.md", content });

		expect(published.path).toBe("plans/legacy-review.md");
		expect(fs.readdirSync(parent).sort()).toEqual(parentBefore);
		expect(fs.readdirSync(canonicalPlanRoot)).toEqual(["plans"]);
		expect(fs.readdirSync(path.join(canonicalPlanRoot, "plans"))).toEqual(["legacy-review.md"]);
		expect(fs.readFileSync(path.join(canonicalPlanRoot, "plans", "legacy-review.md"), "utf8")).toBe(content);
		expect(await publishedCouncilPlanMatches(planRoot, "plans/legacy-review.md", published)).toBeTrue();
	});

	it("accepts a published plan that git rewrote to CRLF, and still rejects different content", async () => {
		using temp = TempDir.createSync("@omp-council-crlf-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const target = await resolveCouncilPublicationTarget(planRoot, "Crlf target", "command");
		const published = await publishCouncilPlan({
			planRoot,
			outputPath: target.relativePath,
			content: "# Plan\n\n- step one\n",
			now: "2026-08-05T12:00:00.000Z",
		});

		// What a Windows checkout with `core.autocrlf=true` or a `*.md text` attribute leaves behind.
		fs.writeFileSync(target.absolutePath, "# Plan\r\n\r\n- step one\r\n");
		expect(await publishedCouncilPlanMatches(planRoot, target.relativePath, published)).toBeTrue();

		fs.writeFileSync(target.absolutePath, "# Someone else's plan\r\n");
		expect(await publishedCouncilPlanMatches(planRoot, target.relativePath, published)).toBeFalse();
	});

	it("publishes on a filesystem that refuses hard links, and keeps a collision terminal", async () => {
		using temp = TempDir.createSync("@omp-council-no-hardlink-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const target = await resolveCouncilPublicationTarget(planRoot, "No hardlink", "command");
		// What FAT/exFAT volumes, most SMB shares, and non-NTFS Windows targets return for CreateHardLinkW.
		const filesystem: CouncilPublicationFileSystem = {
			open: fsPromises.open,
			lstat: fsPromises.lstat,
			realpath: fsPromises.realpath,
			mkdir: fsPromises.mkdir,
			link: async () => {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			},
			unlink: fsPromises.unlink,
		};
		const published = await publishCouncilPlan({
			planRoot,
			outputPath: target.relativePath,
			content: "# Plan without hard links\n",
			durability: { filesystem },
		});

		expect(published.idempotent).toBeFalse();
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("# Plan without hard links\n");
		expect(fs.readdirSync(target.planRoot)).toEqual([target.fileName]);

		await expect(
			publishCouncilPlan({
				planRoot,
				outputPath: target.relativePath,
				content: "a competitor plan",
				durability: { filesystem },
			}),
		).rejects.toMatchObject({ code: "EEXIST", terminal: true });
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("# Plan without hard links\n");
	});

	it("adopts a matching promised target only with explicit recovery opt-in", async () => {
		using temp = TempDir.createSync("@omp-council-adopt-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const target = await resolveCouncilPublicationTarget(planRoot, "Resume target", "command");
		const first = await publishCouncilPlan({
			planRoot,
			outputPath: target.relativePath,
			content: "durable final plan",
			now: "2026-08-05T12:00:00.000Z",
		});
		const resumed = await publishCouncilPlan({
			planRoot,
			outputPath: target.relativePath,
			content: "this content is not allowed to replace the durable target",
			published: first,
			resume: true,
		});

		expect(resumed).toMatchObject({ idempotent: true, sha256: first.sha256, bytes: first.bytes });
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("durable final plan");
	});

	it("keeps a nonmatching existing target terminal during recovery", async () => {
		using temp = TempDir.createSync("@omp-council-adopt-mismatch-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const target = await resolveCouncilPublicationTarget(planRoot, "Mismatch target", "command");
		fs.writeFileSync(target.absolutePath, "competitor");
		await expect(
			publishCouncilPlan({
				planRoot,
				outputPath: target.relativePath,
				content: "our durably referenced plan",
				resume: true,
			}),
		).rejects.toMatchObject({ code: "EEXIST", terminal: true });
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("competitor");
	});

	it("keeps a fresh equal-byte competitor terminal without adoption opt-in", async () => {
		using temp = TempDir.createSync("@omp-council-fresh-equal-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const target = await resolveCouncilPublicationTarget(planRoot, "Fresh target", "command");
		fs.writeFileSync(target.absolutePath, "same bytes");
		await expect(
			publishCouncilPlan({ planRoot, outputPath: target.relativePath, content: "same bytes" }),
		).rejects.toMatchObject({ code: "EEXIST", terminal: true });
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("same bytes");
	});

	it("treats a low-level EEXIST race as terminal and durably removes the staged file", async () => {
		using temp = TempDir.createSync("@omp-council-eexist-");
		const planRoot = temp.join("root");
		fs.mkdirSync(planRoot);
		const target = await resolveCouncilPublicationTarget(planRoot, "Race target", "command");
		const operations: CouncilPublicationDurabilityOperation[] = [];
		const durability = {
			onDurabilityOperation: (operation: CouncilPublicationDurabilityOperation) => operations.push(operation),
		};
		const staged = await stageCouncilPublication(path.dirname(target.absolutePath), "our plan", durability);
		fs.writeFileSync(target.absolutePath, "winner");
		try {
			await commitStagedCouncilPublication(staged, target.absolutePath, durability);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilPublicationError);
			expect(error).toMatchObject({ code: "EEXIST", terminal: true });
		}
		expect(operations).toEqual(durableOps("file-sync", "unlink", "directory-sync"));
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("winner");
		expect(fs.existsSync(staged.tempPath)).toBeFalse();
	});
});
