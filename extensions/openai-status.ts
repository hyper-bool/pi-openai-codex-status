import { AuthStorage, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type RawRateLimitWindowSnapshot = {
	used_percent?: number | string | null;
	limit_window_seconds?: number | null;
	reset_after_seconds?: number | null;
	reset_at?: number | null;
};

type RawRateLimitStatusDetails = {
	allowed?: boolean;
	limit_reached?: boolean;
	primary_window?: RawRateLimitWindowSnapshot | null;
	secondary_window?: RawRateLimitWindowSnapshot | null;
};

type RawCreditStatusDetails = {
	has_credits?: boolean;
	unlimited?: boolean;
	balance?: string | number | null;
};

type RawAdditionalRateLimitDetails = {
	limit_name?: string;
	metered_feature?: string;
	rate_limit?: RawRateLimitStatusDetails | null;
};

type RawRateLimitStatusPayload = {
	plan_type?: string;
	rate_limit?: RawRateLimitStatusDetails | null;
	credits?: RawCreditStatusDetails | null;
	additional_rate_limits?: RawAdditionalRateLimitDetails[] | null;
};

type LimitWindow = {
	usedPercent: number;
	windowSeconds?: number;
	resetsAt?: number;
};

type AdditionalLimit = {
	id: string;
	name?: string;
	primary?: LimitWindow;
	secondary?: LimitWindow;
};

type StatusSnapshot = {
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: LimitWindow;
	secondary?: LimitWindow;
	credits?: {
		hasCredits: boolean;
		unlimited: boolean;
		balance?: string;
	};
	additional: AdditionalLimit[];
	fetchedAt: number;
};

type CodexCredential = {
	accessToken: string;
	accountId: string;
	expires?: number;
};

type OAuthCredentialShape = {
	type: "oauth";
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
};

const PROVIDER_ID = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_PAGE_URL = "https://chatgpt.com/codex/settings/usage";
const CACHE_TTL_MS = 60_000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let cache: StatusSnapshot | null = null;

function clampPercent(value: unknown): number {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length < 2) return null;
	try {
		const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
		const padLength = (4 - (payload.length % 4)) % 4;
		const base64 = payload + "=".repeat(padLength);
		const json = Buffer.from(base64, "base64").toString("utf8");
		const parsed = JSON.parse(json);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function getAccountIdFromToken(token: string): string | undefined {
	const payload = parseJwtPayload(token);
	if (!payload) return undefined;

	const direct = payload["https://api.openai.com/auth.chatgpt_account_id"];
	if (typeof direct === "string" && direct.length > 0) return direct;

	const auth = payload["https://api.openai.com/auth"];
	if (auth && typeof auth === "object") {
		const nested = (auth as Record<string, unknown>).chatgpt_account_id;
		if (typeof nested === "string" && nested.length > 0) return nested;
	}

	return undefined;
}

async function getCodexCredential(authStorage: AuthStorage): Promise<CodexCredential | null> {
	authStorage.reload();
	let cred = authStorage.get(PROVIDER_ID) as OAuthCredentialShape | undefined;
	if (!cred || cred.type !== "oauth") return null;

	if (typeof cred.expires === "number" && Date.now() >= cred.expires) {
		await authStorage.refreshOAuthTokenWithLock(PROVIDER_ID);
		authStorage.reload();
		cred = authStorage.get(PROVIDER_ID) as OAuthCredentialShape | undefined;
		if (!cred || cred.type !== "oauth") return null;
	}

	const accessToken = cred.access ?? (await authStorage.getApiKey(PROVIDER_ID));
	if (!accessToken) return null;

	const accountId = cred.accountId ?? getAccountIdFromToken(accessToken);
	if (!accountId) {
		throw new Error("OpenAI Codex credential is missing ChatGPT account id.");
	}

	return {
		accessToken,
		accountId,
		expires: cred.expires,
	};
}

function normalizeWindow(window: RawRateLimitWindowSnapshot | null | undefined): LimitWindow | undefined {
	if (!window) return undefined;
	const windowSeconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : undefined;
	const resetAtSeconds = typeof window.reset_at === "number" ? window.reset_at : undefined;
	const resetAfterSeconds = typeof window.reset_after_seconds === "number" ? window.reset_after_seconds : undefined;
	return {
		usedPercent: clampPercent(window.used_percent),
		windowSeconds,
		resetsAt:
			typeof resetAtSeconds === "number"
				? resetAtSeconds * 1000
				: typeof resetAfterSeconds === "number"
					? Date.now() + resetAfterSeconds * 1000
					: undefined,
	};
}

function normalizePayload(payload: RawRateLimitStatusPayload): StatusSnapshot {
	const additional = Array.isArray(payload.additional_rate_limits)
		? payload.additional_rate_limits.map((limit) => ({
				id: limit.metered_feature || limit.limit_name || "additional",
				name: limit.limit_name,
				primary: normalizeWindow(limit.rate_limit?.primary_window),
				secondary: normalizeWindow(limit.rate_limit?.secondary_window),
			}))
		: [];

	return {
		planType: payload.plan_type,
		allowed: payload.rate_limit?.allowed,
		limitReached: payload.rate_limit?.limit_reached,
		primary: normalizeWindow(payload.rate_limit?.primary_window),
		secondary: normalizeWindow(payload.rate_limit?.secondary_window),
		credits: payload.credits
			? {
					hasCredits: !!payload.credits.has_credits,
					unlimited: !!payload.credits.unlimited,
					balance:
						payload.credits.balance === null || payload.credits.balance === undefined
							? undefined
							: String(payload.credits.balance),
				}
			: undefined,
		additional,
		fetchedAt: Date.now(),
	};
}

async function fetchUsageSnapshot(authStorage: AuthStorage, signal?: AbortSignal): Promise<StatusSnapshot> {
	const credential = await getCodexCredential(authStorage);
	if (!credential) {
		throw new Error("You are not logged into ChatGPT Plus/Pro Codex in pi. Run /login and choose OpenAI Codex.");
	}

	const response = await fetch(USAGE_URL, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${credential.accessToken}`,
			"ChatGPT-Account-Id": credential.accountId,
			"User-Agent": "pi-openai-status",
		},
		signal,
	});

	if (!response.ok) {
		let details = "";
		try {
			details = await response.text();
		} catch {
			// Ignore body parse errors here.
		}
		const suffix = details ? ` ${truncateToWidth(details.replace(/\s+/g, " ").trim(), 160)}` : "";
		throw new Error(`OpenAI usage request failed (${response.status} ${response.statusText}).${suffix}`);
	}

	const payload = (await response.json()) as RawRateLimitStatusPayload;
	return normalizePayload(payload);
}

function describeWindow(seconds?: number): string {
	if (!seconds || seconds <= 0) return "limit";
	const hours = seconds / 3600;
	const days = seconds / 86_400;
	if (hours <= 24) {
		const rounded = Math.max(1, Math.round(hours));
		return `${rounded}h limit`;
	}
	if (days <= 7.5) return "weekly limit";
	if (days <= 31) return "monthly limit";
	return "annual limit";
}

function formatAge(ms: number): string {
	if (ms < 5_000) return "just now";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
	return `${Math.round(ms / 3_600_000)}h ago`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) {
		const remHours = hours % 24;
		return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
	}
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

function formatResetTime(timestamp?: number): string {
	if (!timestamp) return "reset unknown";
	const diff = timestamp - Date.now();
	if (diff <= 0) return "resetting now";
	if (diff < 36 * 3600 * 1000) return `resets in ${formatDuration(diff)}`;
	return `resets ${new Date(timestamp).toLocaleString(undefined, {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		month: "short",
		day: "numeric",
	})}`;
}

function padRight(text: string, width: number): string {
	const truncated = truncateToWidth(text, width);
	const pad = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(pad);
}

function boxLine(content: string, width: number): string {
	const inner = Math.max(0, width - 2);
	return `│${padRight(content, inner)}│`;
}

function wrapInBox(lines: string[], width: number): string[] {
	if (width < 4) return lines.map((line) => truncateToWidth(line, width));
	const inner = Math.max(0, width - 2);
	const top = `┌${"─".repeat(inner)}┐`;
	const bottom = `└${"─".repeat(inner)}┘`;
	return [top, ...lines.map((line) => boxLine(line, width)), bottom];
}

class StatusOverlay {
	private tui: any;
	private theme: any;
	private modelLabel: string;
	private done: (value?: void) => void;
	private authStorage: AuthStorage;
	private requestRender: () => void;
	private snapshot: StatusSnapshot | null;
	private errorMessage: string | null = null;
	private refreshing = false;
	private spinnerIndex = 0;
	private spinnerTimer: NodeJS.Timeout | undefined;
	private inFlight: AbortController | undefined;
	private closed = false;

	constructor(opts: {
		tui: any;
		theme: any;
		done: (value?: void) => void;
		authStorage: AuthStorage;
		modelLabel: string;
		requestRender: () => void;
		initialSnapshot: StatusSnapshot | null;
	}) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.done = opts.done;
		this.authStorage = opts.authStorage;
		this.modelLabel = opts.modelLabel;
		this.requestRender = opts.requestRender;
		this.snapshot = opts.initialSnapshot;
	}

	start(): void {
		void this.refresh();
	}

	private setRefreshing(value: boolean): void {
		this.refreshing = value;
		if (value) {
			if (!this.spinnerTimer) {
				this.spinnerTimer = setInterval(() => {
					this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
					this.requestRender();
				}, 120);
			}
		} else if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
	}

	async refresh(): Promise<void> {
		if (this.closed) return;
		this.errorMessage = null;
		this.inFlight?.abort();
		this.inFlight = new AbortController();
		this.setRefreshing(true);
		this.requestRender();
		try {
			const snapshot = await fetchUsageSnapshot(this.authStorage, this.inFlight.signal);
			if (this.closed) return;
			cache = snapshot;
			this.snapshot = snapshot;
			this.errorMessage = null;
		} catch (error) {
			if (this.closed) return;
			if ((error as Error)?.name === "AbortError") return;
			this.errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			this.setRefreshing(false);
			this.requestRender();
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.inFlight?.abort();
		this.inFlight = undefined;
		this.setRefreshing(false);
		this.done();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
			this.close();
			return;
		}
		if (data.toLowerCase() === "r") {
			void this.refresh();
		}
	}

	invalidate(): void {
		// Stateless render; nothing to invalidate.
	}

	dispose(): void {
		this.inFlight?.abort();
		this.setRefreshing(false);
	}

	private progressBar(leftPercent: number, width: number): string {
		const clamped = clampPercent(leftPercent);
		const filled = Math.round((clamped / 100) * width);
		const empty = Math.max(0, width - filled);
		const color = clamped <= 15 ? "error" : clamped <= 40 ? "warning" : "success";
		return this.theme.fg(color, "█".repeat(filled)) + this.theme.fg("dim", "░".repeat(empty));
	}

	private renderWindowRow(label: string, window: LimitWindow | undefined, width: number): string[] {
		const inner = Math.max(0, width - 2);
		if (!window) {
			return [truncateToWidth(`${label}: unavailable`, inner)];
		}
		const leftPercent = Math.max(0, 100 - window.usedPercent);
		const titleWidth = 16;
		const barWidth = 32;
		const percentText = `${leftPercent}% left`;
		const resetText = formatResetTime(window.resetsAt);
		const title = this.theme.fg("accent", padRight(label, titleWidth));
		const bar = this.progressBar(leftPercent, barWidth);
		return [truncateToWidth(`${title} ${bar} ${percentText} ${resetText}`, inner)];
	}

	render(width: number): string[] {
		const safeWidth = Math.max(48, width);
		const lines: string[] = [];
		const spinner = this.refreshing ? `${SPINNER_FRAMES[this.spinnerIndex]} ` : "";
		const title = this.theme.fg("accent", this.theme.bold("OpenAI Codex Status"));
		lines.push(`${spinner}${title}`);
		lines.push(this.theme.fg("muted", this.modelLabel));

		if (this.snapshot?.planType) {
			const plan = this.theme.fg("accent", this.snapshot.planType);
			const statusBits: string[] = [];
			if (typeof this.snapshot.allowed === "boolean") statusBits.push(this.snapshot.allowed ? "allowed" : "blocked");
			if (this.snapshot.limitReached) statusBits.push(this.theme.fg("warning", "limit reached"));
			lines.push(`plan: ${plan}${statusBits.length > 0 ? ` · ${statusBits.join(" · ")}` : ""}`);
		}

		if (this.refreshing) {
			lines.push(this.theme.fg("muted", "Refreshing limits from chatgpt.com/backend-api/wham/usage ..."));
		} else if (this.snapshot) {
			lines.push(this.theme.fg("muted", `Updated ${formatAge(Date.now() - this.snapshot.fetchedAt)}`));
		}

		if (this.errorMessage) {
			lines.push(this.theme.fg("error", truncateToWidth(this.errorMessage, Math.max(20, safeWidth - 4))));
		}

		lines.push("");

		if (this.snapshot) {
			lines.push(...this.renderWindowRow(describeWindow(this.snapshot.primary?.windowSeconds), this.snapshot.primary, safeWidth));
			lines.push("");
			lines.push(...this.renderWindowRow(describeWindow(this.snapshot.secondary?.windowSeconds), this.snapshot.secondary, safeWidth));

			if (this.snapshot.credits?.hasCredits) {
				const creditsText = this.snapshot.credits.unlimited
					? this.theme.fg("success", "unlimited")
					: this.snapshot.credits.balance
						? this.theme.fg("accent", this.snapshot.credits.balance)
						: this.theme.fg("muted", "available");
				lines.push(`credits: ${creditsText}`);
			}

			if (this.snapshot.additional.length > 0) {
				lines.push("");
				lines.push(this.theme.fg("muted", "Additional rate limits"));
				lines.push("");
				for (const [index, limit] of this.snapshot.additional.slice(0, 3).entries()) {
					const label = limit.name || limit.id;
					lines.push(...this.renderWindowRow(label, limit.primary ?? limit.secondary, safeWidth));
					if (index < Math.min(this.snapshot.additional.length, 3) - 1) lines.push("");
				}
			}
		} else {
			lines.push(this.theme.fg("muted", "No usage snapshot loaded yet."));
		}

		lines.push("");
		lines.push(this.theme.fg("dim", `Visit ${USAGE_PAGE_URL} for up-to-date information on rate limits and credits.`));
		lines.push(this.theme.fg("dim", "esc/enter close · r refresh"));

		return wrapInBox(lines, safeWidth);
	}
}

export default function openAIStatusExtension(pi: ExtensionAPI) {
	const authStorage = AuthStorage.create();

	pi.registerCommand("status", {
		description: "Show OpenAI Codex subscription usage status",
		handler: async (_args, ctx) => {
			const hasAuth = authStorage.hasAuth(PROVIDER_ID);
			if (!hasAuth) {
				ctx.ui.notify("Not logged into OpenAI Codex. Run /login and choose OpenAI Codex.", "error");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/status overlay requires the interactive TUI.", "error");
				return;
			}

			const initialSnapshot = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS ? cache : null;
			const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model";
			const modelLabel = `model: ${currentModel} · auth: ${PROVIDER_ID}`;

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const overlay = new StatusOverlay({
						tui,
						theme,
						done,
						authStorage,
						modelLabel,
						requestRender: () => tui.requestRender(),
						initialSnapshot,
					});
					overlay.start();
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "68%",
						minWidth: 64,
						maxWidth: 98,
						maxHeight: "80%",
						margin: 1,
					},
				},
			);
		},
	});
}
