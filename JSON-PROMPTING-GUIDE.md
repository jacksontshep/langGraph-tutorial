# JSON Prompting Guide for LangGraph Agents

## Overview

This guide explains the JSON prompting approach implemented across all agents in this project. JSON prompting forces agents to structure their reasoning and responses in a consistent, parseable format, leading to more reliable and transparent AI behavior.

## Benefits of JSON Prompting

1. **Structured Reasoning**: Forces agents to think step-by-step before providing answers
2. **Consistency**: All responses follow a predictable schema
3. **Parseability**: Easy to extract specific information programmatically
4. **Transparency**: Reasoning is explicitly documented in the response
5. **Validation**: Responses can be validated against schemas
6. **Better Tool Use**: Clear separation between reasoning and action

## Implementation Across Agents

### 1. Multi-Agent System (`multi-agent.ts`)

#### Researcher Agents (SerpResearcher, TavResearcher)

**Schema Structure:**
```typescript
{
  reasoning: {
    query_analysis: string,      // What information is needed
    search_strategy: string,      // How to find it
    tool_selection: string        // Why this tool was chosen
  },
  action: {
    type: "use_tool" | "provide_findings",
    tool_name?: string,           // Tool to use if applicable
    findings?: string             // Research findings if ready
  },
  metadata: {
    confidence: number,           // 0-1 confidence score
    sources_needed: boolean       // Whether more sources needed
  }
}
```

**Benefits:**
- Explicit reasoning about search strategy
- Clear decision-making process
- Confidence tracking
- Structured findings

#### Summarizer Agent

**Schema Structure:**
```typescript
{
  reasoning: {
    information_assessment: string,  // Quality of gathered info
    key_themes: string[],           // Main themes identified
    synthesis_approach: string      // How info will be synthesized
  },
  summary: {
    headline: string,               // Compelling headline
    overview: string,               // High-level overview
    key_points: Array<{
      point: string,
      details: string
    }>,
    insights: string,               // Analysis and insights
    conclusion: string              // Concluding thoughts
  },
  metadata: {
    completeness: number,           // 0-1 completeness score
    topic_coverage: string[]        // Topics covered
  }
}
```

**Benefits:**
- Structured summary with clear sections
- Explicit theme identification
- Quality assessment
- Easy formatting for display

### 2. Custom Agent (`cust-agent.ts`)

**Schema Structure:**
```typescript
{
  reasoning: {
    query_understanding: string,    // Understanding of request
    information_gaps: string[],     // What's missing
    search_plan: string            // Plan for gathering info
  },
  analysis: {
    headline: string,
    summary: string,
    key_developments: Array<{
      development: string,
      significance: string
    }>,
    context: string,
    outlook: string
  },
  metadata: {
    sources_consulted: number,
    confidence_level: number
  }
}
```

**Implementation Detail:**
- Uses conditional JSON mode: only enforces JSON schema AFTER tool results are available
- First call uses normal tool calling
- Second call (after tools) uses strict JSON schema

### 3. Simple Agent (`simple-agent.js`)

**Schema Structure (via prompt):**
```javascript
{
  reasoning: {
    query_analysis: string,
    sources_evaluated: string,
    synthesis_approach: string
  },
  report: {
    headline: string,
    summary: string,
    key_points: Array<{
      point: string,
      details: string
    }>,
    insights: string,
    conclusion: string
  },
  metadata: {
    sources_count: number,
    confidence: number
  }
}
```

**Note:** Uses prompt-based JSON enforcement (not strict schema) since it uses `createReactAgent`

## Technical Implementation

### Using Zod Schemas

```typescript
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

// Define schema
const MySchema = z.object({
  reasoning: z.object({
    analysis: z.string().describe("Your analysis")
  }),
  // ... more fields
})

// Convert to JSON Schema for OpenAI
const bindConfig = {
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "agent_response",
      strict: true,
      schema: zodToJsonSchema(MySchema)
    }
  }
}

// Bind to model
const modelWithJson = llm.bind(bindConfig)
```

### Response Formatting

All agents include helper functions to convert JSON responses to readable text:

