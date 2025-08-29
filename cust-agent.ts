import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from '@langchain/langgraph'
import { SerpAPI } from '@langchain/community/tools/serpapi'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { StateGraph, MessagesAnnotation } from '@langchain/langgraph'


import { createServer } from 'http'
import express from 'express'
import { WebSocketServer } from 'ws'

const memory = new MemorySaver()

const getNews = new SerpAPI(process.env.SERP_KEY, {
  hl: "en",
  gl: "us"
})
const toolNode = new ToolNode([getNews])

const model = new ChatOpenAI({
  model: 'gpt-4',
  temperature: 0
}).bindTools([getNews])

function shouldContinue({ messages }: typeof MessagesAnnotation.State) {
    const lastMessage = messages[messages.length - 1] as AIMessage
    if (lastMessage.tool_calls?.length) {
        return "tools"
    }
    return "__end__"
}

async function callModel(state: typeof MessagesAnnotation.State) {
    // Add system prompt if not already present
    const systemPrompt = new SystemMessage(`You are a helpful news analyst assistant. When a user asks for news about a topic:

1. Use the search tool to find current news articles relavent 2025
2. Analyze and summarize the key findings
3. Provide your own insights and context about the topic
4. Highlight the most important or interesting developments
5. Keep your response informative but conversational

Always provide a thoughtful summary rather than just raw search results.`)
    
    const messages = state.messages[0]?.constructor.name === 'SystemMessage' 
        ? state.messages 
        : [systemPrompt, ...state.messages]
    
    const response = await model.invoke(messages)
    return { messages: [response] }
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
      return output
    } catch (err) {
      console.log(err)
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
        const output = await generateNews(topic, session_id)
        const news = output?.messages?.at(-1)?.content || 'No response available'
        socket.send(JSON.stringify({ news }))
      }
    } catch (e) {
      console.error(e)
      socket.send(JSON.stringify({ news: 'Oops, something went wrong!' }))
    }
  })
})

server.listen(2999, () => console.log('http://localhost:2999'))

