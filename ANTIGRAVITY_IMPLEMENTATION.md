# Antigravity Provider Implementation

This document describes the implementation of the Antigravity (Google Cloud Code Assist) provider for pi.

## Overview

Antigravity is Google's internal API for accessing both Gemini and Claude models through Google's infrastructure. It uses OAuth 2.0 authentication with Google accounts and provides access to models at no additional cost for Google Workspace users.

## Files Added/Modified

### @mariozechner/pi-ai package

1. **`src/providers/antigravity.ts`** (NEW)
   - Complete streaming provider implementation
   - Handles both Gemini and Claude models
   - Request/response transformation for Antigravity's wire format
   - SSE stream parsing
   - Tool call handling with Claude-specific normalization
   - Thinking block support

2. **`src/types.ts`** (MODIFIED)
   - Added `"antigravity"` to `Api` type
   - Added `AntigravityOptions` to `ApiOptionsMap`
   - Added `"antigravity"` to `KnownProvider` type

3. **`src/index.ts`** (MODIFIED)
   - Export the new antigravity provider

4. **`src/stream.ts`** (MODIFIED)
   - Added `antigravity` case to `stream()` function
   - Added `antigravity` case to `mapOptionsForApi()` function

5. **`scripts/generate-models.ts`** (MODIFIED)
   - Added Antigravity models to the auto-generator

### @mariozechner/pi-coding-agent package

1. **`src/core/oauth/antigravity.ts`** (NEW)
   - OAuth 2.0 flow with PKCE
   - Local callback server for automatic token capture
   - Token refresh support
   - Project ID discovery from Antigravity API

2. **`src/core/oauth/index.ts`** (MODIFIED)
   - Added `"antigravity"` to `SupportedOAuthProvider`
   - Added Antigravity to `getOAuthProviders()` list
   - Added login/refresh handlers

3. **`src/core/oauth/storage.ts`** (MODIFIED)
   - Extended `OAuthCredentials` with `projectId`, `managedProjectId`, `email`

4. **`src/core/model-config.ts`** (MODIFIED)
   - Added `"antigravity"` to model API schema
   - Added Antigravity to `getApiKeyForModel()`
   - Added Antigravity to `getAvailableModels()`
   - Added Antigravity to OAuth provider mapping

5. **`src/core/model-resolver.ts`** (MODIFIED)
   - Added Antigravity default model to `defaultModelPerProvider`

## Available Models

Via Antigravity, the following models are available:

### Gemini Models
- `gemini-2.5-pro` - Gemini 2.5 Pro
- `gemini-2.5-flash` - Gemini 2.5 Flash  
- `gemini-3-pro-preview` - Gemini 3 Pro Preview

### Claude Models (via Antigravity)
- `claude-sonnet-4-5` - Claude Sonnet 4.5
- `claude-opus-4-5` - Claude Opus 4.5
- `claude-haiku-4-5` - Claude Haiku 4.5

## Usage

### Login

```bash
pi
/login  # Select "Antigravity (Google Cloud Code Assist)"
```

This will:
1. Open your browser to Google OAuth
2. Listen on localhost:51121 for the callback
3. Exchange the code for tokens
4. Discover your project ID from Antigravity
5. Store credentials in `~/.pi/agent/oauth.json`

### Model Selection

After login, Antigravity models appear in `/model`:

```bash
/model antigravity  # Filter to Antigravity models
```

Or specify directly:

```bash
pi --provider antigravity --model gemini-2.5-pro
```

## API Details

### Endpoints

- Primary: `https://daily-cloudcode-pa.sandbox.googleapis.com`
- Fallback: `https://autopush-cloudcode-pa.sandbox.googleapis.com`
- Production: `https://cloudcode-pa.googleapis.com`

### Request Format

Antigravity wraps standard Gemini requests:

```json
{
  "project": "<project-id>",
  "model": "gemini-2.5-pro",
  "request": {
    "contents": [...],
    "systemInstruction": "...",
    "generationConfig": {...},
    "tools": [...]
  },
  "userAgent": "antigravity",
  "requestId": "agent-<uuid>"
}
```

### Response Format

SSE streams with wrapped responses:

```
data: {"response": {"candidates": [...], "usageMetadata": {...}}}
```

### Claude Model Specifics

When using Claude models via Antigravity:
- Tool schemas are sanitized (no anyOf/allOf/oneOf)
- Tool call IDs are normalized and matched with responses
- Unsigned thinking blocks are converted to text with `<thinking>` tags
- Thinking is disabled for multi-turn conversations (Claude requires signed blocks)

## OAuth Details

- Client ID: `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
- Redirect URI: `http://localhost:51121/oauth-callback`
- Scopes:
  - `https://www.googleapis.com/auth/cloud-platform`
  - `https://www.googleapis.com/auth/userinfo.email`
  - `https://www.googleapis.com/auth/userinfo.profile`
  - `https://www.googleapis.com/auth/cclog`
  - `https://www.googleapis.com/auth/experimentsandconfigs`

## Cost

All models via Antigravity are reported with $0 cost as they're included in Google Workspace subscriptions.

## Testing

To test the implementation:

1. Build the packages:
   ```bash
   cd pi-mono/packages/ai && npm run build
   cd pi-mono/packages/coding-agent && npm run build
   ```

2. Run pi and login:
   ```bash
   pi
   /login
   # Select Antigravity
   ```

3. Select an Antigravity model:
   ```bash
   /model
   # Type "antigravity" to filter
   ```

4. Test a simple prompt with tool use:
   ```
   You: List files in the current directory
   ```