```typescript
function formatSummaryFromJSON(summary: any): string {
  let formatted = `# ${summary.headline}\n\n`;
  formatted += `${summary.overview}\n\n`;
  formatted += `## Key Points\n\n`;
  
  for (const kp of summary.key_points) {
    formatted += `**${kp.point}**\n${kp.details}\n\n`;
  }
  
  formatted += `## Insights\n\n${summary.insights}\n\n`;
  formatted += `## Conclusion\n\n${summary.conclusion}`;
  
  return formatted;
}
```

## Best Practices

### 1. Schema Design

- **Include reasoning sections**: Always force agents to explain their thinking
- **Use descriptive field names**: Make schemas self-documenting
- **Add descriptions**: Use `.describe()` for clarity
- **Include metadata**: Track confidence, sources, etc.
- **Structure hierarchically**: Group related fields

### 2. Prompting

- **Explicit instructions**: Tell agents to think step-by-step in reasoning section
- **Schema in prompt**: Reference the schema structure in system message
- **Examples help**: Consider providing example JSON in complex cases
- **Enforce with "MUST"**: Use strong language like "You MUST respond in JSON format"

### 3. Error Handling

```typescript
try {
  const jsonResponse = JSON.parse(response.content);
  if (jsonResponse.summary) {
    // Process structured response
  }
} catch (e) {
  // Fallback to raw content
  console.log('Response is not JSON formatted');
}
```

### 4. Conditional JSON Mode

For agents that use tools, consider conditional JSON enforcement:

```typescript
if (hasToolResults) {
  // Use strict JSON schema after tools
  const modelWithJson = model.bind({ response_format: {...} });
} else {
  // Use normal tool calling mode
  const modelWithTools = model.bindTools(tools);
}
```

## Debugging

### Logging Reasoning

```typescript
const jsonResponse = JSON.parse(result.content);
console.log('🧠 Reasoning:', JSON.stringify(jsonResponse.reasoning, null, 2));
```

### Validating Responses

```typescript
// Use Zod to validate
const result = MySchema.safeParse(jsonResponse);
if (!result.success) {
  console.error('Schema validation failed:', result.error);
}
```

## Common Patterns

### Pattern 1: Research → Analysis

1. **Research phase**: Use JSON to structure search strategy
2. **Analysis phase**: Use JSON to structure findings
3. **Summary phase**: Use JSON to structure final output

### Pattern 2: Multi-Step Reasoning

```typescript
{
  step1_analysis: {...},
  step2_planning: {...},
  step3_execution: {...},
  final_output: {...}
}
```

### Pattern 3: Confidence Tracking

Always include confidence scores to track agent certainty:

```typescript
metadata: {
  confidence: 0.85,  // 0-1 scale
  uncertainty_factors: ["Limited sources", "Recent event"]
}
```

## Migration Checklist

When converting an existing agent to JSON prompting:

- [ ] Install `zod` and `zod-to-json-schema`
- [ ] Define Zod schema for agent responses
- [ ] Update system prompt to require JSON format
- [ ] Add JSON schema to model binding
- [ ] Implement JSON parsing in response handler
- [ ] Create formatting function for display
- [ ] Add error handling for non-JSON responses
- [ ] Test with various inputs
- [ ] Add logging for reasoning sections

## Performance Considerations

- **Token usage**: JSON responses use more tokens than free-form text
- **Latency**: Structured generation may be slightly slower
- **Reliability**: Trade-off is worth it for consistency
- **Caching**: JSON schemas can be cached and reused

## Future Enhancements

1. **Schema versioning**: Track schema versions for compatibility
2. **Dynamic schemas**: Adjust schemas based on task complexity
3. **Schema composition**: Combine smaller schemas for complex tasks
4. **Validation middleware**: Automatic validation of all responses
5. **Response streaming**: Stream JSON as it's generated

## Resources

- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [Zod Documentation](https://zod.dev/)
- [JSON Schema Specification](https://json-schema.org/)
- [LangChain JSON Mode](https://js.langchain.com/docs/modules/model_io/output_parsers/json)
