import * as fs from 'fs/promises';
import * as path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListPromptsRequestSchema,
  ListPromptsRequest,
  ListPromptsResult,
  GetPromptRequestSchema,
  GetPromptRequest,
  GetPromptResult,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { Langfuse, ChatPromptClient } from 'langfuse';
import { z } from 'zod';

import { extractVariables } from './utils.js';

// Requires Environment Variables
console.debug('Initializing Langfuse client with environment variables:', {
  LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY ? '[SET]' : '[NOT SET]',
  LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY ? '[SET]' : '[NOT SET]',
  LANGFUSE_BASEURL: process.env.LANGFUSE_BASEURL || '[NOT SET]',
});

const langfuse = new Langfuse();
const cacheDir = path.resolve(process.cwd(), 'cache_data');

// Create MCP server instance with a "prompts" capability.
const server = new McpServer(
  {
    name: 'langfuse-prompts',
    version: '1.0.0',
  },
  {
    capabilities: {
      prompts: {},
    },
  }
);

async function listPromptsHandler(request: ListPromptsRequest): Promise<ListPromptsResult> {
  try {
    const cursor = request.params?.cursor;
    const page = cursor ? Number(cursor) : 1;
    if (cursor !== undefined && isNaN(page)) {
      throw new Error('Cursor must be a valid number');
    }

    const res = await langfuse.api.promptsList({
      limit: 100,
      page,
      label: 'production',
    });

    const resPrompts: ListPromptsResult['prompts'] = await Promise.all(
      res.data.map(async (i) => {
        const prompt = await langfuse.getPrompt(i.name, undefined, {
          cacheTtlSeconds: 0,
        });
        const variables = extractVariables(JSON.stringify(prompt.prompt));
        return {
          name: i.name,
          arguments: variables.map((v) => ({
            name: v,
            required: false,
          })),
        };
      })
    );

    return {
      prompts: resPrompts,
      nextCursor: res.meta.totalPages > page ? (page + 1).toString() : undefined,
    };
  } catch (error) {
    console.error('Error fetching prompts:', error);
    throw new Error('Failed to fetch prompts');
  }
}

async function getPromptHandler(request: GetPromptRequest): Promise<GetPromptResult> {
  const promptName: string = request.params.name;
  const args = request.params.arguments || {};

  try {
    // Initialize Langfuse client and fetch the prompt by name.
    let compiledTextPrompt: string | undefined;
    let compiledChatPrompt: ChatPromptClient['prompt'] | undefined; // Langfuse chat prompt type

    try {
      // try chat prompt type first
      const prompt = await langfuse.getPrompt(promptName, undefined, {
        type: 'chat',
      });
      if (prompt.type !== 'chat') {
        throw new Error(`Prompt '${promptName}' is not a chat prompt`);
      }
      compiledChatPrompt = prompt.compile(args);
    } catch {
      // fallback to text prompt type
      const prompt = await langfuse.getPrompt(promptName, undefined, {
        type: 'text',
      });
      compiledTextPrompt = prompt.compile(args);
    }

    if (compiledChatPrompt) {
      const result: GetPromptResult = {
        messages: compiledChatPrompt.map((msg) => ({
          role: ['ai', 'assistant'].includes(msg.role) ? 'assistant' : 'user',
          content: {
            type: 'text',
            text: msg.content,
          },
        })),
      };
      return result;
    } else if (compiledTextPrompt) {
      const result: GetPromptResult = {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: compiledTextPrompt },
          },
        ],
      };
      return result;
    } else {
      throw new Error(`Failed to get prompt for '${promptName}'`);
    }
  } catch (error: any) {
    throw new Error(`Failed to get prompt for '${promptName}': ${error.message}`);
  }
}

// Register handlers
server.server.setRequestHandler(ListPromptsRequestSchema, listPromptsHandler);
server.server.setRequestHandler(GetPromptRequestSchema, getPromptHandler);

// Tools for compatibility
server.tool(
  'get-prompts',
  'Get prompts that are stored in Langfuse',
  {
    cursor: z.string().optional().describe('Cursor to paginate through prompts'),
  },
  async (args) => {
    try {
      const res = await listPromptsHandler({
        method: 'prompts/list',
        params: {
          cursor: args.cursor,
        },
      });

      const parsedRes: CallToolResult = {
        content: res.prompts.map((p) => ({
          type: 'text',
          text: JSON.stringify(p),
        })),
      };

      return parsedRes;
    } catch (error) {
      return {
        content: [{ type: 'text', text: 'Error: ' + error }],
        isError: true,
      };
    }
  }
);

