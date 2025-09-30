import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from '@langchain/langgraph'
import { SerpAPI } from '@langchain/community/tools/serpapi'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { StateGraph, MessagesAnnotation } from '@langchain/langgraph'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { z } from 'zod'


import { createServer } from 'http'
import express from 'express'
import { WebSocketServer } from 'ws'

// JSON Schema for structured news analysis
const NewsAnalysisSchema = z.object({
  reasoning: z.object({
    query_understanding: z.string().describe("Understanding of the user's request"),
    information_gaps: z.array(z.string()).describe("What information is missing or needed"),
    search_plan: z.string().describe("Plan for gathering information")
  }),
  analysis: z.object({
    headline: z.string().describe("Compelling headline summarizing the news"),
    summary: z.string().describe("Comprehensive summary of findings"),
    key_developments: z.array(z.object({
      development: z.string(),
      significance: z.string()
    })).describe("Key developments and their significance"),
    context: z.string().describe("Background context and analysis"),
    outlook: z.string().describe("Future implications or outlook")
  }),
  metadata: z.object({
    sources_consulted: z.number().describe("Number of sources consulted"),
    confidence_level: z.number().min(0).max(1).describe("Confidence in analysis (0-1)")
  })
})

// Helper function to format JSON analysis into readable text
function formatAnalysisFromJSON(analysis: any): string {
  let formatted = `# ${analysis.headline}\n\n`;
  formatted += `${analysis.summary}\n\n`;
  formatted += `## Key Developments\n\n`;
  
  for (const dev of analysis.key_developments) {
    formatted += `**${dev.development}**\n${dev.significance}\n\n`;
  }
  
  formatted += `## Context\n\n${analysis.context}\n\n`;
  formatted += `## Outlook\n\n${analysis.outlook}`;
  
  return formatted;
}

const memory = new MemorySaver()

const getNews = new SerpAPI(process.env.SERP_KEY, {
  hl: "en",
  gl: "us"
})
const toolNode = new ToolNode([getNews])

const model = new ChatOpenAI({
  model: 'gpt-4',
  temperature: 0
})

function shouldContinue({ messages }: typeof MessagesAnnotation.State) {
    const lastMessage = messages[messages.length - 1] as AIMessage
    if (lastMessage.tool_calls?.length) {
        return "tools"
    }
    return "__end__"
}

async function callModel(state: typeof MessagesAnnotation.State) {
    // Check if we need to use tools or provide final analysis
    const lastMessage = state.messages[state.messages.length - 1];
    const hasToolResults = lastMessage?.constructor.name === 'ToolMessage';
    
    // Add system prompt if not already present
    const systemPrompt = new SystemMessage(`You are a helpful news analyst assistant. When a user asks for news about a topic:

1. First, analyze what information you need in the reasoning section
2. Use the search tool to find current news articles relevant to 2025
3. After gathering information, provide a structured analysis with headline, summary, key developments, context, and outlook
4. Think step-by-step through your reasoning before providing the final analysis
5. Keep your response informative but conversational

You MUST respond in JSON format following the provided schema. Structure your thinking in the reasoning section, then provide comprehensive analysis.`)
    
    const messages = state.messages[0]?.constructor.name === 'SystemMessage' 
        ? state.messages 
        : [systemPrompt, ...state.messages]
    
    // If we have tool results, use JSON mode for final analysis
    // Otherwise, use regular tool calling mode
    if (hasToolResults) {
        const modelWithJson = model.bind({
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "news_analysis",
                    strict: true,
                    schema: zodToJsonSchema(NewsAnalysisSchema)
                }
            }
        });
        const response = await modelWithJson.invoke(messages);
        console.log('📊 JSON Analysis generated');
        return { messages: [response] };
    } else {
        const modelWithTools = model.bindTools([getNews]);
        const response = await modelWithTools.invoke(messages);
        return { messages: [response] };
    }
}

const workflow = new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addEdge("__start__", "agent") // __start__ is a special name for the entrypoint
    .addNode("tools", toolNode)
    .addEdge("tools", "agent")
    .addConditionalEdges("agent", shouldContinue);

const app = workflow.compile({ checkpointer: memory })

async function generateNews (topic: string, session_id: string) {
    const config = {
      configurable: {
        thread_id: session_id
      }
    }
    try {
      const output = await app.invoke({ messages: [new HumanMessage(`report current events about: ${topic}`)] }, config)
      console.log(output.messages)
      
      // Parse and format the final JSON response
      const finalMessage = output.messages.at(-1);
      let formattedAnalysis: string | undefined;
      
      if (typeof finalMessage?.content === 'string') {
        try {
          const jsonResponse = JSON.parse(finalMessage.content);
          if (jsonResponse.analysis) {
            formattedAnalysis = formatAnalysisFromJSON(jsonResponse.analysis);
            console.log('📄 Formatted analysis generated');
          }
        } catch (e) {
          console.log('ℹ️ Response is not JSON formatted');
        }
      }
      
      return { output, formattedAnalysis }
    } catch (err) {
      console.log(err)
      return { output: undefined, formattedAnalysis: undefined }
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
        // Use formatted analysis if available, otherwise fall back to raw content
        const news = result?.formattedAnalysis || result?.output?.messages?.at(-1)?.content || 'No response available'
        socket.send(JSON.stringify({ news }))
      }
    } catch (e) {
      console.error(e)
      socket.send(JSON.stringify({ news: 'Oops, something went wrong!' }))
    }
  })
})

server.listen(2999, () => console.log('http://localhost:2999'))

