# LangGraph Node Example

This repository showcases simple **LangGraph** agents written in TypeScript / JavaScript and how to run them locally or in Docker.

---

## 🗂️ Project structure

| Path | Purpose |
|------|---------|
| `multi-agent.ts` | Demonstrates a multi-agent conversation orchestrated by LangGraph. |
| `simple-agent.js` | Minimal working JavaScript agent. |
| `cust-agent.ts` | Custom agent example. |
| `public/` | Static assets if you decide to serve the agent via Express. |
| `Dockerfile` + `docker-compose.yml` | Containerised setup. |

---

## ✋ Prerequisites

* **Node.js ≥ 18** (supports `fetch` and ES modules)
* **npm** (comes with Node)
* API keys for providers you plan to use. At minimum set one of:
  * `OPENAI_API_KEY`
  * `ANTHROPIC_API_KEY`
* Optional: `SERPAPI_API_KEY` if you use the web-search tool.

Create a `.env` file at the project root with your keys:

```bash
cp .env.example .env # if the example file exists
# then edit .env and add: OPENAI_API_KEY="sk-..."
```

> 🔒 **Never commit real keys to Git!**

---

## 🚀 Quick start

```bash
# 1. Install deps
yarn install # or: npm install

# 2. Build TypeScript
npm run build

# 3. Run the multi-agent example
npm start
```

The `start` script compiles TypeScript (`tsc`) and executes the generated `dist/multi-agent.js`.

### Live development

```bash
npm run dev  # incremental tsc --watch
```

### Linting

```bash
npm run lint      # check problems
npm run lint:fix  # fix automatically
```

---

## 🐳 Running with Docker

Build and run the container (expects your `.env` in the same directory):

```bash
docker compose up --build
```

The default container command runs `npm start`.

---

## 📞 Usage example

After startup you should see chat logs similar to:

```text
[Agent:Researcher] Searching web for: "LangGraph tutorial"
[Agent:Writer] Drafting concise answer …
```

Feel free to modify `multi-agent.ts` to experiment with different node graphs, tools or memory functions.

---

## 🆘 Troubleshooting

* Make sure the required API key environment variables are set.
* If TypeScript types look stale, delete `dist/` and rebuild.
* On Windows PowerShell, prefix env vars when running scripts: `set OPENAI_API_KEY=...; npm start`.

---

## 📄 License

MIT
