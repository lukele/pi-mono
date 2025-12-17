/**
 * Antigravity OAuth authentication
 *
 * Implements Google OAuth flow for Antigravity (Cloud Code Assist) API access.
 * Uses PKCE for secure authorization code exchange.
 */

import { exec } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "crypto";
import { type OAuthCredentials, saveOAuthCredentials } from "./storage.js";

// ============================================================================
// Constants
// ============================================================================

const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const ANTIGRAVITY_CLIENT_SECRET = "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";
const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const ANTIGRAVITY_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_LOAD_ENDPOINTS = [ANTIGRAVITY_ENDPOINT_PROD, ANTIGRAVITY_ENDPOINT_DAILY];

// Note: For the free tier, loadCodeAssist doesn't return a cloudaicompanionProject.
// We try onboardUser to get a managed project ID, falling back to a known working ID.
const ANTIGRAVITY_FALLBACK_PROJECT_ID = "bubbly-bond-bzsgc";

const ANTIGRAVITY_HEADERS = {
	"User-Agent": "google-api-nodejs-client/9.15.1",
	"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};

// ============================================================================
// Types
// ============================================================================

export interface AntigravityCredentials extends OAuthCredentials {
	projectId?: string;
	managedProjectId?: string;
	email?: string;
}

interface PkcePair {
	verifier: string;
	challenge: string;
}

interface AuthState {
	verifier: string;
	projectId: string;
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token: string;
}

interface UserInfo {
	email?: string;
}

// ============================================================================
// PKCE Helpers
// ============================================================================

function generatePKCE(): PkcePair {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function encodeState(payload: AuthState): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeState(state: string): AuthState {
	const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
	const json = Buffer.from(padded, "base64").toString("utf8");
	const parsed = JSON.parse(json);
	if (typeof parsed.verifier !== "string") {
		throw new Error("Missing PKCE verifier in state");
	}
	return {
		verifier: parsed.verifier,
		projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
	};
}

// ============================================================================
// Project Discovery
// ============================================================================

interface LoadCodeAssistResponse {
	cloudaicompanionProject?: string | { id?: string };
	// The managed project ID is sometimes nested differently
	managedProject?: string | { id?: string };
}

async function fetchProjectId(accessToken: string): Promise<{ projectId: string; raw?: unknown }> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
	};

	for (const baseEndpoint of ANTIGRAVITY_LOAD_ENDPOINTS) {
		try {
			const url = `${baseEndpoint}/v1internal:loadCodeAssist`;
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({
					metadata: {
						ideType: "IDE_UNSPECIFIED",
						platform: "PLATFORM_UNSPECIFIED",
						pluginType: "GEMINI",
					},
				}),
			});

			if (!response.ok) continue;

			const data = (await response.json()) as LoadCodeAssistResponse;

			// Extract the project ID from various possible locations
			let projectId: string | undefined;

			if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
				projectId = data.cloudaicompanionProject;
			} else if (typeof data.cloudaicompanionProject === "object" && data.cloudaicompanionProject?.id) {
				projectId = data.cloudaicompanionProject.id;
			}

			if (projectId) {
				return { projectId, raw: data };
			}
		} catch {}
	}

	return { projectId: "" };
}

interface OnboardUserResponse {
	done?: boolean;
	response?: {
		cloudaicompanionProject?: {
			id?: string;
		};
	};
}

/**
 * Onboard user to get a managed project ID for the free tier.
 * This may take multiple attempts as the backend provisions the project.
 */
async function onboardUser(accessToken: string, maxAttempts = 5, delayMs = 2000): Promise<string | undefined> {
	const metadata = {
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	};

	const requestBody = {
		tierId: "free-tier",
		metadata,
	};

	for (const baseEndpoint of ANTIGRAVITY_LOAD_ENDPOINTS) {
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const response = await fetch(`${baseEndpoint}/v1internal:onboardUser`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${accessToken}`,
						...ANTIGRAVITY_HEADERS,
					},
					body: JSON.stringify(requestBody),
				});

				if (!response.ok) {
					break;
				}

				const payload = (await response.json()) as OnboardUserResponse;
				const managedProjectId = payload.response?.cloudaicompanionProject?.id;
				if (payload.done && managedProjectId) {
					return managedProjectId;
				}

				// Not done yet, wait and retry
				if (!payload.done && attempt < maxAttempts - 1) {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
			} catch {
				break;
			}
		}
	}

	return undefined;
}

// ============================================================================
// Browser Helpers
// ============================================================================

function openBrowser(url: string): void {
	try {
		if (process.platform === "darwin") {
			exec(`open "${url}"`);
		} else if (process.platform === "win32") {
			exec(`start "${url}"`);
		} else {
			exec(`xdg-open "${url}"`);
		}
	} catch {
		// ignore
	}
}

// ============================================================================
// OAuth Callback Server
// ============================================================================

interface OAuthListener {
	port: number;
	waitForCallback(): Promise<URL>;
	close(): Promise<void>;
}

async function startOAuthListener(): Promise<OAuthListener> {
	return new Promise((resolve, reject) => {
		let callbackResolve: (url: URL) => void;
		let callbackReject: (error: Error) => void;
		const callbackPromise = new Promise<URL>((res, rej) => {
			callbackResolve = res;
			callbackReject = rej;
		});

		const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
			if (req.url?.startsWith("/oauth-callback")) {
				const url = new URL(req.url, `http://localhost:51121`);

				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(`
					<!DOCTYPE html>
					<html>
					<head><title>Authorization Complete</title></head>
					<body>
						<h1>Authorization Complete</h1>
						<p>You can close this window and return to the terminal.</p>
						<script>window.close();</script>
					</body>
					</html>
				`);

				callbackResolve(url);
			} else {
				res.writeHead(404);
				res.end("Not found");
			}
		});

		server.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				reject(new Error("Port 51121 is already in use"));
			} else {
				reject(err);
			}
		});

		server.listen(51121, "127.0.0.1", () => {
			resolve({
				port: 51121,
				waitForCallback: () => callbackPromise,
				close: () =>
					new Promise<void>((res) => {
						server.close(() => res());
					}),
			});
		});

		// Set timeout
		setTimeout(
			() => {
				callbackReject(new Error("OAuth callback timed out after 5 minutes"));
				server.close();
			},
			5 * 60 * 1000,
		);
	});
}