server.tool(
  'get-prompt',
  'Get a prompt that is stored in Langfuse',
  {
    name: z
      .string()
      .describe('Name of the prompt to retrieve, use get-prompts to get a list of prompts'),
    arguments: z
      .record(z.string())
      .optional()
      .describe(
        'Arguments with prompt variables to pass to the prompt template, json object, e.g. {"<name>":"<value>"}'
      ),
  },
  async (args, _extra) => {
    try {
      const res = await getPromptHandler({
        method: 'prompts/get',
        params: {
          name: args.name,
          arguments: args.arguments,
        },
      });

      const parsedRes: CallToolResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res),
          },
        ],
      };

      return parsedRes;
    } catch (error) {
      return {
        content: [{ type: 'text', text: 'Error: ' + error }],
        isError: true,
      };
    }
  }
);

// Register the get_trace tool
server.tool(
  'get_trace',
  'Fetches trace data from Langfuse using the provided trace ID.',
  {
    // Inlined schema definition
    traceId: z.string().describe('The ID of the Langfuse trace to fetch.'),
    function_name: z
      .string()
      .optional()
      .describe('Optional name of the function/observation to filter by within the trace'),
    index: z
      .number()
      .int()
      .optional()
      .describe(
        'Optional index (0-based) to select a specific function call if multiple matches are found for function_name'
      ),
  },
  async (args): Promise<CallToolResult> => {
    const cacheFilePath = path.join(cacheDir, `${args.traceId}.json`);
    let traceData: any; // Consider using a more specific type from Langfuse SDK if available, e.g., ApiTraceWithFullDetails

    try {
      // 1. Try reading from cache
      try {
        const cachedContent = await fs.readFile(cacheFilePath, 'utf-8');
        traceData = JSON.parse(cachedContent);
        console.error(`Cache hit for trace ${args.traceId}`);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // Cache miss, fetch from API
          console.error(`Cache miss for trace ${args.traceId}. Fetching from API.`);
          traceData = await langfuse.api.traceGet(args.traceId); // Fetch from API

          // Write to cache after successful API fetch
          try {
            await fs.mkdir(cacheDir, { recursive: true });
            await fs.writeFile(cacheFilePath, JSON.stringify(traceData, null, 2), 'utf-8');
            console.error(`Cached trace ${args.traceId} successfully.`);
          } catch (writeError) {
            // Log cache write error but don't fail the operation
            console.error(`Error writing cache for trace ${args.traceId}:`, writeError);
          }
        } else {
          // Other file system error reading cache, re-throw
          throw error;
        }
      }

      // --- REVISED FILTERING / INDEXING LOGIC ---

      // Ensure traceData and observations are valid before proceeding
      if (!traceData || !Array.isArray(traceData.observations)) {
        console.error(`Trace data or observations missing/invalid for trace ${args.traceId}`);
        return {
          content: [
            {
              type: 'text',
              text: `Error: Invalid trace data structure for trace ${args.traceId}. Cannot process filters.`,
            },
          ],
          isError: true,
        };
      }

      const observations = traceData.observations; // Alias for clarity

      // 1. Check for Index Filter (Highest Priority)
      if (
        args.index !== undefined &&
        typeof args.index === 'number' &&
        Number.isInteger(args.index)
      ) {
        if (args.index >= 0 && args.index < observations.length) {
          // Valid index provided, return the specific observation's details
          const observation = observations[args.index];
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { input: observation.input, output: observation.output },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          // Invalid index
          return {
            content: [
              {
                type: 'text',
                text: `Error: Index ${args.index} is out of bounds. Valid indices are 0 to ${observations.length - 1}.`,
              },
            ],
            isError: true,
          };
        }
      }
      // 2. Check for Function Name Filter (if index not used)
      else if (args.function_name) {
        const matches = observations
          .map((obs: any, originalIndex: number) => ({ obs, originalIndex })) // Keep original index
          .filter((item: any) => item.obs.name === args.function_name);

        if (matches.length === 0) {
          return {
            content: [
              { type: 'text', text: `No observations found with name: ${args.function_name}` },
            ],
          };
        } else if (matches.length === 1) {
          // Single match found, return its details
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { input: matches[0].obs.input, output: matches[0].obs.output },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          // Multiple matches found, return list of original indices and names
          const summary = matches.map((item: any) => ({
            index: item.originalIndex,
            name: item.obs.name,
          }));
          const message = `Multiple observations found with name '${args.function_name}'. Use the 'index' argument with one of the following original indices to retrieve specific details:\n\n${JSON.stringify(summary, null, 2)}`;
          return {
            content: [{ type: 'text', text: message }],
          };
        }
      }
      // 3. Handle No Filter (if index and function_name not used)
      else {
        // No specific filter, check size before returning full trace
        const sizeThreshold = 40 * 1024; // 40 KB
        const stringifiedData = JSON.stringify(traceData);
        const byteSize = Buffer.byteLength(stringifiedData, 'utf-8');

        if (byteSize > sizeThreshold) {
          // Size exceeds threshold, return structure summary with original indices
          const structureSummary = observations.map((obs: any, idx: number) => ({
            index: idx,
            name: obs.name,
          }));
          const message = `Trace data exceeds ${sizeThreshold / 1024} KB (${(byteSize / 1024).toFixed(2)} KB). Returning structure summary. Use 'function_name' or 'index' arguments to retrieve specific observation details.\n\n${JSON.stringify(structureSummary, null, 2)}`;
          return {
            content: [{ type: 'text', text: message }],
          };
        } else {
          // Size is within limit, return full trace
          return {
            content: [{ type: 'text', text: stringifiedData }], // Use already stringified data
          };
        }
      }
    } catch (error) {
      // Handle API errors or unexpected file system errors
      console.error(`Error processing get_trace for ${args.traceId}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error fetching trace ${args.traceId}: ${errorMessage}` }],
        isError: true,
      };
    }
  }
);

