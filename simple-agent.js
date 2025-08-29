import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from '@langchain/langgraph'
import { SerpAPI } from '@langchain/community/tools/serpapi'


import { createServer } from 'http'
import express from 'express'
import { WebSocketServer } from 'ws'

const memory = new MemorySaver()

const getNews = new SerpAPI(process.env.SERP_KEY, {
  hl: "en",
  gl: "us"
})

const model = new ChatOpenAI({
  model: 'gpt-4o'
})

const app = createReactAgent({
  llm: model,
  tools: [getNews],
  checkpointer: memory,
  systemMessage: `You are a helpful news analyst assistant. When a user asks for news about a topic:

1. Use the search tool to find current news articles relavent to 2025
2. Analyze and summarize the key findings
3. Provide your own insights and context about the topic
4. Highlight the most important or interesting developments
5. Keep your response informative but conversational

Always provide a thoughtful summary rather than just raw search results.`
})

async function generateNews (topic, session_id) {
  const config = {
    configurable:{
      thread_id: session_id
    }
  }
  try {
    const output = await app.invoke({ messages: [{ role: 'user', content: `Get news about: ${topic}` }] }, config)
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
  socket.on('message', async raw => {
    try {
      const { command, topic, session_id } = JSON.parse(raw)
      if (command === 'lookup news') {
        const output = await generateNews(topic, session_id)
        const news = output.messages.at(-1).content
        socket.send(JSON.stringify({ news }))
      }
    } catch (e) {
      console.error(e)
      socket.send(JSON.stringify({ news: 'Oops, something went wrong!' }))
    }
  })
})

server.listen(2999, () => console.log('http://localhost:2999'))

