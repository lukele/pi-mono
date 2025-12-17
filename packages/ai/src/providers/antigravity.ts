/**
 * Antigravity provider - Google Cloud Code Assist API
 *
 * This provider supports both Gemini and Claude models through Google's
 * Antigravity (Cloud Code Assist) API. It uses OAuth authentication and
 * wraps requests in the Antigravity-specific format.
 *
 * Key differences from direct API access:
 * - Requires OAuth tokens (not API keys)
 * - Requests wrapped in { project, model, request } format
 * - Responses wrapped in { response } format
 * - SSE streams need transformation
 * - Claude models require special handling for tools and thinking blocks
 */

import crypto from "node:crypto";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transorm-messages.js";

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

const DEFAULT_THINKING_BUDGET = 16000;

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

interface ThinkingConfig {
	thinkingBudget?: number;
	includeThoughts?: boolean;
}

interface Part {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: {
		id?: string;
		name: string;
		args: Record<string, unknown>;
	};
	functionResponse?: {
		id?: string;
		name: string;
		response: {
			result: string;
			isError?: boolean;
		};
	};
	inlineData?: {
		mimeType: string;
		data: string;
	};
}

interface Content {
	role: "user" | "model";
	parts: Part[];
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

function isClaudeModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("claude");
}

function isThinkingCapableModel(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	return lower.includes("thinking") || lower.includes("gemini-3") || lower.includes("opus");
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

// ============================================================================
// Message Conversion
// ============================================================================

function convertMessages(model: Model<"antigravity">, context: Context): Content[] {
	const contents: Content[] = [];
	const transformedMessages = transformMessages(context.messages, model);
	const isClaude = isClaudeModel(model.id);

	// For Claude, we need to track tool call IDs for matching responses
	const pendingCallIdsByName = new Map<string, string[]>();

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			const parts: Part[] = [];

			if (typeof msg.content === "string") {
				parts.push({ text: sanitizeSurrogates(msg.content) });
			} else {
				for (const item of msg.content) {
					if (item.type === "text") {
						parts.push({ text: sanitizeSurrogates(item.text) });
					} else if (item.type === "image" && model.input.includes("image")) {
						parts.push({
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						});
					}
				}
			}

			if (parts.length > 0) {
				contents.push({ role: "user", parts });
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push({ text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					// For Claude, only include signed thinking blocks
					if (isClaude && !block.thinkingSignature) {
						// Convert unsigned thinking to text with tags
						parts.push({
							text: sanitizeSurrogates(`<thinking>\n${block.thinking}\n</thinking>`),
						});
					} else {
						parts.push({
							thought: true,
							thoughtSignature: block.thinkingSignature,
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const callId = block.id || `tool-call-${++toolCallCounter}`;
					const part: Part = {
						functionCall: {
							id: callId,
							name: block.name,
							args: block.arguments,
						},
					};
					if (block.thoughtSignature) {
						part.thoughtSignature = block.thoughtSignature;
					}
					parts.push(part);

					// Track for Claude response matching
					if (isClaude) {
						const queue = pendingCallIdsByName.get(block.name) || [];
						queue.push(callId);
						pendingCallIdsByName.set(block.name, queue);
					}
				}
			}

			if (parts.length > 0) {
				contents.push({ role: "model", parts });
			}
		} else if (msg.role === "toolResult") {
			const parts: Part[] = [];

			// Extract text content
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => (c as TextContent).text)
				.join("\n");

			// Extract images
			const imageBlocks = model.input.includes("image") ? msg.content.filter((c) => c.type === "image") : [];

			// Get matching call ID for Claude
			let responseId: string | undefined;
			if (isClaude) {
				const queue = pendingCallIdsByName.get(msg.toolName);
				if (queue && queue.length > 0) {
					responseId = queue.shift();
					pendingCallIdsByName.set(msg.toolName, queue);
				}
			}

			parts.push({
				functionResponse: {
					id: responseId,
					name: msg.toolName,
					response: {
						result: textResult || (imageBlocks.length > 0 ? "(see attached image)" : ""),
						isError: msg.isError,
					},
				},
			});

			// Add images as inline data
			for (const imageBlock of imageBlocks) {
				parts.push({
					inlineData: {
						mimeType: (imageBlock as any).mimeType,
						data: (imageBlock as any).data,
					},
				});
			}

			contents.push({ role: "user", parts });
		}
	}

	return contents;
}

/**
 * Convert JSON Schema type to Antigravity/Gemini uppercase format.
 * Antigravity expects types like "OBJECT", "STRING", "ARRAY", etc.
 */
function convertSchemaType(type: string | undefined): string {
	if (!type) return "OBJECT";
	return type.toUpperCase();
}

/**
 * Recursively convert a JSON Schema to Antigravity format.
 * - Converts type names to uppercase (object -> OBJECT, string -> STRING)
 * - Removes unsupported features for Claude (anyOf/allOf/oneOf)
 */
function convertSchemaToAntigravity(schema: any, isClaude: boolean): any {
	if (!schema || typeof schema !== "object") {
		return { type: "OBJECT" };
	}

	const result: any = {};

	// Convert type to uppercase
	if (schema.type) {
		result.type = convertSchemaType(schema.type);
	} else {
		result.type = "OBJECT";
	}

	// Copy description
	if (schema.description) {
		result.description = schema.description;
	}

	// Handle properties (for object types)
	if (schema.properties && typeof schema.properties === "object") {
		result.properties = {};
		for (const [key, value] of Object.entries(schema.properties)) {
			result.properties[key] = convertSchemaToAntigravity(value, isClaude);
		}
	}

	// Handle required array
	if (Array.isArray(schema.required)) {
		result.required = schema.required;
	}

	// Handle items (for array types)
	if (schema.items) {
		if (isClaude && (schema.items.anyOf || schema.items.allOf || schema.items.oneOf)) {
			// For Claude, replace complex items with empty object
			result.items = { type: "OBJECT" };
		} else {
			result.items = convertSchemaToAntigravity(schema.items, isClaude);
		}
	}

	// Handle enum
	if (Array.isArray(schema.enum)) {
		result.enum = schema.enum;
	}

	// Skip anyOf/allOf/oneOf for Claude
	if (!isClaude) {
		if (schema.anyOf) result.anyOf = schema.anyOf.map((s: any) => convertSchemaToAntigravity(s, isClaude));
		if (schema.allOf) result.allOf = schema.allOf.map((s: any) => convertSchemaToAntigravity(s, isClaude));
		if (schema.oneOf) result.oneOf = schema.oneOf.map((s: any) => convertSchemaToAntigravity(s, isClaude));
	}

	return result;
}

function convertTools(tools: Tool[], isClaude: boolean): any[] | undefined {
	if (!tools || tools.length === 0) return undefined;

	const functionDeclarations = tools.map((tool) => {
		const schema = tool.parameters as any;

		// Sanitize tool name
		const name = String(tool.name)
			.replace(/[^a-zA-Z0-9_-]/g, "_")
			.slice(0, 64);

		return {
			name,
			description: tool.description || "",
			parameters: convertSchemaToAntigravity(schema, isClaude),
		};
	});

	return [{ functionDeclarations }];
}

// ============================================================================
// Request Building
// ============================================================================

function buildAntigravityRequest(
	model: Model<"antigravity">,
	context: Context,
	options: AntigravityOptions = {},
): AntigravityRequest {
	const isClaude = isClaudeModel(model.id);
	const isThinkingModel = isThinkingCapableModel(model.id);
	const contents = convertMessages(model, context);

	// Build the inner request payload
	const requestPayload: Record<string, unknown> = {
		contents,
	};

	// System instruction - must be Content object with role and parts array
	if (context.systemPrompt) {
		requestPayload.systemInstruction = {
			role: "user",
			parts: [{ text: sanitizeSurrogates(context.systemPrompt) }],
		};
	}

	// Thinking config
	const hasAssistantHistory = contents.some((c) => c.role === "model");

	// Determine thinking settings based on model type
	let thinkingEnabled = false;
	let thinkingBudget = 0;

	// For Claude with history, disable thinking (requires signed blocks)
	if (isClaude && hasAssistantHistory) {
		thinkingEnabled = false;
		thinkingBudget = 0;
	} else if (options.thinking?.enabled && isThinkingModel) {
		thinkingEnabled = true;
		if (isClaude) {
			// Claude uses specific budget values (e.g., 1024)
			thinkingBudget = options.thinking.budgetTokens ?? 1024;
		} else {
			// Gemini uses -1 for dynamic budget
			thinkingBudget = options.thinking.budgetTokens ?? -1;
		}
	} else if (isThinkingModel && !options.thinking) {
		// Default: enable thinking for capable models
		thinkingEnabled = true;
		thinkingBudget = isClaude ? 1024 : -1;
	}

	// Generation config - parameters differ between Claude and Gemini
	// Claude: temperature 0.4, topK 50
	// Gemini thinking: temperature 1, topK 40
	// Gemini non-thinking: temperature 0.7, topK 40
	const generationConfig: Record<string, unknown> = {
		temperature: options.temperature ?? (isClaude ? 0.4 : thinkingEnabled ? 1 : 0.7),
		topP: 1,
		topK: isClaude ? 50 : 40,
		candidateCount: 1,
		maxOutputTokens: options.maxTokens ?? 16384,
		thinkingConfig: {
			includeThoughts: thinkingEnabled,
			thinkingBudget: thinkingBudget,
		},
	};

	requestPayload.generationConfig = generationConfig;

	// Tools
	if (context.tools && context.tools.length > 0) {
		requestPayload.tools = convertTools(context.tools, isClaude);

		// Tool config - use VALIDATED mode when tools are present
		requestPayload.toolConfig = {
			functionCallingConfig: {
				mode: options.toolChoice?.toUpperCase() || "AUTO",
			},
		};
	}

	// Session ID for Antigravity
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

		// Extract from Anthropic-style content array
		if (Array.isArray(data.content)) {
			for (const block of data.content) {
				if (block.type === "text") {
					result.text = block.text;
				} else if (block.type === "thinking") {
					result.text = block.thinking || block.text;
					result.isThinking = true;
					if (block.signature) {
						result.thoughtSignature = block.signature;
					}
				} else if (block.type === "tool_use") {
					result.functionCall = {
						id: block.id || `func_${Date.now()}_${++toolCallCounter}`,
						name: block.name || "",
						args: block.input || {},
					};
				}
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

function mapFinishReason(reason: string | undefined): StopReason {
	if (!reason) return "stop";

	switch (reason.toUpperCase()) {
		case "STOP":
		case "END_TURN":
			return "stop";
		case "MAX_TOKENS":
		case "LENGTH":
			return "length";
		case "TOOL_USE":
			return "toolUse";
		default:
			return "stop";
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

					// Parse retry delay from response
					let retryDelayMs = 1000; // Default 1 second
					try {
						const errorJson = JSON.parse(errorBody);
						const retryInfo = errorJson.error?.details?.find((d: any) => d["@type"]?.includes("RetryInfo"));
						if (retryInfo?.retryDelay) {
							// Parse "0.822129350s" format
							const seconds = parseFloat(retryInfo.retryDelay.replace("s", ""));
							if (!isNaN(seconds)) {
								retryDelayMs = Math.ceil(seconds * 1000) + 100; // Add 100ms buffer
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
					break; // Don't retry non-429 errors
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
						// with empty text and no "thought" flag. Apply signature to existing thinking block.
						if (chunk.thoughtSignature && !isThinking && chunk.text === "" && currentBlock?.type === "thinking") {
							currentBlock.thinkingSignature = chunk.thoughtSignature;
							// Don't emit a delta for empty text, just continue
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
						// End current text/thinking block
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
						output.stopReason = mapFinishReason(chunk.finishReason);
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