// Phase 1: Core Data Fetching Tools

// Add auth check tool first
server.tool('auth-check', 'Verify Langfuse connection and authentication', {}, async () => {
  try {
    console.debug(`Checking Langfuse authentication...`);

    // Test basic API call to verify connection
    await langfuse.api.promptsList({ limit: 1, page: 1 });

    return {
      content: [
        {
          type: 'text',
          text: '✅ Langfuse authentication successful',
        },
      ],
    };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      content: [
        {
          type: 'text',
          text: `❌ Langfuse authentication failed: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

server.tool(
  'fetch-traces',
  {
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Page number for pagination (1-based, default: 1)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Number of traces per page (1-100, default: 10)'),
    name: z.string().optional().describe('Filter traces by specific trace name (exact match)'),
    userId: z
      .string()
      .optional()
      .describe('Filter traces by user ID to see user-specific activities'),
    sessionId: z
      .string()
      .optional()
      .describe('Filter traces by session ID to group related interactions'),
    fromTimestamp: z
      .string()
      .optional()
      .describe(
        "Filter traces from this timestamp (ISO 8601 format, e.g., '2024-01-01T00:00:00Z')"
      ),
    toTimestamp: z
      .string()
      .optional()
      .describe('Filter traces until this timestamp (ISO 8601 format)'),
    orderBy: z
      .enum(['timestamp', 'id'])
      .optional()
      .describe('Order traces by timestamp (newest first) or id'),
    tags: z.array(z.string()).optional().describe('Filter traces by tags (array of strings)'),
  },
  async ({ page, limit, name, userId, sessionId, fromTimestamp, toTimestamp, orderBy, tags }) => {
    try {
      console.debug(`Fetching traces with filters:`, {
        page,
        limit,
        name,
        userId,
        sessionId,
        fromTimestamp,
        toTimestamp,
        orderBy,
        tags,
      });

      // Build query parameters dynamically based on provided filters
      const queryParams: any = {
        page: page || 1,
        limit: limit || 10, // Default to 10 for better readability
      };

      // Add filters if provided (only include non-empty values)
      // Use correct Langfuse API parameter names (underscore format)
      if (name && name.trim() !== '') queryParams.name = name;
      if (userId && userId.trim() !== '') queryParams.user_id = userId;
      if (sessionId && sessionId.trim() !== '') queryParams.session_id = sessionId;
      if (fromTimestamp && fromTimestamp.trim() !== '') queryParams.from_timestamp = fromTimestamp;
      if (toTimestamp && toTimestamp.trim() !== '') queryParams.to_timestamp = toTimestamp;
      if (orderBy && orderBy.trim() !== '') queryParams.order_by = orderBy;
      if (tags && Array.isArray(tags) && tags.length > 0 && tags.some((tag) => tag.trim() !== '')) {
        queryParams.tags = tags.filter((tag) => tag.trim() !== '');
      }

      console.debug(`API call parameters:`, queryParams);

      const result = await langfuse.api.traceList(queryParams);

      // Enhanced response with metadata
      const enhancedResult = {
        meta: {
          queryFilters: queryParams,
          resultsCount: result.data?.length || 0,
          hasMore: result.meta?.totalPages > (page || 1),
          totalPages: result.meta?.totalPages,
          currentPage: page || 1,
        },
        traces:
          result.data?.map((trace: any) => ({
            id: trace.id,
            name: trace.name,
            userId: trace.userId,
            sessionId: trace.sessionId,
            timestamp: trace.timestamp,
            metadata: trace.metadata,
            tags: trace.tags,
            input: trace.input,
            output: trace.output,
            version: trace.version,
            release: trace.release,
            public: trace.public,
            bookmarked: trace.bookmarked,
            projectId: trace.projectId,
            observationsCount: trace.observationsCount,
            latency: trace.latency,
            totalCost: trace.totalCost,
          })) || [],
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(enhancedResult, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      console.error('Error in fetch-traces tool:', err);

      // Properly handle different error types
      let errorMessage = 'Unknown error occurred';
      if (err instanceof Error) {
        errorMessage = err.message || 'Error object without message';
      } else if (typeof err === 'string') {
        errorMessage = err;
      } else if (err && typeof err === 'object' && 'message' in err) {
        errorMessage = String((err as any).message);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Error fetching traces: ${errorMessage}\n\nDebugging tips:\n- Check Langfuse credentials (publicKey, secretKey, baseUrl)\n- Verify Langfuse server is accessible\n- Try with simpler filters first, like just 'limit: 5' to test the connection`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'fetch-observations',
  'Fetch observations from Langfuse with filtering options and pagination',
  {
    page: z.number().int().min(1).optional().describe('Page number for pagination (1-based)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Number of observations per page (max 100)'),
  },
  async ({ page, limit }) => {
    try {
      console.debug(`Fetching observations with pagination: page=${page}, limit=${limit}`);

      // For now, return traces since we know traceList works
      // This is a simplified implementation until we find the correct observations API method
      const result = await langfuse.api.traceList({
        page: page || 1,
        limit: limit || 50,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      console.error('Error in fetch-observations tool:', err);

      // Properly handle different error types
      let errorMessage = 'Unknown error occurred';
      if (err instanceof Error) {
        errorMessage = err.message || 'Error object without message';
      } else if (typeof err === 'string') {
        errorMessage = err;
      } else if (err && typeof err === 'object' && 'message' in err) {
        errorMessage = String((err as any).message);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Error fetching observations: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'fetch-observation',
  'Fetch a single observation from Langfuse by its ID',
  {
    observationId: z.string().describe('The ID of the observation to retrieve'),
  },
  async ({ observationId }) => {
    try {
      console.debug(`Fetching observation with ID: ${observationId}`);

      const result = await langfuse.api.observationsGet(observationId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      console.error('Error in fetch-observation tool:', err);

      // Properly handle different error types
      let errorMessage = 'Unknown error occurred';
      if (err instanceof Error) {
        errorMessage = err.message || 'Error object without message';
      } else if (typeof err === 'string') {
        errorMessage = err;
      } else if (err && typeof err === 'object' && 'message' in err) {
        errorMessage = String((err as any).message);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Error fetching observation: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'fetch-sessions',
  'Fetch user sessions from Langfuse with pagination support',
  {
    page: z.number().int().min(1).optional().describe('Page number for pagination (1-based)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Number of sessions per page (max 100)'),
  },
  async ({ page, limit }) => {
    try {
      console.debug(`Fetching sessions with pagination: page=${page}, limit=${limit}`);

      // Use the same pattern - try traceList for now since we don't have sessionsList
      const result = await langfuse.api.traceList({
        page: page || 1,
        limit: limit || 50,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'get-trace-details',
  'Get comprehensive trace details including user info, metadata, observations summary, and system data from Langfuse',
  {
    traceId: z.string().describe('The ID of the Langfuse trace to fetch detailed information for'),
  },
  async ({ traceId }) => {
    try {
      console.debug(`Fetching detailed trace information for: ${traceId}`);

      const traceData = await langfuse.api.traceGet(traceId);

      // Create a comprehensive, well-formatted response
      const traceDetails = {
        // Basic trace information
        trace: {
          id: traceData.id,
          name: traceData.name,
          timestamp: traceData.timestamp,
          version: traceData.version,
          release: traceData.release,
          public: traceData.public,
        },

        // User and session context
        userContext: {
          userId: traceData.userId,
          sessionId: traceData.sessionId,
          tags: traceData.tags || [],
        },

        // Trace content and metadata
        content: {
          input: traceData.input,
          output: traceData.output,
          metadata: traceData.metadata || {},
        },

        // Performance and cost metrics
        metrics: {
          latency: traceData.latency,
          totalCost: traceData.totalCost,
          observationsCount: traceData.observations?.length || 0,
        },

        // Observations summary
        observations: {
          count: traceData.observations?.length || 0,
          summary:
            traceData.observations?.map((obs: any, index: number) => ({
              index,
              id: obs.id,
              name: obs.name,
              type: obs.type,
              startTime: obs.startTime,
              endTime: obs.endTime,
              level: obs.level,
              model: obs.model,
              usage: obs.usage,
              hasInput: !!obs.input,
              hasOutput: !!obs.output,
            })) || [],
        },
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(traceDetails, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching trace details for ${traceId}: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'analyze-user-activity',
  'Analyze user activity and trace patterns for a specific user ID with comprehensive insights',
  {
    userId: z.string().describe('The user ID to analyze activity patterns for'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Number of recent traces to analyze (default: 20)'),
    fromTimestamp: z
      .string()
      .optional()
      .describe('Analyze activity from this timestamp (ISO 8601 format)'),
  },
  async ({ userId, limit, fromTimestamp }) => {
    try {
      console.debug(`Analyzing user activity for userId: ${userId}`);

      // Fetch user's traces
      const queryParams: any = {
        userId,
        limit: limit || 20,
        orderBy: 'timestamp',
      };

      if (fromTimestamp) queryParams.fromTimestamp = fromTimestamp;

      const result = await langfuse.api.traceList(queryParams);
      const traces = result.data || [];

      if (traces.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No traces found for user ID: ${userId}`,
            },
          ],
        };
      }

      // Analyze patterns
      const analysis = {
        userProfile: {
          userId,
          analysisTimestamp: new Date().toISOString(),
          totalTracesAnalyzed: traces.length,
        },

        activitySummary: {
          firstTraceTime: traces[traces.length - 1]?.timestamp,
          lastTraceTime: traces[0]?.timestamp,
          uniqueTraceNames: [...new Set(traces.map((t: any) => t.name).filter(Boolean))],
          uniqueSessions: [...new Set(traces.map((t: any) => t.sessionId).filter(Boolean))],
          totalSessions: [...new Set(traces.map((t: any) => t.sessionId).filter(Boolean))].length,
        },

        patterns: {
          mostCommonTraceNames: getMostCommon(traces.map((t: any) => t.name).filter(Boolean)),
          tagUsage: getMostCommon(traces.flatMap((t: any) => t.tags || [])),
          sessionsActivity: groupBySession(traces),
        },

        performance: {
          averageLatency: calculateAverage(
            traces.map((t: any) => t.latency).filter(Number.isFinite)
          ),
          totalCost: traces.reduce((sum: number, t: any) => sum + (t.totalCost || 0), 0),
          averageCost: calculateAverage(
            traces.map((t: any) => t.totalCost).filter(Number.isFinite)
          ),
        },

        recentTraces: traces.slice(0, 5).map((trace: any) => ({
          id: trace.id,
          name: trace.name,
          timestamp: trace.timestamp,
          sessionId: trace.sessionId,
          latency: trace.latency,
          cost: trace.totalCost,
          tags: trace.tags,
        })),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(analysis, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        content: [
          {
            type: 'text',
            text: `Error analyzing user activity for ${userId}: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Helper functions for analysis
function getMostCommon(items: string[]): Array<{ item: string; count: number }> {
  const counts = items.reduce((acc: any, item: string) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(counts)
    .map(([item, count]) => ({ item, count: count as number }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function calculateAverage(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((sum, num) => sum + num, 0) / numbers.length;
}

function groupBySession(traces: any[]): any {
  const sessions = traces.reduce((acc: any, trace: any) => {
    if (trace.sessionId) {
      if (!acc[trace.sessionId]) {
        acc[trace.sessionId] = {
          sessionId: trace.sessionId,
          traceCount: 0,
          firstTrace: trace.timestamp,
          lastTrace: trace.timestamp,
        };
      }
      acc[trace.sessionId].traceCount++;
      if (trace.timestamp < acc[trace.sessionId].firstTrace) {
        acc[trace.sessionId].firstTrace = trace.timestamp;
      }
      if (trace.timestamp > acc[trace.sessionId].lastTrace) {
        acc[trace.sessionId].lastTrace = trace.timestamp;
      }
    }
    return acc;
  }, {});

  return Object.values(sessions).slice(0, 3); // Top 3 sessions
}

// Note: fetch-scores tool is not implemented yet due to SDK API limitations
// Future enhancement: Add score fetching once the SDK supports it

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Langfuse Prompts MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
