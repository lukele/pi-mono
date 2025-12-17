/**
 * Antigravity provider - Google Cloud Code Assist API
 *
 * This provider supports both Gemini and Claude models through Google's
 * Antigravity (Cloud Code Assist) API. It uses OAuth authentication and
 * wraps requests in the Antigravity-specific format.
 *
 * Key differences from direct Google API:
 * - Requires OAuth tokens (not API keys)
 * - Requests wrapped in { project, model, request } format
 * - Uses raw fetch + SSE instead of Google SDK
 * - Supports Claude models via the same endpoint
 */

import crypto from "node:crypto";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
	convertMessagesToGemini,
	convertToolsToGemini,
	type GeminiContent,
	isClaudeModel,
	isGptOssModel,
	isThinkingCapableModel,
	mapGeminiStopReason,
} from "./google-shared.js";

// ============================================================================
// Constants
// ============================================================================

export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
	ANTIGRAVITY_ENDPOINT_DAILY,
	ANTIGRAVITY_ENDPOINT_AUTOPUSH,
	ANTIGRAVITY_ENDPOINT_PROD,
] as const;

export const ANTIGRAVITY_HEADERS = {
	"User-Agent": "antigravity/1.11.5 windows/amd64",
	"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
} as const;

// ============================================================================
// Types
// ============================================================================

export interface AntigravityOptions extends StreamOptions {
	/** Project ID for Antigravity API */
	projectId?: string;
	/** Tool choice mode */
	toolChoice?: "auto" | "none" | "any";
	/** Thinking/reasoning configuration */
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
	};
	/** Endpoint override (defaults to daily sandbox) */
	endpoint?: string;
}

interface AntigravityRequest {
	project: string;
	model: string;
	request: Record<string, unknown>;
	userAgent?: string;
	requestId?: string;
	requestType?: string;
}

// ============================================================================
// Helpers
// ============================================================================

// Cache the synthetic project ID so we use the same one consistently
let cachedSyntheticProjectId: string | null = null;

function generateSyntheticProjectId(): string {
	if (cachedSyntheticProjectId) {
		return cachedSyntheticProjectId;
	}
	const adjectives = ["useful", "bright", "swift", "calm", "bold", "bubbly"];
	const nouns = ["fuze", "wave", "spark", "flow", "core", "bond"];
	const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
	const noun = nouns[Math.floor(Math.random() * nouns.length)];
	const randomPart = crypto.randomUUID().slice(0, 5).toLowerCase();
	cachedSyntheticProjectId = `${adj}-${noun}-${randomPart}`;
	return cachedSyntheticProjectId;
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

// ============================================================================
// Request Building
// ============================================================================

function buildAntigravityRequest(
	model: Model<"antigravity">,
	context: Context,
	options: AntigravityOptions = {},
): AntigravityRequest {
	const isClaude = isClaudeModel(model.id);
	const isGptOss = isGptOssModel(model.id);
	const isThinkingModel = isThinkingCapableModel(model.id);

	// Use shared message conversion with Antigravity-specific options
	const contents = convertMessagesToGemini(model, context, {
		uppercaseTypes: true,
		isClaude,
	});

	// Build the inner request payload
	const requestPayload: Record<string, unknown> = {
		contents,
	};

	// System instruction
	if (context.systemPrompt) {
		requestPayload.systemInstruction = {
			role: "user",
			parts: [{ text: sanitizeSurrogates(context.systemPrompt) }],
		};
	}

	// Determine thinking settings
	const hasAssistantHistory = contents.some((c: GeminiContent) => c.role === "model");
	let thinkingEnabled = false;
	let thinkingBudget = 0;

	// Determine default thinking budget based on model type
	const getDefaultThinkingBudget = () => {
		if (isClaude) return 1024;
		if (isGptOss) return 8192; // GPT-OSS uses higher budget
		return -1; // Gemini uses -1 for dynamic
	};

	// For Claude with history, disable thinking (requires signed blocks)
	if (isClaude && hasAssistantHistory) {
		thinkingEnabled = false;
		thinkingBudget = 0;
	} else if (options.thinking?.enabled && isThinkingModel) {
		thinkingEnabled = true;
		thinkingBudget = options.thinking.budgetTokens ?? getDefaultThinkingBudget();
	} else if (isThinkingModel && !options.thinking) {
		// Default: enable thinking for capable models
		thinkingEnabled = true;
		thinkingBudget = getDefaultThinkingBudget();
	}

	// Generation config with model-specific parameters
	const generationConfig: Record<string, unknown> = {
		temperature: options.temperature ?? (isClaude || isGptOss ? 0.4 : thinkingEnabled ? 1 : 0.7),
		topP: 1,
		topK: isClaude || isGptOss ? 50 : 40,
		candidateCount: 1,
		maxOutputTokens: options.maxTokens ?? 16384,
		stopSequences: ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"],
		thinkingConfig: {
			includeThoughts: thinkingEnabled,
			thinkingBudget: thinkingBudget,
		},
	};

	requestPayload.generationConfig = generationConfig;

	// Tools with Antigravity-specific conversion (uppercase types)
	if (context.tools && context.tools.length > 0) {
		requestPayload.tools = convertToolsToGemini(context.tools, {
			uppercaseTypes: true,
			isClaude,
		});

		requestPayload.toolConfig = {
			functionCallingConfig: {
				mode: "VALIDATED",
			},
		};
	}

	// Session ID
	requestPayload.sessionId = "-" + Math.floor(Math.random() * 9000000000000000000).toString();

	const projectId = options.projectId || generateSyntheticProjectId();

	return {
		project: projectId,
		model: model.id,
		request: requestPayload,
		userAgent: "antigravity",
		requestId: "agent-" + crypto.randomUUID(),
		requestType: "agent",
	};
}

// ============================================================================
// Response Parsing
// ============================================================================

interface ParsedChunk {
	text?: string;
	isThinking?: boolean;
	thoughtSignature?: string;
	functionCall?: {
		id: string;
		name: string;
		args: Record<string, unknown>;
		thoughtSignature?: string;
	};
	finishReason?: string;
	usage?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		thoughtsTokenCount?: number;
		totalTokenCount?: number;
		cachedContentTokenCount?: number;
	};
}

