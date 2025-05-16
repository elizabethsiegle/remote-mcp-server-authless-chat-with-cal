import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from 'cloudflare:workers';

export interface Env {
  AI: Ai;
  GOOGLE_CLIENT_EMAIL: string; // service account email
  GOOGLE_PRIVATE_KEY: string; // https://console.cloud.google.com/iam-admin/serviceaccounts -> service account -> keys -> add key -> create new key -> JSON -> get private key from JSON
  GOOGLE_CALENDAR_ID: string; //email of calendar to query ie lizzie.siegle@gmail.com
}

function getEnv<Env>() {
	return env as Env;
}


export class MyMCP extends McpAgent {
    server = new McpServer({
        name: "Google Calendar DataFrame Clone",
        version: "2.0.0",
    });

	toDayString(date: Date) {
		switch (date.getDay()) {
			case 0:
				return "Sunday";
			case 1:
				return "Monday";
			case 2:
				return "Tuesday";
			case 3:
				return "Wednesday";
			case 4:
				return "Thursday";
			case 5:
				return "Friday";
			case 6:
				return "Saturday";
			default:
				return "Unknown";
		}
	}

    async init() {
        console.log("Initializing MCP server...");

        this.server.tool(
            "query_google_calendar",
            "Query Google Calendar events and shape data",
            {
                query: z.string().describe("Search query for calendar events on a certain date")
            },
            async ({ query }) => {
                try {
                    const env = getEnv<Env>();

                    // First LLM call to determine date range
                    const dateRangePrompt = `Given the query "${query}", todays date is ${new Date().toISOString()}, and it is a ${this.toDayString(new Date())} determine the start and end dates to search for calendar events. 
                    Return ONLY a JSON object with two ISO date strings: startDate and endDate.
                    Example: {"startDate": "2024-03-15T00:00:00Z", "endDate": "2024-03-17T23:59:59Z"}
                    Today's date is ${new Date().toISOString()} and with dates at the start and end of a day pacific
					DO NOT INCLUDE ANY OTHER TEXT BESIDES VALID JSON`;

                    const dateRangeMessages = [
                        { role: "system", content: "You are a helpful assistant that determines date ranges for calendar queries. Return only valid JSON with ISO date strings." },
                        { role: "user", content: dateRangePrompt }
                    ];

                    const dateRangeResponse = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages: dateRangeMessages });
                    console.log("Date range response:", dateRangeResponse);
                    
                    // Extract the JSON string from the response
                    const jsonMatch = JSON.parse(dateRangeResponse.response.toString());
					console.log("JSON match:", jsonMatch);
                    if (!jsonMatch) {
                        throw new Error("Could not parse date range from LLM response");
                    }
                    const dateRange = {
                        startDate: new Date(new Date(jsonMatch.startDate).getTime() - (7 * 60 * 60 * 1000)), // PST from UTC 
                        endDate: new Date(new Date(jsonMatch.endDate).getTime() - (7 * 60 * 60 * 1000)) // PST from UTC
                    }
                    console.log("date match:", dateRange);
					

                    const { GoogleAuth } = await import('google-auth-library');
                    const { google } = await import('googleapis');

                    let privateKey = env.GOOGLE_PRIVATE_KEY;
                    if (privateKey.includes('\\n')) {
                        privateKey = privateKey.replace(/\\n/g, '\n');
                    }
                    if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
                        privateKey = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
                    }

                    const auth = new GoogleAuth({
                        credentials: {
                            client_email: env.GOOGLE_CLIENT_EMAIL,
                            private_key: privateKey
                        },
                        scopes: ['https://www.googleapis.com/auth/calendar'],
                    });

                    const calendar = google.calendar({ version: 'v3', auth });

                    // Step 1: Subscribe to new shared calendars
                    const newEmails = [env.GOOGLE_CALENDAR_ID];
                    for (const email of newEmails) {
                        await calendar.calendarList.insert({ requestBody: { id: email } });
                        console.log(`Subscribed to calendar: ${email}`);
                    }

                    // Step 2: List all subscribed calendars
                    const calendarsResult = await calendar.calendarList.list();
                    const calendars = calendarsResult.data.items || [];
                    const emails = calendars.map(c => c.id);
                    console.log(`Total subscribed calendars: ${emails.length}`);

                    if (!emails.length) {
                        throw new Error("No accessible calendars found");
                    }

                    console.log(`Querying events from ${dateRange.startDate} to ${dateRange.endDate}`);

                    const response = await calendar.events.list({
                        calendarId: emails[0] || 'primary',
                        timeMin: dateRange.startDate,
                        timeMax: dateRange.endDate,
                        maxResults: 50,
                        singleEvents: true,
                        orderBy: 'startTime',
                    });

                    const df = (response.data.items || []).map(item => {
                        const start = item.start?.dateTime || item.start?.date;
                        const end = item.end?.dateTime || item.end?.date;

                        return {
                            name: item.summary || 'No title',
                            creator: item.creator?.email || '',
                            start: start ? new Date(start).toISOString() : '',
                            end: end ? new Date(end).toISOString() : '',
                            attendees: item.attendees || [],
                            location: item.location || '',
                            queried_from: emails[0],
                            id: item.id,
                            timeZone: item.start?.timeZone || 'Europe/Berlin',
                            duration: start && end ? (new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60) + ' mins' : ''
                        };
                    });

                    // Build context for LLM
                    const eventsContext = df.map(event => `
						Event: ${event.name}
						Time: ${new Date(event.start).toLocaleString()} - ${new Date(event.end).toLocaleString()}
						Location: ${event.location || 'No location specified'}
						Duration: ${event.duration}
						Attendees: ${event.attendees.length > 0 ? event.attendees.map(a => a.email).join(', ') : 'No attendees'}
                    `).join('\n');

                    // Second LLM call to summarize events
                    const summaryPrompt = `I searched the calendar for "${query}" and found these events between ${new Date(dateRange.startDate).toLocaleDateString()} and ${new Date(dateRange.endDate).toLocaleDateString()}:
					${eventsContext}

					Please provide a natural language summary of these events. Focus on:
					1. The most important or upcoming events
					2. Any patterns or clusters of events
					3. Highlight any events with specific locations or many attendees
					4. Mention the total number of events found
					5. Do not mention past events unless relevant to the query
					6. Today's date is ${new Date().toDateString()}

					Format the response in a friendly, conversational way. Keep the response concise and under 200 words.`;

                    const summaryMessages = [
                        { role: "system", content: "You are a helpful calendar assistant that provides clear, concise summaries of calendar events. Focus on making the information easily digestible and highlighting the most relevant details. Keep responses brief and under 100 words." },
                        { role: "user", content: summaryPrompt }
                    ];

                    try {
                        const llmResponse = await Promise.race([
                            env.AI.run("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", { messages: summaryMessages }),
                            new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('AI response timeout')), 10000)
                            )
                        ]);

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: typeof llmResponse === 'string' ? llmResponse : JSON.stringify(llmResponse)
                                }
                            ]
                        };
                    } catch (error) {
                        console.error("Error calling AI model:", error);
                        // Fallback to basic response if AI fails
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Found ${df.length} events between ${new Date(dateRange.startDate).toLocaleDateString()} and ${new Date(dateRange.endDate).toLocaleDateString()}:\n${eventsContext}`
                                }
                            ]
                        };
                    }

                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return {
                        content: [{ type: "text" as const, text: `❌ Error querying calendar: ${errorMessage}` }]
                    };
                }
            }
        );
    }
}

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);

        if (url.pathname === "/sse" || url.pathname === "/sse/message") {
            // @ts-ignore
            return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
        }

        if (url.pathname === "/mcp") {
            // @ts-ignore
            return MyMCP.serve("/mcp").fetch(request, env, ctx);
        }

        return new Response("Not found", { status: 404 });
    },
};
