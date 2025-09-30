import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from '@langchain/langgraph'
import { SerpAPI } from '@langchain/community/tools/serpapi'


import { createServer } from 'http'
import express from 'express'
import { WebSocketServer } from 'ws'

// Helper function to format JSON report into readable text
function formatReportFromJSON(report) {
  let formatted = `# ${report.headline}\n\n`;
  formatted += `${report.summary}\n\n`;
  formatted += `## Key Points\n\n`;
  
  for (const kp of report.key_points) {
    formatted += `**${kp.point}**\n${kp.details}\n\n`;
  }
  
  formatted += `## Insights\n\n${report.insights}\n\n`;
  formatted += `## Conclusion\n\n${report.conclusion}`;
  
  return formatted;
}

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

1. Use the search tool to find current news articles relevant to 2025
2. After gathering information, respond in JSON format with the following structure:
   {
     "reasoning": {
       "query_analysis": "Your analysis of what information was needed",
       "sources_evaluated": "Summary of sources you found",
       "synthesis_approach": "How you synthesized the information"
     },
     "report": {
       "headline": "Compelling headline",
       "summary": "Comprehensive summary",
       "key_points": [
         {"point": "Key point 1", "details": "Details about it"},
         {"point": "Key point 2", "details": "Details about it"}
       ],
       "insights": "Your analysis and insights",
       "conclusion": "Concluding thoughts"
     },
     "metadata": {
       "sources_count": 5,
       "confidence": 0.9
     }
   }
3. Think through your reasoning step-by-step before providing the final report
4. Keep your response informative but conversational

You MUST respond in valid JSON format following the structure above.`
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
    
    // Parse and format the final JSON response
    const finalMessage = output.messages.at(-1);
    let formattedReport;
    
    if (typeof finalMessage?.content === 'string') {
      try {
        const jsonResponse = JSON.parse(finalMessage.content);
        if (jsonResponse.report) {
          formattedReport = formatReportFromJSON(jsonResponse.report);
          console.log('📄 Formatted report generated');
        }
      } catch (e) {
        console.log('ℹ️ Response is not JSON formatted');
      }
    }
    
    return { output, formattedReport }
  } catch (err) {
    console.log(err)
    return { output: undefined, formattedReport: undefined }
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
        const result = await generateNews(topic, session_id)
        // Use formatted report if available, otherwise fall back to raw content
        const news = result?.formattedReport || result?.output?.messages?.at(-1)?.content || 'No response available'
        socket.send(JSON.stringify({ news }))
      }
    } catch (e) {
      console.error(e)
      socket.send(JSON.stringify({ news: 'Oops, something went wrong!' }))
    }
  })
})

server.listen(2999, () => console.log('http://localhost:2999'))