function parseAntigravityChunk(line: string): ParsedChunk | null {
	if (!line.startsWith("data:")) return null;

	const json = line.slice(5).trim();
	if (!json) return null;

	try {
		const parsed = JSON.parse(json);

		// Unwrap { response: ... } wrapper
		const data = parsed.response ?? parsed;
		if (!data || typeof data !== "object") return null;

		const result: ParsedChunk = {};

		// Extract from candidates array (Gemini style)
		const candidate = data.candidates?.[0];
		if (candidate?.content?.parts) {
			for (const part of candidate.content.parts) {
				if (part.text !== undefined) {
					result.text = part.text;
					result.isThinking = part.thought === true;
					if (part.thoughtSignature) {
						result.thoughtSignature = part.thoughtSignature;
					}
				}
				if (part.functionCall) {
					result.functionCall = {
						id: part.functionCall.id || `func_${Date.now()}_${++toolCallCounter}`,
						name: part.functionCall.name || "",
						args: part.functionCall.args || {},
					};
					if (part.thoughtSignature) {
						result.functionCall.thoughtSignature = part.thoughtSignature;
					}
				}
			}
			if (candidate.finishReason) {
				result.finishReason = candidate.finishReason;
			}
		}

		// Usage metadata
		if (data.usageMetadata) {
			result.usage = {
				promptTokenCount: data.usageMetadata.promptTokenCount,
				candidatesTokenCount: data.usageMetadata.candidatesTokenCount,
				thoughtsTokenCount: data.usageMetadata.thoughtsTokenCount,
				totalTokenCount: data.usageMetadata.totalTokenCount,
				cachedContentTokenCount: data.usageMetadata.cachedContentTokenCount,
			};
		}

		return result;
	} catch {
		return null;
	}
}

// ============================================================================
// Stream Function
// ============================================================================

