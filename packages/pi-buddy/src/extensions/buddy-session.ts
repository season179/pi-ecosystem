import {
	applyBuddyFeedback,
	buildBuddyCalibrationBlock,
	watchdogThresholdForLevel,
	type AdvisoryLevel,
	type BuddyCalibrationNote,
	type BuddyFeedback,
	type BuddyFeedbackResult,
} from "./calibration.js";
import type {
	AutomaticReviewContext,
	ConsultationInjection,
} from "./buddy-context.js";
import type { BuddyMemory } from "./memory-contract.js";
import { buildMemoryBlock } from "./memory-prompt.js";
import {
	activeToolsWithBuddyState,
	CONSULT_BUDDY_TOOL,
	seedBuddyEnabledFromFlag,
} from "./switch.js";

const DEFAULT_ADVISORY_LEVEL: AdvisoryLevel = 0;

/**
 * Owns state whose lifetime is one Buddy process/session, not one request.
 *
 * Workflows remain in ConsultationWorkflow and AutomaticReview; this object
 * owns only enablement, calibration, memory-injection state, warning
 * deduplication, and external-resource usage flags.
 */
export class BuddySession {
	readonly memory: BuddyMemory;
	private advisoryLevel: AdvisoryLevel = DEFAULT_ADVISORY_LEVEL;
	private calibrationNote?: BuddyCalibrationNote;
	private memoryCurated = false;
	private enabledValue = true;
	private switchSeeded = false;
	private consultToolWasActiveWhenDisabled?: boolean;
	private browserUsed = false;
	private readonly configWarningsShown = new Set<string>();

	constructor(memory: BuddyMemory) {
		this.memory = memory;
	}

	get enabled(): boolean {
		return this.enabledValue;
	}

	seedEnablement(disabledFlag: unknown): boolean {
		const seeded = seedBuddyEnabledFromFlag(
			this.enabledValue,
			this.switchSeeded ? undefined : disabledFlag,
			this.switchSeeded,
		);
		this.enabledValue = seeded.enabled;
		this.switchSeeded = seeded.seeded;
		return this.enabledValue;
	}

	setEnabled(enabled: boolean): boolean {
		if (enabled === this.enabledValue) return false;
		this.enabledValue = enabled;
		return true;
	}

	activeToolsFor(enabled: boolean, activeTools: readonly string[]): string[] {
		if (!enabled && this.consultToolWasActiveWhenDisabled === undefined) {
			this.consultToolWasActiveWhenDisabled = activeTools.includes(CONSULT_BUDDY_TOOL);
		}
		const next = activeToolsWithBuddyState(
			activeTools,
			enabled,
			this.consultToolWasActiveWhenDisabled ?? false,
		);
		if (enabled) this.consultToolWasActiveWhenDisabled = undefined;
		return next;
	}

	watchdogThreshold(): number {
		return watchdogThresholdForLevel(this.advisoryLevel);
	}

	applyFeedback(feedback: BuddyFeedback, reason?: string): BuddyFeedbackResult {
		const result = applyBuddyFeedback(this.advisoryLevel, feedback);
		this.advisoryLevel = result.newLevel;
		if (feedback !== "same") {
			this.calibrationNote = {
				feedback,
				reason: reason || undefined,
				level: result.newLevel,
				watchdogThreshold: result.watchdogThreshold,
			};
		}
		return result;
	}

	buildInjection(
		slug: string,
		includeMemory: boolean,
		review: AutomaticReviewContext,
	): ConsultationInjection {
		const sections: string[] = [];
		let memoryChars = 0;
		if (includeMemory) {
			if (!this.memoryCurated && this.memory.curate(slug)) {
				this.memoryCurated = true;
			}
			const memory = this.memory.readForInjection(slug);
			if (memory) {
				const memorySection = buildMemoryBlock(memory);
				memoryChars = memorySection.length;
				sections.push(memorySection);
			}
		}
		const calibration = buildBuddyCalibrationBlock(this.calibrationNote);
		if (calibration) sections.push(calibration);
		if (review.verdictDigest) sections.push(review.verdictDigest);
		if (review.concernDigest) sections.push(review.concernDigest);
		return {
			block: sections.length > 0 ? sections.join("\n\n") : undefined,
			memoryChars,
			openConcerns: review.openConcerns,
			fixedConcerns: review.fixedConcerns,
			rebuttedConcerns: review.rebuttedConcerns,
			concernHistoryChars: review.concernDigest?.length ?? 0,
		};
	}

	configWarningsToShow(warnings: readonly string[]): string[] {
		const unseen: string[] = [];
		for (const warning of warnings) {
			if (this.configWarningsShown.has(warning)) continue;
			this.configWarningsShown.add(warning);
			unseen.push(warning);
		}
		return unseen;
	}

	markBrowserUsed(): void {
		this.browserUsed = true;
	}

	get shouldCloseBrowser(): boolean {
		return this.browserUsed;
	}

	markBrowserClosed(): void {
		this.browserUsed = false;
	}

	resetForSession(): void {
		this.memoryCurated = false;
		this.configWarningsShown.clear();
		this.advisoryLevel = DEFAULT_ADVISORY_LEVEL;
		this.calibrationNote = undefined;
	}

	resetForShutdown(): void {
		this.resetForSession();
	}
}