// ============================================================================
// Token Exchange
// ============================================================================

async function exchangeCodeForTokens(
	code: string,
	state: string,
): Promise<{ credentials: AntigravityCredentials; email?: string } | { error: string }> {
	try {
		const { verifier, projectId } = decodeState(state);

		// Exchange code for tokens
		const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: ANTIGRAVITY_CLIENT_ID,
				client_secret: ANTIGRAVITY_CLIENT_SECRET,
				code,
				grant_type: "authorization_code",
				redirect_uri: ANTIGRAVITY_REDIRECT_URI,
				code_verifier: verifier,
			}),
		});

		if (!tokenResponse.ok) {
			const errorText = await tokenResponse.text();
			return { error: `Token exchange failed: ${errorText}` };
		}

		const tokenData = (await tokenResponse.json()) as TokenResponse;

		// Get user info
		const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: {
				Authorization: `Bearer ${tokenData.access_token}`,
			},
		});
		const userInfo = userInfoResponse.ok ? ((await userInfoResponse.json()) as UserInfo) : {};

		// Get a managed project ID via onboarding (required for free tier)
		let effectiveProjectId = await onboardUser(tokenData.access_token);

		if (!effectiveProjectId) {
			// Fallback to known working ID if onboarding fails
			effectiveProjectId = ANTIGRAVITY_FALLBACK_PROJECT_ID;
		}

		const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

		const credentials: AntigravityCredentials = {
			type: "oauth",
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: expiresAt,
			projectId: effectiveProjectId,
			email: userInfo.email,
		};

		return { credentials, email: userInfo.email };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Unknown error" };
	}
}

// ============================================================================
// Token Refresh
// ============================================================================

export async function refreshAntigravityToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const refreshToken = credentials.refresh;
	if (!refreshToken) {
		throw new Error("No refresh token available");
	}

	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: ANTIGRAVITY_CLIENT_SECRET,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Token refresh failed: ${errorText}`);
	}

	const payload = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	const expiresAt = Date.now() + payload.expires_in * 1000 - 5 * 60 * 1000;

	return {
		...credentials,
		access: payload.access_token,
		expires: expiresAt,
		refresh: payload.refresh_token || refreshToken,
	};
}

// ============================================================================
// Main Login Flow
// ============================================================================

export async function loginAntigravity(
	onAuthUrl: (url: string) => void,
	onPromptCode: () => Promise<string>,
	onProgress?: (message: string) => void,
): Promise<void> {
	const { verifier, challenge } = generatePKCE();

	// Try to start local server for automatic callback
	let listener: OAuthListener | null = null;
	const isHeadless = !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);

	if (!isHeadless) {
		try {
			listener = await startOAuthListener();
		} catch {
			listener = null;
		}
	}

	// Build authorization URL
	const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	authUrl.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
	authUrl.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
	authUrl.searchParams.set("code_challenge", challenge);
	authUrl.searchParams.set("code_challenge_method", "S256");
	authUrl.searchParams.set("state", encodeState({ verifier, projectId: "" }));
	authUrl.searchParams.set("access_type", "offline");
	authUrl.searchParams.set("prompt", "consent");

	const authUrlString = authUrl.toString();

	// Notify caller with URL
	onAuthUrl(authUrlString);

	// Open browser
	if (!isHeadless) {
		openBrowser(authUrlString);
	}

	let code: string;
	let state: string;

	if (listener) {
		// Wait for automatic callback
		try {
			onProgress?.("Waiting for browser authorization...");
			const callbackUrl = await listener.waitForCallback();
			code = callbackUrl.searchParams.get("code") || "";
			state = callbackUrl.searchParams.get("state") || encodeState({ verifier, projectId: "" });

			if (!code) {
				throw new Error("Missing code in callback URL");
			}
		} finally {
			await listener.close();
		}
	} else {
		// Manual code entry
		const input = await onPromptCode();
		const trimmed = input.trim();

		// Check if user pasted full URL or just the code
		if (trimmed.startsWith("http")) {
			const url = new URL(trimmed);
			code = url.searchParams.get("code") || "";
			state = url.searchParams.get("state") || encodeState({ verifier, projectId: "" });
		} else {
			code = trimmed;
			state = encodeState({ verifier, projectId: "" });
		}

		if (!code) {
			throw new Error("No authorization code provided");
		}
	}

	// Exchange code for tokens
	onProgress?.("Exchanging authorization code...");
	const result = await exchangeCodeForTokens(code, state);

	if ("error" in result) {
		throw new Error(result.error);
	}

	// Note: We don't fetch/store project ID - synthetic IDs are generated per request

	// Save credentials
	saveOAuthCredentials("antigravity", result.credentials);

	onProgress?.(`Logged in as ${result.email || "unknown user"}`);
}

/**
 * Get the stored project ID from credentials, if available.
 */
export function getAntigravityProjectId(credentials: OAuthCredentials): string | undefined {
	return (credentials as AntigravityCredentials).projectId;
}
