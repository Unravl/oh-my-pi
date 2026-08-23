import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode } from "@oh-my-pi/pi-utils";
import {
	COUNCIL_READ_FLAGS,
	COUNCIL_STAGE_FLAGS,
	COUNCIL_STAGE_MODE,
	canonicalizeLocalRoot,
	councilTempPath,
	isContained,
	linkExclusive,
	syncDirectory,
} from "./durable-fs";
import { sha256CouncilContent } from "./hash";
import {
	COUNCIL_OUTPUT_STEMS,
	type CouncilPublishedArtifact,
	type CouncilRunOrigin,
	isLegacyCouncilOutputPath,
	isValidCouncilOutputPath,
} from "./state";

/**
 * Ceiling for a freshly minted slug. Deliberately far below the 80-character bound
 * {@link isValidCouncilOutputPath} enforces: that bound stays wide so a run minted before this cap
 * tightened (and every legacy `plans/<slug>.md` manifest) remains readable and resumable, while
 * new names stay short enough to read in a `local://` listing and in the plan-approval header.
 */
export const COUNCIL_SLUG_MAX_LENGTH = 48;

export interface CouncilPublicationTarget {
	/** Canonical session-local root every council artifact and the published plan share. */
	planRoot: string;
	slug: string;
	fileName: string;
	/** Manifest `outputPath`: the bare file name, or a legacy `plans/<slug>.md`. */
	relativePath: string;
	absolutePath: string;
}

export interface StagedCouncilPublication {
	tempPath: string;
	sha256: string;
	bytes: number;
}

export interface CouncilPublicationResult extends CouncilPublishedArtifact {
	path: string;
	idempotent: boolean;
}

export interface CouncilPublicationFileSystem {
	open: typeof fs.open;
	lstat: typeof fs.lstat;
	realpath: typeof fs.realpath;
	mkdir: typeof fs.mkdir;
	link: typeof fs.link;
	unlink: typeof fs.unlink;
}

export type CouncilPublicationDurabilityOperation = "file-sync" | "link" | "directory-sync" | "unlink";

export interface CouncilPublicationDurabilityOptions {
	filesystem?: CouncilPublicationFileSystem;
	randomUUID?: () => string;
	onDurabilityOperation?: (operation: CouncilPublicationDurabilityOperation, targetPath: string) => void;
}

export interface CouncilPublicationCommitOptions extends CouncilPublicationDurabilityOptions {
	/** Recovery-only: adopt EEXIST exactly when the promised target equals this durable hash and byte count. */
	adoptExisting?: Pick<CouncilPublishedArtifact, "sha256" | "bytes">;
	signal?: AbortSignal;
}

export class CouncilPublicationError extends Error {
	readonly terminal: boolean;

	constructor(
		readonly code: "INVALID_TARGET" | "EEXIST" | "IO",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CouncilPublicationError";
		this.terminal = code === "EEXIST";
	}
}

/** Every published stem the slug must never collide with, longest-first so stripping is greedy. */
const RESERVED_SLUG_STEMS: readonly string[] = Object.values(COUNCIL_OUTPUT_STEMS).sort(
	(left, right) => right.length - left.length,
);

/**
 * Lowercase kebab slug, prohibited from ending in an ambiguous published stem (`-plan`, `-brief`).
 * Truncation is word-aligned: a character slice of a sentence-length council task ends mid-word
 * (`…-depending-on-th`), which reads like corruption in the published file name.
 *
 * `maxLength` is narrowed by {@link resolveCouncilPublicationTarget} to leave room for a collision
 * suffix, so the shortened name stays word-aligned too.
 */
export function councilPublicationSlug(text: string, maxLength: number = COUNCIL_SLUG_MAX_LENGTH): string {
	const words = text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(word => word.length > 0);
	let slug = "";
	for (const word of words) {
		const candidate = slug === "" ? word : `${slug}-${word}`;
		if (candidate.length > maxLength) break;
		slug = candidate;
	}
	// A first word longer than the whole budget still has to yield a name; only then is a hard cut
	// the lesser evil.
	if (slug === "" && words.length > 0) slug = words[0]!.slice(0, maxLength);
	// Loop until nothing strips: `…-plan-brief` has to lose both suffixes, and a task ending in
	// `plan plan` has to lose the repeat.
	for (let stripped = true; stripped; ) {
		stripped = false;
		for (const stem of RESERVED_SLUG_STEMS) {
			if (!slug.endsWith(`-${stem}`)) continue;
			slug = slug.slice(0, -(stem.length + 1)).replace(/-+$/g, "");
			stripped = true;
		}
	}
	if (slug === "" || RESERVED_SLUG_STEMS.includes(slug)) slug = "council";
	return slug;
}

