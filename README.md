# Langfuse Observability MCP Server

[Model Context Protocol](https://github.com/modelcontextprotocol) (MCP) Server for [Langfuse](https://langfuse.com). This server provides comprehensive access to Langfuse's observability platform through the Model Context Protocol, including prompt management, trace analysis, observation monitoring, and session tracking.

## Demo

Quick demo of Langfuse Prompts MCP in Claude Desktop (_unmute for voice-over explanations_):

https://github.com/user-attachments/assets/61da79af-07c2-4f69-b28c-ca7c6e606405

## Features

### MCP Prompt Specification

This server implements the [MCP Prompts specification](https://modelcontextprotocol.io/docs/concepts/prompts) for prompt discovery and retrieval.

- `prompts/list`: List all available prompts

  - Optional cursor-based pagination
  - Returns prompt names and their required arguments, limitation: all arguments are assumed to be optional and do not include descriptions as variables do not have specification in Langfuse
  - Includes next cursor for pagination if there's more than 1 page of prompts

- `prompts/get`: Get a specific prompt
  - Transforms Langfuse prompts (text and chat) into MCP prompt objects
  - Compiles prompt with provided variables

### Comprehensive Data Access

Enhanced with powerful data fetching capabilities:

- **Trace Analysis**: Advanced trace filtering with support for time ranges, user IDs, trace names, and custom tags
- **Observation Monitoring**: Detailed observation queries with type filtering (SPAN, GENERATION, EVENT) and hierarchical navigation
- **Session Tracking**: User session management and analysis
- **Real-time Insights**: Access to live observability data with pagination and efficient caching

### Tools

To increase compatibility with other MCP clients that do not support the prompt capability, the server also exports tools that replicate the functionality of the MCP Prompts.

#### Original Prompt Management Tools

- `get-prompts`: List available prompts

  - Optional `cursor` parameter for pagination
  - Returns a list of prompts with their arguments

- `get-prompt`: Retrieve and compile a specific prompt

  - Required `name` parameter: Name of the prompt to retrieve
  - Optional `arguments` parameter: JSON object with prompt variables

- `get-trace`: Retrieve Langfuse trace data, optionally filtering by observation name or index
  - Required `traceId` parameter: The ID of the trace to retrieve
  - Optional `function_name` parameter: Filter observations by exact name
  - Optional `index` parameter: Retrieve a specific observation by its trace-level index (0-based)
  - Caching: Fetched traces are cached locally in the `cache_data/` directory (ignored by git)
  - Size Limit: If no filter provided and the full trace data exceeds 40 KB, returns a summary instead

#### Phase 1: Core Data Fetching Tools

- `fetch-traces`: List traces with advanced filtering options

  - Optional `page` parameter: Page number for pagination (1-based)
  - Optional `limit` parameter: Number of traces per page (max 100)
  - Optional `traceName` parameter: Filter traces by specific trace name
  - Optional `userId` parameter: Filter traces by user ID
  - Optional `sessionId` parameter: Filter traces by session ID
  - Optional `fromTimestamp` parameter: Filter traces from this timestamp (ISO 8601 format)
  - Optional `toTimestamp` parameter: Filter traces until this timestamp (ISO 8601 format)
  - Optional `orderBy` parameter: Order traces by "timestamp" or "latency"
  - Optional `tags` parameter: Filter traces by tags (array of strings)

- `fetch-observations`: List observations with filtering options and pagination

  - Optional `page` parameter: Page number for pagination (1-based)
  - Optional `limit` parameter: Number of observations per page (max 100)
  - Optional `traceId` parameter: Filter observations by trace ID
  - Optional `name` parameter: Filter observations by name
  - Optional `userId` parameter: Filter observations by user ID
  - Optional `type` parameter: Filter observations by type ("SPAN", "GENERATION", "EVENT")
  - Optional `parentObservationId` parameter: Filter observations by parent observation ID
  - Optional `fromStartTime` parameter: Filter observations from this start time (ISO 8601 format)
  - Optional `toStartTime` parameter: Filter observations until this start time (ISO 8601 format)

- `fetch-observation`: Fetch a single observation by its ID

  - Required `observationId` parameter: The ID of the observation to retrieve

- `fetch-sessions`: List user sessions with pagination support
  - Optional `page` parameter: Page number for pagination (1-based)
  - Optional `limit` parameter: Number of sessions per page (max 100)

#### Future Enhancements (Planned)

- `fetch-scores`: Fetch evaluation scores (planned for future implementation once SDK supports it)

## Development

```bash
npm install

# build current file
npm run build

# test in mcp inspector
npx @modelcontextprotocol/inspector node ./build/index.js
```

## Usage

### Step 1: Build

```bash
npm install
npm run build
```

### Step 2: Add the server to your MCP servers:

#### Claude Desktop

Configure Claude for Desktop by editing `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "langfuse": {
      "command": "node",
      "args": ["<absolute-path>/build/index.js"],
      "env": {
        "LANGFUSE_PUBLIC_KEY": "your-public-key",
        "LANGFUSE_SECRET_KEY": "your-secret-key",
        "LANGFUSE_BASEURL": "https://cloud.langfuse.com"
      }
    }
  }
}
```

Make sure to replace the environment variables with your actual Langfuse API keys. The server will now be available to use in Claude Desktop.

#### Cursor

Add new server to Cursor:

- Name: `Langfuse Prompts`
- Type: `command`
- Command:
  ```bash
  LANGFUSE_PUBLIC_KEY="your-public-key" LANGFUSE_SECRET_KEY="your-secret-key" LANGFUSE_BASEURL="https://cloud.langfuse.com" node absolute-path/build/index.js
  ```

## Limitations

The MCP Server is a work in progress and has some limitations:

- Only prompts with a `production` label in Langfuse are returned
- All arguments are assumed to be optional and do not include descriptions as variables do not have specification in Langfuse
- List operations require fetching each prompt individually in the background to extract the arguments, this works but is not efficient

Contributions are welcome! Please open an issue or a PR ([repo](https://github.com/langfuse/mcp-server-langfuse)) if you have any suggestions or feedback.
