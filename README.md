# Build a Remote MCP Server on Cloudflare (Without Auth) to Query + Write to Google Calendar

This example allows you to deploy a remote MCP server giving your MCP client access to your Google Calendar that doesn't require authentication on Cloudflare Workers.

This MCP server can 
1. query your Google Calendar
2. add an event to your GCal
so you can do it directly from Cursor or Windsurf, leaving your coding flow uninterrupted!

## Get started: 

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

This will deploy your MCP server to a URL like: `remote-mcp-server-authless.<your-account>.workers.dev/sse`

Alternatively, you can use the command line below to get the remote MCP Server created on your local machine:
```bash
npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless
```

## Setup Google Calendar API
Create a [Google Service account here](https://console.cloud.google.com/iam-admin/serviceaccounts) if you haven't already.

On the [service accounts page](https://console.cloud.google.com/iam-admin/serviceaccounts), select your service account and then click <strong>Keys</strong> -> click <strong>add key</strong> -> click <strong>create new key</strong>, select <strong>JSON</strong> as the key type, and finally click <strong>get private key from JSON</strong>. Open that JSON file and select the string corresponding to private key.

Add it and the following variables to your <em>.dev.vars</em> file like so:

```json
GOOGLE_CLIENT_EMAIL="REPLACE-WITH-YOUR-service account email" 
GOOGLE_CALENDAR_ID="REPLACE-WITH-THE-GMAIL-ACCOUNT-OF-THE-CALENDAR-YOU-WANT-TO-QUERY"
GOOGLE_PRIVATE_KEY="REPLACE-WITH-PRIVATE-KEY" 
```
<em>.dev.vars</em> is for local texting. To deploy your secrets to your deployed Cloudflare Worker/MCP server, run `npx wrangler secret put GOOGLE_CLIENT_EMAIL`, click <strong>enter</strong>, and type in your google_client_email. Do that for each secret.

We need to activate the [Google Calendar API](https://developers.google.com/calendar/api/guides/overview) for a Google Cloud project of our choice (ie Google Calendar API). Use an existing project or create a new one: At the top of the [Google Cloud Console dashboard](https://console.cloud.google.com/), click on the project selection and “New Project”, enter a name e.g. “chat-with-calendar-mcp" and click “Create”. Then, in the [Google API dashboard](https://console.developers.google.com/), click <em>Enable APIs and services</em>. Search for the Google Calendar API and click <em>Enable</em>.

## Share your GCal w/ the Google Storage Account Email
In your Google Calendar, click <em>settings</em>, then <em>Settings menu</em>, then under <em>Settings for my calendars</em> select the calendar you want to share. Click <em>+ Add people and groups</em> and type in your storage account email. Give them permission to "Make changes and manage sharing." 
<img width="675" alt="Share GCal with Google Storage Email and give them read/write permissions" src="https://github.com/user-attachments/assets/3579725b-5d8f-42e9-9d1b-255dca6c9b4e" />



## Customizing your MCP Server

To add your own [tools](https://developers.cloudflare.com/agents/model-context-protocol/tools/) to the MCP server, define each tool inside the `init()` method of `src/index.ts` using `this.server.tool(...)`. 

## Connect to Cloudflare AI Playground

You can connect to your MCP server from the Cloudflare AI Playground, which is a remote MCP client:

1. Go to https://playground.ai.cloudflare.com/
2. Enter your deployed MCP server URL (`remote-mcp-server-authless.<your-account>.workers.dev/sse`)
3. You can now use your MCP tools directly from the playground!

## Connect Claude Desktop to your MCP server

You can also connect to your remote MCP server from local MCP clients, by using the [mcp-remote proxy](https://www.npmjs.com/package/mcp-remote). 

To connect to your MCP server from Claude Desktop, follow [Anthropic's Quickstart](https://modelcontextprotocol.io/quickstart/user) and within Claude Desktop go to Settings > Developer > Edit Config.

Update with this configuration:

```json
{
  "mcpServers": {
    "calculator": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:8787/sse"  // or remote-mcp-server-authless.your-account.workers.dev/sse
      ]
    }
  }
}
```

Restart Claude and you should see the tools become available. 
