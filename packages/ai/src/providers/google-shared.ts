/**
 * Shared utilities for Google and Antigravity providers
 *
 * Both providers use the same Gemini-style message format and tool declarations.
 * This module provides common conversion functions.
 */

import type { Api, Context, Model, StopReason, TextContent, Tool } from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transorm-messages.js";

// ============================================================================
// Types
// ============================================================================

export interface GeminiPart {
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

export interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

export interface ConvertMessagesOptions {
	/** Whether to convert types to uppercase (required for Antigravity) */
	uppercaseTypes?: boolean;
	/** Whether this is a Claude model (affects thinking block handling) */
	isClaude?: boolean;
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

// ============================================================================
// Message Conversion
// ============================================================================

/**
 * Convert internal messages to Gemini/Antigravity format.
 * Works for both Google and Antigravity providers.
 */
export function convertMessagesToGemini<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: ConvertMessagesOptions = {},
): GeminiContent[] {
	const contents: GeminiContent[] = [];
	const transformedMessages = transformMessages(context.messages, model);
	const isClaude = options.isClaude ?? false;

	// For Claude, we need to track tool call IDs for matching responses
	const pendingCallIdsByName = new Map<string, string[]>();

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			const parts: GeminiPart[] = [];

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
			const parts: GeminiPart[] = [];

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
					const part: GeminiPart = {
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
			const parts: GeminiPart[] = [];

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

// ============================================================================
// Tool Conversion
// ============================================================================

export interface ConvertToolsOptions {
	/** Whether to convert types to uppercase (required for Antigravity) */
	uppercaseTypes?: boolean;
	/** Whether this is a Claude model (affects schema handling) */
	isClaude?: boolean;
}

/**
 * Convert JSON Schema type to uppercase format (required for Antigravity).
 */
function convertSchemaType(type: string | undefined, uppercase: boolean): string {
	if (!type) return uppercase ? "OBJECT" : "object";
	return uppercase ? type.toUpperCase() : type;
}

/**
 * Recursively convert a JSON Schema for Gemini/Antigravity format.
 * - Optionally converts type names to uppercase (object -> OBJECT)
 * - Removes unsupported features for Claude (anyOf/allOf/oneOf)
 */
function convertSchema(schema: any, options: ConvertToolsOptions): any {
	if (!schema || typeof schema !== "object") {
		return { type: options.uppercaseTypes ? "OBJECT" : "object" };
	}

	const result: any = {};

	// Convert type
	if (schema.type) {
		result.type = convertSchemaType(schema.type, options.uppercaseTypes ?? false);
	} else {
		result.type = options.uppercaseTypes ? "OBJECT" : "object";
	}

	// Copy description
	if (schema.description) {
		result.description = schema.description;
	}

	// Handle properties (for object types)
	if (schema.properties && typeof schema.properties === "object") {
		result.properties = {};
		for (const [key, value] of Object.entries(schema.properties)) {
			result.properties[key] = convertSchema(value, options);
		}
	}

	// Handle required array
	if (Array.isArray(schema.required)) {
		result.required = schema.required;
	}

	// Handle items (for array types)
	if (schema.items) {
		if (options.isClaude && (schema.items.anyOf || schema.items.allOf || schema.items.oneOf)) {
			// For Claude, replace complex items with empty object
			result.items = { type: options.uppercaseTypes ? "OBJECT" : "object" };
		} else {
			result.items = convertSchema(schema.items, options);
		}
	}

	// Handle enum
	if (Array.isArray(schema.enum)) {
		result.enum = schema.enum;
	}

	// Skip anyOf/allOf/oneOf for Claude
	if (!options.isClaude) {
		if (schema.anyOf) result.anyOf = schema.anyOf.map((s: any) => convertSchema(s, options));
		if (schema.allOf) result.allOf = schema.allOf.map((s: any) => convertSchema(s, options));
		if (schema.oneOf) result.oneOf = schema.oneOf.map((s: any) => convertSchema(s, options));
	}

	return result;
}

/**
 * Convert tools to Gemini/Antigravity function declarations format.
 * For Antigravity, each tool is wrapped in its own functionDeclarations array.
 */
export function convertToolsToGemini(tools: Tool[], options: ConvertToolsOptions = {}): any[] | undefined {
	if (!tools || tools.length === 0) return undefined;

	// Antigravity format: each tool in its own functionDeclarations wrapper
	// [{ functionDeclarations: [tool1] }, { functionDeclarations: [tool2] }, ...]
	return tools.map((tool) => {
		const schema = tool.parameters as any;

		// Sanitize tool name
		const name = String(tool.name)
			.replace(/[^a-zA-Z0-9_-]/g, "_")
			.slice(0, 64);

		return {
			functionDeclarations: [
				{
					name,
					description: tool.description || "",
					parameters: convertSchema(schema, options),
				},
			],
		};
	});
}

// ============================================================================
// Stop Reason Mapping
// ============================================================================

/**
 * Map Gemini/Antigravity finish reasons to internal StopReason.
 */
export function mapGeminiStopReason(reason: string | undefined): StopReason {
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
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "SAFETY":
		case "IMAGE_SAFETY":
		case "IMAGE_PROHIBITED_CONTENT":
		case "RECITATION":
		case "FINISH_REASON_UNSPECIFIED":
		case "OTHER":
		case "LANGUAGE":
		case "MALFORMED_FUNCTION_CALL":
		case "UNEXPECTED_TOOL_CALL":
		case "NO_IMAGE":
			return "error";
		default:
			return "stop";
	}
}

// ============================================================================
// Model Helpers
// ============================================================================

/**
 * Check if a model ID indicates a Claude model.
 */
export function isClaudeModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("claude");
}

/**
 * Check if a model supports thinking/reasoning.
 */
export function isThinkingCapableModel(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	return (
		lower.includes("thinking") || lower.includes("gemini-3") || lower.includes("opus") || lower.includes("gpt-oss")
	);
}

/**
 * Check if a model is a GPT-OSS model.
 */
export function isGptOssModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("gpt-oss");
}
