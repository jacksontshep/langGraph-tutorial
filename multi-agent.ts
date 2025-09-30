import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from '@langchain/langgraph'
import { SerpAPI } from '@langchain/community/tools/serpapi'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { StateGraph, MessagesAnnotation } from '@langchain/langgraph'
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts'
import { StructuredTool } from '@langchain/core/tools'
import { Runnable } from '@langchain/core/runnables'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { z } from 'zod'

import { createServer } from 'http'
import express from 'express'
import { WebSocketServer } from 'ws'

// JSON Schema definitions for structured reasoning
const ResearcherResponseSchema = z.object({
  reasoning: z.object({
    query_analysis: z.string().describe("Analysis of what information is needed"),
    search_strategy: z.string().describe("Strategy for finding relevant information"),
    tool_selection: z.string().describe("Why this tool was chosen")
  }),
  action: z.object({
    type: z.enum(["use_tool", "provide_findings"]).describe("Type of action to take"),
    tool_name: z.string().optional().describe("Name of tool to use if type is use_tool"),
    findings: z.string().optional().describe("Research findings if type is provide_findings")
  }),
  metadata: z.object({
    confidence: z.number().min(0).max(1).describe("Confidence in findings (0-1)"),
    sources_needed: z.boolean().describe("Whether more sources are needed")
  })
})

const SummarizerResponseSchema = z.object({
  reasoning: z.object({
    information_assessment: z.string().describe("Assessment of gathered information"),
    key_themes: z.array(z.string()).describe("Main themes identified"),
    synthesis_approach: z.string().describe("How information will be synthesized")
  }),
  summary: z.object({
    headline: z.string().describe("Compelling headline for the summary"),
    overview: z.string().describe("High-level overview paragraph"),
    key_points: z.array(z.object({
      point: z.string(),
      details: z.string()
    })).describe("Structured key points with details"),
    insights: z.string().describe("Analysis and insights"),
    conclusion: z.string().describe("Concluding thoughts")
  }),
  metadata: z.object({
    completeness: z.number().min(0).max(1).describe("How complete the information is (0-1)"),
    topic_coverage: z.array(z.string()).describe("Topics covered in summary")
  })
})

async function createAgent({
  llm,
  tools,
  systemMessage,
  responseSchema,
}: {
  llm: ChatOpenAI;
  tools: StructuredTool[];
  systemMessage: string;
  responseSchema?: z.ZodObject<any>;
}): Promise<Runnable> {
  const toolNames = tools.map((tool) => tool.name).join(", ");
  const formattedTools = tools.map((t) => convertToOpenAITool(t));

  let systemPrompt = "You are a helpful AI assistant, collaborating with other assistants." +
    " Use the provided tools to progress towards answering the question." +
    " If you are unable to fully answer, that's OK, another assistant with different tools " +
    " will help where you left off. Execute what you can to make progress." +
    " If you or any of the other assistants have the final answer or deliverable," +
    " prefix your response with FINAL ANSWER so the team knows to stop." +
    " You have access to the following tools: {tool_names}.\n{system_message}";

  if (responseSchema) {
    systemPrompt += "\n\nYou MUST respond in JSON format following this schema. Think through your reasoning step-by-step in the reasoning section before taking action.";
  }

  let prompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("messages"),
  ]);
  
  prompt = await prompt.partial({
    system_message: systemMessage,
    tool_names: toolNames,
  });

  // Bind tools and optionally enforce JSON response format
  const bindConfig: any = { tools: formattedTools };
  
  if (responseSchema) {
    bindConfig.response_format = {
      type: "json_schema",
      json_schema: {
        name: "agent_response",
        strict: true,
        schema: zodToJsonSchema(responseSchema)
      }
    };
  }

  return prompt.pipe(llm.bind(bindConfig));
}

import { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import { TavilySearchResults } from '@langchain/community/tools/tavily_search'
import { SystemMessage } from '@langchain/core/messages'

// Helper function to format JSON summary into readable text
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

// This defines the object that is passed between each node
// in the graph. We will create different nodes for each agent and tool
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  sender: Annotation<string>({
    reducer: (x, y) => y ?? x ?? "user",
    default: () => "user",
  }),
})

