import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { MemorySaver } from '@langchain/langgraph';
import { SerpAPI } from '@langchain/community/tools/serpapi';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { StateGraph } from '@langchain/langgraph';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createServer } from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
async function createAgent({ llm, tools, systemMessage, }) {
    const toolNames = tools.map((tool) => tool.name).join(", ");
    const formattedTools = tools.map((t) => convertToOpenAITool(t));
    let prompt = ChatPromptTemplate.fromMessages([
        [
            "system",
            "You are a helpful AI assistant, collaborating with other assistants." +
                " Use the provided tools to progress towards answering the question." +
                " If you are unable to fully answer, that's OK, another assistant with different tools " +
                " will help where you left off. Execute what you can to make progress." +
                " If you or any of the other assistants have the final answer or deliverable," +
                " prefix your response with FINAL ANSWER so the team knows to stop." +
                " You have access to the following tools: {tool_names}.\n{system_message}",
        ],
        new MessagesPlaceholder("messages"),
    ]);
    prompt = await prompt.partial({
        system_message: systemMessage,
        tool_names: toolNames,
    });
    return prompt.pipe(llm.bind({ tools: formattedTools }));
}
import { Annotation } from "@langchain/langgraph";
import { TavilySearchResults } from '@langchain/community/tools/tavily_search';
// This defines the object that is passed between each node
// in the graph. We will create different nodes for each agent and tool
const AgentState = Annotation.Root({
    messages: Annotation({
        reducer: (x, y) => x.concat(y),
    }),
    sender: Annotation({
        reducer: (x, y) => y ?? x ?? "user",
        default: () => "user",
    }),
});
const memory = new MemorySaver();
const getNews = new SerpAPI(process.env.SERP_KEY, {
    hl: "en",
    gl: "us"
});
const tavNews = new TavilySearchResults({
    maxResults: 5
});
const llm = new ChatOpenAI({
    model: 'gpt-4',
    temperature: 0
});
function shouldContinue({ messages }) {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.tool_calls?.length) {
        return "tools";
    }
    return "__end__";
}
async function runAgentNode(props) {
    const { state, agent, name, config } = props;
    console.log(`🔄 Executing agent: ${name}`);
    console.log(`📊 Current message count: ${state.messages.length}`);
    let result = await agent.invoke(state, config);
    console.log(`✅ ${name} completed execution`);
    console.log(`📝 ${name} response preview: ${typeof result.content === 'string' ? result.content.substring(0, 100) : '[Complex content]'}...`);
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
    tools: [getNews],
    systemMessage: "You should provide accurate information for the summarizer to use"
});
async function serpNode(state, config) {
    return runAgentNode({
        state: state,
        agent: serpAgent,
        name: "SerpResearcher",
        config
    });
}
const tavAgent = await createAgent({
    llm,
    tools: [tavNews],
    systemMessage: "You should provide accurate information for the summarizer to use"
});
const summarizerAgent = await createAgent({
    llm,
    tools: [], // No tools needed for summarization
    systemMessage: `You are a news summarizer. Your job is to:

1. Analyze information gathered by the research agents
2. Create a comprehensive, well-structured summary with proper formatting
3. Highlight the most important developments and trends
4. Provide insights and context about the topic
5. Keep the response informative but conversational
6. Use line breaks and paragraphs to make the response easy to read
7. Do NOT include "FINAL ANSWER" in your response

Format your response with:
- Clear paragraph breaks between different topics
- Bullet points for key highlights when appropriate
- Proper spacing for readability

Synthesize all the research into a cohesive, engaging, well-formatted news summary.`
});
async function tavNode(state, config) {
    return runAgentNode({
        state: state,
        agent: tavAgent,
        name: "TavResearcher",
        config
    });
}
async function summarizerNode(state, config) {
    return runAgentNode({
        state: state,
        agent: summarizerAgent,
        name: "Summarizer",
        config
    });
}
const tools = [tavNews, getNews];
const toolNode = new ToolNode(tools);
function router(state) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1];
    console.log(`🧭 Router decision for sender: ${state.sender}`);
    console.log(`📋 Total messages: ${messages.length}`);
    if (lastMessage?.tool_calls && lastMessage.tool_calls.length > 0) {
        console.log(`🔧 Routing to tools (${lastMessage.tool_calls.length} tool calls)`);
        return "call_tool";
    }
    // End workflow if last message is from Summarizer
    if (state.sender === "Summarizer") {
        console.log(`🏁 Summarizer completed - ending workflow`);
        return "end";
    }
    // Count research messages to determine when to summarize
    const researchMessages = messages.filter(msg => msg.name === "SerpResearcher" || msg.name === "TavResearcher");
    console.log(`🔍 Research messages found: ${researchMessages.length}`);
    // After both researchers have contributed, go to summarizer
    if (researchMessages.length >= 2) {
        console.log(`📝 Both researchers completed - routing to Summarizer`);
        return "summarize";
    }
    console.log(`➡️ Continuing to next agent`);
    return "continue";
}
import { END, START } from '@langchain/langgraph';
const workflow = new StateGraph(AgentState)
    .addNode("SerpResearcher", serpNode)
    .addNode("TavResearcher", tavNode)
    .addNode("Summarizer", summarizerNode)
    .addNode("call_tool", toolNode);
workflow.addConditionalEdges("SerpResearcher", router, {
    continue: "TavResearcher",
    call_tool: "call_tool",
    summarize: "Summarizer",
    end: END
});
workflow.addConditionalEdges("TavResearcher", router, {
    continue: "SerpResearcher",
    call_tool: "call_tool",
    summarize: "Summarizer",
    end: END
});
workflow.addConditionalEdges("call_tool", (x) => x.sender, {
    "SerpResearcher": "SerpResearcher",
    "TavResearcher": "TavResearcher"
});
workflow.addConditionalEdges("Summarizer", router, {
    end: END
});
workflow.addEdge(START, "SerpResearcher");
const graph = workflow.compile({ checkpointer: memory });
async function generateNews(topic, session_id) {
    const config = {
        configurable: {
            thread_id: session_id
        }
    };
    try {
        console.log(`🚀 Starting workflow for topic: "${topic}"`);
        console.log(`🔑 Session ID: ${session_id}`);
        const output = await graph.invoke({
            messages: [new HumanMessage(`report current events about: ${topic}`)],
            sender: "user"
        }, config);
        console.log(`🎯 Workflow completed with ${output.messages.length} total messages`);
        const finalMessage = output.messages.at(-1);
        const preview = typeof finalMessage?.content === 'string'
            ? finalMessage.content.substring(0, 200)
            : '[Complex content]';
        console.log(`📄 Final output preview: ${preview}...`);
        return output;
    }
    catch (err) {
        console.error(`❌ Workflow error:`, err);
    }
}
// Backend
const ex = express();
ex.use(express.static('public')); // serves index.html
const server = createServer(ex);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', socket => {
    socket.on('message', async (raw) => {
        try {
            const { command, topic, session_id } = JSON.parse(raw);
            if (command === 'lookup news') {
                const output = await generateNews(topic, session_id);
                const news = output?.messages?.at(-1)?.content || 'No response available';
                socket.send(JSON.stringify({ news }));
            }
        }
        catch (e) {
            console.error(e);
            socket.send(JSON.stringify({ news: 'Oops, something went wrong!' }));
        }
    });
});
server.listen(2999, () => console.log('http://localhost:2999'));
//# sourceMappingURL=multi-agent.js.map