export const streamAntigravity: StreamFunction<"antigravity"> = (
	model: Model<"antigravity">,
	context: Context,
	options?: AntigravityOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "antigravity" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			if (!options?.apiKey) {
				throw new Error("Antigravity requires OAuth token. Use /login to authenticate.");
			}

			// Parse apiKey - can be JSON with {token, projectId} or plain token
			let authToken = options.apiKey;
			let projectId = options.projectId;

			if (options.apiKey.startsWith("{")) {
				try {
					const parsed = JSON.parse(options.apiKey);
					authToken = parsed.token || options.apiKey;
					projectId = parsed.projectId || projectId;
				} catch {
					// Not valid JSON, use as plain token
				}
			}

			const effectiveOptions = { ...options, apiKey: authToken, projectId };
			const requestBody = buildAntigravityRequest(model, context, effectiveOptions);
			const endpoint = options?.endpoint || ANTIGRAVITY_ENDPOINT_DAILY;
			const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

			const headers: Record<string, string> = {
				Authorization: `Bearer ${authToken}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...ANTIGRAVITY_HEADERS,
			};

			// Debug logging - write to file if enabled
			if (process.env.DEBUG_ANTIGRAVITY) {
				const fs = await import("node:fs");
				const debugPath =
					process.env.DEBUG_ANTIGRAVITY === "1" ? "/tmp/antigravity-debug.json" : process.env.DEBUG_ANTIGRAVITY;
				const debugData = {
					url,
					timestamp: new Date().toISOString(),
					model: model.id,
					requestBody,
				};
				fs.writeFileSync(debugPath, JSON.stringify(debugData, null, 2));
			}

			// Retry logic for rate limiting (429 errors)
			const MAX_RETRIES = 5;
			let response: Response | null = null;
			let lastError: Error | null = null;

			for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(requestBody),
					signal: options?.signal,
				});

				if (response.ok) {
					break;
				}

				// Handle rate limiting with retry
				if (response.status === 429) {
					const errorBody = await response.text();
					let retryDelayMs = 1000;

					try {
						const errorJson = JSON.parse(errorBody);
						const retryInfo = errorJson.error?.details?.find((d: any) => d["@type"]?.includes("RetryInfo"));
						if (retryInfo?.retryDelay) {
							const seconds = parseFloat(retryInfo.retryDelay.replace("s", ""));
							if (!Number.isNaN(seconds)) {
								retryDelayMs = Math.ceil(seconds * 1000) + 100;
							}
						}
					} catch {
						// Use default delay
					}

					if (attempt < MAX_RETRIES - 1) {
						await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
						continue;
					}

					lastError = new Error(`Antigravity API error (429): ${errorBody}`);
				} else {
					const errorText = await response.text();
					lastError = new Error(`Antigravity API error (${response.status}): ${errorText}`);
					break;
				}
			}

			if (!response?.ok) {
				throw lastError || new Error("Request failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });

			let currentBlock: ((TextContent | ThinkingContent) & { index?: number }) | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const chunk = parseAntigravityChunk(line);
					if (!chunk) continue;

					// Handle text/thinking content
					if (chunk.text !== undefined) {
						const isThinking = chunk.isThinking === true;

						// Special case: Gemini sends thoughtSignature in a separate final chunk
						if (chunk.thoughtSignature && !isThinking && chunk.text === "" && currentBlock?.type === "thinking") {
							currentBlock.thinkingSignature = chunk.thoughtSignature;
							continue;
						}

						// Check if we need to start a new block
						if (
							!currentBlock ||
							(isThinking && currentBlock.type !== "thinking") ||
							(!isThinking && currentBlock.type !== "text")
						) {
							// End current block
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
							}

							// Start new block
							if (isThinking) {
								currentBlock = {
									type: "thinking",
									thinking: "",
									thinkingSignature: chunk.thoughtSignature,
								};
								output.content.push(currentBlock);
								stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
							} else {
								currentBlock = { type: "text", text: "" };
								output.content.push(currentBlock);
								stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
							}
						}

						// Append content
						if (currentBlock.type === "thinking") {
							currentBlock.thinking += chunk.text;
							if (chunk.thoughtSignature) {
								currentBlock.thinkingSignature = chunk.thoughtSignature;
							}
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: chunk.text,
								partial: output,
							});
						} else {
							currentBlock.text += chunk.text;
							stream.push({
								type: "text_delta",
								contentIndex: blockIndex(),
								delta: chunk.text,
								partial: output,
							});
						}
					}

					// Handle function calls
					if (chunk.functionCall) {
						if (currentBlock) {
							if (currentBlock.type === "text") {
								stream.push({
									type: "text_end",
									contentIndex: blockIndex(),
									content: currentBlock.text,
									partial: output,
								});
							} else {
								stream.push({
									type: "thinking_end",
									contentIndex: blockIndex(),
									content: currentBlock.thinking,
									partial: output,
								});
							}
							currentBlock = null;
						}

						const toolCall: ToolCall = {
							type: "toolCall",
							id: chunk.functionCall.id,
							name: chunk.functionCall.name,
							arguments: chunk.functionCall.args,
						};
						if (chunk.functionCall.thoughtSignature) {
							toolCall.thoughtSignature = chunk.functionCall.thoughtSignature;
						}

						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta: JSON.stringify(toolCall.arguments),
							partial: output,
						});
						stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
					}

					// Handle finish reason
					if (chunk.finishReason) {
						output.stopReason = mapGeminiStopReason(chunk.finishReason);
						if (output.content.some((b) => b.type === "toolCall")) {
							output.stopReason = "toolUse";
						}
					}

					// Handle usage
					if (chunk.usage) {
						output.usage = {
							input: chunk.usage.promptTokenCount || 0,
							output: (chunk.usage.candidatesTokenCount || 0) + (chunk.usage.thoughtsTokenCount || 0),
							cacheRead: chunk.usage.cachedContentTokenCount || 0,
							cacheWrite: 0,
							totalTokens: chunk.usage.totalTokenCount || 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
						calculateCost(model, output.usage);
					}
				}
			}

			// End final block
			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};