const memory = new MemorySaver()

const getNews = new SerpAPI(process.env.SERP_KEY, {
  hl: "en",
  gl: "us"
})
const tavNews = new TavilySearchResults({
  maxResults: 5
})

const llm = new ChatOpenAI({
  model: 'gpt-4',
  temperature: 0
})
 
import { RunnableConfig } from '@langchain/core/runnables'

async function runAgentNode(props: {
  state: typeof AgentState.State;
  agent: Runnable;
  name: string;
  config?: RunnableConfig;
}) {
  const { state, agent, name, config } = props;
  console.log(`🔄 Executing agent: ${name}`);
  console.log(`📊 Current message count: ${state.messages.length}`);
  
  let result = await agent.invoke(state, config);
  
  // Parse and log JSON response if available
  if (typeof result.content === 'string') {
    try {
      const jsonResponse = JSON.parse(result.content);
      console.log(`✅ ${name} completed execution`);
      console.log(`🧠 Reasoning:`, JSON.stringify(jsonResponse.reasoning, null, 2));
      
      if (jsonResponse.action) {
        console.log(`🎯 Action:`, jsonResponse.action.type);
      }
      if (jsonResponse.summary) {
        console.log(`📰 Summary headline:`, jsonResponse.summary.headline);
      }
    } catch (e) {
      console.log(`✅ ${name} completed execution`);
      console.log(`📝 ${name} response preview: ${result.content.substring(0, 100)}...`);
    }
  }
  
  // We convert the agent output into a format that is suitable
  // to append to the global state
  if (!result?.tool_calls || result.tool_calls.length === 0) {
    // If the agent is NOT calling a tool, we want it to
    // look like a human message.
    result = new HumanMessage({ ...result, name: name });
  }
  return {
    messages: [result],
    // Since we have a strict workflow, we can
    // track the sender so we know who to pass to next.
    sender: name,
  };
}

const serpAgent = await createAgent({
  llm,
  tools:[getNews],
  systemMessage: "You should provide accurate information for the summarizer to use. Analyze the query, determine the best search strategy, and gather comprehensive information.",
  responseSchema: ResearcherResponseSchema
})

async function serpNode(
  state: typeof AgentState.State,
  config?: RunnableConfig
) {
  return runAgentNode({
    state: state,
    agent: serpAgent,
    name: "SerpResearcher",
    config
  })
}

const tavAgent = await createAgent({
  llm,
  tools:[tavNews],
  systemMessage: "You should provide accurate information for the summarizer to use. Analyze the query, determine the best search strategy, and gather comprehensive information.",
  responseSchema: ResearcherResponseSchema
})

const summarizerAgent = await createAgent({
  llm,
  tools: [], // No tools needed for summarization
  systemMessage: `You are a news summarizer. Your job is to:

1. Analyze information gathered by the research agents
2. Identify key themes and patterns in the information
3. Create a comprehensive, well-structured summary with proper formatting
4. Highlight the most important developments and trends
5. Provide insights and context about the topic
6. Keep the response informative but conversational
7. Do NOT include "FINAL ANSWER" in your response

Think through your synthesis approach in the reasoning section, then provide a structured summary with headline, overview, key points, insights, and conclusion.`,
  responseSchema: SummarizerResponseSchema
})

async function tavNode(
  state: typeof AgentState.State,
  config?: RunnableConfig
) {
  return runAgentNode({
    state: state,
    agent: tavAgent,
    name: "TavResearcher",
    config
  })
}

async function summarizerNode(
  state: typeof AgentState.State,
  config?: RunnableConfig
) {
  return runAgentNode({
    state: state,
    agent: summarizerAgent,
    name: "Summarizer",
    config
  })
}

const tools = [tavNews, getNews]
const toolNode = new ToolNode<typeof AgentState.State>(tools)