/**
 * Canonicalize — creating when absent — the session-local directory council plans are published into.
 * This never appends a path segment and never touches the repository: a council run must create
 * nothing in the working tree.
 */
export async function ensureCouncilPlanRoot(
	planRoot: string,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<string> {
	try {
		return await canonicalizeLocalRoot(planRoot, options.filesystem ?? fs, {
			create: true,
			onDurabilityOperation: options.onDurabilityOperation,
		});
	} catch (error) {
		throw new CouncilPublicationError("INVALID_TARGET", `Council plan root is unusable: ${String(error)}`, {
			cause: error,
		});
	}
}

/**
 * Directory that actually holds the final plan. New runs publish directly into the plan root; a
 * manifest written before the retarget keeps its `plans/` subdirectory, resolved under that same
 * session-local plan root, so an in-flight run stays resumable.
 */
function publicationDirectory(canonicalPlanRoot: string, outputPath: string): string {
	return isLegacyCouncilOutputPath(outputPath) ? path.join(canonicalPlanRoot, "plans") : canonicalPlanRoot;
}

/** Create the legacy `plans/` subdirectory on demand; the plan root itself is already canonical. */
async function ensurePublicationDirectory(
	canonicalPlanRoot: string,
	outputPath: string,
	options: CouncilPublicationDurabilityOptions,
): Promise<string> {
	const directory = publicationDirectory(canonicalPlanRoot, outputPath);
	if (directory === canonicalPlanRoot) return directory;
	const filesystem = options.filesystem ?? fs;
	let created = false;
	try {
		await filesystem.mkdir(directory);
		created = true;
	} catch (error) {
		if (!hasFsCode(error, "EEXIST")) {
			throw new CouncilPublicationError("IO", `Could not create legacy council plans directory: ${String(error)}`, {
				cause: error,
			});
		}
	}
	try {
		const info = await filesystem.lstat(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new CouncilPublicationError(
				"INVALID_TARGET",
				`Council publication path ${directory} is not a real directory`,
			);
		}
		if (created) await syncDirectory(filesystem, canonicalPlanRoot, options.onDurabilityOperation);
	} catch (error) {
		if (error instanceof CouncilPublicationError) throw error;
		throw new CouncilPublicationError("INVALID_TARGET", `Council plans directory is unusable: ${String(error)}`, {
			cause: error,
		});
	}
	return directory;
}

/**
 * Resolve and promise a collision-free target once, before any child model is launched.
 * `name` is the model-generated plan title when one is available and the raw task otherwise; both
 * are slugified identically. `origin` picks the stem, which is the only thing separating a
 * plan-review candidate from an agent's brief.
 */
export async function resolveCouncilPublicationTarget(
	planRoot: string,
	name: string,
	origin: CouncilRunOrigin,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<CouncilPublicationTarget> {
	const filesystem = options.filesystem ?? fs;
	const canonicalPlanRoot = await ensureCouncilPlanRoot(planRoot, options);
	const stem = COUNCIL_OUTPUT_STEMS[origin];
	for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix++) {
		const suffixText = suffix === 1 ? "" : `-${suffix}`;
		const slug = `${councilPublicationSlug(name, COUNCIL_SLUG_MAX_LENGTH - suffixText.length)}${suffixText}`;
		// Namespacing is load-bearing, not cosmetic: user plan-mode plans are `local://<slug>-plan.md`
		// in this same root and `listPlanFiles` has no provenance check, so an un-namespaced council
		// plan could both be mistaken for "the" plan and collide with a same-slug user plan — and a
		// publication collision is a terminal, non-resumable council failure. The `brief` stem goes
		// further and leaves that listing entirely, because an agent-origin run was never offered for
		// execution.
		const fileName = `council-${slug}-${stem}.md`;
		const absolutePath = path.join(canonicalPlanRoot, fileName);
		try {
			await filesystem.lstat(absolutePath);
		} catch (error) {
			if (hasFsCode(error, "ENOENT")) {
				return { planRoot: canonicalPlanRoot, slug, fileName, relativePath: fileName, absolutePath };
			}
			throw new CouncilPublicationError("IO", `Could not inspect council publication target: ${String(error)}`, {
				cause: error,
			});
		}
	}
	throw new CouncilPublicationError("IO", "Could not allocate a council publication target");
}

/** Strips the `council-` prefix and whichever published stem the promised name carries. */
const PROMISED_STEM_PATTERN = new RegExp(`-(?:${Object.values(COUNCIL_OUTPUT_STEMS).join("|")})\\.md$`);

/** Revalidate a manifest's already-promised target without allocating a collision suffix. */
export async function resolvePromisedCouncilPublicationTarget(
	planRoot: string,
	outputPath: string,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<CouncilPublicationTarget> {
	const canonicalPlanRoot = await ensureCouncilPlanRoot(planRoot, options);
	const absolutePath = resolvePromisedTarget(canonicalPlanRoot, outputPath);
	const fileName = path.basename(absolutePath);
	return {
		planRoot: canonicalPlanRoot,
		slug: fileName
			.replace(/^council-/, "")
			.replace(PROMISED_STEM_PATTERN, "")
			.replace(/\.md$/, ""),
		fileName,
		relativePath: outputPath,
		absolutePath,
	};
}

/**
 * Absolute final path for a promised `outputPath`, gated against escape.
 *
 * Containment is asserted against the *canonical* plan root, never against a `realpath === resolve`
 * equality: a session root routinely sits behind a symlinked ancestor (macOS `/var`, a symlinked
 * home, the `os.tmpdir()` fallback), and demanding lexical equality would refuse a healthy session.
 */
function resolvePromisedTarget(canonicalPlanRoot: string, outputPath: string): string {
	if (
		path.isAbsolute(outputPath) ||
		outputPath.split(/[\\/]/).includes("..") ||
		!isValidCouncilOutputPath(outputPath)
	) {
		throw new CouncilPublicationError(
			"INVALID_TARGET",
			`Council outputPath must be a promised council plan file name: ${outputPath}`,
		);
	}
	const finalPath = path.resolve(canonicalPlanRoot, ...outputPath.split("/"));
	if (
		!isContained(canonicalPlanRoot, finalPath) ||
		path.dirname(finalPath) !== publicationDirectory(canonicalPlanRoot, outputPath)
	) {
		throw new CouncilPublicationError("INVALID_TARGET", `Council outputPath escapes the plan root: ${outputPath}`);
	}
	return finalPath;
}

/**
 * Does the published plan still hold the content this run committed?
 *
 * Every plan this checks lives under the session-local plan root: a new run publishes its file
 * directly into that root, and a legacy `plans/<slug>.md` manifest resolves into the root's
 * `plans/` subdirectory. Neither case consults the working tree.
 *
 * An exact digest over the bytes on disk is therefore the normal answer. The single tolerated
 * divergence is line endings: content carrying CRLF still matches when its LF-normalized form has
 * the promised digest and byte count, so a run whose plan was stored with CRLF resumes instead of
 * being reported as a foreign collision. CRLF at most doubles the size, which bounds how much is
 * worth reading.
 */
async function fileMatches(
	filesystem: CouncilPublicationFileSystem,
	finalPath: string,
	expected: Pick<CouncilPublishedArtifact, "sha256" | "bytes">,
): Promise<boolean> {
	try {
		const info = await filesystem.lstat(finalPath);
		if (info.isSymbolicLink() || !info.isFile()) return false;
		if (info.size < expected.bytes || info.size > expected.bytes * 2) return false;
		const handle = await filesystem.open(finalPath, COUNCIL_READ_FLAGS);
		try {
			const openedInfo = await handle.stat();
			if (!openedInfo.isFile() || openedInfo.size !== info.size) return false;
			// `O_NOFOLLOW` is a no-op on Windows, where reparse points still exist, so identity of the
			// opened file against the `lstat` above is what actually closes the check-then-open race.
			if (openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) return false;
			const content = await handle.readFile();
			if (openedInfo.size === expected.bytes && sha256CouncilContent(content) === expected.sha256) return true;
			if (!content.includes("\r\n")) return false;
			const normalized = content.toString("utf8").replaceAll("\r\n", "\n");
			return (
				Buffer.byteLength(normalized) === expected.bytes && sha256CouncilContent(normalized) === expected.sha256
			);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (hasFsCode(error, "ENOENT")) return false;
		throw error;
	}
}

export async function publishedCouncilPlanMatches(
	planRoot: string,
	outputPath: string,
	published: Pick<CouncilPublishedArtifact, "sha256" | "bytes">,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<boolean> {
	const filesystem = options.filesystem ?? fs;
	const finalPath = resolvePromisedTarget(await ensureCouncilPlanRoot(planRoot, options), outputPath);
	try {
		return await fileMatches(filesystem, finalPath, published);
	} catch (error) {
		throw new CouncilPublicationError("IO", `Could not verify published council plan: ${String(error)}`, {
			cause: error,
		});
	}
}
export type CouncilPromisedPublicationStatus = "missing" | "matches" | "collision";

/**
 * Inspect a resume run's immutable promised path without allocating another suffix.
 * An existing entry matches only when an expected final content reference is supplied.
 */
export async function inspectPromisedCouncilPublication(
	planRoot: string,
	outputPath: string,
	expected?: Pick<CouncilPublishedArtifact, "sha256" | "bytes">,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<CouncilPromisedPublicationStatus> {
	const filesystem = options.filesystem ?? fs;
	const finalPath = resolvePromisedTarget(await ensureCouncilPlanRoot(planRoot, options), outputPath);
	try {
		await filesystem.lstat(finalPath);
	} catch (error) {
		if (hasFsCode(error, "ENOENT")) return "missing";
		throw new CouncilPublicationError("IO", `Could not inspect promised council plan: ${String(error)}`, {
			cause: error,
		});
	}
	if (!expected) return "collision";
	try {
		return (await fileMatches(filesystem, finalPath, expected)) ? "matches" : "collision";
	} catch (error) {
		throw new CouncilPublicationError("IO", `Could not verify promised council plan: ${String(error)}`, {
			cause: error,
		});
	}
}

/** FileHandle-based durable staging. Merely staging can never expose a partial final plan. */
export async function stageCouncilPublication(
	targetDirectory: string,
	content: string,
	options: CouncilPublicationDurabilityOptions = {},
): Promise<StagedCouncilPublication> {
	const filesystem = options.filesystem ?? fs;
	const info = await filesystem.lstat(targetDirectory).catch(error => {
		throw new CouncilPublicationError("INVALID_TARGET", `Council plan directory is unusable: ${String(error)}`, {
			cause: error,
		});
	});
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new CouncilPublicationError(
			"INVALID_TARGET",
			`Council publication path ${targetDirectory} is not a real directory`,
		);
	}
	// Ancestors may legitimately be symlinks - macOS resolves `/var` to `/private/var`, and the session
	// cache is routinely reached through a symlinked home or the `os.tmpdir()` fallback - so requiring
	// the whole path to equal its own realpath would reject a healthy session. The `lstat` gate above
	// already rejects a symlinked final component, which is the guarantee that matters; staging then
	// works from the canonical directory so the committed temp file and the final plan are provably
	// siblings.
	const canonicalDirectory = await filesystem.realpath(targetDirectory);
	const bytes = Buffer.byteLength(content);
	const sha256 = sha256CouncilContent(content);
	const tempPath = councilTempPath(
		canonicalDirectory,
		"council",
		(options.randomUUID ?? (() => Bun.randomUUIDv7()))(),
	);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await filesystem.open(tempPath, COUNCIL_STAGE_FLAGS, COUNCIL_STAGE_MODE);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		options.onDurabilityOperation?.("file-sync", tempPath);
		await handle.close();
		handle = undefined;
		return { tempPath, sha256, bytes };
	} catch (error) {
		await handle?.close().catch(() => {});
		await filesystem.unlink(tempPath).catch(() => {});
		throw new CouncilPublicationError("IO", `Could not stage council plan: ${String(error)}`, { cause: error });
	}
}

/** No-clobber commit. Existing files are adopted only through the explicit, hash-bound recovery option. */
export async function commitStagedCouncilPublication(
	staged: StagedCouncilPublication,
	finalPath: string,
	options: CouncilPublicationCommitOptions = {},
): Promise<void> {
	const filesystem = options.filesystem ?? fs;
	const targetDirectory = path.dirname(finalPath);
	let failure: unknown;
	try {
		options.signal?.throwIfAborted();
		if ((await filesystem.realpath(path.dirname(staged.tempPath))) !== (await filesystem.realpath(targetDirectory))) {
			throw new CouncilPublicationError("INVALID_TARGET", "Staged and final council plans must share one directory");
		}
		options.signal?.throwIfAborted();
		await linkExclusive(filesystem, staged.tempPath, finalPath);
		options.onDurabilityOperation?.("link", finalPath);
		await syncDirectory(filesystem, targetDirectory, options.onDurabilityOperation);
	} catch (error) {
		if (options.signal?.aborted) {
			failure = options.signal.reason ?? new DOMException("This operation was aborted", "AbortError");
		} else if (hasFsCode(error, "EEXIST")) {
			let adopt = false;
			if (options.adoptExisting) {
				try {
					adopt = await fileMatches(filesystem, finalPath, options.adoptExisting);
					if (adopt) await syncDirectory(filesystem, targetDirectory, options.onDurabilityOperation);
				} catch {
					adopt = false;
				}
			}
			if (!adopt) {
				failure = new CouncilPublicationError("EEXIST", `Council publication target already exists: ${finalPath}`, {
					cause: error,
				});
			}
		} else {
			failure =
				error instanceof CouncilPublicationError
					? error
					: new CouncilPublicationError("IO", `Could not publish council plan: ${String(error)}`, {
							cause: error,
						});
		}
	}
	try {
		await filesystem.unlink(staged.tempPath);
		options.onDurabilityOperation?.("unlink", staged.tempPath);
		await syncDirectory(filesystem, path.dirname(staged.tempPath), options.onDurabilityOperation);
	} catch (error) {
		if (!failure) {
			failure = new CouncilPublicationError("IO", `Could not clean staged council plan: ${String(error)}`, {
				cause: error,
			});
		}
	}
	if (failure) throw failure;
}

export async function publishCouncilPlan(options: {
	/** Session-local plan root; a council run publishes nothing into the working tree. */
	planRoot: string;
	outputPath: string;
	content: string;
	published?: CouncilPublishedArtifact;
	now?: string;
	/** Recovery-only opt-in to adopt an existing promised target after exact durable-content verification. */
	resume?: boolean;
	adoptExisting?: boolean;
	durability?: CouncilPublicationDurabilityOptions;
	signal?: AbortSignal;
}): Promise<CouncilPublicationResult> {
	const durability = options.durability ?? {};
	options.signal?.throwIfAborted();
	const canonicalPlanRoot = await ensureCouncilPlanRoot(options.planRoot, durability);
	const finalPath = resolvePromisedTarget(canonicalPlanRoot, options.outputPath);
	if (options.published && options.published.path !== options.outputPath) {
		throw new CouncilPublicationError("INVALID_TARGET", "Recovered publication reference does not match outputPath");
	}
	const targetDirectory = await ensurePublicationDirectory(canonicalPlanRoot, options.outputPath, durability);
	const contentReference = {
		sha256: sha256CouncilContent(options.content),
		bytes: Buffer.byteLength(options.content),
	};
	const adoptionReference = options.published ?? contentReference;
	const mayAdopt = options.resume === true || options.adoptExisting === true;
	if (
		mayAdopt &&
		(await publishedCouncilPlanMatches(canonicalPlanRoot, options.outputPath, adoptionReference, durability))
	) {
		await syncDirectory(durability.filesystem ?? fs, targetDirectory, durability.onDurabilityOperation);
		return {
			...(options.published ?? {
				...contentReference,
				publishedAt: options.now ?? new Date().toISOString(),
			}),
			path: options.outputPath,
			idempotent: true,
		};
	}
	options.signal?.throwIfAborted();
	const staged = await stageCouncilPublication(targetDirectory, options.content, durability);
	await commitStagedCouncilPublication(staged, finalPath, {
		...durability,
		signal: options.signal,
		...(mayAdopt ? { adoptExisting: adoptionReference } : {}),
	});
	return {
		sha256: staged.sha256,
		bytes: staged.bytes,
		publishedAt: options.now ?? new Date().toISOString(),
		path: options.outputPath,
		idempotent: false,
	};
}