function router(state: typeof AgentState.State) {
  const messages = state.messages
  const lastMessage = messages[messages.length - 1] as AIMessage
  
  console.log(`🧭 Router decision for sender: ${state.sender}`);
  console.log(`📋 Total messages: ${messages.length}`);
  
  if (lastMessage?.tool_calls && lastMessage.tool_calls.length > 0) {
    console.log(`🔧 Routing to tools (${lastMessage.tool_calls.length} tool calls)`);
    return "call_tool"
  } 
  
  // End workflow if last message is from Summarizer
  if (state.sender === "Summarizer") {
    console.log(`🏁 Summarizer completed - ending workflow`);
    return "end"
  }
  
  // Count research messages to determine when to summarize
  const researchMessages = messages.filter(msg => 
    msg.name === "SerpResearcher" || msg.name === "TavResearcher"
  )
  
  console.log(`🔍 Research messages found: ${researchMessages.length}`);
  
  // After both researchers have contributed, go to summarizer
  if (researchMessages.length >= 2) {
    console.log(`📝 Both researchers completed - routing to Summarizer`);
    return "summarize"
  }
  
  console.log(`➡️ Continuing to next agent`);
  return "continue"
}

import { END, START } from '@langchain/langgraph'
const workflow = new StateGraph(AgentState)
  .addNode("SerpResearcher", serpNode)
  .addNode("TavResearcher", tavNode)
  .addNode("Summarizer", summarizerNode)
  .addNode("call_tool", toolNode)

workflow.addConditionalEdges("SerpResearcher", router, {
  continue: "TavResearcher",
  call_tool: "call_tool",
  summarize: "Summarizer",
  end: END
})

workflow.addConditionalEdges("TavResearcher", router, {
  continue: "SerpResearcher",
  call_tool: "call_tool",
  summarize: "Summarizer",
  end: END
})

workflow.addConditionalEdges(
  "call_tool",
  (x) => x.sender,
  {
    "SerpResearcher": "SerpResearcher",
    "TavResearcher": "TavResearcher"
  }
)

workflow.addConditionalEdges("Summarizer", router, {
  end: END
})

workflow.addEdge(START, "SerpResearcher")
const graph = workflow.compile({ checkpointer: memory })

async function generateNews (topic: string, session_id: string) {
    const config = {
      configurable: {
        thread_id: session_id
      }
    }
    try {
      console.log(`🚀 Starting workflow for topic: "${topic}"`);
      console.log(`🔑 Session ID: ${session_id}`);
      
      const output = await graph.invoke({ 
        messages: [new HumanMessage(`report current events about: ${topic}`)],
        sender: "user" 
      }, config)
      
      console.log(`🎯 Workflow completed with ${output.messages.length} total messages`);
      const finalMessage = output.messages.at(-1);
      
      // Parse and format the final JSON response
      let formattedSummary: string | undefined;
      if (typeof finalMessage?.content === 'string') {
        try {
          const jsonResponse = JSON.parse(finalMessage.content);
          if (jsonResponse.summary) {
            // Format the structured summary into readable text
            formattedSummary = formatSummaryFromJSON(jsonResponse.summary);
            console.log(`📄 Final summary generated`);
          }
        } catch (e) {
          console.log(`📄 Final output preview: ${finalMessage.content.substring(0, 200)}...`);
        }
      }
      
      return { output, formattedSummary }
    } catch (err) {
      console.error(`❌ Workflow error:`, err)
      return { output: undefined, formattedSummary: undefined }
    }
  }

// Backend
const ex = express()
ex.use(express.static('public')) // serves index.html

const server = createServer(ex)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', socket => {
  socket.on('message', async (raw: string) => {
    try {
      const { command, topic, session_id } = JSON.parse(raw)
      if (command === 'lookup news') {
        const result = await generateNews(topic, session_id)
        // Use formatted summary if available, otherwise fall back to raw content
        const news = result?.formattedSummary || result?.output?.messages?.at(-1)?.content || 'No response available'
        socket.send(JSON.stringify({ news }))
      }
    } catch (e) {
      console.error(e)
      socket.send(JSON.stringify({ news: 'Oops, something went wrong!' }))
    }
  })
})

server.listen(2999, () => console.log('http://localhost:2999'))

